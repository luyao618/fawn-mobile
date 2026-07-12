/**
 * Proof-only native backend access.
 *
 * Production FMBK operations continue to use BackupCryptoPort. This module
 * imports Quick Crypto directly only for the RFC 7914 parameter vector that
 * intentionally differs from the production-fixed scrypt parameters.
 */
import { Buffer, scrypt } from "react-native-quick-crypto";

import { fromHex, toHex, utf8 } from "./bytes.ts";
import { CryptoAuthenticationError } from "./cryptoPort.ts";
import type { BackupCryptoPort } from "./cryptoPort.ts";
import { readFmbk, writeFmbk } from "./fmbk.ts";
import {
  SCRYPT_MAX_MEMORY_BYTES,
  copyExactBytes,
  wipeBytes,
} from "./nativeCryptoPortValidation.ts";
import {
  VECTOR_DERIVED_KEY_HEX,
  VECTOR_PASSPHRASE,
  vectorEntries,
} from "./vector.ts";

const RFC_7914_VECTOR_1 = "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906";
const AES_EMPTY_FRAME = "530f8afbc74536b9a963b4f1c4cb738b";
const AES_SLICED_FRAME = "f6096e3e51de14a87a7c9dc81b67dec17d7178f7c33f0f42e3c34c7f1ba730dc";
const PRODUCTION_SCRYPT = { N: 32768, r: 8, p: 1 } as const;

type QuickBuffer = ReturnType<typeof Buffer.from>;

type SelfTestFlags = {
  rfc: boolean;
  node: boolean;
  aes: boolean;
  sliced: boolean;
  rejections: boolean;
  tamper: boolean;
  queue: boolean;
};

export type NativeCryptoSelfTestResult = Readonly<{
  ok: boolean;
  count: 7;
  failures: readonly string[];
  flags: Readonly<SelfTestFlags>;
}>;

