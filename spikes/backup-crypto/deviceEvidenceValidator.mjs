#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const G016_PROOF_PREFIX = "G016_CRYPTO_PROOF ";
export const G016_DEVICE_EVIDENCE_PREFIX = "G016_DEVICE_EVIDENCE ";

const PROOF_OBSERVED_PREFIX = "G016_PROOF_OBSERVED_AT ";
const COMMAND_BEGIN_PREFIX = "G016_NATIVE_COMMAND_BEGIN ";
const COMMAND_END_PREFIX = "G016_NATIVE_COMMAND_END ";
const ADVERSE_PREFIX = "G016_ADVERSE_LOG ";
const APP_ID = "com.fawnmobile.g016backupcrypto";
const FMBK_SHA256 = "231f64bf4045b430ca0de6c18b215f9a4414293683021528c411ae85d0010231";
const EXECUTING_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_TOOL_BUFFER = 512 * 1024 * 1024;
const MAX_PROOF_OBSERVATION_LAG_MS = 60_000;
const TRUST_BOUNDARY = "local-consistency-and-tamper-detection-not-hardware-attestation";
const PINNED_FILE_IDENTITY = Symbol("g016-pinned-file-identity");
const RUNTIME_SNAPSHOT_PATHS = {
  android: { baseApk: "runtime/installed-base.apk" },
  ios: {
    executable: "runtime/installed-G016FMBKCryptoProof",
    bundle: "runtime/installed-main.jsbundle",
  },
};

export const G016_SOURCE_PATHS = [
  "spikes/backup-crypto/.gitignore",
  "spikes/backup-crypto/App.tsx",
  "spikes/backup-crypto/README.md",
  "spikes/backup-crypto/THIRD_PARTY_NOTICES.md",
  "spikes/backup-crypto/aesBenchmark.ts",
  "spikes/backup-crypto/app.json",
  "spikes/backup-crypto/bytes.ts",
  "spikes/backup-crypto/canonicalJson.ts",
  "spikes/backup-crypto/compactProof.ts",
  "spikes/backup-crypto/cryptoPort.ts",
  "spikes/backup-crypto/deviceEvidenceValidator.mjs",
  "spikes/backup-crypto/fmbk.ts",
  "spikes/backup-crypto/index.ts",
  "spikes/backup-crypto/licenseCheck.mjs",
  "spikes/backup-crypto/metro.config.cjs",
  "spikes/backup-crypto/mobileProof.ts",
  "spikes/backup-crypto/nativeCryptoPort.ts",
  "spikes/backup-crypto/nativeCryptoPortValidation.ts",
  "spikes/backup-crypto/nativeCryptoSelfTests.ts",
  "spikes/backup-crypto/package-lock.json",
  "spikes/backup-crypto/package.json",
  "spikes/backup-crypto/third-party-licenses/blake3-Apache-2.0-LLVM-exception.txt",
  "spikes/backup-crypto/third-party-licenses/blake3-Apache-2.0.txt",
  "spikes/backup-crypto/third-party-licenses/blake3-CC0-1.0.txt",
  "spikes/backup-crypto/third-party-licenses/craftzdog-react-native-buffer-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/events-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/expo-build-properties-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/expo-crypto-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/fastpbkdf2-CC0-notice.txt",
  "spikes/backup-crypto/third-party-licenses/ncrypto-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/openssl-ACKNOWLEDGEMENTS.md",
  "spikes/backup-crypto/third-party-licenses/openssl-Apache-2.0.txt",
  "spikes/backup-crypto/third-party-licenses/quick-crypto-base64-notice.txt",
  "spikes/backup-crypto/third-party-licenses/react-native-nitro-modules-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/react-native-quick-base64-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/react-native-quick-crypto-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/readable-stream-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/safe-buffer-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/simdutf-Apache-2.0.txt",
  "spikes/backup-crypto/third-party-licenses/simdutf-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/string_decoder-MIT.txt",
  "spikes/backup-crypto/third-party-licenses/util-MIT.txt",
  "spikes/backup-crypto/tsconfig.json",
  "spikes/backup-crypto/vector.ts",
  "tests/fixtures/backups/fmbk-v1-vector.fmbk",
  "tests/fixtures/backups/fmbk-v1-vector.json",
  "tests/support/nodeCryptoPort.ts",
  "tests/unit/backup/fmbk-and-recovery.test.ts",
  "tests/unit/backup/g016-proof-and-validator.test.ts",
];

const EXPECTED_PACKAGES = {
  "react-native-quick-crypto": "1.1.6",
  "react-native-nitro-modules": "0.36.1",
  "react-native-quick-base64": "3.0.1",
};

const PLATFORM_CONTRACT = {
  android: {
    architecture: "arm64-v8a",
    targets: new Set(["emulator", "physical"]),
    artifactExtension: ".apk",
    bundleMember: "assets/index.android.bundle",
    memoryKind: "android-pss-mib",
    peakDeltaMiB: 96,
    peakMiB: 256,
    resolutionBasename: "gradle-release-runtime.txt",
  },
  ios: {
    architecture: "arm64",
    targets: new Set(["simulator", "physical"]),
    artifactExtension: ".zip",
    memoryKind: "ios-physical-footprint-mib",
    peakDeltaMiB: 128,
    peakMiB: Number.POSITIVE_INFINITY,
    resolutionBasename: "Podfile.lock",
  },
};

