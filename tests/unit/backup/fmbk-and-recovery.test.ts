import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../../spikes/backup-crypto/canonicalJson.ts";
import { runAesGcmBenchmark } from "../../../spikes/backup-crypto/aesBenchmark.ts";
import { concatBytes, fromHex, toHex, u32, utf8 } from "../../../spikes/backup-crypto/bytes.ts";
import { CryptoAuthenticationError } from "../../../spikes/backup-crypto/cryptoPort.ts";
import type { BackupCryptoPort } from "../../../spikes/backup-crypto/cryptoPort.ts";
import {
  FMBK_ERROR,
  FmbkError,
  createProductionHeader,
  encodePlaintext,
  isFmbkAuthenticationFailure,
  readFmbk,
  vectorHeader,
  writeFmbk,
} from "../../../spikes/backup-crypto/fmbk.ts";
import type { FmbkEntry, FmbkHeader } from "../../../spikes/backup-crypto/fmbk.ts";
import {
  assertAes256GcmInputs,
  assertRequiredScryptParameters,
  assertSecureRandomLength,
  copyExactBytes,
  createSerializedSnapshotQueue,
  snapshotRequiredScryptParameters,
  splitCiphertextAndTag,
} from "../../../spikes/backup-crypto/nativeCryptoPortValidation.ts";
import {
  VECTOR_ARCHIVE_LENGTH,
  VECTOR_ARCHIVE_SHA256,
  VECTOR_DERIVED_KEY_HEX,
  VECTOR_PASSPHRASE,
  VECTOR_PLAINTEXT_LENGTH,
  VECTOR_PLAINTEXT_SHA256,
  vectorEntries,
  vectorManifest,
} from "../../../spikes/backup-crypto/vector.ts";
import { nodeCryptoPort } from "../../support/nodeCryptoPort.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../../fixtures/backups/fmbk-v1-vector.fmbk");
const fixtureJsonPath = resolve(here, "../../fixtures/backups/fmbk-v1-vector.json");
const vectorReadOptions = { availableStorageBytes: 3, mode: "normative-vector" as const };

async function makeVector(crypto: BackupCryptoPort): Promise<Uint8Array> {
  return writeFmbk(VECTOR_PASSPHRASE, vectorHeader(), vectorEntries(), crypto, { mode: "normative-vector" });
}

function manifestEntries(files: readonly Readonly<{ name: string; content: Uint8Array }>[]): readonly FmbkEntry[] {
  const manifest = {
    album_count: 0,
    app_schema_version: 1,
    backup_format_version: 1,
    dataset_id: "00000000-0000-4000-8000-000000000016",
    exported_at: "2026-07-12T00:00:00.000Z",
    files: files.map((file) => ({
      name: file.name,
      sha256: toHex(nodeCryptoPort.sha256(file.content)),
      size: file.content.length,
    })),
  };
  return [
    { type: "manifest", name: "manifest.json", content: utf8(canonicalJson(manifest)) },
    ...files.map((file) => ({ type: "file" as const, name: file.name, content: file.content })),
  ];
}

async function makeProduction(
  entries: readonly FmbkEntry[] = vectorEntries(),
  crypto: BackupCryptoPort = nodeCryptoPort,
): Promise<{ archive: Uint8Array; header: FmbkHeader }> {
  const archive = await writeFmbk(VECTOR_PASSPHRASE, undefined, entries, crypto);
  const headerLength = new DataView(archive.buffer, archive.byteOffset + 6, 4).getUint32(0, false);
  const header = JSON.parse(new TextDecoder().decode(archive.slice(10, 10 + headerLength))) as FmbkHeader;
  return { archive, header };
}

function replaceHeader(archive: Uint8Array, headerText: string): Uint8Array {
  const oldLength = new DataView(archive.buffer, archive.byteOffset + 6, 4).getUint32(0, false);
  return concatBytes(archive.slice(0, 6), u32(utf8(headerText).length), utf8(headerText), archive.slice(10 + oldLength));
}

function firstRecordOffset(archive: Uint8Array): number {
  return 10 + new DataView(archive.buffer, archive.byteOffset + 6, 4).getUint32(0, false);
}

