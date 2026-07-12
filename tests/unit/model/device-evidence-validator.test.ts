import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  G017_SOURCE_PATHS,
  computeG017SourceFingerprint,
  validateExportArtifact,
  validateG017Evidence,
  validateProofText,
} from "../../../spikes/model-transport/deviceEvidenceValidator.mjs";

function proofRecord(platform: "android" | "ios", fingerprint: string) {
  return `G017_TRANSPORT_PROOF ${JSON.stringify({
    schemaVersion: 1,
    contractId: "for-mobile-g017-device-proof-v1",
    status: "PASS",
    platform,
    targetScope: "emulator-or-simulator-local-mock-only",
    release: true,
    hermes: true,
    newArchitecture: true,
    profiles: [
      { profile: "profile-a", content: "profile-a ok" },
      { profile: "profile-b", content: "profile-b 宝宝 ok" },
    ],
    cancellation: "cancelled",
    sourceFingerprint: fingerprint,
    dependencies: { expo: "57.0.4", react: "19.2.3", reactNative: "0.86.0", eventsourceParser: "3.1.0" },
  })}`;
}

function proofLog(
  platform: "android" | "ios",
  fingerprint: string,
  options: { pid?: number; rawTime?: string; observedAt?: string; offset?: string } = {},
) {
  const pid = options.pid ?? (platform === "android" ? 1601 : 1602);
  const rawTime = options.rawTime ?? (platform === "android" ? "07-12 00:00:05.000" : "2026-07-12 00:00:05.000");
  const observedAt = options.observedAt ?? "2026-07-12T00:00:05.100Z";
  const observedMs = Date.parse(observedAt);
  const record = proofRecord(platform, fingerprint);
  const raw = platform === "android"
    ? `${rawTime}  ${pid}  1701 I ReactNativeJS: ${record}`
    : `${rawTime} I FawnG017TransportProof[${pid}:3e8] [com.facebook.react.log:javascript] ${record}`;
  const command = platform === "android" ? "adb shell ps -A -o PID,NAME,ARGS" : "xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=";
  const target = platform === "android" ? "emulator" : "simulator";
  const body = platform === "android"
    ? `  PID NAME ARGS\n ${pid} com.luyao618.fawn.g017transportproof com.luyao618.fawn.g017transportproof`
    : ` ${pid} Ss /Users/test/Containers/Bundle/Application/fixture/FawnG017TransportProof.app/FawnG017TransportProof`;
  return [
    raw,
    `G017_TARGET_UTC_OFFSET ${options.offset ?? "+00:00"}`,
    `G017_PROOF_OBSERVED_AT ${observedAt}`,
    `G017_NATIVE_COMMAND_BEGIN ${JSON.stringify({ id: `${platform}-liveness`, platform, kind: "liveness", phase: "post-proof", pid, startedAt: new Date(observedMs + 900).toISOString(), target, command })}`,
    body,
    `G017_NATIVE_COMMAND_END ${JSON.stringify({ id: `${platform}-liveness`, endedAt: new Date(observedMs + 1_000).toISOString(), exitCode: 0 })}`,
    "",
  ].join("\n");
}

async function writeSyntheticArtifact(root: string, platform: "android" | "ios", fingerprint: string) {
  const bundlePath = `_expo/static/js/${platform}/index-${(platform === "android" ? "a" : "b").repeat(32)}.hbc`;
  const directory = join(root, `${platform}-export`);
  const metadata = { version: 0, bundler: "metro", fileMetadata: { [platform]: { bundle: bundlePath, assets: [] } } };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const embedded = [fingerprint, "57.0.4", "19.2.3", "0.86.0", "3.1.0", "G017_TRANSPORT_PROOF"].join("\0");
  const bundle = Buffer.concat([Buffer.from("c61fbc03c103191f", "hex"), Buffer.from(embedded), Buffer.alloc(110_000, 1)]);
  const manifest = {
    schemaVersion: 1,
    contractId: "for-mobile-g017-expo-export-v1",
    platform,
    sourceFingerprint: fingerprint,
    dependencies: { expo: "57.0.4", react: "19.2.3", reactNative: "0.86.0", eventsourceParser: "3.1.0" },
    metadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
    bundle: { path: bundlePath, bytes: bundle.length, sha256: createHash("sha256").update(bundle).digest("hex"), format: "hermes-bytecode" },
  };
  await mkdir(join(directory, `_expo/static/js/${platform}`), { recursive: true });
  await Promise.all([
    writeFile(join(directory, "metadata.json"), metadataBytes),
    writeFile(join(directory, "g017-proof-manifest.json"), JSON.stringify(manifest)),
    writeFile(join(directory, bundlePath), bundle),
  ]);
  return directory;
}


