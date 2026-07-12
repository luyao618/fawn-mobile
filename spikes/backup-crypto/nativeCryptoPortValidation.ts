import type { ScryptParameters } from "./cryptoPort.ts";

export const AES_256_KEY_BYTES = 32;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;
export const SCRYPT_DERIVED_KEY_BYTES = 32;
export const SCRYPT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
export const REQUIRED_SCRYPT_PARAMETERS = { N: 32768, r: 8, p: 1 } as const;

export type SerializedSnapshotQueue = <Result>(
  inputs: readonly Uint8Array[],
  operation: (snapshots: readonly Uint8Array[]) => Promise<Result>,
) => Promise<Result>;

function isSharedArrayBufferBacked(value: Uint8Array): boolean {
  return Object.prototype.toString.call(value.buffer) === "[object SharedArrayBuffer]";
}

export function wipeBytes(...values: Array<Uint8Array | undefined>): void {
  for (const value of values) {
    try {
      value?.fill(0);
    } catch {
      // Best-effort only: native/VM copies cannot be comprehensively erased here.
    }
  }
}

export function assertCopyableBytes(value: Uint8Array): void {
  if (!(value instanceof Uint8Array)) throw new Error("Native crypto input must be a Uint8Array");
  if (isSharedArrayBufferBacked(value)) {
    throw new Error("Native crypto input must not be backed by SharedArrayBuffer");
  }
}

export function assertRequiredScryptParameters(parameters: ScryptParameters): void {
  if (
    parameters.N !== REQUIRED_SCRYPT_PARAMETERS.N
    || parameters.r !== REQUIRED_SCRYPT_PARAMETERS.r
    || parameters.p !== REQUIRED_SCRYPT_PARAMETERS.p
  ) {
    throw new Error("Native scrypt requires N=32768, r=8, and p=1");
  }
}

export function snapshotRequiredScryptParameters(parameters: ScryptParameters): ScryptParameters {
  assertRequiredScryptParameters(parameters);
  return Object.freeze({ N: parameters.N, r: parameters.r, p: parameters.p });
}

export function assertAes256GcmInputs(key: Uint8Array, nonce: Uint8Array): void {
  assertCopyableBytes(key);
  assertCopyableBytes(nonce);
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error("AES-256-GCM requires a 32-byte key");
  }
  if (nonce.length !== AES_GCM_NONCE_BYTES) {
    throw new Error("AES-256-GCM requires a 12-byte nonce");
  }
}

export function copyExactBytes(value: Uint8Array): Uint8Array {
  assertCopyableBytes(value);
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

export function createSerializedSnapshotQueue(): SerializedSnapshotQueue {
  let tail: Promise<void> = Promise.resolve();

  return function enqueue<Result>(
    inputs: readonly Uint8Array[],
    operation: (snapshots: readonly Uint8Array[]) => Promise<Result>,
  ): Promise<Result> {
    const snapshots: Uint8Array[] = [];
    try {
      for (const input of inputs) snapshots.push(copyExactBytes(input));
    } catch (error) {
      wipeBytes(...snapshots);
      throw error;
    }

    let run: Promise<Result>;
    try {
      run = tail.then(() => operation(snapshots));
      tail = run.then(() => undefined, () => undefined);
    } catch (error) {
      wipeBytes(...snapshots);
      throw error;
    }

    return run.finally(() => wipeBytes(...snapshots));
  };
}

export function splitCiphertextAndTag(ciphertextAndTag: Uint8Array): Readonly<{
  ciphertext: Uint8Array;
  tag: Uint8Array;
}> {
  assertCopyableBytes(ciphertextAndTag);
  if (ciphertextAndTag.length < AES_GCM_TAG_BYTES) {
    throw new Error("AES-256-GCM payload is shorter than its authentication tag");
  }
  const ciphertextLength = ciphertextAndTag.length - AES_GCM_TAG_BYTES;
  return {
    ciphertext: ciphertextAndTag.subarray(0, ciphertextLength),
    tag: ciphertextAndTag.subarray(ciphertextLength),
  };
}

export function assertSecureRandomLength(length: number): void {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error("Secure random byte length must be a positive safe integer");
  }
}
