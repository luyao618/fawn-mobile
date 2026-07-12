import {
  concatBytes,
  decodeUtf8,
  fromBase64,
  toBase64,
  toHex,
  u16,
  u32,
  u64,
  utf8,
} from "./bytes.ts";
import { assertValidUnicode, canonicalJson } from "./canonicalJson.ts";
import { CryptoAuthenticationError } from "./cryptoPort.ts";
import type { BackupCryptoPort, ScryptParameters } from "./cryptoPort.ts";

const MAGIC = utf8("FMBK");
const VERSION = 1;
const TAG_LENGTH = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PLAINTEXT_BYTES = 512 * 1024 * 1024;
const TERMINATOR_INDEX = 0xffff_ffff;
const PRODUCTION_CHUNK_SIZE = 4 * 1024 * 1024;
const VECTOR_HEADER_JSON = '{"aead":"aes-256-gcm","chunk_size":64,"kdf":"scrypt","kdf_params":{"N":32768,"p":1,"r":8},"nonce_prefix_b64":"EBESExQVFhc=","salt_b64":"AAECAwQFBgcICQoLDA0ODw=="}';
const VECTOR_ARCHIVE_SHA256 = "231f64bf4045b430ca0de6c18b215f9a4414293683021528c411ae85d0010231";

export const FMBK_ERROR = {
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  INVALID_FORMAT: "INVALID_FORMAT",
  RESOURCE_LIMIT: "RESOURCE_LIMIT",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
} as const;

export type FmbkErrorCode = typeof FMBK_ERROR[keyof typeof FMBK_ERROR];

export class FmbkError extends Error {
  override readonly name = "FmbkError";

  constructor(
    readonly code: FmbkErrorCode,
    message: string,
    options?: Readonly<{ cause: unknown }>,
  ) {
    super(`FMBK rejected: ${message}`, options);
  }
}

export type FmbkHeader = Readonly<{
  aead: "aes-256-gcm";
  chunk_size: number;
  kdf: "scrypt";
  kdf_params: ScryptParameters;
  nonce_prefix_b64: string;
  salt_b64: string;
}>;

export type FmbkEntry = Readonly<{
  type: "manifest" | "file";
  name: string;
  content: Uint8Array;
}>;

export type FmbkManifestFile = Readonly<{
  name: string;
  sha256: string;
  size: number;
}>;

export type FmbkManifest = Readonly<{
  album_count: number;
  app_schema_version: number;
  backup_format_version: 1;
  dataset_id: string;
  exported_at: string;
  files: readonly FmbkManifestFile[];
}>;

export type FmbkReadResult = Readonly<{
  header: FmbkHeader;
  manifest: FmbkManifest;
  plaintext: Uint8Array;
  entries: readonly FmbkEntry[];
}>;

export type FmbkResourceLimits = Readonly<{
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxPlaintextBytes?: number;
}>;

export type FmbkReadOptions = FmbkResourceLimits & Readonly<{
  availableStorageBytes: number;
  mode?: "production" | "normative-vector";
}>;

export type FmbkWriteOptions = FmbkResourceLimits & Readonly<{
  mode?: "production" | "normative-vector";
}>;

type ResolvedLimits = Readonly<{
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxPlaintextBytes: number;
}>;

function ensure(
  condition: unknown,
  message: string,
  code: FmbkErrorCode = FMBK_ERROR.INVALID_FORMAT,
): asserts condition {
  if (!condition) throw new FmbkError(code, message);
}