test("Metro selected resolver values equal Expo defaults with no explicit root fallback", async () => {
  const projectRoot = resolve("spikes/model-transport");
  const spikeRequire = createRequire(resolve(projectRoot, "package.json"));
  const { getDefaultConfig } = spikeRequire("expo/metro-config");
  const config = spikeRequire("./metro.config.cjs");
  const defaults = getDefaultConfig(projectRoot);
  assert.deepEqual(config.watchFolders, defaults.watchFolders);
  assert.deepEqual(config.resolver.nodeModulesPaths, defaults.resolver.nodeModulesPaths);
  assert.equal(config.resolver.disableHierarchicalLookup, defaults.resolver.disableHierarchicalLookup);
  const source = await readFile(resolve(projectRoot, "metro.config.cjs"), "utf8");
  assert.doesNotMatch(source, /workspaceRoot|nodeModulesPaths|disableHierarchicalLookup/);
});

test("platform-shaped proof and retained PID liveness are required", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  assert.deepEqual(validateProofText(proofLog("android", fingerprint), "android", fingerprint), []);
  assert.deepEqual(validateProofText(proofLog("ios", fingerprint), "ios", fingerprint), []);
  assert.match(validateProofText(`${proofRecord("android", fingerprint)}\n`, "android", fingerprint).join("; "), /platform-shaped/);
  assert.match(validateProofText(proofLog("android", fingerprint).replace(" 1601 com.luyao618", " 9999 com.luyao618"), "android", fingerprint).join("; "), /liveness output/);
  assert.match(validateProofText(proofLog("ios", fingerprint).replace("00:00:05.000", "00:02:05.000"), "ios", fingerprint).join("; "), /timestamp/);
});

test("proof logs require exactly one canonical bounded target UTC offset", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  const valid = proofLog("android", fingerprint);
  assert.match(validateProofText(valid.replace("G017_TARGET_UTC_OFFSET +00:00\n", ""), "android", fingerprint).join("; "), /target UTC offset/);
  for (const malformed of ["UTC+08:00", "+8:00", "+14:01", "-12:01", "-00:00"]) {
    assert.match(validateProofText(valid.replace("+00:00", malformed), "android", fingerprint).join("; "), /target UTC offset/);
  }
  assert.match(validateProofText(valid.replace("G017_TARGET_UTC_OFFSET +00:00", "G017_TARGET_UTC_OFFSET +00:00\nG017_TARGET_UTC_OFFSET +00:00"), "android", fingerprint).join("; "), /target UTC offset/);
});

test("UTC+8 and UTC-8 target-local timestamps normalize before observation checks", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  for (const platform of ["android", "ios"] as const) {
    const positiveRaw = platform === "android" ? "07-12 08:00:05.000" : "2026-07-12 08:00:05.000";
    const negativeRaw = platform === "android" ? "07-11 16:00:05.000" : "2026-07-11 16:00:05.000";
    assert.deepEqual(validateProofText(proofLog(platform, fingerprint, { rawTime: positiveRaw, offset: "+08:00" }), platform, fingerprint), []);
    assert.deepEqual(validateProofText(proofLog(platform, fingerprint, { rawTime: negativeRaw, offset: "-08:00" }), platform, fingerprint), []);
  }
});

test("target-local timestamps bind uniquely across a UTC year boundary", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  assert.deepEqual(validateProofText(proofLog("android", fingerprint, {
    rawTime: "01-01 00:00:05.000",
    observedAt: "2025-12-31T16:00:05.100Z",
    offset: "+08:00",
  }), "android", fingerprint), []);
  assert.deepEqual(validateProofText(proofLog("ios", fingerprint, {
    rawTime: "2025-12-31 16:00:05.000",
    observedAt: "2026-01-01T00:00:05.100Z",
    offset: "-08:00",
  }), "ios", fingerprint), []);
});