function terminatorOffset(archive: Uint8Array): number {
  const recordOffset = firstRecordOffset(archive);
  const payloadLength = new DataView(archive.buffer, archive.byteOffset + recordOffset + 9, 4).getUint32(0, false);
  return recordOffset + 13 + payloadLength;
}

test("G016 FMBK crypto UT-BACKUP-002: Node reproduces the exact frozen vector and fixture", async () => {
  const passphraseBytes = utf8(VECTOR_PASSPHRASE.normalize("NFC"));
  const key = await nodeCryptoPort.deriveKey(
    passphraseBytes,
    fromHex("000102030405060708090a0b0c0d0e0f"),
    vectorHeader().kdf_params,
  );
  assert.equal(toHex(key), VECTOR_DERIVED_KEY_HEX);
  key.fill(0);
  passphraseBytes.fill(0);

  const plaintext = encodePlaintext(vectorEntries(), nodeCryptoPort);
  assert.equal(plaintext.length, VECTOR_PLAINTEXT_LENGTH);
  assert.equal(toHex(nodeCryptoPort.sha256(plaintext)), VECTOR_PLAINTEXT_SHA256);

  const [nodeArchive, fixture, fixtureJson] = await Promise.all([
    makeVector(nodeCryptoPort),
    readFile(fixturePath),
    readFile(fixtureJsonPath, "utf8"),
  ]);
  assert.equal(nodeArchive.length, VECTOR_ARCHIVE_LENGTH);
  assert.equal(toHex(nodeCryptoPort.sha256(nodeArchive)), VECTOR_ARCHIVE_SHA256);
  assert.deepEqual(nodeArchive, new Uint8Array(fixture));
  assert.equal(JSON.parse(fixtureJson).archive_sha256, VECTOR_ARCHIVE_SHA256);

  const restored = await readFmbk(nodeArchive, VECTOR_PASSPHRASE, nodeCryptoPort, vectorReadOptions);
  assert.equal(new TextDecoder().decode(restored.entries[1].content), "abc");
});

test("G016 FMBK crypto UT-BACKUP-002: production headers use fresh validated entropy and archives round-trip", async () => {
  const randomRequests: number[] = [];
  const observingRandomPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    secureRandomBytes(length) {
      randomRequests.push(length);
      return nodeCryptoPort.secureRandomBytes(length);
    },
  };
  const first = await writeFmbk(VECTOR_PASSPHRASE, undefined, vectorEntries(), observingRandomPort);
  const second = await writeFmbk(VECTOR_PASSPHRASE, undefined, vectorEntries(), observingRandomPort);
  assert.deepEqual(randomRequests, [8, 16, 8, 16]);
  assert.notDeepEqual(first, second);
  const firstRead = await readFmbk(first, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 });
  const secondRead = await readFmbk(second, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 });
  assert.notEqual(firstRead.header.salt_b64, secondRead.header.salt_b64);
  assert.notEqual(firstRead.header.nonce_prefix_b64, secondRead.header.nonce_prefix_b64);

  const reusableHeader = createProductionHeader(nodeCryptoPort);
  await assert.rejects(
    writeFmbk(VECTOR_PASSPHRASE, reusableHeader, vectorEntries(), nodeCryptoPort),
    /caller-provided headers are forbidden/,
  );

  const wrongLengthPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    secureRandomBytes: (length) => length === 8 ? new Uint8Array(7) : nodeCryptoPort.secureRandomBytes(length),
  };
  assert.throws(() => createProductionHeader(wrongLengthPort), /nonce prefix must be 8 bytes/);
});

