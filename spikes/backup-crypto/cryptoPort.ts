export type ScryptParameters = Readonly<{ N: number; r: number; p: number }>;

export class CryptoAuthenticationError extends Error {
  override readonly name = "CryptoAuthenticationError";

  constructor(message: string, options: Readonly<{ cause: unknown }>) {
    super(message, options);
  }
}

export interface BackupCryptoPort {
  deriveKey(passphraseUtf8: Uint8Array, salt: Uint8Array, parameters: ScryptParameters): Promise<Uint8Array>;
  sha256(value: Uint8Array): Uint8Array;
  secureRandomBytes(length: number): Uint8Array;
  encrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    associatedData: Uint8Array,
  ): Uint8Array;
  decrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertextAndTag: Uint8Array,
    associatedData: Uint8Array,
  ): Uint8Array;
}

export type SecureRandomSource = (length: number) => Uint8Array;