const BUDGETS = {
  scryptP95Ms: 2_000,
  scryptMaxMs: 3_000,
  aesEncryptP95Ms: 200,
  aesDecryptP95Ms: 200,
  heartbeatMaxGapMs: 250,
  retainedGrowthMiB: 16,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sha256Text(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function push(failures, condition, message) {
  if (!condition) failures.push(message);
}

function exactKeys(value, expected, label, failures) {
  if (!isObject(value)) return;
  push(
    failures,
    Object.keys(value).sort().join(",") === [...expected].sort().join(","),
    `${label} fields are not exact`,
  );
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== value ? null : timestamp.valueOf();
}

function safeRelativePath(value, prefix) {
  return typeof value === "string"
    && !isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
    && (value === prefix || value.startsWith(`${prefix}/`));
}

function isInsideOrEqual(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function independentFileIdentity(left, right) {
  const leftIdentity = left?.[PINNED_FILE_IDENTITY];
  const rightIdentity = right?.[PINNED_FILE_IDENTITY];
  return leftIdentity !== undefined && rightIdentity !== undefined && !sameIdentity(leftIdentity, rightIdentity);
}

function requireNoFollowFlag(value = fsConstants.O_NOFOLLOW) {
  if (!Number.isInteger(value) || value === 0) throw new Error("O_NOFOLLOW is unavailable; descriptor validation fails closed");
  return value;
}

async function canonicalDirectory(path, label, failures) {
  let handle = null;
  try {
    const metadata = await lstat(path, { bigint: true });
    push(failures, metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} must be a non-symlink directory`);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    const canonical = await realpath(path);
    push(failures, resolve(path) === path, `${label} must not use a lexical path alias`);
    if (resolve(path) !== path) return null;
    const noFollow = requireNoFollowFlag();
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollow);
    const opened = await handle.stat({ bigint: true });
    push(failures, opened.isDirectory() && sameIdentity(metadata, opened), `${label} identity changed while its descriptor was pinned`);
    if (!opened.isDirectory() || !sameIdentity(metadata, opened)) {
      await handle.close();
      return null;
    }
    return { path: canonical, handle, metadata: opened };
  } catch {
    if (handle) await handle.close().catch(() => {});
    failures.push(`${label} is missing or unreadable`);
    return null;
  }
}

async function snapshotFile(root, relativePath, declaredHash, label, failures, requiredPrefix, testOptions = {}) {
  push(failures, safeRelativePath(relativePath, requiredPrefix), `${label} path is invalid or forged`);
  push(failures, sha256Text(declaredHash), `${label} SHA-256 is invalid`);
  if (!safeRelativePath(relativePath, requiredPrefix) || !sha256Text(declaredHash)) return null;

  const ownedRoot = typeof root === "string" ? await canonicalDirectory(resolve(root), `${label} root`, failures) : null;
  const anchor = ownedRoot ?? root;
  if (!anchor?.path || !anchor?.handle) return null;
  const canonicalRoot = anchor.path;
  const absolutePath = resolve(canonicalRoot, relativePath);
  if (!isInsideOrEqual(canonicalRoot, absolutePath)) {
    failures.push(`${label} escapes its anchored root`);
    return null;
  }

  const directorySnapshots = [{ path: canonicalRoot, metadata: anchor.metadata, handle: anchor.handle }];
  let current = canonicalRoot;
  try {
    const parts = relativePath.split("/");
    const noFollow = requireNoFollowFlag(testOptions.noFollowFlag);
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = join(current, parts[index]);
      const metadata = await lstat(current, { bigint: true });
      push(failures, !metadata.isSymbolicLink(), `${label} has a symlink path component`);
      push(failures, metadata.isDirectory(), `${label} path component has the wrong type`);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
      const handle = await open(current, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollow);
      const opened = await handle.stat({ bigint: true });
      push(failures, opened.isDirectory() && sameIdentity(metadata, opened), `${label} ancestor identity changed before it was pinned`);
      if (!opened.isDirectory() || !sameIdentity(metadata, opened)) {
        await handle.close();
        return null;
      }
      directorySnapshots.push({ path: current, metadata: opened, handle });
    }

    const leafSnapshot = await lstat(absolutePath, { bigint: true });
    push(failures, leafSnapshot.isFile() && !leafSnapshot.isSymbolicLink(), `${label} leaf must be a non-symlink file`);
    if (!leafSnapshot.isFile() || leafSnapshot.isSymbolicLink()) return null;
    if (testOptions.beforeLeafOpen) await testOptions.beforeLeafOpen(absolutePath);
    const handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);
    let bytes;
    let before;
    let after;
    try {
      before = await handle.stat({ bigint: true });
      push(failures, before.isFile() && sameIdentity(leafSnapshot, before), `${label} opened leaf is detached from its pinned ancestor chain`);
      if (testOptions.afterOpen) await testOptions.afterOpen(absolutePath);
      bytes = await handle.readFile();
      after = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }

    push(failures, before.isFile() && after.isFile() && sameIdentity(before, after), `${label} changed while being read`);
    push(failures, before.size === after.size && after.size === BigInt(bytes.length), `${label} size changed while being read`);
    const finalLeaf = await lstat(absolutePath, { bigint: true });
    push(failures, !finalLeaf.isSymbolicLink() && sameIdentity(after, finalLeaf), `${label} was replaced during validation`);
    for (const snapshot of directorySnapshots) {
      const descriptorMetadata = await snapshot.handle.stat({ bigint: true });
      push(failures, descriptorMetadata.isDirectory() && sameIdentity(snapshot.metadata, descriptorMetadata), `${label} pinned ancestor descriptor changed during validation`);
      const finalMetadata = await lstat(snapshot.path, { bigint: true });
      push(failures, !finalMetadata.isSymbolicLink() && sameIdentity(snapshot.metadata, finalMetadata), `${label} ancestor changed during validation`);
    }
    const canonicalFile = await realpath(absolutePath);
    push(failures, canonicalFile === absolutePath, `${label} resolves through a symlink or replacement`);
    if (!sameIdentity(leafSnapshot, before) || !sameIdentity(before, after) || !sameIdentity(after, finalLeaf) || canonicalFile !== absolutePath) return null;

    const actualHash = hash(bytes);
    push(failures, actualHash === declaredHash, `${label} SHA-256 does not match the descriptor snapshot`);
    const snapshot = { path: absolutePath, bytes, sha256: actualHash };
    Object.defineProperty(snapshot, PINNED_FILE_IDENTITY, {
      value: { dev: after.dev, ino: after.ino },
    });
    return snapshot;
  } catch (error) {
    failures.push(`${label} file is missing, unsafe, or unreadable${error instanceof Error ? `: ${error.message}` : ""}`);
    return null;
  } finally {
    for (const snapshot of directorySnapshots.slice(1).reverse()) await snapshot.handle.close().catch(() => {});
    if (ownedRoot) await ownedRoot.handle.close().catch(() => {});
  }
}

export async function snapshotG016FileForTest(root, relativePath, declaredHash, options = {}) {
  const failures = [];
  const snapshot = await snapshotFile(root, relativePath, declaredHash, "test snapshot", failures, relativePath.split("/")[0], options);
  return { snapshot, failures };
}

async function validateCandidate(candidate, evidenceRoot, failures) {
  push(failures, isObject(candidate), "candidate evidence is missing");
  if (!isObject(candidate)) return null;
  exactKeys(candidate, ["rootPath", "sourceManifestPath", "sourceManifestSha256"], "candidate", failures);
  push(failures, typeof candidate.rootPath === "string" && isAbsolute(candidate.rootPath), "candidate rootPath must be absolute");
  if (typeof candidate.rootPath !== "string" || !isAbsolute(candidate.rootPath)) return null;

  const candidateRoot = await canonicalDirectory(candidate.rootPath, "candidate rootPath", failures);
  const executingRoot = await canonicalDirectory(EXECUTING_REPO_ROOT, "executing repository root", failures);
  if (!candidateRoot || !executingRoot) {
    if (candidateRoot) await candidateRoot.handle.close();
    if (executingRoot) await executingRoot.handle.close();
    return null;
  }
  const matchesExecutingRoot = candidateRoot.path === executingRoot.path && sameIdentity(candidateRoot.metadata, executingRoot.metadata);
  push(failures, matchesExecutingRoot, "candidate rootPath is not the repository executing this validator");
  await executingRoot.handle.close();
  if (!matchesExecutingRoot) {
    await candidateRoot.handle.close();
    return null;
  }

  const manifest = await snapshotFile(
    evidenceRoot,
    candidate.sourceManifestPath,
    candidate.sourceManifestSha256,
    "source manifest",
    failures,
    "integrity",
  );
  if (!manifest) {
    await candidateRoot.handle.close();
    return null;
  }
  const manifestText = manifest.bytes.toString("utf8");
  const lines = manifestText.split("\n");
  if (lines.at(-1) === "") lines.pop();
  push(failures, lines.length === G016_SOURCE_PATHS.length, `source manifest must contain exactly ${G016_SOURCE_PATHS.length} paths`);
  const parsed = lines.map((line) => /^([0-9a-f]{64})  (.+)$/.exec(line));
  push(failures, parsed.every(Boolean), "source manifest contains a malformed line");
  if (!parsed.every(Boolean) || parsed.length !== G016_SOURCE_PATHS.length) {
    await candidateRoot.handle.close();
    return null;
  }
  const paths = parsed.map((match) => match[2]);
  push(failures, paths.every((path, index) => path === G016_SOURCE_PATHS[index]), "source manifest paths differ from the exact G016 allowlist");
  if (!paths.every((path, index) => path === G016_SOURCE_PATHS[index])) {
    await candidateRoot.handle.close();
    return null;
  }

  const currentLines = [];
  let lockBytes = null;
  for (let index = 0; index < parsed.length; index += 1) {
    const source = await snapshotFile(
      candidateRoot,
      paths[index],
      parsed[index][1],
      `source path ${paths[index]}`,
      failures,
      paths[index].split("/")[0],
    );
    if (!source) continue;
    currentLines.push(`${source.sha256}  ${paths[index]}\n`);
    if (paths[index] === "spikes/backup-crypto/package-lock.json") lockBytes = source.bytes;
  }
  if (currentLines.length !== G016_SOURCE_PATHS.length) {
    await candidateRoot.handle.close();
    return null;
  }
  const canonicalManifest = currentLines.join("");
  push(failures, canonicalManifest === manifestText, "source manifest is not the canonical current-file manifest");

  try {
    const lock = JSON.parse(lockBytes.toString("utf8"));
    for (const [name, version] of Object.entries(EXPECTED_PACKAGES)) {
      push(failures, lock.packages?.[`node_modules/${name}`]?.version === version, `candidate lock does not bind ${name}@${version}`);
    }
  } catch {
    failures.push("candidate package-lock.json is missing or malformed");
  }
  return { root: candidateRoot, fingerprint: hash(Buffer.from(canonicalManifest)) };
}

function parseJsonLine(line, prefix, label, failures) {
  if (!line.startsWith(prefix)) {
    failures.push(`${label} prefix is invalid`);
    return null;
  }
  try {
    const value = JSON.parse(line.slice(prefix.length));
    push(failures, isObject(value), `${label} JSON must be an object`);
    return isObject(value) ? value : null;
  } catch {
    failures.push(`${label} JSON is malformed`);
    return null;
  }
}

function parseSingleProofRecord(record, failures) {
  push(failures, typeof record === "string", "proof record is missing");
  if (typeof record !== "string") return null;
  push(failures, record.startsWith(G016_PROOF_PREFIX), "proof record prefix is invalid");
  push(failures, record.indexOf(G016_PROOF_PREFIX, G016_PROOF_PREFIX.length) === -1, "proof record contains more than one prefix");
  push(failures, !record.includes("\n") && !record.includes("\r"), "proof record must be one line");
  push(failures, Buffer.byteLength(record, "utf8") < 900, "proof record is not below 900 UTF-8 bytes");
  return parseJsonLine(record, G016_PROOF_PREFIX, "proof record", failures);
}

function validateProof(proof, platform, sourceFingerprint, resolutionSha256, failures) {
  if (!proof) return;
  exactKeys(proof, ["v", "st", "f", "p", "rel", "h", "na", "be", "vec", "self", "runs", "sc", "ag", "hb", "i"], "proof", failures);
  push(failures, proof.v === 2, "proof schema version must be 2");
  push(failures, proof.st === "IN_PROCESS_PASS", "proof status must be IN_PROCESS_PASS");
  push(failures, Array.isArray(proof.f) && proof.f.length === 0, "proof failures must be empty");
  push(failures, proof.p === platform, "proof platform does not match its evidence set");
  push(failures, proof.rel === true, "proof must be Release (__DEV__ false)");
  push(failures, proof.h === true, "proof must report Hermes");
  push(failures, proof.na === true, "proof must report the New Architecture runtime");

  const integrity = proof.i;
  push(failures, isObject(integrity), "proof integrity block is missing");
  if (isObject(integrity)) {
    exactKeys(integrity, ["s", "r"], "proof integrity", failures);
    push(failures, integrity.s === sourceFingerprint, "proof source digest is stale or mismatched");
    push(failures, integrity.r === resolutionSha256, "proof resolution digest is stale or mismatched");
  }

  const backend = proof.be;
  push(failures, isObject(backend), "proof backend block is missing");
  if (isObject(backend)) {
    exactKeys(backend, ["a", "n", "ri", "i", "r", "cg", "bg", "nt", "tr"], "proof backend", failures);
    push(failures, backend.a === "B1", "adapter identity mismatch");
    push(failures, backend.n === "Q1", "backend identity mismatch");
    push(failures, backend.ri === true, "package-root imports were not proven");
    push(failures, backend.i === false, "install() must remain unused");
    push(failures, backend.r === "E57", "injected RNG identity mismatch");
    push(failures, backend.cg === true, "global.crypto identity changed");
    push(failures, backend.bg === true, "global.Buffer identity changed");
    push(failures, backend.nt === true, "process.nextTick transition is invalid");
    push(failures, backend.tr === "I" || backend.tr === "P", "process.nextTick transition code is invalid");
  }

  const vector = proof.vec;
  push(failures, isObject(vector), "proof vector block is missing");
  if (isObject(vector)) {
    exactKeys(vector, ["r", "n", "a", "f", "b", "h"], "proof vector", failures);
    push(failures, vector.r === "R1", "RFC scrypt vector identifier mismatch");
    push(failures, vector.n === "S1", "Node scrypt vector identifier mismatch");
    push(failures, vector.a === "A1", "AES vector identifier mismatch");
    push(failures, vector.f === "F1" && vector.b === 790 && vector.h === FMBK_SHA256, "FMBK vector mismatch");
  }

  const self = proof.self;
  push(failures, isObject(self), "native self-test block is missing");
  if (isObject(self)) {
    exactKeys(self, ["ok", "n", "r", "d", "a", "s", "x", "t", "q", "f"], "proof self-test", failures);
    push(failures, self.ok === true && self.n === 8, "all eight native self-tests must pass");
    for (const field of ["r", "d", "a", "s", "x", "t", "q", "f"]) push(failures, self[field] === true, `native self-test ${field} failed`);
  }
  push(failures, isObject(proof.runs) && proof.runs.w === 1 && proof.runs.s === 10 && proof.runs.a === 10, "run counts must be one warm-up and ten measured scrypt/AES runs");

  const scrypt = proof.sc;
  push(failures, isObject(scrypt), "scrypt timing block is missing");
  if (isObject(scrypt)) {
    push(failures, finiteNonnegative(scrypt.p95), "scrypt p95 must be finite and nonnegative");
    push(failures, finiteNonnegative(scrypt.max), "scrypt max must be finite and nonnegative");
    if (finiteNonnegative(scrypt.p95) && finiteNonnegative(scrypt.max)) {
      push(failures, scrypt.p95 <= scrypt.max, "scrypt p95 exceeds scrypt max");
      push(failures, scrypt.p95 <= BUDGETS.scryptP95Ms, "scrypt p95 exceeds 2,000 ms");
      push(failures, scrypt.max <= BUDGETS.scryptMaxMs, "scrypt max exceeds 3,000 ms");
    }
  }

  const aes = proof.ag;
  push(failures, isObject(aes), "AES timing/framing block is missing");
  if (isObject(aes)) {
    push(failures, finiteNonnegative(aes.ep95), "AES encrypt p95 must be finite and nonnegative");
    push(failures, finiteNonnegative(aes.dp95), "AES decrypt p95 must be finite and nonnegative");
    if (finiteNonnegative(aes.ep95)) push(failures, aes.ep95 <= BUDGETS.aesEncryptP95Ms, "AES encrypt p95 exceeds 200 ms");
    if (finiteNonnegative(aes.dp95)) push(failures, aes.dp95 <= BUDGETS.aesDecryptP95Ms, "AES decrypt p95 exceeds 200 ms");
    push(failures, aes.p === 4 * 1024 * 1024 && aes.c === (4 * 1024 * 1024) + 16 && aes.t === 16, "AES framing is not exact");
  }

  const heartbeat = proof.hb;
  push(failures, isObject(heartbeat), "heartbeat block is missing");
  if (isObject(heartbeat)) {
    push(failures, finiteNonnegative(heartbeat.max), "heartbeat max must be finite and nonnegative");
    push(failures, heartbeat.lim === BUDGETS.heartbeatMaxGapMs, "heartbeat threshold must remain 250 ms");
    if (finiteNonnegative(heartbeat.max)) push(failures, heartbeat.max <= BUDGETS.heartbeatMaxGapMs, "heartbeat exceeds 250 ms");
  }
}

function validateMemorySamples(samples, platform, failures) {
  const contract = PLATFORM_CONTRACT[platform];
  push(failures, samples.length >= 5, `${platform} memory requires at least five timestamped samples`);
  if (samples.length < 5) return null;
  const parsed = [];
  for (const sample of samples) {
    exactKeys(sample, ["pid", "timestamp", "valueMiB", "phase"], `${platform} memory sample`, failures);
    const timestamp = canonicalTimestamp(sample.timestamp);
    push(failures, Number.isSafeInteger(sample.pid) && sample.pid > 0, `${platform} memory sample PID is invalid`);
    push(failures, timestamp !== null, `${platform} memory sample timestamp is invalid`);
    push(failures, finiteNonnegative(sample.valueMiB), `${platform} memory sample value must be finite and nonnegative`);
    push(failures, ["baseline", "run", "post-first-run"].includes(sample.phase), `${platform} memory sample phase is invalid`);
    if (timestamp !== null && finiteNonnegative(sample.valueMiB)) parsed.push({ ...sample, timestampMs: timestamp });
  }
  if (parsed.length !== samples.length) return null;
  push(failures, parsed.every((sample, index) => index === 0 || sample.timestampMs > parsed[index - 1].timestampMs), `${platform} memory timestamps must be strictly increasing`);
  push(failures, parsed[0].phase === "baseline" && parsed.filter((sample) => sample.phase === "baseline").length === 1, `${platform} memory requires exactly one leading baseline sample`);
  push(failures, parsed.some((sample) => sample.phase === "run"), `${platform} memory requires a run sample`);
  const post = parsed.filter((sample) => sample.phase === "post-first-run");
  push(failures, post.length >= 3 && parsed.slice(-post.length).every((sample) => sample.phase === "post-first-run"), `${platform} memory requires at least three trailing post-first-run samples`);
  if (post.length < 3) return null;

  const baselineMiB = parsed[0].valueMiB;
  const peakMiB = Math.max(...parsed.map((sample) => sample.valueMiB));
  const finalMiB = parsed.at(-1).valueMiB;
  const peakDeltaMiB = peakMiB - baselineMiB;
  const retainedGrowthMiB = finalMiB - baselineMiB;
  push(failures, peakDeltaMiB <= contract.peakDeltaMiB, `${platform} memory peak delta exceeds ${contract.peakDeltaMiB} MiB`);
  push(failures, peakMiB <= contract.peakMiB, `${platform} memory peak exceeds ${contract.peakMiB} MiB`);
  push(failures, retainedGrowthMiB <= BUDGETS.retainedGrowthMiB, `${platform} retained memory growth exceeds 16 MiB`);

  let monotonicStart = post[0].valueMiB;
  let monotonicViolation = false;
  for (let index = 1; index < post.length; index += 1) {
    if (post[index].valueMiB < post[index - 1].valueMiB) monotonicStart = post[index].valueMiB;
    else if (post[index].valueMiB - monotonicStart > BUDGETS.retainedGrowthMiB) monotonicViolation = true;
  }
  push(failures, !monotonicViolation, `${platform} post-first-run monotonic growth exceeds 16 MiB`);
  return { parsed, summary: { baselineMiB, peakMiB, finalMiB, peakDeltaMiB, retainedGrowthMiB } };
}

function validateAndroidResolution(text, failures) {
  const normalized = text.replace(/\u001b\[[0-9;]*m/g, "");
  push(failures, Buffer.byteLength(text) >= 50_000 && Buffer.byteLength(text) <= 4 * 1024 * 1024, "android resolution is a minimal, truncated, or unbounded Gradle report");
  push(failures, !/^G016_NPM_PACKAGE /m.test(normalized), "android resolution contains prohibited synthetic npm footers");
  const expectedHeaders = [
    "dependencies releaseRuntimeClasspath",
    "dependencyInsight react-native-quick-crypto",
    "dependencyInsight react-native-nitro-modules",
    "dependencyInsight react-native-quick-base64",
    "dependencyInsight io.github.ronickg:openssl",
  ];
  const matches = [...normalized.matchAll(/^===== ([^\r\n=]+) =====$/gm)];
  const headers = matches.map((match) => match[1]);
  push(failures, headers.length === expectedHeaders.length && headers.every((header, index) => header === expectedHeaders[index]), "android resolution command sections are missing, duplicated, or out of order");
  if (headers.length !== expectedHeaders.length || !headers.every((header, index) => header === expectedHeaders[index])) return;
  const sections = Object.fromEntries(matches.map((match, index) => [match[1], normalized.slice(match.index + match[0].length + 1, matches[index + 1]?.index ?? normalized.length)]));
  for (const [header, body] of Object.entries(sections)) {
    push(failures, Buffer.byteLength(body) >= 500 && Buffer.byteLength(body) <= 2 * 1024 * 1024, `android resolution section ${header} is truncated or unbounded`);
    push(failures, (body.match(/^BUILD SUCCESSFUL in /gm) ?? []).length === 1, `android resolution section ${header} lacks exactly one successful Gradle footer`);
  }

  const dependencies = sections[expectedHeaders[0]];
  push(failures, (dependencies.match(/^> Task :app:dependencies$/gm) ?? []).length === 1, "android resolution is not one Gradle :app:dependencies command transcript");
  push(failures, (dependencies.match(/^releaseRuntimeClasspath - Runtime classpath of '\/release'\.$/gm) ?? []).length === 1, "android resolution omits the exact releaseRuntimeClasspath output");
  push(failures, /^\+--- project :react-native-nitro-modules$/m.test(dependencies), "android resolution omits the selected NitroModules runtime edge");
  push(failures, /^\+--- project :react-native-quick-crypto$/m.test(dependencies), "android resolution omits the selected QuickCrypto runtime edge");
  push(failures, /^\|    \+--- project :react-native-nitro-modules \(\*\)$/m.test(dependencies), "android resolution omits QuickCrypto to NitroModules");
  push(failures, /^\|    \\--- io\.github\.ronickg:openssl:3\.6\.2-1$/m.test(dependencies), "android resolution omits QuickCrypto to exact OpenSSL 3.6.2-1");

  for (const name of ["react-native-quick-crypto", "react-native-nitro-modules"]) {
    const body = sections[`dependencyInsight ${name}`];
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    push(failures, (body.match(/^> Task :app:dependencyInsight$/gm) ?? []).length === 1, `android resolution ${name} insight is not one dependencyInsight command transcript`);
    push(failures, new RegExp(`^project :${escaped}$`, "m").test(body), `android resolution does not select project :${name}`);
    push(failures, /^  Variant releaseRuntimeElements:$/m.test(body), `android resolution ${name} insight omits releaseRuntimeElements`);
    push(failures, new RegExp(`^project :${escaped}[\\s\\S]*releaseRuntimeClasspath$`, "m").test(body), `android resolution ${name} insight is detached from releaseRuntimeClasspath`);
  }
  const base64 = sections["dependencyInsight react-native-quick-base64"];
  push(failures, (base64.match(/^> Task :app:dependencyInsight$/gm) ?? []).length === 1, "android QuickBase64 insight is not one dependencyInsight command transcript");
  push(failures, (base64.match(/^No dependencies matching given input were found in configuration ':app:releaseRuntimeClasspath'$/gm) ?? []).length === 1, "android QuickBase64 insight must record its exact absence from the Java runtime graph");
  const openssl = sections["dependencyInsight io.github.ronickg:openssl"];
  push(failures, (openssl.match(/^> Task :app:dependencyInsight$/gm) ?? []).length === 1, "android OpenSSL insight is not one dependencyInsight command transcript");
  push(failures, (openssl.match(/^io\.github\.ronickg:openssl:3\.6\.2-1$/gm) ?? []).length >= 2, "android resolution does not select exact OpenSSL 3.6.2-1");
  push(failures, /^  Variant exportedAars:$/m.test(openssl), "android OpenSSL insight omits the selected exportedAars variant");
  push(failures, /^\\--- project :react-native-quick-crypto\n     \\--- releaseRuntimeClasspath$/m.test(openssl), "android resolution does not prove OpenSSL is QuickCrypto-transitive");
}

function podSections(text, failures) {
  const required = ["PODS", "DEPENDENCIES", "SPEC REPOS", "EXTERNAL SOURCES", "SPEC CHECKSUMS", "PODFILE CHECKSUM", "COCOAPODS"];
  const headers = [...text.matchAll(/^([A-Z][A-Z ]+):(?: .*)?$/gm)].map((match) => ({ name: match[1], index: match.index, bodyStart: match.index + match[0].length + 1 }));
  const counts = new Map();
  for (const header of headers) counts.set(header.name, (counts.get(header.name) ?? 0) + 1);
  push(failures, [...counts.values()].every((count) => count === 1), "ios Podfile.lock contains duplicate top-level sections");
  const sections = {};
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!(header.name in sections)) sections[header.name] = text.slice(header.bodyStart, headers[index + 1]?.index ?? text.length);
  }
  for (const name of required) push(failures, typeof sections[name] === "string", `ios Podfile.lock omits ${name}:`);
  return sections;
}

function topLevelPodVersions(section, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...section.matchAll(new RegExp(`^  - ${escaped} \\(([^)]+)\\)(?::|$)`, "gm"))].map((match) => match[1]);
}

export function validateG016ResolutionForTest(text, platform) {
  const failures = [];
  validateResolution(text, platform, failures);
  return failures;
}

function validateIosResolution(text, failures) {
  push(failures, Buffer.byteLength(text) >= 50_000 && Buffer.byteLength(text) <= 2 * 1024 * 1024, "ios Podfile.lock is minimal, truncated, or unbounded");
  const sections = podSections(text, failures);
  const expected = {
    QuickCrypto: ["1.1.6", "45cde9545e593271dc32418ecbe91b7ec920702f"],
    NitroModules: ["0.36.1", "b4174dd303728e16ad1afb79f64c1a5c69a3b373"],
    "react-native-quick-base64": ["3.0.1", "5c829c9016276132ac03c4d598c8d256b964e6ac"],
    "OpenSSL-Universal": ["3.6.2000", "ecee7b138fa75a74ecf00d7ffd248fb584739b9e"],
  };
  for (const [name, [version, checksum]] of Object.entries(expected)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versions = topLevelPodVersions(sections.PODS ?? "", name);
    push(failures, versions.length === 1 && versions[0] === version, `ios resolution does not bind exactly ${name}@${version}`);
    push(failures, (sections["SPEC CHECKSUMS"]?.match(new RegExp(`^  ${escaped}: ${checksum}$`, "gm")) ?? []).length === 1, `ios Podfile.lock checksum does not exactly bind ${name}`);
  }
  for (const name of ["QuickCrypto", "NitroModules", "react-native-quick-base64"]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    push(failures, new RegExp(`^  - ${escaped}(?: \\([^)]*\\))?(?: \\(from .+\\))?$`, "m").test(sections.DEPENDENCIES ?? ""), `ios Podfile.lock dependency declaration omits ${name}`);
    const packageName = name === "QuickCrypto" ? "react-native-quick-crypto" : name === "NitroModules" ? "react-native-nitro-modules" : name;
    push(failures, new RegExp(`^  ${escaped}:\\n    :path: "?\\.\\./node_modules/${packageName}"?$`, "m").test(sections["EXTERNAL SOURCES"] ?? ""), `ios Podfile.lock external source path does not exactly bind ${name}`);
  }
  push(failures, !/^  - OpenSSL-Universal(?:\s|$)/m.test(sections.DEPENDENCIES ?? ""), "ios OpenSSL must be QuickCrypto-transitive, not a top-level Pod dependency");
  const quickCryptoStart = (sections.PODS ?? "").search(/^  - QuickCrypto \(1\.1\.6\):$/m);
  const quickCryptoTail = quickCryptoStart >= 0 ? sections.PODS.slice(quickCryptoStart) : "";
  const nextPod = quickCryptoTail.slice(1).search(/^  - /m);
  const quickCryptoBlock = nextPod >= 0 ? quickCryptoTail.slice(0, nextPod + 1) : quickCryptoTail;
  push(failures, /^    - NitroModules(?: \([^)]*\))?$/m.test(quickCryptoBlock), "ios QuickCrypto pod does not depend on NitroModules");
  push(failures, /^    - OpenSSL-Universal \(~> 3\.6\.2000\)$/m.test(quickCryptoBlock), "ios QuickCrypto pod does not transitively bind OpenSSL-Universal");
  push(failures, /^    - OpenSSL-Universal$/m.test(sections["SPEC REPOS"] ?? ""), "ios Podfile.lock spec repo omits OpenSSL-Universal");
  push(failures, /^PODFILE CHECKSUM: a79be2349ed5c10606852f1ed74be7bfda291977$/m.test(text), "ios Podfile.lock does not bind the exact Podfile checksum");
  push(failures, /^COCOAPODS: 1\.16\.2$/m.test(text), "ios Podfile.lock does not bind CocoaPods 1.16.2");
}

function validateResolution(text, platform, failures) {
  if (platform === "android") validateAndroidResolution(text, failures);
  else validateIosResolution(text, failures);
}

function runTool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.binary ? null : "utf8",
    input: options.input,
    maxBuffer: MAX_TOOL_BUFFER,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout ?? (options.binary ? Buffer.alloc(0) : ""),
    stderr: result.stderr ?? (options.binary ? Buffer.alloc(0) : ""),
  };
}

async function latestNdkTool(name) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
  try {
    const versions = (await readdir(join(sdk, "ndk"))).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    return versions.length > 0 ? join(sdk, "ndk", versions[0], "toolchains/llvm/prebuilt/darwin-x86_64/bin", name) : null;
  } catch {
    return null;
  }
}

async function latestAndroidTool(relativeTool) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
  if (relativeTool.startsWith("cmdline-tools/")) return join(sdk, relativeTool);
  try {
    const versions = (await readdir(join(sdk, "build-tools"))).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    return versions.length > 0 ? join(sdk, "build-tools", versions[0], relativeTool) : null;
  } catch {
    return null;
  }
}

async function withCapturedArtifact(bytes, suffix, callback) {
  const directory = await mkdtemp(join(tmpdir(), "g016-validator-"));
  const path = join(directory, `artifact${suffix}`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function safeZipMembers(text, label, failures) {
  const members = text.split(/\r?\n/).filter(Boolean);
  push(failures, members.length > 0, `${label} archive has no members`);
  push(failures, new Set(members).size === members.length, `${label} archive contains duplicate member names`);
  for (const member of members) {
    push(
      failures,
      !member.startsWith("/") && !member.includes("\\") && member.split("/").every((part) => part !== "." && part !== ".."),
      `${label} archive contains an unsafe member path`,
    );
  }
  return members;
}

function extractZipMember(artifactPath, member, label, failures) {
  const result = runTool("/usr/bin/unzip", ["-p", artifactPath, member], { binary: true });
  push(failures, result.ok, `${label} could not be extracted with unzip`);
  return result.ok ? result.stdout : null;
}

function validateElf(bytes, label, failures) {
  const valid = bytes.length >= 64
    && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
    && bytes[4] === 2 && bytes[5] === 1
    && bytes.readUInt16LE(16) === 3
    && bytes.readUInt16LE(18) === 183;
  push(failures, valid, `${label} is not an arm64 ELF shared object`);
}

async function inspectElf(path, member, bytes, failures) {
  validateElf(bytes, `Android native member ${member}`, failures);
  const readelf = await latestNdkTool("llvm-readelf");
  const nm = await latestNdkTool("llvm-nm");
  push(failures, readelf !== null && nm !== null, "Android NDK llvm-readelf/llvm-nm are unavailable; ELF validation fails closed");
  if (!readelf || !nm) return null;
  const dynamic = runTool(readelf, ["-d", path]);
  const symbols = runTool(nm, ["-D", "-C", "--defined-only", path]);
  push(failures, dynamic.ok, `Android native member ${member} has unreadable dynamic entries`);
  push(failures, symbols.ok, `Android native member ${member} has unreadable dynamic symbols`);
  if (!dynamic.ok || !symbols.ok) return null;
  return {
    member,
    sha256: hash(bytes),
    needed: [...dynamic.stdout.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map((match) => match[1]),
    definedSymbols: symbols.stdout,
  };
}

function arm64MachOSlice(bytes) {
  if (bytes.length < 32) return null;
  if (bytes.subarray(0, 8).toString("ascii") === "!<arch>\n") {
    let offset = 8;
    while (offset + 60 <= bytes.length) {
      const name = bytes.subarray(offset, offset + 16).toString("ascii").trim();
      const size = Number.parseInt(bytes.subarray(offset + 48, offset + 58).toString("ascii").trim(), 10);
      const dataOffset = offset + 60;
      if (!Number.isSafeInteger(size) || size <= 0 || dataOffset + size > bytes.length) return null;
      const extendedNameBytes = name.startsWith("#1/") ? Number.parseInt(name.slice(3), 10) : 0;
      const memberOffset = dataOffset + (Number.isSafeInteger(extendedNameBytes) ? extendedNameBytes : 0);
      const slice = memberOffset < dataOffset + size ? arm64MachOSlice(bytes.subarray(memberOffset, dataOffset + size)) : null;
      if (slice) return slice;
      offset = dataOffset + size + (size % 2);
    }
    return null;
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c) return bytes;
  const magic = bytes.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return null;
  const count = bytes.readUInt32BE(4);
  const entrySize = magic === 0xcafebabf ? 32 : 20;
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * entrySize;
    if (offset + entrySize > bytes.length || bytes.readUInt32BE(offset) !== 0x0100000c) continue;
    const sliceOffset = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(offset + 8)) : bytes.readUInt32BE(offset + 8);
    const sliceSize = magic === 0xcafebabf ? Number(bytes.readBigUInt64BE(offset + 16)) : bytes.readUInt32BE(offset + 12);
    if (sliceOffset + sliceSize <= bytes.length) return bytes.subarray(sliceOffset, sliceOffset + sliceSize);
  }
  return null;
}

function machOPlatform(bytes) {
  const slice = arm64MachOSlice(bytes);
  if (!slice || slice.length < 32) return null;
  const commands = slice.readUInt32LE(16);
  let offset = 32;
  let platform = null;
  for (let index = 0; index < commands; index += 1) {
    if (offset + 8 > slice.length) return null;
    const command = slice.readUInt32LE(offset);
    const size = slice.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > slice.length) return null;
    if (command === 0x32 && size >= 24) {
      if (platform !== null) return null;
      platform = slice.readUInt32LE(offset + 8);
    }
    offset += size;
  }
  return platform === 2 ? "physical" : platform === 7 ? "simulator" : null;
}

async function validateMachOWithAppleTools(bytes, label, expectedFileType, failures) {
  const directory = await mkdtemp(join(tmpdir(), "g016-macho-"));
  const path = join(directory, "member");
  try {
    await writeFile(path, bytes, { mode: 0o700 });
    const lipo = runTool("/usr/bin/lipo", ["-archs", path]);
    push(failures, lipo.ok && lipo.stdout.trim() === "arm64", `${label} is not exactly arm64 according to lipo`);
    const otool = runTool("/usr/bin/otool", ["-hv", path]);
    push(failures, otool.ok && otool.stdout.includes("ARM64") && otool.stdout.includes(expectedFileType), `${label} is not a valid ${expectedFileType} Mach-O according to otool`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function inspectAndroidArtifact(artifact, build, sourceFingerprint, resolutionSha256, failures) {
  return withCapturedArtifact(artifact.bytes, ".apk", async (artifactPath) => {
    const aapt = await latestAndroidTool("aapt");
    const apksigner = await latestAndroidTool("apksigner");
    const apkanalyzer = join(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk"), "cmdline-tools/latest/bin/apkanalyzer");
    push(failures, aapt !== null && apksigner !== null, "Android aapt/apksigner is unavailable; APK validation fails closed");
    if (!aapt || !apksigner) return null;
    const signature = runTool(apksigner, ["verify", "--verbose", "--print-certs", artifactPath]);
    push(failures, signature.ok && /Verified using v[123] scheme \(APK Signature Scheme v[123]\): true/.test(signature.stdout), "Android final APK signature verification failed");
    push(failures, /Signer(?: #1)?: certificate SHA-256 digest: [0-9a-f]{64}/i.test(signature.stdout), "Android APK signer certificate digest is missing");
    const badging = runTool(aapt, ["dump", "badging", artifactPath]);
    push(failures, badging.ok, "Android artifact is not a structurally valid APK according to aapt");
    push(failures, badging.stdout.includes(`package: name='${APP_ID}'`), "Android APK manifest application ID mismatch");
    push(failures, badging.stdout.includes("native-code: 'arm64-v8a'") && !/native-code:[^\n]*(x86|armeabi-v7a)/.test(badging.stdout), "Android APK native architecture is not exactly arm64-v8a");
    push(failures, !badging.stdout.includes("application-debuggable"), "Android APK manifest is debuggable, not Release");
    const analyzer = runTool(apkanalyzer, ["manifest", "application-id", artifactPath]);
    push(failures, analyzer.ok && analyzer.stdout.trim() === APP_ID, "Android APK application ID was not confirmed by apkanalyzer");

    const listing = runTool("/usr/bin/unzip", ["-Z1", artifactPath]);
    push(failures, listing.ok, "Android artifact is not readable by unzip");
    if (!listing.ok) return null;
    const members = safeZipMembers(listing.stdout, "Android APK", failures);
    const details = runTool("/usr/bin/zipinfo", ["-l", artifactPath]);
    push(failures, details.ok && !details.stdout.split(/\r?\n/).some((line) => /^l/.test(line)), "Android APK contains a symlink member");
    const bundle = extractZipMember(artifactPath, PLATFORM_CONTRACT.android.bundleMember, "Android JS bundle", failures);
    if (bundle) {
      push(failures, bundle.includes(Buffer.from(sourceFingerprint)) && bundle.includes(Buffer.from(resolutionSha256)), "Android JS bundle does not embed source and resolution digests");
    }
    const expectedMembers = ["libQuickCrypto.so", "libNitroModules.so", "libcrypto.so", "libssl.so", "libhermesvm.so", "libappmodules.so"];
    const inspections = {};
    const extractedDirectory = join(dirname(artifactPath), "elf");
    await mkdir(extractedDirectory);
    const elfMembers = members.filter((member) => /^lib\/arm64-v8a\/[^/]+\.so$/.test(member));
    const elfNames = elfMembers.map((member) => basename(member));
    push(failures, elfMembers.length > 0 && new Set(elfNames).size === elfNames.length, "Android APK arm64 ELF member names are empty or ambiguous");
    for (const name of expectedMembers) push(failures, elfNames.includes(name), `Android APK omits native member lib/arm64-v8a/${name}`);
    for (const member of elfMembers) {
      const name = basename(member);
      const bytes = extractZipMember(artifactPath, member, `Android native member ${name}`, failures);
      if (bytes) {
        const path = join(extractedDirectory, name);
        await writeFile(path, bytes);
        inspections[name] = await inspectElf(path, member, bytes, failures);
      }
    }
    const nativeAbis = new Set(members.map((member) => /^lib\/([^/]+)\//.exec(member)?.[1]).filter(Boolean));
    push(failures, nativeAbis.size === 1 && nativeAbis.has("arm64-v8a"), "Android APK contains a non-arm64-v8a native ABI");
    const symbolContracts = {
      "libQuickCrypto.so": {
        "QuickCrypto scrypt": /margelo::nitro::crypto::HybridScrypt::deriveKey\(/,
        "QuickCrypto AES-GCM": /margelo::nitro::crypto::HybridCipher::setAAD\(/,
      },
      "libNitroModules.so": { "NitroModules identity": /NitroModules/i },
      "libcrypto.so": { "OpenSSL crypto identity": /OpenSSL_version/ },
      "libssl.so": { "OpenSSL TLS identity": /SSL_(?:new|connect|ctx)/i },
      "libhermesvm.so": { "Hermes identity": /HermesRuntime|_sh_init/i },
    };
    for (const [name, contracts] of Object.entries(symbolContracts)) {
      for (const [identity, pattern] of Object.entries(contracts)) {
        push(failures, pattern.test(inspections[name]?.definedSymbols ?? ""), `Android ${name} lacks linked ${identity} implementation symbols`);
      }
    }
    const appSymbols = inspections["libappmodules.so"]?.definedSymbols ?? "";
    push(failures, /QuickBase64(?:Impl|Spec)/.test(appSymbols), "Android appmodules lacks linked QuickBase64 symbols");
    push(failures, /QuickCrypto_(?:ModuleProvider|registerComponentDescriptorsFromCodegen)/.test(appSymbols), "Android appmodules lacks QuickCrypto autolink symbols");
    push(failures, /NitroModules(?:Spec)?_(?:ModuleProvider|registerComponentDescriptorsFromCodegen)/.test(appSymbols), "Android appmodules lacks NitroModules autolink symbols");
    const packagedNames = new Set(elfNames);
    const systemLibraries = new Set([
      "libaaudio.so", "libamidi.so", "libandroid.so", "libbinder_ndk.so", "libc.so", "libcamera2ndk.so",
      "libdl.so", "libEGL.so", "libGLESv1_CM.so", "libGLESv2.so", "libGLESv3.so", "libjnigraphics.so",
      "liblog.so", "libm.so", "libmediandk.so", "libnativewindow.so", "libOpenMAXAL.so", "libOpenSLES.so",
      "libvulkan.so", "libz.so",
    ]);
    for (const inspection of Object.values(inspections).filter(Boolean)) {
      for (const needed of inspection.needed) push(failures, packagedNames.has(needed) || systemLibraries.has(needed), `Android native dependency closure is missing ${needed} required by ${inspection.member}`);
    }
    const quickNeeded = new Set(inspections["libQuickCrypto.so"]?.needed ?? []);
    for (const needed of ["libNitroModules.so", "libcrypto.so", "libssl.so"]) push(failures, quickNeeded.has(needed), `Android QuickCrypto does not dynamically depend on ${needed}`);
    return {
      target: build.target,
      nativeMembers: Object.fromEntries(Object.values(inspections).filter(Boolean).map((entry) => [entry.member, entry.sha256])),
      packagedMembers: {
        "base.apk": artifact.sha256,
        ...(bundle ? { [PLATFORM_CONTRACT.android.bundleMember]: hash(bundle) } : {}),
      },
      runtimeMembers: {
        baseApk: { bytes: artifact.bytes, sha256: artifact.sha256 },
      },
    };
  });
}

async function inspectIosArtifact(artifact, build, sourceFingerprint, resolutionSha256, failures) {
  return withCapturedArtifact(artifact.bytes, ".zip", async (artifactPath) => {
    const listing = runTool("/usr/bin/unzip", ["-Z1", artifactPath]);
    push(failures, listing.ok, "iOS artifact is not a structurally valid ZIP according to unzip");
    if (!listing.ok) return null;
    const members = safeZipMembers(listing.stdout, "iOS app ZIP", failures);
    const details = runTool("/usr/bin/zipinfo", ["-l", artifactPath]);
    push(failures, details.ok && !details.stdout.split(/\r?\n/).some((line) => /^l/.test(line)), "iOS app ZIP contains a symlink member");
    const plistMembers = members.filter((member) => /^Payload\/[A-Za-z0-9_.-]+\.app\/Info\.plist$/.test(member));
    push(failures, plistMembers.length === 1, "iOS app ZIP must contain exactly one Payload/*.app/Info.plist");
    if (plistMembers.length !== 1) return null;
    const appRoot = dirname(plistMembers[0]);
    const extractionRoot = join(dirname(artifactPath), "unpacked");
    const extracted = runTool("/usr/bin/unzip", ["-qq", artifactPath, "-d", extractionRoot]);
    push(failures, extracted.ok, "iOS app ZIP could not be safely extracted");
    if (!extracted.ok) return null;
    const appPath = join(extractionRoot, appRoot);
    const signature = runTool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    push(failures, signature.ok, "iOS final app signature verification failed");
    const signatureInfo = runTool("/usr/bin/codesign", ["-d", "--verbose=4", appPath]);
    const signatureText = `${signatureInfo.stdout}\n${signatureInfo.stderr}`;
    push(failures, signatureInfo.ok && (/Signature=adhoc/.test(signatureText) || /^Authority=/m.test(signatureText)), "iOS app is neither ad-hoc nor identity signed");
    const plistBytes = await readFile(join(appPath, "Info.plist"));
    if (!plistBytes) return null;
    const plistLint = runTool("/usr/bin/plutil", ["-lint", "-"], { input: plistBytes });
    push(failures, plistLint.ok, "iOS Info.plist is structurally invalid according to plutil");
    const appId = runTool("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", "-"], { input: plistBytes });
    const executableName = runTool("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", "-"], { input: plistBytes });
    push(failures, appId.ok && appId.stdout.trim() === APP_ID, "iOS Info.plist bundle identifier mismatch");
    push(failures, executableName.ok && /^[A-Za-z0-9_.-]+$/.test(executableName.stdout.trim()), "iOS Info.plist executable identity is invalid");
    const executableMember = `${appRoot}/${executableName.stdout.trim()}`;
    push(failures, members.includes(executableMember), "iOS app ZIP omits its declared executable");
    const executable = await readFile(join(extractionRoot, executableMember));
    await validateMachOWithAppleTools(executable, "iOS app executable", "EXECUTE", failures);
    const target = machOPlatform(executable);
    push(failures, target !== null, "iOS executable lacks an unambiguous iOS build platform");

    const bundleMember = `${appRoot}/main.jsbundle`;
    push(failures, members.includes(bundleMember), "iOS app ZIP omits main.jsbundle");
    const bundle = extractZipMember(artifactPath, bundleMember, "iOS JS bundle", failures);
    if (bundle) push(failures, bundle.includes(Buffer.from(sourceFingerprint)) && bundle.includes(Buffer.from(resolutionSha256)), "iOS JS bundle does not embed source and resolution digests");

    const executablePath = join(extractionRoot, executableMember);
    const symbols = runTool("/usr/bin/nm", ["-arch", "arm64", "-C", "-U", executablePath]);
    push(failures, symbols.ok, "iOS executable symbols could not be inspected");
    const implementationSymbols = {
      "QuickCrypto scrypt": /margelo::nitro::crypto::HybridScrypt::deriveKey\(/,
      "QuickCrypto AES-GCM": /margelo::nitro::crypto::HybridCipher::setAAD\(/,
      "Nitro installation": /margelo::nitro::install\(facebook::jsi::Runtime&/,
      "QuickBase64 implementation": /facebook::react::QuickBase64Impl::base64(?:From|To)ArrayBuffer\(/,
    };
    for (const [name, pattern] of Object.entries(implementationSymbols)) {
      push(failures, pattern.test(symbols.stdout), `iOS executable lacks linked ${name} implementation symbols`);
    }
    const loads = runTool("/usr/bin/otool", ["-arch", "arm64", "-L", executablePath]);
    push(failures, loads.ok, "iOS executable load commands could not be inspected");
    const nativeMembers = {};
    for (const framework of ["OpenSSL", "hermesvm"]) {
      const loadPath = `@rpath/${framework}.framework/${framework}`;
      push(failures, loads.stdout.includes(loadPath), `iOS executable lacks LC_LOAD_DYLIB for ${framework}`);
      const member = `${appRoot}/Frameworks/${framework}.framework/${framework}`;
      push(failures, members.includes(member), `iOS signed app omits loaded ${framework} framework member`);
      if (!members.includes(member)) continue;
      const frameworkPath = join(extractionRoot, member);
      const frameworkBytes = await readFile(frameworkPath);
      await validateMachOWithAppleTools(frameworkBytes, `iOS ${framework} framework`, "DYLIB", failures);
      push(failures, machOPlatform(frameworkBytes) === target, `iOS ${framework} framework has a detached build platform`);
      const identity = runTool("/usr/bin/otool", ["-arch", "arm64", "-D", frameworkPath]);
      push(failures, identity.ok && identity.stdout.includes(loadPath), `iOS ${framework} framework identity does not match its load command`);
      nativeMembers[member] = hash(frameworkBytes);
    }
    return {
      target,
      nativeMembers,
      packagedMembers: {
        [executableMember]: hash(executable),
        ...(bundle ? { [bundleMember]: hash(bundle) } : {}),
      },
      runtimeMembers: {
        executable: { bytes: executable, member: executableMember, sha256: hash(executable) },
        ...(bundle ? { bundle: { bytes: bundle, member: bundleMember, sha256: hash(bundle) } } : {}),
      },
    };
  });
}

async function validateRuntimeIdentity(identity, platform, evidenceRoot, artifact, inspection, failures) {
  const runtimeFailures = [];
  push(runtimeFailures, isObject(identity), `${platform} runtime identity evidence is missing`);
  if (!isObject(identity)) {
    failures.push(...runtimeFailures);
    return null;
  }

  const expectedKeys = platform === "android"
    ? ["artifactSha256", "installedBaseApkPath", "installedBaseApkSha256"]
    : [
      "artifactSha256",
      "installedBundlePath",
      "installedBundleSha256",
      "installedExecutablePath",
      "installedExecutableSha256",
    ];
  exactKeys(identity, expectedKeys, `${platform} runtime identity`, runtimeFailures);
  push(runtimeFailures, sha256Text(identity.artifactSha256), `${platform} runtime artifact SHA-256 is invalid`);
  push(
    runtimeFailures,
    artifact !== null && identity.artifactSha256 === artifact.sha256,
    `${platform} runtime identity is detached from the inspected signed artifact`,
  );

  const installedMembers = {};
  let installedBaseApk = null;
  let installedExecutable = null;
  let installedBundle = null;
  if (platform === "android") {
    const expectedPath = RUNTIME_SNAPSHOT_PATHS.android.baseApk;
    const exactPath = identity.installedBaseApkPath === expectedPath;
    push(runtimeFailures, exactPath, `android installed base APK path must be exactly ${expectedPath}`);
    if (exactPath) {
      installedBaseApk = await snapshotFile(
        evidenceRoot,
        `${platform}/${expectedPath}`,
        identity.installedBaseApkSha256,
        "android installed base APK",
        runtimeFailures,
        platform,
      );
    }
    const packaged = inspection?.runtimeMembers?.baseApk;
    push(runtimeFailures, packaged !== undefined, "Android artifact inspection did not retain the signed base APK identity");
    if (installedBaseApk && artifact) {
      push(
        runtimeFailures,
        independentFileIdentity(installedBaseApk, artifact),
        "Android installed base APK must be an independent file, not the signed artifact snapshot or a hardlink",
      );
    }
    if (installedBaseApk && packaged) {
      push(
        runtimeFailures,
        installedBaseApk.sha256 === packaged.sha256,
        "Android installed base APK SHA-256 does not match the exact signed artifact",
      );
      push(
        runtimeFailures,
        installedBaseApk.bytes.length === packaged.bytes.length && installedBaseApk.bytes.equals(packaged.bytes),
        "Android installed base APK bytes do not match the exact signed artifact",
      );
      installedMembers.baseApk = installedBaseApk.sha256;
    }
  } else {
    const expectedExecutablePath = RUNTIME_SNAPSHOT_PATHS.ios.executable;
    const expectedBundlePath = RUNTIME_SNAPSHOT_PATHS.ios.bundle;
    const exactExecutablePath = identity.installedExecutablePath === expectedExecutablePath;
    const exactBundlePath = identity.installedBundlePath === expectedBundlePath;
    push(runtimeFailures, exactExecutablePath, `ios installed app executable path must be exactly ${expectedExecutablePath}`);
    push(runtimeFailures, exactBundlePath, `ios installed main.jsbundle path must be exactly ${expectedBundlePath}`);
    if (exactExecutablePath) {
      installedExecutable = await snapshotFile(
        evidenceRoot,
        `${platform}/${expectedExecutablePath}`,
        identity.installedExecutableSha256,
        "ios installed app executable",
        runtimeFailures,
        platform,
      );
    }
    if (exactBundlePath) {
      installedBundle = await snapshotFile(
        evidenceRoot,
        `${platform}/${expectedBundlePath}`,
        identity.installedBundleSha256,
        "ios installed main.jsbundle",
        runtimeFailures,
        platform,
      );
    }
    for (const [label, installed] of [
      ["app executable", installedExecutable],
      ["main.jsbundle", installedBundle],
    ]) {
      if (installed && artifact) {
        push(
          runtimeFailures,
          independentFileIdentity(installed, artifact),
          `iOS installed ${label} must be an independent file from the signed ZIP snapshot`,
        );
      }
    }
    if (installedExecutable && installedBundle) {
      push(
        runtimeFailures,
        independentFileIdentity(installedExecutable, installedBundle),
        "iOS installed app executable and main.jsbundle must be independent files, not aliases or hardlinks",
      );
    }
    for (const [label, installed, packaged] of [
      ["app executable", installedExecutable, inspection?.runtimeMembers?.executable],
      ["main.jsbundle", installedBundle, inspection?.runtimeMembers?.bundle],
    ]) {
      push(runtimeFailures, packaged !== undefined, `iOS artifact inspection did not retain packaged ${label} identity`);
      if (!installed || !packaged) continue;
      push(
        runtimeFailures,
        installed.sha256 === packaged.sha256,
        `iOS installed ${label} SHA-256 does not match the inspected signed ZIP member`,
      );
      push(
        runtimeFailures,
        installed.bytes.length === packaged.bytes.length && installed.bytes.equals(packaged.bytes),
        `iOS installed ${label} bytes do not match the inspected signed ZIP member`,
      );
      installedMembers[packaged.member] = installed.sha256;
    }
  }

  let runtimeArtifactSha256 = null;
  if (runtimeFailures.length === 0) {
    runtimeArtifactSha256 = platform === "android" ? installedBaseApk?.sha256 : artifact?.sha256;
    push(
      runtimeFailures,
      sha256Text(runtimeArtifactSha256),
      `${platform} runtime artifact identity could not be derived from independently matched installed files`,
    );
  }
  failures.push(...runtimeFailures);
  return {
    valid: runtimeFailures.length === 0,
    artifactSha256: runtimeFailures.length === 0 ? runtimeArtifactSha256 : null,
    installedMembers,
  };
}

function parseNativeCommandBlocks(lines, platform, kind, failures) {
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const begin = parseJsonLine(lines[index], COMMAND_BEGIN_PREFIX, `${platform} ${kind} command begin`, failures);
    if (!begin) {
      failures.push(`${platform} ${kind} log contains an unframed or caller-authored summary line`);
      index += 1;
      continue;
    }
    exactKeys(begin, ["id", "platform", "kind", "phase", "pid", "startedAt", "target", "command"], `${platform} ${kind} command begin`, failures);
    let endIndex = index + 1;
    while (endIndex < lines.length && !lines[endIndex].startsWith(COMMAND_END_PREFIX)) {
      if (lines[endIndex].startsWith(COMMAND_BEGIN_PREFIX)) break;
      endIndex += 1;
    }
    push(failures, endIndex < lines.length && lines[endIndex].startsWith(COMMAND_END_PREFIX), `${platform} ${kind} command transcript is unterminated or nested`);
    if (endIndex >= lines.length || !lines[endIndex].startsWith(COMMAND_END_PREFIX)) {
      index = endIndex;
      continue;
    }
    const end = parseJsonLine(lines[endIndex], COMMAND_END_PREFIX, `${platform} ${kind} command end`, failures);
    if (!end) {
      index = endIndex + 1;
      continue;
    }
    exactKeys(end, ["id", "endedAt", "exitCode"], `${platform} ${kind} command end`, failures);
    const startedAt = canonicalTimestamp(begin.startedAt);
    const endedAt = canonicalTimestamp(end.endedAt);
    push(failures, typeof begin.id === "string" && /^[a-z0-9-]{1,64}$/.test(begin.id) && end.id === begin.id, `${platform} ${kind} command identity is invalid`);
    push(failures, begin.platform === platform && begin.kind === kind, `${platform} ${kind} command metadata is contradictory`);
    push(failures, Number.isSafeInteger(begin.pid) && begin.pid > 0, `${platform} ${kind} command PID is invalid`);
    push(failures, typeof begin.command === "string" && begin.command.length <= 512 && !/[\r\n]/.test(begin.command), `${platform} ${kind} command is invalid`);
    push(failures, startedAt !== null && endedAt !== null && endedAt >= startedAt, `${platform} ${kind} command timing is invalid`);
    push(failures, end.exitCode === 0, `${platform} ${kind} native command did not exit successfully`);
    const body = lines.slice(index + 1, endIndex).join("\n");
    push(failures, Buffer.byteLength(body) > 0 && Buffer.byteLength(body) <= 2 * 1024 * 1024, `${platform} ${kind} command output is empty or unbounded`);
    blocks.push({ ...begin, startedAtMs: startedAt, endedAtMs: endedAt, body });
    index = endIndex + 1;
  }
  push(failures, new Set(blocks.map((block) => block.id)).size === blocks.length, `${platform} ${kind} command IDs must be unique within the log`);
  return blocks;
}

function parseProcessLog(bytes, platform, sourceFingerprint, resolutionSha256, runtimeArtifactSha256, failures) {
  const lines = bytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  const proofIndexes = lines.map((line, index) => line.startsWith(G016_PROOF_PREFIX) ? index : -1).filter((index) => index >= 0);
  const observedIndexes = lines.map((line, index) => line.startsWith(PROOF_OBSERVED_PREFIX) ? index : -1).filter((index) => index >= 0);
  push(failures, proofIndexes.length === 1, `${platform} process log must contain exactly one proof record`);
  push(failures, observedIndexes.length === 1, `${platform} process log must contain exactly one proof observation timestamp`);
  push(failures, sha256Text(runtimeArtifactSha256), `${platform} process binding lacks the validated runtime artifact SHA-256`);
  const proofRecord = proofIndexes.length === 1 ? lines[proofIndexes[0]] : null;
  const proof = proofRecord !== null ? parseSingleProofRecord(proofRecord, failures) : null;
  validateProof(proof, platform, sourceFingerprint, resolutionSha256, failures);
  const proofAt = observedIndexes.length === 1 ? canonicalTimestamp(lines[observedIndexes[0]].slice(PROOF_OBSERVED_PREFIX.length)) : null;
  push(failures, proofAt !== null, `${platform} proof observation timestamp is invalid`);
  const excluded = new Set([...proofIndexes, ...observedIndexes]);
  const blocks = parseNativeCommandBlocks(lines.filter((_, index) => !excluded.has(index)), platform, "liveness", failures);
  push(failures, blocks.length === 1, `${platform} process log must contain exactly one native liveness command transcript`);
  if (blocks.length !== 1) return null;
  const block = blocks[0];
  push(failures, block.phase === "post-proof", `${platform} liveness command phase must be post-proof`);
  push(failures, PLATFORM_CONTRACT[platform].targets.has(block.target), `${platform} liveness target is invalid`);
  push(failures, proofAt !== null && block.startedAtMs !== null && block.startedAtMs >= proofAt && block.endedAtMs > proofAt, `${platform} liveness command does not follow the proof observation`);
  if (platform === "android") {
    push(failures, block.command === "adb shell ps -A -o PID,NAME,ARGS", "android liveness must retain the exact native ps command");
    const matches = block.body.split("\n").filter((line) => new RegExp(`^\\s*${block.pid}\\s+${APP_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${APP_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(line));
    push(failures, matches.length === 1, "android liveness output does not contain exactly one PID/app process row");
  } else {
    push(failures, block.command === "xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=", "ios liveness must retain the exact simulator /bin/ps command");
    const matches = block.body.split("\n").filter((line) => new RegExp(`^\\s*${block.pid}\\s+\\S+\\s+/.+\\.app/G016FMBKCryptoProof\\s*$`).test(line));
    push(failures, matches.length === 1, "ios liveness output does not contain exactly one PID/app executable row");
  }
  return {
    artifactSha256: runtimeArtifactSha256,
    checkedAt: block.endedAtMs,
    pid: block.pid,
    proofAt,
    proofRecord,
    target: block.target,
  };
}

function androidAdverseEvent(line, pid) {
  const escapedApp = APP_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pidScoped = new RegExp(`^\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d+\\s+${pid}\\s+\\d+\\s+[A-Z]\\s+[^:]+:`).test(line);
  const appScoped = new RegExp(`(?:${escapedApp}|\\bpid[=: ]+${pid}\\b|\\(${pid}\\))`, "i").test(line);
  if (pidScoped && /(?:FATAL EXCEPTION|fatal signal|uncaught (?:exception|error)|outofmemoryerror|SIG(?:ABRT|SEGV|BUS)|tombstone)/i.test(line)) return "app-crash";
  if (!appScoped) return null;
  if (/\bANR in\b|am_anr|input dispatching timed out/i.test(line)) return "anr";
  const killSource = /(?:lmkd|lowmemorykiller|ActivityManager).*\b(?:kill|killing|killed)\b/i.test(line);
  const exactKillPid = new RegExp(`(?:\\b(?:kill|killing|killed)\\s+(?:process\\s+)?${pid}(?=[:\\s(])|\\b(?:kill|killing|killed)\\s+['\"]?${escapedApp}['\"]?\\s*\\(${pid}\\)|\\b(?:kill|killing|killed)\\s+(?:process\\s+)?${escapedApp}[^\\n]*\\bpid[=: ]+${pid}\\b)`, "i").test(line);
  if (killSource && exactKillPid) return "low-memory-kill";
  if (/\b(?:out of memory|oom kill|oom_reaper)\b/i.test(line)) return "oom";
  if (/\b(?:fatal signal|crash|uncaught exception|process .* has died)\b/i.test(line)) return "app-crash";
  return null;
}

function iosAdverseEvent(line, pid) {
  const escapedApp = APP_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appScoped = new RegExp(`(?:${escapedApp}|\\[${pid}(?::|\\])|\\bpid[=: ]+${pid}\\b|\\(${pid}\\))`, "i").test(line);
  if (!appScoped) return null;
  if (/(?:memorystatus|runningboard|SpringBoard).*(?:jetsam|memory-pressure).*(?:kill|terminate)|jetsam_reason|per-process-limit/i.test(line)) return "jetsam";
  if (/\b(?:EXC_(?:CRASH|BAD_ACCESS)|fatal error|uncaught exception|termination reason|terminated due to signal|SIG(?:ABRT|SEGV|BUS)|crashed thread)\b/i.test(line)) return "app-crash";
  if (/\bunhandled (?:exception|rejection)\b/i.test(line)) return "unhandled";
  return null;
}

function rawProofTimestamp(parts, candidateYears, observedAt, captureStartedAt, captureEndedAt) {
  if ([observedAt, captureStartedAt, captureEndedAt].some((value) => value === null)) return null;
  const [month, day, hour, minute, second, fraction] = parts;
  if (!/^\d{3}$/.test(fraction)) return null;
  const millisecond = Number(fraction);
  const candidates = new Set();
  for (const year of candidateYears) {
    const wallClock = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    const exact = new Date(wallClock);
    if (
      !Number.isFinite(wallClock)
      || exact.getUTCFullYear() !== year
      || exact.getUTCMonth() + 1 !== month
      || exact.getUTCDate() !== day
      || exact.getUTCHours() !== hour
      || exact.getUTCMinutes() !== minute
      || exact.getUTCSeconds() !== second
      || exact.getUTCMilliseconds() !== millisecond
    ) continue;
    for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
      const timestamp = wallClock - (offsetMinutes * 60_000);
      if (
        timestamp >= captureStartedAt
        && timestamp <= captureEndedAt
        && timestamp <= observedAt
        && observedAt - timestamp <= MAX_PROOF_OBSERVATION_LAG_MS
      ) candidates.add(timestamp);
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

function platformRawProof(line, platform, timing) {
  const match = platform === "android"
    ? /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)\s+(\d+)\s+\d+\s+[VDIWEF]\s+[^:\r\n]+:\s*(G016_CRYPTO_PROOF .+)$/.exec(line)
    : /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d+)\s+\S+\s+G016FMBKCryptoProof\[(\d+):[0-9a-fA-F]+\]\s+\[[^\]\r\n]+\]\s+(G016_CRYPTO_PROOF .+)$/.exec(line);
  if (!match) return null;
  const observedYear = new Date(timing.observedAt).getUTCFullYear();
  const timestampParts = platform === "android"
    ? [...match.slice(1, 6).map(Number), match[6]]
    : [...match.slice(2, 7).map(Number), match[7]];
  const candidateYears = platform === "android"
    ? [observedYear - 1, observedYear, observedYear + 1]
    : [Number(match[1])];
  const pidIndex = platform === "android" ? 7 : 8;
  const proofIndex = platform === "android" ? 8 : 9;
  const proofAt = rawProofTimestamp(
    timestampParts,
    candidateYears,
    timing.observedAt,
    timing.captureStartedAt,
    timing.captureEndedAt,
  );
  return { pid: Number(match[pidIndex]), proofAt, proofRecord: match[proofIndex] };
}

function parseAdverseLog(bytes, platform, liveness, failures) {
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines.filter((line) => line.startsWith(ADVERSE_PREFIX));
  push(failures, headers.length === 1, `${platform} adverse log must contain exactly one capture header`);
  const header = headers.length === 1 ? parseJsonLine(headers[0], ADVERSE_PREFIX, `${platform} adverse header`, failures) : null;
  let captureStartedAt = null;
  let captureEndedAt = null;
  if (header) {
    exactKeys(header, ["pid", "startedAt", "endedAt"], `${platform} adverse header`, failures);
    captureStartedAt = canonicalTimestamp(header.startedAt);
    captureEndedAt = canonicalTimestamp(header.endedAt);
    push(failures, header.pid === liveness?.pid, `${platform} adverse log PID does not match the live proof process`);
    push(failures, captureStartedAt !== null && captureEndedAt !== null && captureStartedAt <= liveness?.proofAt && captureEndedAt >= liveness?.checkedAt, `${platform} adverse log does not cover proof and liveness`);
  }
  const rawProofLines = lines.filter((line) => line.includes(G016_PROOF_PREFIX));
  push(failures, rawProofLines.length === 1, `${platform} adverse raw OS log must contain exactly one G016 proof line`);
  const rawProof = rawProofLines.length === 1 ? platformRawProof(rawProofLines[0], platform, {
    observedAt: liveness?.proofAt ?? null,
    captureStartedAt,
    captureEndedAt,
  }) : null;
  push(failures, rawProof !== null, `${platform} adverse raw proof line is not platform-shaped and PID-scoped`);
  if (rawProof) {
    push(failures, rawProof.proofAt !== null, `${platform} adverse raw proof timestamp cannot be normalized and bound to the proof observation`);
    push(failures, rawProof.pid === liveness?.pid, `${platform} adverse raw proof PID is detached from the live process`);
    push(
      failures,
      rawProof.proofRecord === liveness?.proofRecord,
      `${platform} adverse raw proof is not byte-equal to the canonical process proof`,
    );
  }
  const detector = platform === "android" ? androidAdverseEvent : iosAdverseEvent;
  const matches = lines
    .filter((line) => !line.startsWith(ADVERSE_PREFIX))
    .map((line) => detector(line, liveness?.pid))
    .filter(Boolean);
  push(failures, matches.length === 0, `${platform} adverse log contains PID/app-scoped events: ${[...new Set(matches)].join(",")}`);
  return rawProof;
}

function parseMemoryLog(bytes, platform, declaredKind, liveness, rawProof, failures) {
  const blocks = parseNativeCommandBlocks(bytes.toString("utf8").split(/\r?\n/).filter(Boolean), platform, "memory", failures);
  push(failures, declaredKind === PLATFORM_CONTRACT[platform].memoryKind, `${platform} memory kind is invalid`);
  const samples = [];
  for (const block of blocks) {
    push(failures, block.pid === liveness?.pid, `${platform} memory command PID is detached from the live proof process`);
    push(failures, block.target === liveness?.target, `${platform} memory command target contradicts liveness`);
    let valueMiB = null;
    if (platform === "android") {
      push(failures, block.command === `adb shell dumpsys meminfo ${block.pid}`, "android memory must retain the exact native dumpsys meminfo command");
      const identities = [...block.body.matchAll(/^\*\* MEMINFO in pid (\d+) \[([^\]]+)\] \*\*$/gm)];
      push(failures, identities.length === 1 && Number(identities[0][1]) === block.pid && identities[0][2] === APP_ID, "android memory output PID/app identity is invalid");
      const totals = [...block.body.matchAll(/^\s*TOTAL PSS:\s+(\d+)\s+/gm)];
      push(failures, totals.length === 1, "android memory output lacks exactly one native TOTAL PSS value");
      if (totals.length === 1) valueMiB = Number(totals[0][1]) / 1024;
    } else {
      push(failures, block.command === `footprint -f bytes -p ${block.pid}`, "ios memory must retain the exact byte-format footprint command");
      const identities = [...block.body.matchAll(new RegExp(`^G016FMBKCryptoProof \\[(${block.pid})\\]: 64-bit\\s+Footprint: \\d+ B \\(\\d+ bytes per page\\)$`, "gm"))];
      push(failures, identities.length === 1, "ios memory output PID/app identity or byte format is invalid");
      const footprints = [...block.body.matchAll(/^\s*phys_footprint:\s+(\d+) B$/gm)];
      push(failures, footprints.length === 1, "ios memory output lacks exactly one native byte phys_footprint value");
      if (footprints.length === 1) valueMiB = Number(footprints[0][1]) / (1024 * 1024);
    }
    if (finiteNonnegative(valueMiB)) samples.push({ pid: block.pid, timestamp: new Date(block.startedAtMs).toISOString(), valueMiB, phase: block.phase, startedAtMs: block.startedAtMs, endedAtMs: block.endedAtMs });
  }
  const validated = validateMemorySamples(samples.map(({ startedAtMs, endedAtMs, ...sample }) => sample), platform, failures);
  if (!validated) return null;
  push(failures, samples.every((sample, index) => index === samples.length - 1 || sample.endedAtMs < samples[index + 1].startedAtMs), `${platform} memory command windows overlap or are unordered`);
  push(failures, Number.isFinite(rawProof?.proofAt) && samples.length > 0 && samples.at(-1).endedAtMs <= rawProof.proofAt, `${platform} memory transcripts do not finish before the raw platform proof`);
  return validated.summary;
}