test("G016 native adapter pure guards enforce fixed parameters, exact offsets, and tag framing", () => {
  assert.doesNotThrow(() => assertRequiredScryptParameters({ N: 32768, r: 8, p: 1 }));
  for (const parameters of [
    { N: 16384, r: 8, p: 1 },
    { N: 32768, r: 4, p: 1 },
    { N: 32768, r: 8, p: 2 },
  ]) assert.throws(() => assertRequiredScryptParameters(parameters), /requires N=32768/);
  const mutableParameters = { N: 32768, r: 8, p: 1 };
  const parameterSnapshot = snapshotRequiredScryptParameters(mutableParameters);
  mutableParameters.N = 2;
  mutableParameters.r = 1;
  mutableParameters.p = 99;
  assert.deepEqual(parameterSnapshot, { N: 32768, r: 8, p: 1 });
  assert.ok(Object.isFrozen(parameterSnapshot));
  assert.doesNotThrow(() => assertAes256GcmInputs(new Uint8Array(32), new Uint8Array(12)));
  assert.throws(() => assertAes256GcmInputs(new Uint8Array(31), new Uint8Array(12)), /32-byte key/);
  assert.throws(() => assertAes256GcmInputs(new Uint8Array(32), new Uint8Array(11)), /12-byte nonce/);
  assert.throws(() => assertSecureRandomLength(0), /positive safe integer/);

  const backing = Uint8Array.of(0xee, 1, 2, 3, 4, 5, 6, 7, 8, 0xff);
  const sliced = backing.subarray(1, 9);
  const copied = copyExactBytes(sliced);
  assert.deepEqual(copied, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  backing.fill(0);
  assert.deepEqual(copied, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));

  assert.throws(() => splitCiphertextAndTag(new Uint8Array(15)), /shorter than its authentication tag/);
  const framedBacking = Uint8Array.from({ length: 24 }, (_, index) => index);
  const { ciphertext, tag } = splitCiphertextAndTag(framedBacking.subarray(2, 22));
  assert.deepEqual(ciphertext, Uint8Array.of(2, 3, 4, 5));
  assert.deepEqual(tag, Uint8Array.from({ length: 16 }, (_, index) => index + 6));
});

test("G016 native scrypt queue snapshots exact views synchronously, serializes starts, and wipes every path", async () => {
  const enqueue = createSerializedSnapshotQueue();
  const firstBacking = Uint8Array.of(0xee, 1, 2, 3, 0xff);
  const secondBacking = Uint8Array.of(0xee, 4, 5, 6, 0xff);
  const starts: number[] = [];
  const snapshots: Uint8Array[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = enqueue([firstBacking.subarray(1, 4)], async ([snapshot]) => {
    starts.push(1);
    snapshots.push(snapshot);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await firstGate;
    const observed = Array.from(snapshot);
    active -= 1;
    return observed;
  });
  const second = enqueue([secondBacking.subarray(1, 4)], async ([snapshot]) => {
    starts.push(2);
    snapshots.push(snapshot);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const observed = Array.from(snapshot);
    active -= 1;
    return observed;
  });

  firstBacking.fill(0xa1);
  secondBacking.fill(0xb2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [1]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(starts, [1, 2]);
  assert.equal(maximumActive, 1);
  assert.ok(snapshots.every((snapshot) => snapshot.every((byte) => byte === 0)));

  let rejectedSnapshot: Uint8Array | undefined;
  await assert.rejects(
    enqueue([Uint8Array.of(7, 8, 9)], async ([snapshot]) => {
      rejectedSnapshot = snapshot;
      throw new Error("expected queue failure");
    }),
    /expected queue failure/,
  );
  assert.ok(rejectedSnapshot?.every((byte) => byte === 0));

  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    assert.throws(() => copyExactBytes(shared), /must not be backed by SharedArrayBuffer/);
    assert.throws(() => enqueue([shared], async () => undefined), /must not be backed by SharedArrayBuffer/);
  }
});

test("G016 FMBK crypto UT-BACKUP-002/003: wrong passphrases and manifest, file, and terminator tampering fail closed", async () => {
  const archive = await makeVector(nodeCryptoPort);
  await assert.rejects(
    readFmbk(archive, "wrong-passphrase", nodeCryptoPort, vectorReadOptions),
    /authentication failed/,
  );

  for (const [region, offset] of [
    ["manifest", 190],
    ["file", archive.length - 70],
    ["terminator", archive.length - 1],
  ] as const) {
    const tampered = archive.slice();
    tampered[offset] ^= 1;
    await assert.rejects(
      readFmbk(tampered, VECTOR_PASSPHRASE, nodeCryptoPort, vectorReadOptions),
      /normative-vector archive is not exact/,
      region,
    );
  }
});

test("G016 FMBK maps only typed authentication failures and retains causes", async () => {
  const { archive } = await makeProduction();
  const typedCause = new Error("native tag rejected");
  const typed = new CryptoAuthenticationError("AES-256-GCM authentication failed", { cause: typedCause });
  const authenticatingPort: BackupCryptoPort = { ...nodeCryptoPort, decrypt() { throw typed; } };
  await assert.rejects(
    readFmbk(archive, VECTOR_PASSPHRASE, authenticatingPort, { availableStorageBytes: 3 }),
    (error: unknown) => error instanceof FmbkError
      && error.code === FMBK_ERROR.AUTHENTICATION_FAILED
      && error.message === "FMBK rejected: chunk authentication failed"
      && error.cause === typed
      && typed.cause === typedCause
      && isFmbkAuthenticationFailure(error)
      && !error.message.includes("native tag rejected"),
  );

  const bridgeFailure = new Error("native bridge contract violated");
  const failingPort: BackupCryptoPort = { ...nodeCryptoPort, decrypt() { throw bridgeFailure; } };
  await assert.rejects(
    readFmbk(archive, VECTOR_PASSPHRASE, failingPort, { availableStorageBytes: 3 }),
    (error: unknown) => error === bridgeFailure && !isFmbkAuthenticationFailure(error),
  );

  const kdfFailure = new Error("native scrypt bridge failed");
  const failingKdfPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    deriveKey() { return Promise.reject(kdfFailure); },
  };
  await assert.rejects(
    readFmbk(archive, VECTOR_PASSPHRASE, failingKdfPort, { availableStorageBytes: 3 }),
    (error: unknown) => error === kdfFailure && !isFmbkAuthenticationFailure(error),
  );
});