test("raw local calendars accept leap days and reject impossible rollover dates", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  for (const platform of ["android", "ios"] as const) {
    const leapRaw = platform === "android" ? "02-29 12:00:05.000" : "2028-02-29 12:00:05.000";
    const impossibleRaw = platform === "android" ? "02-30 12:00:05.000" : "2028-02-30 12:00:05.000";
    const options = { observedAt: "2028-02-29T12:00:05.100Z", rawTime: leapRaw };
    assert.deepEqual(validateProofText(proofLog(platform, fingerprint, options), platform, fingerprint), []);
    assert.match(validateProofText(proofLog(platform, fingerprint, { ...options, rawTime: impossibleRaw }), platform, fingerprint).join("; "), /timestamp/);
  }
  assert.match(validateProofText(proofLog("ios", fingerprint, {
    rawTime: "2027-02-29 12:00:05.000",
    observedAt: "2027-03-01T12:00:05.100Z",
  }), "ios", fingerprint).join("; "), /timestamp/);
});

test("fully synthetic artifacts and symlinked proof inputs fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "g017-forged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fingerprint = await computeG017SourceFingerprint();
  const androidLog = join(root, "android.log");
  const iosLog = join(root, "ios.log");
  const linkedAndroidLog = join(root, "android-linked.log");
  await Promise.all([writeFile(androidLog, proofLog("android", fingerprint)), writeFile(iosLog, proofLog("ios", fingerprint))]);
  await symlink(androidLog, linkedAndroidLog);
  const androidArtifact = await writeSyntheticArtifact(root, "android", fingerprint);
  const iosArtifact = await writeSyntheticArtifact(root, "ios", fingerprint);
  const result = await validateG017Evidence({ androidLog: linkedAndroidLog, iosLog, androidArtifact, iosArtifact });
  assert.equal(result.status, "FAIL");
  assert.match(result.failures.join("; "), /non-symlink regular file|canonical Expo export path|Hermes bytecode validation/);
});

test("fresh canonical Android and iOS exports pass Hermes validation and local-consistency evidence", async (t) => {
  const spikeExpo = resolve("spikes/model-transport/.expo");
  const exportRoot = resolve("spikes/model-transport/.expo-export");
  await Promise.all([
    rm(spikeExpo, { recursive: true, force: true }),
    rm(exportRoot, { recursive: true, force: true }),
  ]);
  t.after(() => Promise.all([
    rm(spikeExpo, { recursive: true, force: true }),
    rm(exportRoot, { recursive: true, force: true }),
  ]));
  for (const platform of ["android", "ios"] as const) {
    const exported = spawnSync("npm", ["run", `g017:export:${platform}`, "--silent"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    assert.equal(exported.status, 0, `${platform} export failed: ${exported.stderr}`);
  }
  const fingerprint = await computeG017SourceFingerprint();
  for (const platform of ["android", "ios"] as const) {
    assert.deepEqual(await validateExportArtifact(resolve(exportRoot, platform), platform, fingerprint), []);
  }
  const logs = await mkdtemp(join(tmpdir(), "g017-real-export-"));
  t.after(() => rm(logs, { recursive: true, force: true }));
  const androidLog = join(logs, "android.log");
  const iosLog = join(logs, "ios.log");
  await Promise.all([writeFile(androidLog, proofLog("android", fingerprint)), writeFile(iosLog, proofLog("ios", fingerprint))]);
  const result = await validateG017Evidence({
    androidLog,
    iosLog,
    androidArtifact: resolve(exportRoot, "android"),
    iosArtifact: resolve(exportRoot, "ios"),
  });
  assert.equal(result.status, "PASS", result.failures.join("; "));
});

test("G017 source boundary remains exactly 41 unique existing paths", async () => {
  assert.equal(G017_SOURCE_PATHS.length, 41);
  assert.equal(new Set(G017_SOURCE_PATHS).size, 41);
  assert(G017_SOURCE_PATHS.includes(".gitignore"));
  assert(G017_SOURCE_PATHS.includes("tools/redaction.d.mts"));
  for (const path of G017_SOURCE_PATHS) await assert.doesNotReject(readFile(resolve(path)), path);
});