async function validatePlatformEvidence(evidence, platform, evidenceRoot, sourceFingerprint, failures) {
  const platformFailures = [];
  push(platformFailures, isObject(evidence), `${platform} evidence set is malformed`);
  if (!isObject(evidence)) { failures.push(...platformFailures); return null; }
  exactKeys(
    evidence,
    ["platform", "build", "runtimeIdentity", "process", "adverseEvents", "nativeResolution", "memory"],
    `${platform} evidence`,
    platformFailures,
  );
  push(platformFailures, evidence.platform === platform, `${platform} evidence platform field is inconsistent`);
  const contract = PLATFORM_CONTRACT[platform];

  const native = evidence.nativeResolution;
  push(platformFailures, isObject(native), `${platform} native resolution evidence is missing`);
  let resolution = null;
  if (isObject(native)) {
    exactKeys(native, ["resolutionPath", "resolutionSha256"], `${platform} native resolution`, platformFailures);
    resolution = await snapshotFile(evidenceRoot, `${platform}/${native.resolutionPath}`, native.resolutionSha256, `${platform} native resolution`, platformFailures, platform);
    if (resolution) {
      push(platformFailures, basename(resolution.path) === contract.resolutionBasename, `${platform} native resolution artifact type is invalid`);
      validateResolution(resolution.bytes.toString("utf8"), platform, platformFailures);
    }
  }

  const build = evidence.build;
  push(platformFailures, isObject(build), `${platform} build evidence is missing`);
  let artifact = null;
  let artifactInspection = null;
  if (isObject(build)) {
    exactKeys(build, ["configuration", "applicationId", "buildIdentity", "architecture", "artifactPath", "artifactSha256", "sourceFingerprintSha256", "target"], `${platform} build`, platformFailures);
    push(platformFailures, build.configuration === "Release", `${platform} build configuration must be Release`);
    push(platformFailures, build.applicationId === APP_ID, `${platform} application identity mismatch`);
    push(platformFailures, build.architecture === contract.architecture, `${platform} architecture must be exactly ${contract.architecture}`);
    push(platformFailures, contract.targets.has(build.target), `${platform} target is invalid`);
    push(platformFailures, build.sourceFingerprintSha256 === sourceFingerprint, `${platform} source fingerprint is stale or mismatched`);
    artifact = await snapshotFile(evidenceRoot, `${platform}/${build.artifactPath}`, build.artifactSha256, `${platform} build artifact`, platformFailures, platform);
    if (artifact) {
      push(platformFailures, basename(artifact.path).endsWith(contract.artifactExtension), `${platform} artifact extension is invalid`);
      push(platformFailures, build.buildIdentity === `g016-${platform}-${artifact.sha256.slice(0, 16)}`, `${platform} build identity is not derived from the actual artifact digest`);
      if (resolution) {
        artifactInspection = platform === "android"
          ? await inspectAndroidArtifact(artifact, build, sourceFingerprint, resolution.sha256, platformFailures)
          : await inspectIosArtifact(artifact, build, sourceFingerprint, resolution.sha256, platformFailures);
        push(platformFailures, artifactInspection?.target === build.target, `${platform} target contradicts the inspected artifact`);
      }
    }
  }

  const runtimeIdentity = await validateRuntimeIdentity(
    evidence.runtimeIdentity,
    platform,
    evidenceRoot,
    artifact,
    artifactInspection,
    platformFailures,
  );

  let liveness = null;
  const processEvidence = evidence.process;
  push(platformFailures, isObject(processEvidence), `${platform} process-liveness evidence is missing`);
  if (isObject(processEvidence)) {
    exactKeys(processEvidence, ["logPath", "logSha256"], `${platform} process`, platformFailures);
    const log = await snapshotFile(evidenceRoot, `${platform}/${processEvidence.logPath}`, processEvidence.logSha256, `${platform} process log`, platformFailures, platform);
    if (log && runtimeIdentity?.valid !== true) {
      platformFailures.push(`${platform} process binding requires a fully valid installed runtime identity`);
    }
    if (log && resolution && runtimeIdentity?.valid === true) {
      liveness = parseProcessLog(
        log.bytes,
        platform,
        sourceFingerprint,
        resolution.sha256,
        runtimeIdentity.artifactSha256,
        platformFailures,
      );
    }
    if (liveness) {
      push(platformFailures, liveness.target === build?.target, `${platform} liveness target contradicts the artifact`);
      push(
        platformFailures,
        runtimeIdentity?.valid === true && liveness.artifactSha256 === runtimeIdentity.artifactSha256,
        `${platform} live proof process is detached from the installed signed-artifact identity`,
      );
    }
  }

  let rawProof = null;
  const adverse = evidence.adverseEvents;
  push(platformFailures, isObject(adverse), `${platform} adverse-event evidence is missing`);
  if (isObject(adverse)) {
    exactKeys(adverse, ["logPath", "logSha256"], `${platform} adverse events`, platformFailures);
    const log = await snapshotFile(evidenceRoot, `${platform}/${adverse.logPath}`, adverse.logSha256, `${platform} adverse-event log`, platformFailures, platform);
    if (log) rawProof = parseAdverseLog(log.bytes, platform, liveness, platformFailures);
  }

  let memory = null;
  const memoryEvidence = evidence.memory;
  push(platformFailures, isObject(memoryEvidence), `${platform} external memory evidence is missing`);
  if (isObject(memoryEvidence)) {
    exactKeys(memoryEvidence, ["kind", "logPath", "logSha256"], `${platform} memory`, platformFailures);
    const log = await snapshotFile(evidenceRoot, `${platform}/${memoryEvidence.logPath}`, memoryEvidence.logSha256, `${platform} memory sampler log`, platformFailures, platform);
    if (log) memory = parseMemoryLog(log.bytes, platform, memoryEvidence.kind, liveness, rawProof, platformFailures);
  }

  failures.push(...platformFailures);
  return {
    valid: platformFailures.length === 0,
    platform,
    artifactSha256: artifact?.sha256 ?? null,
    resolutionSha256: resolution?.sha256 ?? null,
    memory,
    nativeMembers: artifactInspection?.nativeMembers ?? null,
    packagedMembers: artifactInspection?.packagedMembers ?? null,
    runtimeIdentity: runtimeIdentity?.valid ? runtimeIdentity.installedMembers : null,
    target: artifactInspection?.target ?? null,
  };
}