test("G016 FMBK writer rejects invalid entries and plaintext resource overflow before KDF", async () => {
  let deriveCalls = 0;
  const observingPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    deriveKey(passphraseUtf8, salt, parameters) {
      deriveCalls += 1;
      return nodeCryptoPort.deriveKey(passphraseUtf8, salt, parameters);
    },
  };
  await assert.rejects(
    writeFmbk(VECTOR_PASSPHRASE, undefined, [
      { type: "manifest", name: "manifest.json", content: utf8("{") },
      { type: "file", name: "user.db", content: utf8("abc") },
    ], observingPort),
    (error: unknown) => error instanceof FmbkError && error.code === FMBK_ERROR.INVALID_FORMAT,
  );
  await assert.rejects(
    writeFmbk(VECTOR_PASSPHRASE, undefined, [
      {
        type: "manifest",
        name: "manifest.json",
        content: utf8(canonicalJson({ ...vectorManifest, backup_format_version: 2 })),
      },
      { type: "file", name: "user.db", content: utf8("abc") },
    ], observingPort),
    (error: unknown) => error instanceof FmbkError && error.code === FMBK_ERROR.UNSUPPORTED_VERSION,
  );
  await assert.rejects(
    writeFmbk(VECTOR_PASSPHRASE, undefined, vectorEntries(), observingPort, { maxPlaintextBytes: 10 }),
    (error: unknown) => error instanceof FmbkError && error.code === FMBK_ERROR.RESOURCE_LIMIT,
  );
  for (const entries of [
    [
      { type: "manifest" as const, name: "manifest.json", content: utf8(canonicalJson(vectorManifest)) },
      { type: "file" as const, name: "bad\ud800.db", content: utf8("abc") },
    ],
    [
      {
        type: "manifest" as const,
        name: "manifest.json",
        content: utf8(JSON.stringify({
          ...vectorManifest,
          files: [{ ...vectorManifest.files[0], name: "bad\ud800.db" }],
        })),
      },
      { type: "file" as const, name: "user.db", content: utf8("abc") },
    ],
  ]) {
    await assert.rejects(
      writeFmbk(VECTOR_PASSPHRASE, undefined, entries, observingPort),
      /unpaired UTF-16 surrogate|invalid manifest JSON value/,
    );
  }
  assert.equal(deriveCalls, 0);
});

test("G016 FMBK accepts paired Unicode in canonical JSON and round-trips Unicode names", async () => {
  assert.equal(canonicalJson({ "鹿😀": "相册🦌" }), '{"鹿😀":"相册🦌"}');
  assert.throws(() => canonicalJson({ value: "bad\ud800" }), /unpaired UTF-16 surrogate/);
  assert.throws(() => canonicalJson({ ["bad\udc00"]: true }), /unpaired UTF-16 surrogate/);

  const entries = manifestEntries([{ name: "相册/鹿😀.db", content: utf8("合法🦌") }]);
  const { archive } = await makeProduction(entries);
  const restored = await readFmbk(archive, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 32 });
  assert.equal(restored.entries[1].name, "相册/鹿😀.db");
  assert.equal(new TextDecoder().decode(restored.entries[1].content), "合法🦌");
});

