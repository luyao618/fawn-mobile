#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const G017_SOURCE_PATHS = Object.freeze([
  "spikes/model-transport/App.tsx",
  "spikes/model-transport/app.json",
  "spikes/model-transport/deviceEvidenceValidator.mjs",
  "spikes/model-transport/index.ts",
  "spikes/model-transport/metro.config.cjs",
  "spikes/model-transport/package-lock.json",
  "spikes/model-transport/package.json",
  "spikes/model-transport/README.md",
  "spikes/model-transport/plugins/withLocalMockNetwork.cjs",
  "spikes/model-transport/src/adapter.ts",
  "spikes/model-transport/src/contracts.ts",
  "spikes/model-transport/src/deviceProof.ts",
  "spikes/model-transport/src/sse.ts",
  "spikes/model-transport/src/url.ts",
  "spikes/model-transport/tsconfig.json",
  "tests/fixtures/providers/chat-completions/malformed-json.sse",
  "tests/fixtures/providers/chat-completions/premature-eof.sse",
  "tests/fixtures/providers/chat-completions/profile-a.sse",
  "tests/fixtures/providers/chat-completions/profile-b.sse",
  "tests/fixtures/providers/mockCompatibleServer.ts",
  "tests/unit/model/device-evidence-validator.test.ts",
  "tests/unit/model/provider-contract.test.ts",
  "tests/unit/model/sse-parser.test.ts",
  "tests/unit/model/transport-lifecycle.test.ts",
  "tests/unit/tooling/redaction.test.ts",
  "tests/unit/tooling/typecheck-fixture-lifecycle.test.ts",
  "tools/check-audit.mjs",
  "tools/check-licenses.mjs",
  "tools/export-g017.mjs",
  "tools/redaction.d.mts",
  "tools/redaction.mjs",
  "tools/start-mock-provider.mts",
  "dependencies.slice0.lock.json",
  "licenses.slice0.json",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const PREFIX = "G017_TRANSPORT_PROOF ";
const RESULT_PREFIX = "G017_EVIDENCE_RESULT ";
const OFFSET_PREFIX = "G017_TARGET_UTC_OFFSET ";
const SECRET = /(Bearer\s+[A-Za-z0-9._~+/=-]+|api[-_]?key\s*[:=]|authorization\s*[:=]|password\s*[:=]|-----BEGIN [^-]*PRIVATE KEY-----)/i;
const EXPECTED_DEPENDENCIES = Object.freeze({ expo: "57.0.4", react: "19.2.3", reactNative: "0.86.0", eventsourceParser: "3.1.0" });

export async function computeG017SourceFingerprint(root = REPO_ROOT) {
  const aggregate = createHash("sha256");
  for (const path of G017_SOURCE_PATHS) {
    const absolute = resolve(root, path);
    if (relative(root, absolute).startsWith("..")) throw new Error("source path escapes repository");
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`source path is not a regular file: ${path}`);
    const bytes = await readFile(absolute);
    aggregate.update(path).update("\0").update(createHash("sha256").update(bytes).digest("hex")).update("\n");
  }
  return aggregate.digest("hex");
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function parseRawProofLine(line, platform) {
  if (platform === "android") {
    const match = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+\d+\s+[A-Z]\s+ReactNativeJS:\s+(G017_TRANSPORT_PROOF .+)$/.exec(line);
    return match ? { pid: Number(match[3]), rawTime: `${match[1]}T${match[2]}`, record: match[4] } : null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+[A-Z]\s+FawnG017TransportProof\[(\d+):[0-9a-f]+\]\s+\[com\.facebook\.react\.log:javascript\]\s+(G017_TRANSPORT_PROOF .+)$/.exec(line);
  return match ? { pid: Number(match[3]), rawTime: `${match[1]}T${match[2]}`, record: match[4] } : null;
}

function parseUtcOffset(value) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const total = (hours * 60 + minutes) * (match[1] === "+" ? 1 : -1);
  if (minutes > 59 || total < -12 * 60 || total > 14 * 60) return null;
  if ((total === -12 * 60 || total === 14 * 60) && minutes !== 0) return null;
  if (total === 0 && match[1] !== "+") return null;
  return total;
}

