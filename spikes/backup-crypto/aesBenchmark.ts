import { utf8 } from "./bytes.ts";
import type { BackupCryptoPort } from "./cryptoPort.ts";

export type AesBenchmarkOptions = Readonly<{
  measuredRuns: number;
  plaintextBytes: number;
  now: () => number;
  delay: () => Promise<void>;
}>;

export type AesBenchmarkResult = Readonly<{
  ciphertextAndTagBytes: number;
  encryptSamplesMs: readonly number[];
  decryptSamplesMs: readonly number[];
}>;

function verifyAndWipeDecrypted(decrypted: Uint8Array, expectedLength: number, label: string): void {
  try {
    if (decrypted.length !== expectedLength || decrypted.some((byte) => byte !== 0xa5)) {
      throw new Error(`${label} round-trip failed`);
    }
  } finally {
    decrypted.fill(0);
  }
}

function uniqueNonce(crypto: BackupCryptoPort, used: Set<string>): Uint8Array {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const nonce = crypto.secureRandomBytes(12);
    const identity = Array.from(nonce, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!used.has(identity)) {
      used.add(identity);
      return nonce;
    }
    nonce.fill(0);
  }
  throw new Error("AES benchmark could not obtain a unique nonce");
}

function assertFraming(ciphertextAndTag: Uint8Array, plaintextBytes: number): void {
  if (ciphertextAndTag.length !== plaintextBytes + 16) {
    throw new Error("AES benchmark ciphertext/tag framing is invalid");
  }
}

export async function runAesGcmBenchmark(
  crypto: BackupCryptoPort,
  options: AesBenchmarkOptions,
): Promise<AesBenchmarkResult> {
  if (!Number.isSafeInteger(options.measuredRuns) || options.measuredRuns <= 0) {
    throw new Error("AES benchmark measured run count is invalid");
  }
  if (!Number.isSafeInteger(options.plaintextBytes) || options.plaintextBytes <= 0) {
    throw new Error("AES benchmark plaintext size is invalid");
  }

  const key = crypto.secureRandomBytes(32);
  const plaintext = new Uint8Array(options.plaintextBytes);
  plaintext.fill(0xa5);
  const associatedData = utf8("G016-4MiB-benchmark");
  const usedNonces = new Set<string>();
  const encryptSamplesMs: number[] = [];
  const decryptSamplesMs: number[] = [];
  let warmupNonce: Uint8Array | undefined;
  let warmupCiphertext: Uint8Array | undefined;
  let ciphertextAndTagBytes = 0;

  try {
    warmupNonce = uniqueNonce(crypto, usedNonces);
    warmupCiphertext = crypto.encrypt(key, warmupNonce, plaintext, associatedData);
    assertFraming(warmupCiphertext, options.plaintextBytes);
    await options.delay();
    verifyAndWipeDecrypted(
      crypto.decrypt(key, warmupNonce, warmupCiphertext, associatedData),
      options.plaintextBytes,
      "AES benchmark warm-up",
    );
    await options.delay();

    for (let index = 0; index < options.measuredRuns; index += 1) {
      let nonce: Uint8Array | undefined;
      let ciphertext: Uint8Array | undefined;
      try {
        nonce = uniqueNonce(crypto, usedNonces);
        const encryptStarted = options.now();
        ciphertext = crypto.encrypt(key, nonce, plaintext, associatedData);
        encryptSamplesMs.push(options.now() - encryptStarted);
        assertFraming(ciphertext, options.plaintextBytes);
        ciphertextAndTagBytes = ciphertext.length;
        await options.delay();

        const decryptStarted = options.now();
        const decrypted = crypto.decrypt(key, nonce, ciphertext, associatedData);
        decryptSamplesMs.push(options.now() - decryptStarted);
        verifyAndWipeDecrypted(decrypted, options.plaintextBytes, "AES benchmark");
        await options.delay();
      } finally {
        nonce?.fill(0);
        ciphertext?.fill(0);
      }
    }

    return { ciphertextAndTagBytes, encryptSamplesMs, decryptSamplesMs };
  } finally {
    key.fill(0);
    plaintext.fill(0);
    associatedData.fill(0);
    warmupNonce?.fill(0);
    warmupCiphertext?.fill(0);
  }
}