test("G016 FMBK crypto: normative-vector mode cannot authorize any other 64-byte archive", async () => {
  await assert.rejects(
    writeFmbk("different", vectorHeader(), vectorEntries(), nodeCryptoPort, { mode: "normative-vector" }),
    /normative-vector archive is not exact/,
  );
  await assert.rejects(
    writeFmbk(VECTOR_PASSPHRASE, vectorHeader(), vectorEntries(), nodeCryptoPort),
    /caller-provided headers are forbidden/,
  );
  const archive = await makeVector(nodeCryptoPort);
  await assert.rejects(
    readFmbk(archive, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }),
    /chunk size is outside contract limits/,
  );
});

test("G016 FMBK crypto: malformed, noncanonical, unknown-algorithm, and weak-KDF headers fail before decryption", async () => {
  const { archive, header } = await makeProduction();
  const cases = [
    ["malformed", "{"],
    ["noncanonical", ` ${canonicalJson(header)}`],
    ["unknown algorithm", canonicalJson({ ...header, aead: "aes-128-gcm" })],
    ["weak KDF", canonicalJson({ ...header, kdf_params: { N: 16384, p: 1, r: 8 } })],
    ["noncanonical salt base64", canonicalJson({ ...header, salt_b64: "AAECAwQFBgcICQoLDA0ODx==" })],
    ["unknown field", canonicalJson({ ...header, unexpected: true })],
  ] as const;
  for (const [name, headerText] of cases) {
    await assert.rejects(
      readFmbk(replaceHeader(archive, headerText), VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }),
      /FMBK rejected/,
      name,
    );
  }

  const oversized = archive.slice();
  new DataView(oversized.buffer, oversized.byteOffset).setUint32(6, 65_537, false);
  await assert.rejects(
    readFmbk(oversized, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }),
    /header exceeds/,
  );
});

test("G016 FMBK crypto: chunk gaps, payload length mismatches, truncation, authenticated tamper, and trailing bytes fail closed", async () => {
  const { archive } = await makeProduction();
  const recordOffset = firstRecordOffset(archive);

  const gap = archive.slice();
  new DataView(gap.buffer, gap.byteOffset).setUint32(recordOffset + 1, 1, false);
  await assert.rejects(readFmbk(gap, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }), /not contiguous/);

  const payloadMismatch = archive.slice();
  new DataView(payloadMismatch.buffer, payloadMismatch.byteOffset).setUint32(recordOffset + 9, 1, false);
  await assert.rejects(readFmbk(payloadMismatch, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }), /payload length/);

  const authenticatedTamper = archive.slice();
  authenticatedTamper[recordOffset + 13] ^= 1;
  await assert.rejects(readFmbk(authenticatedTamper, VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }), /authentication failed/);

  for (const length of [0, 9, archive.length - 1]) {
    await assert.rejects(readFmbk(archive.slice(0, length), VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }), /truncated/);
  }
  await assert.rejects(
    readFmbk(concatBytes(archive, Uint8Array.of(0)), VECTOR_PASSPHRASE, nodeCryptoPort, { availableStorageBytes: 3 }),
    /trailing unauthenticated bytes/,
  );
});