function resolveLimits(limits: FmbkResourceLimits): ResolvedLimits {
  const resolved = {
    maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxEntryBytes: limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxPlaintextBytes: limits.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES,
  };
  for (const [name, value] of Object.entries(resolved)) {
    ensure(Number.isSafeInteger(value) && value >= 0, `${name} is invalid`, FMBK_ERROR.RESOURCE_LIMIT);
  }
  ensure(
    resolved.maxEntries >= 2 && resolved.maxEntries <= DEFAULT_MAX_ENTRIES,
    "entry-count limit is outside contract bounds",
    FMBK_ERROR.RESOURCE_LIMIT,
  );
  return resolved;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function normalizedPassphraseBytes(passphrase: string): Uint8Array {
  ensure(typeof passphrase === "string", "passphrase must be a string");
  return utf8(passphrase.normalize("NFC"));
}

function chunkNonce(prefix: Uint8Array, index: number): Uint8Array {
  ensure(prefix.length === 8, "nonce prefix must be eight bytes");
  return concatBytes(prefix, u32(index));
}

function chunkAad(headerHash: Uint8Array, index: number, plaintextLength: number): Uint8Array {
  return concatBytes(MAGIC, u16(VERSION), headerHash, u32(index), u32(plaintextLength));
}

function terminatorAad(
  headerHash: Uint8Array,
  chunkCount: number,
  totalLength: number,
  plaintextHash: Uint8Array,
): Uint8Array {
  return concatBytes(
    MAGIC,
    u16(VERSION),
    headerHash,
    Uint8Array.of(0xff),
    u32(chunkCount),
    u64(totalLength),
    plaintextHash,
  );
}

function validateName(name: string): Uint8Array {
  ensure(typeof name === "string", "entry name must be a string");
  try {
    assertValidUnicode(name);
  } catch {
    throw new FmbkError(FMBK_ERROR.INVALID_FORMAT, "entry name contains an unpaired UTF-16 surrogate");
  }
  const normalized = name.normalize("NFC");
  ensure(name === normalized, "entry names must already be NFC-normalized");
  ensure(name.length > 0, "entry name is empty");
  ensure(!name.startsWith("/") && !/^[A-Za-z]:\//.test(name), "absolute entry paths are forbidden");
  ensure(!name.includes("\\") && !name.includes("\0"), "entry name is not normalized POSIX");
  ensure(!name.endsWith("/") && !name.includes("//"), "entry name contains an empty path segment");
  const segments = name.split("/");
  ensure(!segments.includes(".") && !segments.includes(".."), "dot and parent path segments are forbidden");
  const encoded = utf8(name);
  ensure(encoded.length <= MAX_NAME_BYTES, "entry name exceeds 1,024 UTF-8 bytes");
  return encoded;
}

function ensureAllowedBackupFileName(name: string): void {
  validateName(name);
  const lower = name.toLowerCase();
  const segments = lower.split("/");
  ensure(!segments.includes("reference.db"), "reference.db is forbidden");
  ensure(!segments.some((segment) => segment === "cache" || segment === "caches"), "cache entries are forbidden");
  ensure(
    !segments.some((segment) => /(?:credential|api[_-]?key|secret[_-]?header)/.test(segment)),
    "credential entries are forbidden",
  );
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new FmbkError(FMBK_ERROR.INVALID_FORMAT, `invalid ${label} JSON`);
  }
  let canonical: Uint8Array;
  try {
    canonical = utf8(canonicalJson(parsed));
  } catch {
    throw new FmbkError(FMBK_ERROR.INVALID_FORMAT, `invalid ${label} JSON value`);
  }
  ensure(equalBytes(canonical, bytes), `${label} is not canonical JSON`);
  return parsed;
}

function decodeCanonicalBase64(value: unknown, expectedLength: number, label: string): Uint8Array {
  ensure(typeof value === "string", `${label} must be base64`);
  let decoded: Uint8Array;
  try {
    decoded = fromBase64(value);
  } catch {
    throw new FmbkError(FMBK_ERROR.INVALID_FORMAT, `${label} must be canonical base64`);
  }
  ensure(decoded.length === expectedLength && toBase64(decoded) === value, `${label} must be ${expectedLength} bytes`);
  return decoded;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  ensure(Object.keys(value).sort().join(",") === [...expected].sort().join(","), `${label} fields are not exact`);
}

function validateManifest(value: unknown): FmbkManifest {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "manifest must be an object");
  const manifest = value as Record<string, unknown>;
  exactKeys(
    manifest,
    ["album_count", "app_schema_version", "backup_format_version", "dataset_id", "exported_at", "files"],
    "manifest",
  );
  ensure(Number.isSafeInteger(manifest.album_count) && (manifest.album_count as number) >= 0, "album count is invalid");
  ensure(Number.isSafeInteger(manifest.app_schema_version) && (manifest.app_schema_version as number) >= 1, "app schema version is invalid");
  ensure(
    manifest.backup_format_version === 1,
    "backup format version is unsupported",
    FMBK_ERROR.UNSUPPORTED_VERSION,
  );
  ensure(
    typeof manifest.dataset_id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(manifest.dataset_id),
    "dataset ID is invalid",
  );
  ensure(typeof manifest.exported_at === "string", "export timestamp is invalid");
  const timestamp = new Date(manifest.exported_at);
  ensure(!Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === manifest.exported_at, "export timestamp is not canonical UTC");
  ensure(Array.isArray(manifest.files), "manifest files must be an array");
  for (const descriptor of manifest.files) {
    ensure(descriptor !== null && typeof descriptor === "object" && !Array.isArray(descriptor), "manifest file must be an object");
    const file = descriptor as Record<string, unknown>;
    exactKeys(file, ["name", "sha256", "size"], "manifest file");
    ensure(typeof file.name === "string", "manifest file name is invalid");
    ensureAllowedBackupFileName(file.name);
    ensure(typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256), "manifest file SHA-256 is invalid");
    ensure(Number.isSafeInteger(file.size) && (file.size as number) >= 0, "manifest file size is invalid");
  }
  return value as FmbkManifest;
}

