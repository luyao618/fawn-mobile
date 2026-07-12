import {
  Buffer,
  createCipheriv,
  createDecipheriv,
  createHash,
  scrypt,
} from "react-native-quick-crypto";

import { CryptoAuthenticationError } from "./cryptoPort.ts";
import type { BackupCryptoPort, SecureRandomSource } from "./cryptoPort.ts";
import {
  AES_GCM_TAG_BYTES,
  SCRYPT_DERIVED_KEY_BYTES,
  SCRYPT_MAX_MEMORY_BYTES,
  assertAes256GcmInputs,
  assertSecureRandomLength,
  copyExactBytes,
  createSerializedSnapshotQueue,
  splitCiphertextAndTag,
  snapshotRequiredScryptParameters,
  wipeBytes,
} from "./nativeCryptoPortValidation.ts";

export const NATIVE_CRYPTO_ADAPTER_IDENTITY = "BackupCryptoPort/nativeCryptoPort@1";
export const NATIVE_CRYPTO_PACKAGE_ROOT_IMPORTS = true;
export const NATIVE_CRYPTO_INSTALL_CALLED = false;
export const NATIVE_CRYPTO_BACKEND = "react-native-quick-crypto@1.1.6/OpenSSL";

const enqueueScrypt = createSerializedSnapshotQueue();

type QuickBuffer = ReturnType<typeof Buffer.from>;
type NativeInput = Readonly<{ snapshot: Uint8Array; buffer: QuickBuffer }>;

function nativeView(snapshot: Uint8Array): QuickBuffer {
  try {
    return Buffer.from(snapshot.buffer as ArrayBuffer, snapshot.byteOffset, snapshot.byteLength);
  } catch (error) {
    wipeBytes(snapshot);
    throw error;
  }
}

function nativeInput(value: Uint8Array): NativeInput {
  let snapshot: Uint8Array | undefined;
  try {
    snapshot = copyExactBytes(value);
    return { snapshot, buffer: nativeView(snapshot) };
  } catch (error) {
    wipeBytes(snapshot);
    throw error;
  }
}

function wipeNativeInput(value: NativeInput | undefined): void {
  if (value === undefined) return;
  wipeBytes(value.buffer, value.snapshot);
}

function concatenateNativeOutputs(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function createNativeCryptoPort(randomSource: SecureRandomSource): BackupCryptoPort {
  return {
    deriveKey(passphraseUtf8, salt, parameters) {
      const parameterSnapshot = snapshotRequiredScryptParameters(parameters);
      return enqueueScrypt([passphraseUtf8, salt], async ([passphraseSnapshot, saltSnapshot]) => {
        let passphrase: QuickBuffer | undefined;
        let nativeSalt: QuickBuffer | undefined;
        let derived: QuickBuffer | undefined;
        try {
          passphrase = nativeView(passphraseSnapshot);
          nativeSalt = nativeView(saltSnapshot);
          const passphraseBuffer = passphrase;
          const saltBuffer = nativeSalt;
          derived = await new Promise<QuickBuffer>((resolve, reject) => {
            scrypt(
              passphraseBuffer,
              saltBuffer,
              SCRYPT_DERIVED_KEY_BYTES,
              {
                N: parameterSnapshot.N,
                r: parameterSnapshot.r,
                p: parameterSnapshot.p,
                maxmem: SCRYPT_MAX_MEMORY_BYTES,
              },
              (error, value) => {
                if (error !== null) reject(error);
                else if (value === undefined || value.length !== SCRYPT_DERIVED_KEY_BYTES) {
                  reject(new Error("Native scrypt returned an invalid key"));
                } else resolve(value);
              },
            );
          });
          return copyExactBytes(derived);
        } finally {
          wipeBytes(derived, passphrase, nativeSalt);
        }
      });
    },

    sha256(value) {
      let input: NativeInput | undefined;
      let digest: QuickBuffer | undefined;
      try {
        input = nativeInput(value);
        digest = createHash("sha256").update(input.buffer).digest();
        return copyExactBytes(digest);
      } finally {
        wipeBytes(digest);
        wipeNativeInput(input);
      }
    },

    secureRandomBytes(length) {
      assertSecureRandomLength(length);
      const value = randomSource(length);
      try {
        if (!(value instanceof Uint8Array) || value.length !== length) {
          throw new Error(`Secure random source returned ${value?.length ?? "non-bytes"} bytes; expected ${length}`);
        }
        return copyExactBytes(value);
      } finally {
        wipeBytes(value);
      }
    },

    encrypt(key, nonce, plaintext, associatedData) {
      assertAes256GcmInputs(key, nonce);
      let nativeKey: NativeInput | undefined;
      let nativeNonce: NativeInput | undefined;
      let nativePlaintext: NativeInput | undefined;
      let nativeAad: NativeInput | undefined;
      let updated: QuickBuffer | undefined;
      let finalized: QuickBuffer | undefined;
      let tag: QuickBuffer | undefined;
      try {
        nativeKey = nativeInput(key);
        nativeNonce = nativeInput(nonce);
        nativePlaintext = nativeInput(plaintext);
        nativeAad = nativeInput(associatedData);
        const cipher = createCipheriv("aes-256-gcm", nativeKey.buffer, nativeNonce.buffer, {
          authTagLength: AES_GCM_TAG_BYTES,
        });
        cipher.setAAD(nativeAad.buffer);
        updated = cipher.update(nativePlaintext.buffer);
        finalized = cipher.final();
        tag = cipher.getAuthTag();
        if (tag.length !== AES_GCM_TAG_BYTES) throw new Error("Native AES-GCM returned an invalid tag");
        return concatenateNativeOutputs([updated, finalized, tag]);
      } finally {
        wipeBytes(updated, finalized, tag);
        wipeNativeInput(nativeKey);
        wipeNativeInput(nativeNonce);
        wipeNativeInput(nativePlaintext);
        wipeNativeInput(nativeAad);
      }
    },

    decrypt(key, nonce, ciphertextAndTag, associatedData) {
      assertAes256GcmInputs(key, nonce);
      let nativeKey: NativeInput | undefined;
      let nativeNonce: NativeInput | undefined;
      let nativeFrame: NativeInput | undefined;
      let nativeAad: NativeInput | undefined;
      let unauthenticatedPlaintext: QuickBuffer | undefined;
      let finalizedPlaintext: QuickBuffer | undefined;
      try {
        nativeKey = nativeInput(key);
        nativeNonce = nativeInput(nonce);
        nativeFrame = nativeInput(ciphertextAndTag);
        nativeAad = nativeInput(associatedData);
        const split = splitCiphertextAndTag(nativeFrame.buffer);
        const decipher = createDecipheriv("aes-256-gcm", nativeKey.buffer, nativeNonce.buffer, {
          authTagLength: AES_GCM_TAG_BYTES,
        });
        decipher.setAAD(nativeAad.buffer);
        decipher.setAuthTag(split.tag as QuickBuffer);
        unauthenticatedPlaintext = decipher.update(split.ciphertext as QuickBuffer);
        try {
          finalizedPlaintext = decipher.final();
        } catch (cause) {
          throw new CryptoAuthenticationError("AES-256-GCM authentication failed", { cause });
        }
        return concatenateNativeOutputs([unauthenticatedPlaintext, finalizedPlaintext]);
      } finally {
        wipeBytes(unauthenticatedPlaintext, finalizedPlaintext);
        wipeNativeInput(nativeKey);
        wipeNativeInput(nativeNonce);
        wipeNativeInput(nativeFrame);
        wipeNativeInput(nativeAad);
      }
    },
  };
}