test("G016 FMBK reader rejects V1 framing and resource failures before KDF or decryption", async () => {
  const { archive, header } = await makeProduction();
  const recordOffset = firstRecordOffset(archive);
  const endOffset = terminatorOffset(archive);
  const cases: Array<Readonly<{
    name: string;
    archive: Uint8Array;
    options?: Readonly<{ maxPlaintextBytes: number }>;
    code?: string;
  }>> = [];

  const badMagic = archive.slice();
  badMagic[0] ^= 1;
  cases.push({ name: "bad magic", archive: badMagic });

  const unsupportedVersion = archive.slice();
  new DataView(unsupportedVersion.buffer, unsupportedVersion.byteOffset).setUint16(4, 2, false);
  cases.push({
    name: "unsupported V2 envelope",
    archive: unsupportedVersion,
    code: FMBK_ERROR.UNSUPPORTED_VERSION,
  });

  cases.push({
    name: "unsupported algorithm",
    archive: replaceHeader(archive, canonicalJson({ ...header, aead: "aes-128-gcm" })),
  });
  cases.push({
    name: "malformed salt base64",
    archive: replaceHeader(archive, canonicalJson({ ...header, salt_b64: "not-base64" })),
  });

  const gap = archive.slice();
  new DataView(gap.buffer, gap.byteOffset).setUint32(recordOffset + 1, 1, false);
  cases.push({ name: "gapped records", archive: gap });

  const impossiblePayload = archive.slice();
  new DataView(impossiblePayload.buffer, impossiblePayload.byteOffset).setUint32(recordOffset + 9, 1, false);
  cases.push({ name: "impossible payload length", archive: impossiblePayload });

  const wrongChunkCount = archive.slice();
  new DataView(wrongChunkCount.buffer, wrongChunkCount.byteOffset).setUint32(endOffset + 1, 2, false);
  cases.push({ name: "terminator chunk-count contradiction", archive: wrongChunkCount });

  const wrongPlaintextLength = archive.slice();
  new DataView(wrongPlaintextLength.buffer, wrongPlaintextLength.byteOffset).setBigUint64(endOffset + 5, 1n, false);
  cases.push({ name: "terminator length contradiction", archive: wrongPlaintextLength });
  cases.push({ name: "truncated terminator", archive: archive.slice(0, -1) });
  cases.push({ name: "trailing bytes", archive: concatBytes(archive, Uint8Array.of(0)) });
  cases.push({
    name: "maxPlaintext resource overflow",
    archive,
    options: { maxPlaintextBytes: 10 },
    code: FMBK_ERROR.RESOURCE_LIMIT,
  });

  for (const entry of cases) {
    let deriveCalls = 0;
    let decryptCalls = 0;
    const observingPort: BackupCryptoPort = {
      ...nodeCryptoPort,
      deriveKey(passphraseUtf8, salt, parameters) {
        deriveCalls += 1;
        return nodeCryptoPort.deriveKey(passphraseUtf8, salt, parameters);
      },
      decrypt(key, nonce, ciphertextAndTag, associatedData) {
        decryptCalls += 1;
        return nodeCryptoPort.decrypt(key, nonce, ciphertextAndTag, associatedData);
      },
    };
    await assert.rejects(
      readFmbk(entry.archive, VECTOR_PASSPHRASE, observingPort, {
        availableStorageBytes: 3,
        ...entry.options,
      }),
      (error: unknown) => error instanceof FmbkError
        && (entry.code === undefined || error.code === entry.code),
      entry.name,
    );
    assert.equal(deriveCalls, 0, `${entry.name} derived a key`);
    assert.equal(decryptCalls, 0, `${entry.name} decrypted a payload`);
  }
});

test("G016 FMBK crypto: malformed and noncanonical manifests plus authenticated name, size, and SHA mismatches fail closed", () => {
  const file = { type: "file" as const, name: "user.db", content: utf8("abc") };
  assert.throws(
    () => encodePlaintext([{ type: "manifest", name: "manifest.json", content: utf8("{") }, file], nodeCryptoPort),
    /invalid manifest JSON/,
  );
  assert.throws(
    () => encodePlaintext([{ type: "manifest", name: "manifest.json", content: utf8(` ${canonicalJson(vectorManifest)}`) }, file], nodeCryptoPort),
    /not canonical JSON/,
  );
  assert.throws(
    () => encodePlaintext([
      { type: "manifest", name: "manifest.json", content: utf8(canonicalJson({ ...vectorManifest, files: [{ ...vectorManifest.files[0], size: 4 }] })) },
      file,
    ], nodeCryptoPort),
    /file size mismatch/,
  );
  assert.throws(
    () => encodePlaintext([
      { type: "manifest", name: "manifest.json", content: utf8(canonicalJson({ ...vectorManifest, files: [{ ...vectorManifest.files[0], sha256: "0".repeat(64) }] })) },
      file,
    ], nodeCryptoPort),
    /SHA-256 mismatch/,
  );
  assert.throws(
    () => encodePlaintext([
      { type: "manifest", name: "manifest.json", content: utf8(canonicalJson({ ...vectorManifest, files: [{ ...vectorManifest.files[0], name: "missing.db" }] })) },
      file,
    ], nodeCryptoPort),
    /missing file/,
  );
});