function validateEntrySemantics(
  entries: readonly FmbkEntry[],
  crypto: BackupCryptoPort,
  limits: ResolvedLimits,
): FmbkManifest {
  ensure(
    entries.length >= 2 && entries.length <= limits.maxEntries,
    "entry count is outside limits",
    FMBK_ERROR.RESOURCE_LIMIT,
  );
  ensure(entries[0].type === "manifest" && entries[0].name === "manifest.json", "manifest.json must be first");
  ensure(entries.filter((entry) => entry.type === "manifest").length === 1, "exactly one manifest is required");

  const names = new Set<string>();
  for (const entry of entries) {
    validateName(entry.name);
    ensure(!names.has(entry.name), "duplicate entry name");
    names.add(entry.name);
    ensure(entry.content.length <= limits.maxEntryBytes, "entry exceeds per-entry limit", FMBK_ERROR.RESOURCE_LIMIT);
  }

  const manifest = validateManifest(parseCanonicalJson(entries[0].content, "manifest"));
  const files = entries.slice(1);
  ensure(files.every((entry) => entry.type === "file"), "non-manifest entries must be files");
  ensure(manifest.files.length === files.length, "manifest file count mismatch");

  const filesByName = new Map(files.map((entry) => [entry.name, entry]));
  ensure(filesByName.size === files.length, "duplicate file entry name");
  const declaredNames = new Set<string>();
  let total = 0;
  for (const descriptor of manifest.files) {
    ensure(!declaredNames.has(descriptor.name), "duplicate manifest file name");
    declaredNames.add(descriptor.name);
    const entry = filesByName.get(descriptor.name);
    ensure(entry !== undefined, "manifest names a missing file");
    ensureAllowedBackupFileName(entry.name);
    ensure(entry.content.length === descriptor.size, "authenticated manifest file size mismatch");
    ensure(toHex(crypto.sha256(entry.content)) === descriptor.sha256, "authenticated manifest file SHA-256 mismatch");
    ensure(
      descriptor.size <= limits.maxEntryBytes,
      "manifest file exceeds per-entry limit",
      FMBK_ERROR.RESOURCE_LIMIT,
    );
    total += descriptor.size;
    ensure(
      Number.isSafeInteger(total) && total <= limits.maxTotalBytes,
      "authenticated manifest total exceeds aggregate limit",
      FMBK_ERROR.RESOURCE_LIMIT,
    );
  }
  return manifest;
}