function requireSelfTest(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function slicedBytes(bytes: Uint8Array): Readonly<{ backing: Uint8Array; view: Uint8Array }> {
  const backing = new Uint8Array(bytes.length + 2);
  backing.fill(0xee);
  backing.set(bytes, 1);
  return { backing, view: backing.subarray(1, -1) };
}

function nativeScryptRfcVector(): Promise<Uint8Array> {
  const password = new Uint8Array();
  const salt = new Uint8Array();
  let passwordSnapshot: Uint8Array | undefined;
  let saltSnapshot: Uint8Array | undefined;
  let nativePassword: QuickBuffer | undefined;
  let nativeSalt: QuickBuffer | undefined;

  try {
    passwordSnapshot = copyExactBytes(password);
    saltSnapshot = copyExactBytes(salt);
    nativePassword = Buffer.from(passwordSnapshot.buffer as ArrayBuffer, 0, passwordSnapshot.byteLength);
    nativeSalt = Buffer.from(saltSnapshot.buffer as ArrayBuffer, 0, saltSnapshot.byteLength);
  } catch (error) {
    wipeBytes(nativePassword, nativeSalt, passwordSnapshot, saltSnapshot);
    throw error;
  }

  return new Promise<QuickBuffer>((resolve, reject) => {
    scrypt(
      nativePassword,
      nativeSalt,
      64,
      { N: 16, r: 1, p: 1, maxmem: SCRYPT_MAX_MEMORY_BYTES },
      (error, value) => {
        if (error !== null) reject(error);
        else if (value === undefined || value.length !== 64) reject(new Error("RFC 7914 scrypt returned an invalid key"));
        else resolve(value);
      },
    );
  }).then((derived) => {
    try {
      return copyExactBytes(derived);
    } finally {
      wipeBytes(derived);
    }
  }).finally(() => {
    wipeBytes(nativePassword, nativeSalt, passwordSnapshot, saltSnapshot);
  });
}

async function testRfcScrypt(): Promise<void> {
  const derived = await nativeScryptRfcVector();
  try {
    requireSelfTest(toHex(derived) === RFC_7914_VECTOR_1, "RFC 7914 vector 1 mismatch");
  } finally {
    wipeBytes(derived);
  }
}

async function testNodeProductionVector(crypto: BackupCryptoPort): Promise<void> {
  const passphrase = utf8(VECTOR_PASSPHRASE.normalize("NFC"));
  const salt = fromHex("000102030405060708090a0b0c0d0e0f");
  let derived: Uint8Array | undefined;
  try {
    derived = await crypto.deriveKey(passphrase, salt, PRODUCTION_SCRYPT);
    requireSelfTest(toHex(derived) === VECTOR_DERIVED_KEY_HEX, "Node production scrypt vector mismatch");
  } finally {
    wipeBytes(derived, passphrase, salt);
  }
}

function authenticationRejected(cryptoOperation: () => Uint8Array): boolean {
  try {
    const unexpected = cryptoOperation();
    wipeBytes(unexpected);
    return false;
  } catch (error) {
    return error instanceof CryptoAuthenticationError
      && error.message === "AES-256-GCM authentication failed"
      && error.cause !== undefined;
  }
}

function testAesVectors(crypto: BackupCryptoPort): Readonly<{
  aes: boolean;
  sliced: boolean;
  rejections: boolean;
}> {
  const emptyKey = new Uint8Array(32);
  const emptyNonce = new Uint8Array(12);
  const emptyPlaintext = new Uint8Array();
  const emptyAad = new Uint8Array();
  let emptyFrame: Uint8Array | undefined;
  let emptyDecrypted: Uint8Array | undefined;

  const key = slicedBytes(Uint8Array.from({ length: 32 }, (_, index) => index));
  const nonce = slicedBytes(Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index));
  const plaintext = slicedBytes(Uint8Array.from({ length: 16 }, (_, index) => 0x10 + index));
  const aad = slicedBytes(Uint8Array.from({ length: 8 }, (_, index) => 0xf0 + index));
  let frame: Uint8Array | undefined;
  let frameBacking: Uint8Array | undefined;
  let decrypted: Uint8Array | undefined;
  let wrongAad: Uint8Array | undefined;
  let wrongTag: Uint8Array | undefined;
  let wrongCiphertext: Uint8Array | undefined;

  try {
    emptyFrame = crypto.encrypt(emptyKey, emptyNonce, emptyPlaintext, emptyAad);
    requireSelfTest(emptyFrame.length === 16, "AES empty plaintext framing mismatch");
    requireSelfTest(toHex(emptyFrame) === AES_EMPTY_FRAME, "AES empty known-answer mismatch");
    emptyDecrypted = crypto.decrypt(emptyKey, emptyNonce, emptyFrame, emptyAad);
    requireSelfTest(emptyDecrypted.length === 0, "AES empty known-answer did not decrypt to empty plaintext");

    frame = crypto.encrypt(key.view, nonce.view, plaintext.view, aad.view);
    requireSelfTest(toHex(frame) === AES_SLICED_FRAME, "AES sliced-view known-answer mismatch");
    frameBacking = new Uint8Array(frame.length + 2);
    frameBacking.fill(0xdd);
    frameBacking.set(frame, 1);
    decrypted = crypto.decrypt(key.view, nonce.view, frameBacking.subarray(1, -1), aad.view);
    requireSelfTest(toHex(decrypted) === toHex(plaintext.view), "AES sliced-view round-trip mismatch");

    wrongAad = aad.view.slice();
    wrongAad[0] ^= 1;
    wrongTag = frame.slice();
    wrongTag[wrongTag.length - 1] ^= 1;
    wrongCiphertext = frame.slice();
    wrongCiphertext[0] ^= 1;
    requireSelfTest(
      authenticationRejected(() => crypto.decrypt(key.view, nonce.view, frame!, wrongAad!)),
      "AES wrong AAD was not rejected with a retained native cause",
    );
    requireSelfTest(
      authenticationRejected(() => crypto.decrypt(key.view, nonce.view, wrongTag!, aad.view)),
      "AES wrong tag was not rejected with a retained native cause",
    );
    requireSelfTest(
      authenticationRejected(() => crypto.decrypt(key.view, nonce.view, wrongCiphertext!, aad.view)),
      "AES wrong ciphertext was not rejected with a retained native cause",
    );

    return { aes: true, sliced: true, rejections: true };
  } finally {
    wipeBytes(
      emptyKey,
      emptyNonce,
      emptyPlaintext,
      emptyAad,
      emptyFrame,
      emptyDecrypted,
      key.backing,
      nonce.backing,
      plaintext.backing,
      aad.backing,
      frame,
      frameBacking,
      decrypted,
      wrongAad,
      wrongTag,
      wrongCiphertext,
    );
  }
}