test("G016 FMBK crypto: canonical dataset IDs accept the frozen vector and reject malformed forms", () => {
  assert.doesNotThrow(() => encodePlaintext(vectorEntries(), nodeCryptoPort));
  for (const datasetId of [
    "00000000-0000-0000-0000-00000000001",
    "00000000-0000-0000-0000-0000000000010",
    "000000000000-0000-0000-000000000001",
    "00000000-0000-0000-0000-00000000000g",
    "00000000-0000-0000-0000-00000000000A",
  ]) {
    const manifest = { ...vectorManifest, dataset_id: datasetId };
    assert.throws(
      () => encodePlaintext([
        { type: "manifest", name: "manifest.json", content: utf8(canonicalJson(manifest)) },
        { type: "file", name: "user.db", content: utf8("abc") },
      ], nodeCryptoPort),
      /dataset ID is invalid/,
      datasetId,
    );
  }
});

test("G016 FMBK crypto: duplicate and non-normalized entry names fail closed across every required path class", () => {
  const invalidNames = [
    "/user.db",
    "C:/user.db",
    "../user.db",
    "album/./user.db",
    "album//user.db",
    "album/user.db/",
    "album\\user.db",
    "album/\0user.db",
    `${"é".repeat(513)}.db`,
    "cafe\u0301.db",
  ];
  for (const name of invalidNames) {
    assert.throws(() => encodePlaintext(manifestEntries([{ name, content: utf8("abc") }]), nodeCryptoPort), /FMBK rejected/, name);
  }
  assert.throws(
    () => encodePlaintext([
      ...vectorEntries(),
      { type: "file", name: "user.db", content: utf8("abc") },
    ], nodeCryptoPort),
    /duplicate entry name/,
  );
});

test("G016 FMBK crypto UT-BACKUP-001: forbidden backup resources fail closed", () => {
  for (const name of [
    "reference.db",
    "data/reference.db",
    "cache/thumb.jpg",
    "album/caches/thumb.jpg",
    "credentials.json",
    "settings/api_key.txt",
    "settings/secret-header.json",
  ]) {
    assert.throws(() => encodePlaintext(manifestEntries([{ name, content: utf8("secret") }]), nodeCryptoPort), /forbidden/, name);
  }
});

test("G016 FMBK crypto UT-BACKUP-009: entry-count, per-entry, aggregate, framing, and available-storage limits fail closed", async () => {
  const entries = manifestEntries([
    { name: "user.db", content: utf8("abc") },
    { name: "album/photo.jpg", content: utf8("xyz") },
  ]);
  const { archive } = await makeProduction(entries);
  await assert.rejects(readFmbk(archive, VECTOR_PASSPHRASE, nodeCryptoPort, {
    availableStorageBytes: 6,
    maxEntries: 2,
  }), /entry count exceeds/);
  await assert.rejects(readFmbk(archive, VECTOR_PASSPHRASE, nodeCryptoPort, {
    availableStorageBytes: 6,
    maxEntryBytes: 200,
  }), /per-entry limit/);
  await assert.rejects(readFmbk(archive, VECTOR_PASSPHRASE, nodeCryptoPort, {
    availableStorageBytes: 6,
    maxTotalBytes: 5,
  }), /aggregate limit/);
  await assert.rejects(readFmbk(archive, VECTOR_PASSPHRASE, nodeCryptoPort, {
    availableStorageBytes: 6,
    maxPlaintextBytes: 10,
  }), /framing limit/);
  await assert.rejects(readFmbk(archive, VECTOR_PASSPHRASE, nodeCryptoPort, {
    availableStorageBytes: 5,
  }), /available-storage preflight/);
});