function encodeEntry(entry: FmbkEntry, crypto: BackupCryptoPort): Uint8Array {
  const name = validateName(entry.name);
  const type = entry.type === "manifest" ? 0x01 : 0x02;
  return concatBytes(
    Uint8Array.of(type),
    u16(name.length),
    name,
    u64(entry.content.length),
    crypto.sha256(entry.content),
    entry.content,
  );
}

export function encodePlaintext(
  entries: readonly FmbkEntry[],
  crypto: BackupCryptoPort,
  limitOptions: FmbkResourceLimits = {},
): Uint8Array {
  const limits = resolveLimits(limitOptions);
  validateEntrySemantics(entries, crypto, limits);
  const plaintext = concatBytes(...entries.map((entry) => encodeEntry(entry, crypto)), Uint8Array.of(0xff));
  ensure(
    plaintext.length <= limits.maxPlaintextBytes,
    "plaintext exceeds aggregate framing limit",
    FMBK_ERROR.RESOURCE_LIMIT,
  );
  return plaintext;
}

function validateHeader(value: unknown, mode: "production" | "normative-vector"): FmbkHeader {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "header must be an object");
  const header = value as Record<string, unknown>;
  exactKeys(header, ["aead", "chunk_size", "kdf", "kdf_params", "nonce_prefix_b64", "salt_b64"], "header");
  ensure(header.aead === "aes-256-gcm" && header.kdf === "scrypt", "unknown algorithms");
  ensure(header.kdf_params !== null && typeof header.kdf_params === "object" && !Array.isArray(header.kdf_params), "KDF parameters must be an object");
  const params = header.kdf_params as Record<string, unknown>;
  exactKeys(params, ["N", "p", "r"], "KDF parameter");
  ensure(params.N === 32768 && params.r === 8 && params.p === 1, "weak or unknown KDF parameters");
  const chunkSize = header.chunk_size;
  ensure(typeof chunkSize === "number" && Number.isInteger(chunkSize), "invalid chunk size");
  if (mode === "normative-vector") {
    ensure(canonicalJson(header) === VECTOR_HEADER_JSON, "normative-vector header is not exact");
  } else {
    ensure(chunkSize >= 1024 * 1024 && chunkSize <= 8 * 1024 * 1024, "chunk size is outside contract limits");
  }
  decodeCanonicalBase64(header.salt_b64, 16, "salt");
  decodeCanonicalBase64(header.nonce_prefix_b64, 8, "nonce prefix");
  return value as FmbkHeader;
}

export function createProductionHeader(
  crypto: BackupCryptoPort,
  chunkSize = PRODUCTION_CHUNK_SIZE,
): FmbkHeader {
  let noncePrefix: Uint8Array | undefined;
  let salt: Uint8Array | undefined;
  try {
    noncePrefix = crypto.secureRandomBytes(8);
    salt = crypto.secureRandomBytes(16);
    const header: FmbkHeader = {
      aead: "aes-256-gcm",
      chunk_size: chunkSize,
      kdf: "scrypt",
      kdf_params: { N: 32768, p: 1, r: 8 },
      nonce_prefix_b64: toBase64(noncePrefix),
      salt_b64: toBase64(salt),
    };
    return validateHeader(header, "production");
  } finally {
    noncePrefix?.fill(0);
    salt?.fill(0);
  }
}