export async function validateG016FinalEvidence(evidence) {
  const failures = [];
  push(failures, isObject(evidence), "aggregate evidence must be an object");
  if (!isObject(evidence)) return { schemaVersion: 2, status: "FAIL", failures, trustBoundary: TRUST_BOUNDARY, physicalIosProductionGate: "OPEN" };
  exactKeys(evidence, ["schemaVersion", "evidenceRoot", "candidate", "platforms"], "aggregate evidence", failures);
  push(failures, evidence.schemaVersion === 2, "aggregate evidence schemaVersion must be 2");
  push(failures, typeof evidence.evidenceRoot === "string" && isAbsolute(evidence.evidenceRoot), "evidenceRoot must be absolute");
  const evidenceRoot = typeof evidence.evidenceRoot === "string" && isAbsolute(evidence.evidenceRoot)
    ? await canonicalDirectory(evidence.evidenceRoot, "evidenceRoot", failures)
    : null;
  if (!evidenceRoot) return { schemaVersion: 2, status: "FAIL", failures, trustBoundary: TRUST_BOUNDARY, physicalIosProductionGate: "OPEN" };

  const candidate = await validateCandidate(evidence.candidate, evidenceRoot, failures);
  push(failures, Array.isArray(evidence.platforms), "platforms must be an array");
  if (!Array.isArray(evidence.platforms) || !candidate) {
    if (candidate) await candidate.root.handle.close();
    await evidenceRoot.handle.close();
    return { schemaVersion: 2, status: "FAIL", failures, sourceFingerprintSha256: candidate?.fingerprint ?? null, trustBoundary: TRUST_BOUNDARY, physicalIosProductionGate: "OPEN" };
  }
  const platformNames = evidence.platforms.map((entry) => entry?.platform);
  push(failures, evidence.platforms.length === 2, "exactly two platform evidence sets are required");
  push(failures, platformNames.filter((value) => value === "android").length === 1, "exactly one Android evidence set is required");
  push(failures, platformNames.filter((value) => value === "ios").length === 1, "exactly one iOS evidence set is required");

  const results = [];
  for (const platform of ["android", "ios"]) {
    const entries = evidence.platforms.filter((entry) => entry?.platform === platform);
    if (entries.length === 1) results.push(await validatePlatformEvidence(entries[0], platform, evidenceRoot, candidate.fingerprint, failures));
  }
  const status = failures.length === 0 && results.length === 2 && results.every((result) => result?.valid) ? "PASS" : "FAIL";
  const result = {
    schemaVersion: 2,
    status,
    failures,
    sourceFingerprintSha256: candidate.fingerprint,
    artifacts: Object.fromEntries(results.map((result) => [result.platform, result.artifactSha256])),
    resolutions: Object.fromEntries(results.map((result) => [result.platform, result.resolutionSha256])),
    nativeMembers: Object.fromEntries(results.map((result) => [result.platform, result.nativeMembers])),
    packagedMembers: Object.fromEntries(results.map((result) => [result.platform, result.packagedMembers])),
    runtimeIdentities: Object.fromEntries(results.map((result) => [result.platform, result.runtimeIdentity])),
    memory: Object.fromEntries(results.map((result) => [result.platform, result.memory])),
    trustBoundary: TRUST_BOUNDARY,
    // A physical build slice is not device attestation. Production remains open until a separately approved physical-device gate exists.
    physicalIosProductionGate: "OPEN",
  };
  await candidate.root.handle.close();
  await evidenceRoot.handle.close();
  return result;
}

async function runCli() {
  const inputPath = process.argv[2];
  let result;
  if (!inputPath) {
    result = await validateG016FinalEvidence(null);
    result.failures.unshift("usage: node deviceEvidenceValidator.mjs <aggregate-evidence.json>");
  } else {
    try {
      result = await validateG016FinalEvidence(JSON.parse(await readFile(inputPath, "utf8")));
    } catch (error) {
      result = { schemaVersion: 2, status: "FAIL", failures: [error instanceof Error ? error.message : String(error)], trustBoundary: TRUST_BOUNDARY, physicalIosProductionGate: "OPEN" };
    }
  }
  process.stdout.write(G016_DEVICE_EVIDENCE_PREFIX + JSON.stringify(result) + "\n");
  if (result.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