function localTimestampToUtc(rawTime, year, offsetMinutes) {
  const match = year === undefined
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(rawTime)
    : /^(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(rawTime);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  const [resolvedYear, month, day, hour, minute, second, millisecond] = year === undefined
    ? values
    : [year, ...values];
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(resolvedYear, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  if (wallClock.getUTCFullYear() !== resolvedYear
    || wallClock.getUTCMonth() !== month - 1
    || wallClock.getUTCDate() !== day
    || wallClock.getUTCHours() !== hour
    || wallClock.getUTCMinutes() !== minute
    || wallClock.getUTCSeconds() !== second
    || wallClock.getUTCMilliseconds() !== millisecond) return null;
  return wallClock.getTime() - offsetMinutes * 60_000;
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parseProofRecord(record, platform, fingerprint, failures) {
  if (Buffer.byteLength(record) > 4096) failures.push(`${platform} proof record exceeds byte limit`);
  let proof;
  try {
    proof = JSON.parse(record.slice(PREFIX.length));
  } catch {
    failures.push(`${platform} proof record is invalid JSON`);
    return;
  }
  if (!hasExactKeys(proof, ["schemaVersion", "contractId", "status", "platform", "targetScope", "release", "hermes", "newArchitecture", "profiles", "cancellation", "sourceFingerprint", "dependencies"])) failures.push(`${platform} proof contains unknown or missing fields`);
  if (proof?.schemaVersion !== 1 || proof?.contractId !== "for-mobile-g017-device-proof-v1") failures.push(`${platform} proof contract mismatch`);
  if (proof?.status !== "PASS") failures.push(`${platform} proof did not pass`);
  if (proof?.platform !== platform) failures.push(`${platform} proof platform mismatch`);
  if (proof?.targetScope !== "emulator-or-simulator-local-mock-only") failures.push(`${platform} proof overstates target scope`);
  if (proof?.release !== true || proof?.hermes !== true || proof?.newArchitecture !== true) failures.push(`${platform} runtime predicates failed`);
  if (proof?.sourceFingerprint !== fingerprint) failures.push(`${platform} source fingerprint is stale`);
  if (JSON.stringify(proof?.dependencies) !== JSON.stringify(EXPECTED_DEPENDENCIES)) failures.push(`${platform} dependency identity mismatch`);
  if (proof?.cancellation !== "cancelled") failures.push(`${platform} cancellation proof failed`);
  const expectedProfiles = [
    { profile: "profile-a", content: "profile-a ok" },
    { profile: "profile-b", content: "profile-b 宝宝 ok" },
  ];
  if (JSON.stringify(proof?.profiles) !== JSON.stringify(expectedProfiles)) failures.push(`${platform} profile outputs mismatch`);
}

export function validateProofText(text, platform, fingerprint) {
  const failures = [];
  if (Buffer.byteLength(text) > 256 * 1024) failures.push(`${platform} log exceeds byte limit`);
  if (SECRET.test(text)) failures.push(`${platform} log contains secret-like material`);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const raw = lines.map((line) => parseRawProofLine(line, platform)).filter(Boolean);
  if (raw.length !== 1) return [...failures, `${platform} log must contain exactly one platform-shaped raw OS proof line`];
  if (lines.some((line) => line.startsWith(PREFIX))) failures.push(`${platform} bare caller-authored proof records are forbidden`);
  parseProofRecord(raw[0].record, platform, fingerprint, failures);

  const offsetLines = lines.filter((line) => line.startsWith(OFFSET_PREFIX));
  const offsetMinutes = offsetLines.length === 1 ? parseUtcOffset(offsetLines[0].slice(OFFSET_PREFIX.length)) : null;
  if (offsetLines.length !== 1 || offsetMinutes === null) failures.push(`${platform} target UTC offset is missing or invalid`);
  const observed = lines.filter((line) => line.startsWith("G017_PROOF_OBSERVED_AT "));
  const observedAt = observed.length === 1 ? canonicalTimestamp(observed[0].slice("G017_PROOF_OBSERVED_AT ".length)) : null;
  if (observed.length !== 1 || observedAt === null) failures.push(`${platform} proof observation timestamp is missing or invalid`);
  const beginLines = lines.filter((line) => line.startsWith("G017_NATIVE_COMMAND_BEGIN "));
  const endLines = lines.filter((line) => line.startsWith("G017_NATIVE_COMMAND_END "));
  let begin;
  let end;
  try {
    if (beginLines.length === 1) begin = JSON.parse(beginLines[0].slice("G017_NATIVE_COMMAND_BEGIN ".length));
    if (endLines.length === 1) end = JSON.parse(endLines[0].slice("G017_NATIVE_COMMAND_END ".length));
  } catch {
    failures.push(`${platform} liveness command framing is invalid JSON`);
  }
  if (beginLines.length !== 1 || endLines.length !== 1 || !begin || !end) {
    failures.push(`${platform} log must retain exactly one native liveness command transcript`);
    return failures;
  }
  const beginIndex = lines.indexOf(beginLines[0]);
  const endIndex = lines.indexOf(endLines[0]);
  if (endIndex <= beginIndex) failures.push(`${platform} liveness transcript ordering is invalid`);
  const body = lines.slice(beginIndex + 1, endIndex);
  const startedAt = canonicalTimestamp(begin.startedAt);
  const endedAt = canonicalTimestamp(end.endedAt);
  if (!hasExactKeys(begin, ["id", "platform", "kind", "phase", "pid", "startedAt", "target", "command"]) || !hasExactKeys(end, ["id", "endedAt", "exitCode"])) failures.push(`${platform} liveness framing contains unknown or missing fields`);
  if (begin.id !== `${platform}-liveness` || end.id !== begin.id || begin.platform !== platform || begin.kind !== "liveness" || begin.phase !== "post-proof" || end.exitCode !== 0) {
    failures.push(`${platform} liveness command contract mismatch`);
  }
  if (!Number.isSafeInteger(begin.pid) || begin.pid <= 0 || begin.pid !== raw[0].pid) failures.push(`${platform} proof PID is detached from liveness`);
  if (startedAt === null || endedAt === null || observedAt === null || startedAt < observedAt || endedAt < startedAt) failures.push(`${platform} liveness timing does not follow proof observation`);
  if (observedAt !== null && offsetMinutes !== null) {
    const observedYear = new Date(observedAt).getUTCFullYear();
    const candidates = platform === "android"
      ? [observedYear - 1, observedYear, observedYear + 1].map((year) => localTimestampToUtc(raw[0].rawTime, year, offsetMinutes))
      : [localTimestampToUtc(raw[0].rawTime, undefined, offsetMinutes)];
    const matchingTimes = candidates.filter((value) => value !== null && value <= observedAt && observedAt - value <= 60_000);
    if (matchingTimes.length !== 1) failures.push(`${platform} raw proof timestamp is not uniquely bound to its observation`);
  }
  if (platform === "android") {
    if (begin.command !== "adb shell ps -A -o PID,NAME,ARGS" || begin.target !== "emulator") failures.push("android liveness command or target is invalid");
    const escaped = "com.luyao618.fawn.g017transportproof".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = body.filter((line) => new RegExp(`^\\s*${begin.pid}\\s+${escaped}\\s+${escaped}\\s*$`).test(line));
    if (matches.length !== 1 || body.length !== 2 || !/^\s*PID\s+NAME\s+ARGS\s*$/.test(body[0])) failures.push("android liveness output does not retain exactly one proof process row");
  } else {
    if (begin.command !== "xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=" || begin.target !== "simulator") failures.push("ios liveness command or target is invalid");
    const matches = body.filter((line) => new RegExp(`^\\s*${begin.pid}\\s+\\S+\\s+/.+\\.app/FawnG017TransportProof\\s*$`).test(line));
    if (matches.length !== 1 || body.length !== 1) failures.push("ios liveness output does not retain exactly one proof process row");
  }
  if (lines.some((line, index) => {
    if (parseRawProofLine(line, platform) !== null || line.startsWith(OFFSET_PREFIX) || line.startsWith("G017_PROOF_OBSERVED_AT ")) return false;
    if (index === beginIndex || index === endIndex || (index > beginIndex && index < endIndex)) return false;
    return true;
  })) failures.push(`${platform} log contains unframed caller-authored lines`);
  return failures;
}

function hermesCompilerPath(root) {
  const binary = process.platform === "darwin" ? "osx-bin/hermesc" : process.platform === "linux" ? "linux64-bin/hermesc" : "win64-bin/hermesc.exe";
  return resolve(root, "node_modules/hermes-compiler/hermesc", binary);
}

async function regularFile(path, label, failures) {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      failures.push(`${label} must be a non-symlink regular file`);
      return null;
    }
    return await readFile(path);
  } catch {
    failures.push(`${label} is missing`);
    return null;
  }
}

export async function validateExportArtifact(path, platform, fingerprint, root = REPO_ROOT) {
  const failures = [];
  const canonicalPath = resolve(root, `spikes/model-transport/.expo-export/${platform}`);
  if (resolve(path) !== canonicalPath) failures.push(`${platform} artifact is not at the canonical Expo export path`);
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return [...failures, `${platform} artifact is missing`];
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return [...failures, `${platform} artifact must be a non-symlink Expo export directory`];
  try {
    if (await realpath(path) !== canonicalPath) failures.push(`${platform} artifact canonical path is inconsistent`);
  } catch {
    failures.push(`${platform} artifact canonical path cannot be resolved`);
  }
  const metadataBytes = await regularFile(resolve(path, "metadata.json"), `${platform} metadata`, failures);
  const manifestBytes = await regularFile(resolve(path, "g017-proof-manifest.json"), `${platform} proof manifest`, failures);
  if (!metadataBytes || !manifestBytes) return failures;
  let metadata;
  let manifest;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return [...failures, `${platform} artifact metadata or proof manifest is invalid JSON`];
  }
  if (!hasExactKeys(metadata, ["version", "bundler", "fileMetadata"]) || !hasExactKeys(metadata?.fileMetadata, [platform]) || !hasExactKeys(metadata?.fileMetadata?.[platform], ["bundle", "assets"]) || !Array.isArray(metadata?.fileMetadata?.[platform]?.assets)) failures.push(`${platform} Expo metadata contains unknown or missing fields`);
  if (!hasExactKeys(manifest, ["schemaVersion", "contractId", "platform", "sourceFingerprint", "dependencies", "metadataSha256", "bundle"]) || !hasExactKeys(manifest?.bundle, ["path", "bytes", "sha256", "format"])) failures.push(`${platform} artifact manifest contains unknown or missing fields`);
  const bundlePath = metadata?.fileMetadata?.[platform]?.bundle;
  if (metadata?.version !== 0 || metadata?.bundler !== "metro" || typeof bundlePath !== "string") failures.push(`${platform} Expo metadata shape is invalid`);
  if (typeof bundlePath !== "string" || !new RegExp(`^_expo/static/js/${platform}/index-[a-f0-9]{32}\\.hbc$`).test(bundlePath)) {
    return [...failures, `${platform} artifact has no canonical platform Hermes bundle path`];
  }
  const bundleAbsolute = resolve(path, bundlePath);
  if (relative(path, bundleAbsolute).startsWith("..")) return [...failures, `${platform} bundle path escapes artifact`];
  const bundle = await regularFile(bundleAbsolute, `${platform} bundle`, failures);
  if (!bundle) return failures;
  try {
    if (await realpath(bundleAbsolute) !== bundleAbsolute) failures.push(`${platform} bundle canonical path is inconsistent`);
  } catch {
    failures.push(`${platform} bundle canonical path cannot be resolved`);
  }
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const metadataSha256 = createHash("sha256").update(metadataBytes).digest("hex");
  if (bundle.length < 100_000) failures.push(`${platform} Hermes bundle is implausibly small`);
  const compiler = hermesCompilerPath(root);
  const compilerStats = await regularFile(compiler, "Hermes bytecode validator", failures);
  if (compilerStats) {
    const inspected = spawnSync(compiler, ["-dump-bytecode", bundleAbsolute], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (inspected.error || inspected.status !== 0 || !/Bytecode File Information|Function<global>/i.test(`${inspected.stdout}\n${inspected.stderr}`)) {
      failures.push(`${platform} bundle failed Hermes bytecode validation`);
    }
  }
  if (manifest?.schemaVersion !== 1 || manifest?.contractId !== "for-mobile-g017-expo-export-v1" || manifest?.platform !== platform) failures.push(`${platform} artifact manifest contract mismatch`);
  if (manifest?.sourceFingerprint !== fingerprint || !bundle.includes(Buffer.from(fingerprint))) failures.push(`${platform} artifact does not embed current source fingerprint`);
  if (JSON.stringify(manifest?.dependencies) !== JSON.stringify(EXPECTED_DEPENDENCIES)) failures.push(`${platform} artifact dependency identity mismatch`);
  for (const value of Object.values(EXPECTED_DEPENDENCIES)) if (!bundle.includes(Buffer.from(value))) failures.push(`${platform} bundle does not embed dependency ${value}`);
  if (manifest?.metadataSha256 !== metadataSha256) failures.push(`${platform} artifact metadata hash mismatch`);
  if (manifest?.bundle?.path !== bundlePath || manifest?.bundle?.bytes !== bundle.length || manifest?.bundle?.sha256 !== bundleSha256 || manifest?.bundle?.format !== "hermes-bytecode") failures.push(`${platform} artifact bundle manifest mismatch`);
  const topLevel = (await readdir(path)).sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(["_expo", "g017-proof-manifest.json", "metadata.json"])) failures.push(`${platform} artifact contains unexpected top-level entries`);
  return failures;
}

export async function validateG017Evidence({ androidLog, iosLog, androidArtifact, iosArtifact, root = REPO_ROOT }) {
  const fingerprint = await computeG017SourceFingerprint(root);
  const failures = [];
  for (const [platform, logPath, artifactPath] of [
    ["android", androidLog, androidArtifact],
    ["ios", iosLog, iosArtifact],
  ]) {
    if (!logPath || !artifactPath) {
      failures.push(`${platform} log and artifact are required`);
      continue;
    }
    const logBytes = await regularFile(logPath, `${platform} evidence log`, failures);
    if (logBytes) failures.push(...validateProofText(logBytes.toString("utf8"), platform, fingerprint));
    failures.push(...await validateExportArtifact(artifactPath, platform, fingerprint, root));
  }
  return Object.freeze({ status: failures.length === 0 ? "PASS" : "FAIL", fingerprint, failures });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--fingerprint")) {
    console.log(await computeG017SourceFingerprint());
  } else {
    const result = await validateG017Evidence({
      androidLog: option("--android-log"),
      iosLog: option("--ios-log"),
      androidArtifact: option("--android-artifact"),
      iosArtifact: option("--ios-artifact"),
    });
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
    if (result.status !== "PASS") process.exitCode = 1;
  }
}