export async function writeFmbk(
  passphrase: string,
  header: FmbkHeader | undefined,
  entries: readonly FmbkEntry[],
  crypto: BackupCryptoPort,
  options: FmbkWriteOptions = {},
): Promise<Uint8Array> {
  const mode = options.mode ?? "production";
  const limits = resolveLimits(options);
  if (mode === "normative-vector") ensure(header !== undefined, "normative-vector header is required");
  else ensure(header === undefined, "caller-provided headers are forbidden in production mode");
  const plaintext = encodePlaintext(entries, crypto, limits);
  const resolvedHeader = mode === "normative-vector" ? validateHeader(header, mode) : createProductionHeader(crypto);
  const headerBytes = utf8(canonicalJson(resolvedHeader));
  ensure(headerBytes.length <= MAX_HEADER_BYTES, "header exceeds 64 KiB", FMBK_ERROR.RESOURCE_LIMIT);
  const headerHash = crypto.sha256(headerBytes);
  const salt = fromBase64(resolvedHeader.salt_b64);
  const noncePrefix = fromBase64(resolvedHeader.nonce_prefix_b64);
  const passphraseBytes = normalizedPassphraseBytes(passphrase);
  let key: Uint8Array | undefined;
  try {
    key = await crypto.deriveKey(passphraseBytes, salt, resolvedHeader.kdf_params);
    ensure(key.length === 32, "KDF returned an invalid key length");
    const records: Uint8Array[] = [];
    let index = 0;
    for (let offset = 0; offset < plaintext.length; offset += resolvedHeader.chunk_size) {
      ensure(index < TERMINATOR_INDEX, "chunk index exhausted", FMBK_ERROR.RESOURCE_LIMIT);
      const chunk = plaintext.slice(offset, offset + resolvedHeader.chunk_size);
      const encrypted = crypto.encrypt(
        key,
        chunkNonce(noncePrefix, index),
        chunk,
        chunkAad(headerHash, index, chunk.length),
      );
      ensure(encrypted.length === chunk.length + TAG_LENGTH, "AEAD returned an invalid payload length");
      records.push(Uint8Array.of(0x01), u32(index), u32(chunk.length), u32(encrypted.length), encrypted);
      index += 1;
    }
    const plaintextHash = crypto.sha256(plaintext);
    const terminatorTag = crypto.encrypt(
      key,
      chunkNonce(noncePrefix, TERMINATOR_INDEX),
      new Uint8Array(),
      terminatorAad(headerHash, index, plaintext.length, plaintextHash),
    );
    ensure(terminatorTag.length === TAG_LENGTH, "terminator must contain only an authentication tag");
    const archive = concatBytes(
      MAGIC,
      u16(VERSION),
      u32(headerBytes.length),
      headerBytes,
      ...records,
      Uint8Array.of(0xff),
      u32(index),
      u64(plaintext.length),
      plaintextHash,
      terminatorTag,
    );
    if (mode === "normative-vector") {
      ensure(toHex(crypto.sha256(archive)) === VECTOR_ARCHIVE_SHA256, "normative-vector archive is not exact");
    }
    return archive;
  } finally {
    key?.fill(0);
    passphraseBytes.fill(0);
  }
}

function fmbkAuthenticationFailure(message: string, cause: CryptoAuthenticationError): FmbkError {
  return new FmbkError(FMBK_ERROR.AUTHENTICATION_FAILED, message, { cause });
}

export function isFmbkAuthenticationFailure(error: unknown): error is FmbkError {
  return error instanceof FmbkError
    && error.code === FMBK_ERROR.AUTHENTICATION_FAILED
    && error.cause instanceof CryptoAuthenticationError;
}