async function testQueuedOwnership(crypto: BackupCryptoPort): Promise<void> {
  const passphraseBytes = utf8(VECTOR_PASSPHRASE.normalize("NFC"));
  const saltBytes = fromHex("000102030405060708090a0b0c0d0e0f");
  const firstPassphrase = slicedBytes(passphraseBytes);
  const firstSalt = slicedBytes(saltBytes);
  const secondPassphrase = slicedBytes(passphraseBytes);
  const secondSalt = slicedBytes(saltBytes);
  let firstKey: Uint8Array | undefined;
  let secondKey: Uint8Array | undefined;
  const firstParameters: { N: number; r: number; p: number } = { ...PRODUCTION_SCRYPT };
  const secondParameters: { N: number; r: number; p: number } = { ...PRODUCTION_SCRYPT };

  try {
    const first = crypto.deriveKey(firstPassphrase.view, firstSalt.view, firstParameters);
    const second = crypto.deriveKey(secondPassphrase.view, secondSalt.view, secondParameters);
    firstPassphrase.backing.fill(0xa1);
    firstSalt.backing.fill(0xa2);
    secondPassphrase.backing.fill(0xb1);
    secondSalt.backing.fill(0xb2);
    firstParameters.N = 2;
    firstParameters.r = 1;
    firstParameters.p = 99;
    secondParameters.N = 4;
    secondParameters.r = 2;
    secondParameters.p = 88;
    [firstKey, secondKey] = await Promise.all([first, second]);
    requireSelfTest(toHex(firstKey) === VECTOR_DERIVED_KEY_HEX, "First queued scrypt input was not owned");
    requireSelfTest(toHex(secondKey) === VECTOR_DERIVED_KEY_HEX, "Second queued scrypt input was not owned");
  } finally {
    wipeBytes(
      passphraseBytes,
      saltBytes,
      firstPassphrase.backing,
      firstSalt.backing,
      secondPassphrase.backing,
      secondSalt.backing,
      firstKey,
      secondKey,
    );
  }
}

async function testProductionTamper(crypto: BackupCryptoPort): Promise<void> {
  const entries = vectorEntries();
  let archive: Uint8Array | undefined;
  let tampered: Uint8Array | undefined;
  let nativeDecryptCalls = 0;
  try {
    archive = await writeFmbk(VECTOR_PASSPHRASE, undefined, entries, crypto);
    tampered = archive.slice();
    const headerLength = new DataView(tampered.buffer, tampered.byteOffset + 6, 4).getUint32(0, false);
    const firstCiphertextByte = 10 + headerLength + 13;
    tampered[firstCiphertextByte] ^= 1;
    const observingPort: BackupCryptoPort = {
      ...crypto,
      decrypt(key, nonce, ciphertextAndTag, associatedData) {
        nativeDecryptCalls += 1;
        return crypto.decrypt(key, nonce, ciphertextAndTag, associatedData);
      },
    };
    let rejectedByAuthentication = false;
    try {
      const unexpected = await readFmbk(tampered, VECTOR_PASSPHRASE, observingPort, { availableStorageBytes: 3 });
      wipeBytes(unexpected.plaintext, ...unexpected.entries.map((entry) => entry.content));
    } catch (error) {
      rejectedByAuthentication = error instanceof Error && /chunk authentication failed/.test(error.message);
    }
    requireSelfTest(nativeDecryptCalls === 1, "Production tamper did not reach native decryption");
    requireSelfTest(rejectedByAuthentication, "Production tamper was not rejected by native authentication");
  } finally {
    wipeBytes(archive, tampered, ...entries.map((entry) => entry.content));
  }
}

export async function runNativeCryptoSelfTests(crypto: BackupCryptoPort): Promise<NativeCryptoSelfTestResult> {
  const failures: string[] = [];
  const flags: SelfTestFlags = {
    rfc: false,
    node: false,
    aes: false,
    sliced: false,
    rejections: false,
    tamper: false,
    queue: false,
  };

  const run = async (name: keyof SelfTestFlags, operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation();
      flags[name] = true;
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await run("rfc", testRfcScrypt);
  await run("node", () => testNodeProductionVector(crypto));
  try {
    const aes = testAesVectors(crypto);
    flags.aes = aes.aes;
    flags.sliced = aes.sliced;
    flags.rejections = aes.rejections;
  } catch (error) {
    failures.push(`aes: ${error instanceof Error ? error.message : String(error)}`);
  }
  await run("tamper", () => testProductionTamper(crypto));
  await run("queue", () => testQueuedOwnership(crypto));

  return { ok: failures.length === 0, count: 7, failures, flags };
}