test("G016 FMBK crypto UT-BACKUP-009: the format layer NFC-normalizes passphrases before the crypto port", async () => {
  const composed = `caf\u00e9-${VECTOR_PASSPHRASE}`;
  const decomposed = `cafe\u0301-${VECTOR_PASSPHRASE}`;
  const observedPassphrases: Uint8Array[] = [];
  const observingPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    deriveKey(passphraseUtf8, salt, parameters) {
      observedPassphrases.push(passphraseUtf8.slice());
      return nodeCryptoPort.deriveKey(passphraseUtf8, salt, parameters);
    },
  };
  const archive = await writeFmbk(composed, undefined, vectorEntries(), observingPort);
  const restored = await readFmbk(archive, decomposed, observingPort, { availableStorageBytes: 3 });
  assert.equal(restored.entries[1].name, "user.db");
  const expected = utf8(composed.normalize("NFC"));
  assert.equal(observedPassphrases.length, 2);
  assert.ok(observedPassphrases.every((value) => toHex(value) === toHex(expected)));
});

test("G016 FMBK crypto: derived encryption and decryption keys are wiped in finally blocks", async () => {
  const derivedKeys: Uint8Array[] = [];
  const observingPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    async deriveKey(passphraseUtf8, salt, parameters) {
      const key = await nodeCryptoPort.deriveKey(passphraseUtf8, salt, parameters);
      derivedKeys.push(key);
      return key;
    },
  };
  const { archive } = await makeProduction(vectorEntries(), observingPort);
  assert.ok(derivedKeys.at(-1)?.every((byte) => byte === 0));
  await readFmbk(archive, VECTOR_PASSPHRASE, observingPort, { availableStorageBytes: 3 });
  assert.ok(derivedKeys.at(-1)?.every((byte) => byte === 0));
});

test("G016 FMBK crypto: AES benchmark uses one unique nonce per encryption and wipes sensitive buffers", async () => {
  const encryptInputs: Array<{ key: Uint8Array; nonce: Uint8Array; plaintext: Uint8Array }> = [];
  const decryptedBuffers: Uint8Array[] = [];
  const randomOutputs: Uint8Array[] = [];
  let nonceCalls = 0;
  const observingPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    secureRandomBytes(length) {
      const value = length === 32
        ? Uint8Array.from({ length }, (_, index) => index + 1)
        : new Uint8Array(length).fill(nonceCalls++ < 2 ? 7 : nonceCalls + 7);
      randomOutputs.push(value);
      return value;
    },
    encrypt(key, nonce, plaintext, associatedData) {
      encryptInputs.push({ key, nonce: nonce.slice(), plaintext });
      return nodeCryptoPort.encrypt(key, nonce, plaintext, associatedData);
    },
    decrypt(key, nonce, ciphertextAndTag, associatedData) {
      const decrypted = nodeCryptoPort.decrypt(key, nonce, ciphertextAndTag, associatedData);
      decryptedBuffers.push(decrypted);
      return decrypted;
    },
  };

  const result = await runAesGcmBenchmark(observingPort, {
    measuredRuns: 2,
    plaintextBytes: 32,
    delay: async () => {},
    now: (() => { let tick = 0; return () => ++tick; })(),
  });

  assert.equal(encryptInputs.length, 3);
  assert.equal(decryptedBuffers.length, 3);
  assert.equal(nonceCalls, 4);
  assert.equal(new Set(encryptInputs.map(({ nonce }) => toHex(nonce))).size, encryptInputs.length);
  assert.equal(result.ciphertextAndTagBytes, 48);
  assert.ok(encryptInputs.every(({ key }) => key.every((byte) => byte === 0)));
  assert.ok(encryptInputs.every(({ plaintext }) => plaintext.every((byte) => byte === 0)));
  assert.ok(decryptedBuffers.every((buffer) => buffer.every((byte) => byte === 0)));
  assert.ok(randomOutputs.every((buffer) => buffer.every((byte) => byte === 0)));

  const corruptingPort: BackupCryptoPort = {
    ...nodeCryptoPort,
    decrypt(key, nonce, ciphertextAndTag, associatedData) {
      const decrypted = nodeCryptoPort.decrypt(key, nonce, ciphertextAndTag, associatedData);
      decrypted[decrypted.length - 1] = 0;
      return decrypted;
    },
  };
  await assert.rejects(
    runAesGcmBenchmark(corruptingPort, {
      measuredRuns: 1,
      plaintextBytes: 32,
      delay: async () => {},
      now: (() => { let tick = 0; return () => ++tick; })(),
    }),
    /round-trip failed/,
  );
});