class Cursor {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  take(length: number): Uint8Array {
    ensure(Number.isSafeInteger(length) && length >= 0 && this.offset + length <= this.bytes.length, "truncated archive");
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  byte(): number { return this.take(1)[0]; }
  uint16(): number { const part = this.take(2); return new DataView(part.buffer, part.byteOffset, 2).getUint16(0, false); }
  uint32(): number { const part = this.take(4); return new DataView(part.buffer, part.byteOffset, 4).getUint32(0, false); }
  uint64(): number {
    const part = this.take(8);
    const value = new DataView(part.buffer, part.byteOffset, 8).getBigUint64(0, false);
    ensure(value <= BigInt(Number.MAX_SAFE_INTEGER), "64-bit value exceeds safe range", FMBK_ERROR.RESOURCE_LIMIT);
    return Number(value);
  }
  done(): boolean { return this.offset === this.bytes.length; }
}

function parseEntries(
  plaintext: Uint8Array,
  crypto: BackupCryptoPort,
  limits: ResolvedLimits,
): { entries: FmbkEntry[]; manifest: FmbkManifest } {
  const cursor = new Cursor(plaintext);
  const entries: FmbkEntry[] = [];
  const names = new Set<string>();
  while (true) {
    const type = cursor.byte();
    if (type === 0xff) break;
    ensure(type === 0x01 || type === 0x02, "unknown plaintext entry type");
    ensure(entries.length < limits.maxEntries, "entry count exceeds limit", FMBK_ERROR.RESOURCE_LIMIT);
    const nameBytes = cursor.take(cursor.uint16());
    ensure(nameBytes.length <= MAX_NAME_BYTES, "entry name exceeds limit");
    let name: string;
    try {
      name = decodeUtf8(nameBytes);
    } catch {
      throw new FmbkError(FMBK_ERROR.INVALID_FORMAT, "entry name is not valid UTF-8");
    }
    validateName(name);
    ensure(!names.has(name), "duplicate entry name");
    names.add(name);
    const contentLength = cursor.uint64();
    ensure(contentLength <= limits.maxEntryBytes, "entry exceeds per-entry limit", FMBK_ERROR.RESOURCE_LIMIT);
    const expectedHash = cursor.take(32);
    const content = cursor.take(contentLength);
    ensure(equalBytes(crypto.sha256(content), expectedHash), "entry content hash mismatch");
    entries.push({ type: type === 0x01 ? "manifest" : "file", name, content });
  }
  ensure(cursor.done(), "bytes follow plaintext terminator");
  return { entries, manifest: validateEntrySemantics(entries, crypto, limits) };
}

type EncryptedRecord = Readonly<{
  index: number;
  plaintextLength: number;
  payload: Uint8Array;
}>;

type EnvelopePreflight = Readonly<{
  chunkCount: number;
  declaredHash: Uint8Array;
  declaredLength: number;
  header: FmbkHeader;
  headerHash: Uint8Array;
  noncePrefix: Uint8Array;
  records: readonly EncryptedRecord[];
  tag: Uint8Array;
}>;

function preflightEnvelope(
  archive: Uint8Array,
  crypto: BackupCryptoPort,
  mode: "production" | "normative-vector",
  limits: ResolvedLimits,
): EnvelopePreflight {
  const cursor = new Cursor(archive);
  ensure(equalBytes(cursor.take(4), MAGIC), "bad magic");
  ensure(cursor.uint16() === VERSION, "unsupported version", FMBK_ERROR.UNSUPPORTED_VERSION);
  const headerLength = cursor.uint32();
  ensure(headerLength <= MAX_HEADER_BYTES, "header exceeds 64 KiB", FMBK_ERROR.RESOURCE_LIMIT);
  const headerBytes = cursor.take(headerLength);
  const header = validateHeader(parseCanonicalJson(headerBytes, "header"), mode);
  const headerHash = crypto.sha256(headerBytes);
  const noncePrefix = fromBase64(header.nonce_prefix_b64);
  const records: EncryptedRecord[] = [];
  let expectedIndex = 0;
  let totalLength = 0;
  let previousPlaintextLength: number | undefined;
  while (true) {
    const recordType = cursor.byte();
    if (recordType === 0xff) break;
    ensure(recordType === 0x01, "unknown encrypted record type");
    const index = cursor.uint32();
    const plaintextLength = cursor.uint32();
    const payloadLength = cursor.uint32();
    ensure(index === expectedIndex, "chunk indexes are not contiguous");
    ensure(index < TERMINATOR_INDEX, "chunk index exhausted", FMBK_ERROR.RESOURCE_LIMIT);
    if (previousPlaintextLength !== undefined) {
      ensure(previousPlaintextLength === header.chunk_size, "non-final chunk is short");
    }
    ensure(plaintextLength > 0 && plaintextLength <= header.chunk_size, "chunk plaintext length is invalid");
    ensure(payloadLength === plaintextLength + TAG_LENGTH, "chunk payload length is invalid");
    totalLength += plaintextLength;
    ensure(
      Number.isSafeInteger(totalLength) && totalLength <= limits.maxPlaintextBytes,
      "archive exceeds aggregate framing limit",
      FMBK_ERROR.RESOURCE_LIMIT,
    );
    const payload = cursor.take(payloadLength);
    records.push({ index, plaintextLength, payload });
    expectedIndex += 1;
    previousPlaintextLength = plaintextLength;
  }
  const chunkCount = cursor.uint32();
  const declaredLength = cursor.uint64();
  const declaredHash = cursor.take(32);
  const tag = cursor.take(TAG_LENGTH);
  ensure(cursor.done(), "trailing unauthenticated bytes");
  ensure(records.length > 0 && totalLength > 0, "encrypted record stream is empty");
  ensure(chunkCount === expectedIndex && declaredLength === totalLength, "terminator counts do not match");
  ensure(
    chunkCount === Math.ceil(declaredLength / header.chunk_size),
    "chunk count contradicts plaintext length",
  );
  return { chunkCount, declaredHash, declaredLength, header, headerHash, noncePrefix, records, tag };
}

export async function readFmbk(
  archive: Uint8Array,
  passphrase: string,
  crypto: BackupCryptoPort,
  options: FmbkReadOptions,
): Promise<FmbkReadResult> {
  const mode = options.mode ?? "production";
  const limits = resolveLimits(options);
  ensure(
    Number.isSafeInteger(options.availableStorageBytes) && options.availableStorageBytes >= 0,
    "available storage is invalid",
    FMBK_ERROR.RESOURCE_LIMIT,
  );
  if (mode === "normative-vector") {
    ensure(toHex(crypto.sha256(archive)) === VECTOR_ARCHIVE_SHA256, "normative-vector archive is not exact");
  }
  const preflight = preflightEnvelope(archive, crypto, mode, limits);
  const passphraseBytes = normalizedPassphraseBytes(passphrase);
  let key: Uint8Array | undefined;
  try {
    key = await crypto.deriveKey(passphraseBytes, fromBase64(preflight.header.salt_b64), preflight.header.kdf_params);
    ensure(key.length === 32, "KDF returned an invalid key length");
    const chunks: Uint8Array[] = [];
    for (const record of preflight.records) {
      let plaintext: Uint8Array;
      try {
        plaintext = crypto.decrypt(
          key,
          chunkNonce(preflight.noncePrefix, record.index),
          record.payload,
          chunkAad(preflight.headerHash, record.index, record.plaintextLength),
        );
      } catch (error) {
        if (error instanceof CryptoAuthenticationError) {
          throw fmbkAuthenticationFailure("chunk authentication failed", error);
        }
        throw error;
      }
      ensure(plaintext.length === record.plaintextLength, "decrypted chunk length mismatch");
      chunks.push(plaintext);
    }
    const plaintext = concatBytes(...chunks);
    ensure(equalBytes(crypto.sha256(plaintext), preflight.declaredHash), "plaintext hash mismatch");
    try {
      const empty = crypto.decrypt(
        key,
        chunkNonce(preflight.noncePrefix, TERMINATOR_INDEX),
        preflight.tag,
        terminatorAad(
          preflight.headerHash,
          preflight.chunkCount,
          preflight.declaredLength,
          preflight.declaredHash,
        ),
      );
      ensure(empty.length === 0, "terminator decrypted non-empty content");
    } catch (error) {
      if (error instanceof CryptoAuthenticationError) {
        throw fmbkAuthenticationFailure("terminator authentication failed", error);
      }
      throw error;
    }
    const { entries, manifest } = parseEntries(plaintext, crypto, limits);
    const manifestTotal = manifest.files.reduce((total, file) => total + file.size, 0);
    ensure(
      manifestTotal <= options.availableStorageBytes,
      "available-storage preflight failed",
      FMBK_ERROR.RESOURCE_LIMIT,
    );
    return { header: preflight.header, manifest, plaintext, entries };
  } finally {
    key?.fill(0);
    passphraseBytes.fill(0);
  }
}

export function vectorHeader(): FmbkHeader {
  return JSON.parse(VECTOR_HEADER_JSON) as FmbkHeader;
}
