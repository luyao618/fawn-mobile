import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as nodeScrypt,
} from "node:crypto";

import { CryptoAuthenticationError } from "../../spikes/backup-crypto/cryptoPort.ts";
import type { BackupCryptoPort } from "../../spikes/backup-crypto/cryptoPort.ts";

export const nodeCryptoPort: BackupCryptoPort = {
  async deriveKey(passphraseUtf8, salt, parameters) {
    const value = await new Promise<Buffer>((resolve, reject) => {
      nodeScrypt(passphraseUtf8, salt, 32, {
        ...parameters,
        maxmem: 64 * 1024 * 1024,
      }, (error, key) => error ? reject(error) : resolve(key));
    });
    return new Uint8Array(value);
  },
  sha256(value) {
    return new Uint8Array(createHash("sha256").update(value).digest());
  },
  secureRandomBytes(length) {
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Invalid random byte length");
    return new Uint8Array(randomBytes(length));
  },
  encrypt(key, nonce, plaintext, associatedData) {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associatedData);
    return new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  decrypt(key, nonce, ciphertextAndTag, associatedData) {
    const ciphertext = ciphertextAndTag.slice(0, -16);
    const tag = ciphertextAndTag.slice(-16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    const updated = decipher.update(ciphertext);
    try {
      return new Uint8Array(Buffer.concat([updated, decipher.final()]));
    } catch (cause) {
      updated.fill(0);
      throw new CryptoAuthenticationError("AES-256-GCM authentication failed", { cause });
    }
  },
};
