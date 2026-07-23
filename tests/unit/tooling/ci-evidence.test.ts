import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import * as ciEvidence from "../../../tools/collect-ci-evidence.mjs";
import {
  assertCleanTrackedStatus,
  CI_EVIDENCE_SCHEMA_VERSION,
  CLEAN_REPOSITORY_STATUS_ARGS,
  collectFaultBundleEvidence,
  collectProfileRestartEvidence,
  collectProfilePrivacyProof,
  validateNativeReports,
  validateProfileRestartReport,
  validateTestResultInput,
  validatePersistenceReport,
} from "../../../tools/collect-ci-evidence.mjs";
import { NATIVE_EVIDENCE_PATHS, NATIVE_SCHEME_PLACEMENTS } from "../../../tools/check-native-schemes.mjs";
import {
  canonicalJson,
  collectTrackerPrivacyProof,
  deriveTrackerFixture,
  migrationIdentity,
  snapshotTrackerDatabase,
  validateCanonicalTrackerReportBytes,
} from "../../../tools/tracker-evidence.mjs";

const sha = "a".repeat(40);
const opening = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity">`;
const filter = `<intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="formobile-test"/></intent-filter>`;
const closing = `</activity></application></manifest>`;
const productionBytes = opening + closing;
const e2eBytes = opening + filter + closing;

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function fileIdentity(path: string, root = resolve(".")) {
  return { path, sha256: hash(requireFile(join(root, path))) };
}

function requireFile(path: string) {
  return readFileSync(path);
}

function trackerAccessibility(platform: "android" | "ios") {
  return {
    selectorPolicy: {
      allowedKinds: ["id", "textBelowText", "exactText"], anchoredSelectorCount: 47,
      coordinateTapCount: 0, indexSelectorCount: 0, ambiguousSelectorCount: 0,
      optionalCommandCount: 0, retryCommandCount: 0, sleepCommandCount: 0,
    },
    keyboardDismissal: {
      strategy: platform === "android"
        ? "maestro-hideKeyboard-then-entered-value-below-field"
        : "maestro-down-swipe-then-entered-value-below-field",
      mandatory: true,
    },
    nativeObservations: {
      healthConfirmationEntered: true, healthCancelReturnedToEditor: true,
      healthEditorFieldsUnchanged: true, healthCheckupConfirmationFieldObservedWithoutRetap: true,
      healthSecondSubmitObserved: true, healthFinalConfirmationObserved: true,
      feedingFormulaCreatedRowObserved: true, feedingNinetyToHundredDiffObserved: true,
      feedingUpdateFinalConfirmationObserved: true, sleepNightCreatedRowObserved: true,
      diaperMixedCreatedRowObserved: true, diaperDeleteIdentifyingSummaryObserved: true,
      diaperConsequenceObserved: true, diaperFinalConfirmationObserved: true,
      relaunchActiveRowsObserved: true, relaunchDiaperAbsentObserved: true,
    },
    claims: { physicalDevice: false, screenReader: false, e2e006: false },
  };
}

async function trackerReportFixture(platform: "android" | "ios", root = resolve(".")) {
  const directory = await mkdtemp(join(tmpdir(), "g035-c3-tracker-report-"));
  try {
  const migrationSource = await readFile(join(root, "src/infrastructure/db/migrations/migration1.ts"), "utf8");
  const prefix = "export const MIGRATION_1_SQL = String.raw`";
  const start = migrationSource.indexOf(prefix);
  const end = migrationSource.indexOf("`;\n\nexport const MIGRATION_1_SHA256", start + prefix.length);
  assert(start >= 0 && end > start, "Tracker migration source is malformed");
  const createDatabase = (path: string, populated: boolean) => {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    database.exec(migrationSource.slice(start + prefix.length, end));
    database.prepare("INSERT INTO schema_migrations(version, name, sha256, applied_at) VALUES (?, ?, ?, ?)").run(
      1,
      "initial-schema",
      "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec",
      "2026-07-20T00:00:00.000Z",
    );
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    if (populated) database.exec(`BEGIN IMMEDIATE;
      INSERT INTO growth_records VALUES ('tracker-growth-c3','2026-07-19',7200,68.5,43.2,NULL,NULL,NULL,'synthetic growth',NULL,'2026-07-20T01:10:00.000Z','2026-07-20T01:10:00.000Z',NULL);
      INSERT INTO feeding_records VALUES ('tracker-feeding-c3','2026-07-20T00:10:00.000Z','formula',100,NULL,'synthetic feeding',NULL,'2026-07-20T01:11:00.000Z','2026-07-20T01:16:00.000Z',NULL);
      INSERT INTO sleep_records VALUES ('tracker-sleep-c3','2026-07-19T20:00:00.000Z','2026-07-20T01:00:00.000Z','night',2,'synthetic sleep',NULL,'2026-07-20T01:12:00.000Z','2026-07-20T01:12:00.000Z',NULL);
      INSERT INTO diaper_records VALUES ('tracker-diaper-c3','2026-07-20T00:20:00.000Z','mixed','synthetic diaper',NULL,'2026-07-20T01:13:00.000Z','2026-07-20T01:17:00.000Z','2026-07-20T01:17:00.000Z');
      INSERT INTO health_records VALUES ('tracker-health-c3','2026-07-18','checkup','Synthetic checkup','synthetic health',NULL,'2026-07-20T01:14:00.000Z','2026-07-20T01:14:00.000Z',NULL);
      COMMIT;`);
    database.close();
  };
  const prePath = join(directory, "pre.db");
  const postPath = join(directory, "post.db");
  createDatabase(prePath, false);
  createDatabase(postPath, true);
  const preSave = snapshotTrackerDatabase(prePath);
  const postSave = snapshotTrackerDatabase(postPath);
  const fixture = deriveTrackerFixture("Asia/Shanghai", root);
  const binaryValue = platform === "android"
    ? { apkSha256: "1".repeat(64), embeddedBundleSha256: "2".repeat(64) }
    : { executableSha256: "1".repeat(64), mainJsBundleSha256: "2".repeat(64), infoPlistCanonicalSha256: "3".repeat(64) };
  const phase = (pid: number) => ({ pid, terminated: true, absentBeforeSnapshot: true });
  const report = {
    schemaVersion: 1, reportType: "manual-tracker-offline-restart", platform,
    flavor: "e2e-release", checkedOutSha: sha, expectedSha: sha, testId: "G025-E2E-001",
    fixture, accessibility: trackerAccessibility(platform),
    binary: {
      format: platform === "android" ? "apk" : "ios-three-component-identity",
      source: binaryValue, installedBefore: { ...binaryValue }, installedAfter: { ...binaryValue },
    },
    database: { preSave, postSave, postRelaunch: structuredClone(postSave) },
    lifecycle: {
      metro: { ownedPid: 456, terminatedBeforeTracker: true, probeBeforeTrackerFailed: true, probeBeforeReportFailed: true },
      androidReverse: platform === "android"
        ? { port: 8081, absentBeforeTracker: true, absentBeforeReport: true }
        : null,
      directLaunches: { preSave: phase(101), save: phase(202), relaunch: phase(303) },
      zoneObservations: { preSave: "Asia/Shanghai", postSave: "Asia/Shanghai", postRelaunch: "Asia/Shanghai" },
      freshInstallCount: 1,
      postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 },
      saveRelaunchPidDifferent: true,
      restartProof: platform === "android"
        ? "terminated-snapshot-direct-relaunch-same-installed-apk"
        : "terminated-snapshot-direct-relaunch-same-ios-three-component-identity",
    },
    privacy: collectTrackerPrivacyProof({
      preSave: preSave.modelCounts, postSave: postSave.modelCounts, postRelaunch: postSave.modelCounts,
    }, root),
    migration: migrationIdentity(root),
    evidence: {
      flows: {
        saveEditDelete: fileIdentity("e2e/maestro/tracker-save-edit-delete.yaml", root),
        restart: fileIdentity("e2e/maestro/tracker-restart.yaml", root),
      },
      fixture: fileIdentity("tests/fixtures/tracker/manual-tracker-v1.json", root),
      tool: fileIdentity("tools/tracker-evidence.mjs", root),
      runner: fileIdentity(`scripts/e2e/run-tracker-restart-${platform}.sh`, root),
    },
    status: "pass", skipped: [],
  };
  const bytes = Buffer.from(canonicalJson(report));
  validateCanonicalTrackerReportBytes(bytes, platform, sha, root);
  return { directory, report, bytes };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function collectorCliFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "g035-c3-collector-cli-")));
  try {
  const files = [
    "tools/collect-ci-evidence.mjs", "tools/check-app-config.mjs",
    "tools/check-fault-bundles.mjs", "tools/check-native-schemes.mjs", "tools/tracker-evidence.mjs",
    "src/testing/faultPoints.json",
  ];
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await copyFile(file, join(root, file));
  }
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  const trackerModulePath = join(root, "tools/tracker-evidence.mjs");
  const trackerModule = await import(`${pathToFileURL(trackerModulePath).href}?fixture-self-check=1`);
  assert.equal(typeof trackerModule.validateCanonicalTrackerReportBytes, "function",
    "Isolated collector fixture cannot import its copied tracker validator");
  const bin = join(root, "bin");
  await mkdir(bin);
  const fakeGit = join(bin, "git");
  await writeFile(fakeGit, `#!/usr/bin/env bash
case "$1" in
  rev-parse) printf '%s\\n' ${JSON.stringify(sha)} ;;
  status) exit 0 ;;
  *) exec /usr/bin/git "$@" ;;
esac
`);
  await chmod(fakeGit, 0o755);
  const resultPath = join(root, "result.log");
  await writeFile(resultPath, "pass\n");
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, "tools/collect-ci-evidence.mjs"),
    "--expected-sha", sha, "--flavor", args.includes("host") ? "static" : "e2e",
    "--test-result", "pass", "--test-result-file", resultPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  return { root, resultPath, run };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function copyIntoRoot(root: string, path: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await copyFile(path, join(root, path));
}

function startupPersistenceReport(platform: "android" | "ios", migrationSha: string) {
  const snapshot = {
    sha256: "c".repeat(64), migration: [{ version: 1, name: "initial-schema", sha256: migrationSha }], journalMode: "wal",
    objectTypes: [{ type: "index", total: 14 }, { type: "table", total: 26 }, { type: "trigger", total: 3 }],
    meta: null, jobs: [], turns: [], tasks: [],
  };
  const recovered = {
    ...snapshot,
    meta: { value_json: '"preserved"' },
    jobs: [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }],
    turns: [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }],
    tasks: [{ id: "e2e-p", status: "expired" }],
  };
  const poison = poisonSnapshot();
  return {
    schemaVersion: 2, reportType: "startup-persistence", platform,
    checkedOutSha: sha, expectedSha: sha, migrationSha256: migrationSha, skipped: [],
    scenarios: {
      firstOpen: { status: "pass", snapshot },
      recoveryRelaunch: { status: "pass", snapshot: structuredClone(recovered), noOpSnapshot: structuredClone(recovered) },
      migrationHashRetry: { status: "pass", snapshot: structuredClone(recovered) },
      failedMigrationRollback: {
        status: "pass", collisionObject: "chat_turns",
        beforeSnapshot: structuredClone(poison), afterSnapshot: structuredClone(poison),
      },
    },
  };
}

async function collectorSuccessFixture(platform: "host" | "android" | "ios") {
  const fixture = await collectorCliFixture();
  let trackerFixture: Awaited<ReturnType<typeof trackerReportFixture>> | null = null;
  try {
    await writeFile(join(fixture.root, "tools/check-app-config.mjs"),
      "export function validateResolvedConfigs() {}\n");
    await writeFile(join(fixture.root, "tools/check-fault-bundles.mjs"),
      "export async function validateFaultBundleProof(report) { return report.bundles; }\n");
    await writeFile(join(fixture.root, "tools/check-native-schemes.mjs"), `import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export const NATIVE_EVIDENCE_PATHS = {
  android: { production: ".artifacts/native/android/production/AndroidManifest.xml", e2e: ".artifacts/native/android/e2e/AndroidManifest.xml" },
  ios: { production: ".artifacts/native/ios/production/Info.plist", e2e: ".artifacts/native/ios/e2e/Info.plist" },
};
export async function inspectNativeScheme(platform, flavor, input) {
  const bytes = await readFile(input);
  return {
    nativeInputSha256: createHash("sha256").update(bytes).digest("hex"),
    structure: { scheme: "formobile-test", count: flavor === "e2e" ? 1 : 0, placement: \`stub-\${platform}\` },
  };
}
`);

    const listed = spawnSync("/usr/bin/git", ["ls-files", "-z", "App*", "index*", "src/**", "app.config.*"], {
      cwd: resolve("."), encoding: "buffer",
    });
    assert.equal(listed.status, 0, listed.stderr.toString("utf8"));
    const runtimeFiles = listed.stdout.toString("utf8").split("\0").filter(Boolean);
    for (const path of runtimeFiles) await copyIntoRoot(fixture.root, path);
    for (const path of [
      "package-lock.json", "knowledge/manifest.public.yaml", "knowledge/manifest.private.yaml",
      "knowledge/sources/who-growth/source-manifest.json", "tests/fixtures/tracker/manual-tracker-v1.json",
      "e2e/maestro/profile-save.yaml", "e2e/maestro/profile-restart.yaml",
      "e2e/maestro/tracker-save-edit-delete.yaml", "e2e/maestro/tracker-restart.yaml",
      "scripts/e2e/run-tracker-restart-android.sh", "scripts/e2e/run-tracker-restart-ios.sh",
    ]) await copyIntoRoot(fixture.root, path);
    for (const args of [["init", "--quiet"], ["add", "--", ...runtimeFiles]] as const) {
      const result = spawnSync("/usr/bin/git", args, { cwd: fixture.root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const trackedList = join(fixture.root, "tracked-files.bin");
    await writeFile(trackedList, listed.stdout);
    const fakeGit = join(fixture.root, "bin/git");
    await writeFile(fakeGit, `#!/usr/bin/env bash
case "$1" in
  rev-parse) printf '%s\\n' ${JSON.stringify(sha)} ;;
  status) exit 0 ;;
  ls-files) /bin/cat ${JSON.stringify(trackedList)} ;;
  *) exit 1 ;;
esac
`);
    await chmod(fakeGit, 0o755);

    const output = `.artifacts/${platform}-success.json`;
    if (platform === "host") {
      const proof = ".artifacts/fault-bundles/proof.json";
      await mkdir(dirname(join(fixture.root, proof)), { recursive: true });
      await writeFile(join(fixture.root, proof), JSON.stringify({ bundles: { stub: true } }));
      return {
        ...fixture, output, trackerFixture,
        args: ["--platform", "host", "--fault-bundle-proof", proof, "--output", output],
      };
    }

    for (const flavor of ["production", "e2e"] as const) {
      const nativePath = `.artifacts/native/${platform}/${flavor}/${platform === "android" ? "AndroidManifest.xml" : "Info.plist"}`;
      const nativeBytes = Buffer.from(`${platform}-${flavor}-native`);
      await mkdir(dirname(join(fixture.root, nativePath)), { recursive: true });
      await writeFile(join(fixture.root, nativePath), nativeBytes);
      const configPath = `.artifacts/config/${platform}-${flavor}.json`;
      const config = flavor === "production" ? baseConfig() : { ...baseConfig(), scheme: "formobile-test", extra: { e2eFaults: true } };
      await mkdir(dirname(join(fixture.root, configPath)), { recursive: true });
      await writeFile(join(fixture.root, configPath), JSON.stringify({
        schemaVersion: 1, reportType: "resolved-app-config", platform, flavor,
        checkedOutSha: sha, expectedSha: sha, configSha256: hash(JSON.stringify(config)), config,
      }));
      const schemePath = `.artifacts/schemes/${platform}-${flavor}.json`;
      await mkdir(dirname(join(fixture.root, schemePath)), { recursive: true });
      await writeFile(join(fixture.root, schemePath), JSON.stringify({
        schemaVersion: 1, reportType: "native-scheme", platform, flavor,
        checkedOutSha: sha, expectedSha: sha, scheme: "formobile-test",
        count: flavor === "e2e" ? 1 : 0, placement: `stub-${platform}`,
        nativeInput: { path: nativePath, sha256: hash(nativeBytes) },
      }));
    }
    const migrationSource = await readFile(join(fixture.root, "src/infrastructure/db/migrations/migration1.ts"), "utf8");
    const migrationMatch = /export const MIGRATION_1_SHA256 = "([0-9a-f]{64})"/.exec(migrationSource);
    assert(migrationMatch);
    const persistencePath = `.artifacts/${platform}-persistence.json`;
    await writeFile(join(fixture.root, persistencePath), JSON.stringify(startupPersistenceReport(platform, migrationMatch[1])));
    const profilePath = `.artifacts/${platform}-profile-restart.json`;
    const profile = await profileReport(platform, fixture.root);
    await writeFile(join(fixture.root, profilePath), JSON.stringify(profile));
    trackerFixture = await trackerReportFixture(platform, fixture.root);
    const trackerPath = `.artifacts/${platform}-tracker-restart.json`;
    await writeFile(join(fixture.root, trackerPath), trackerFixture.bytes);
    return {
      ...fixture, output, trackerFixture, profile, profilePath, trackerPath,
      args: [
        "--platform", platform,
        "--config-report-production", `.artifacts/config/${platform}-production.json`,
        "--config-report-e2e", `.artifacts/config/${platform}-e2e.json`,
        "--scheme-report-production", `.artifacts/schemes/${platform}-production.json`,
        "--scheme-report-e2e", `.artifacts/schemes/${platform}-e2e.json`,
        "--persistence-report", persistencePath,
        "--profile-restart-report", profilePath,
        "--tracker-restart-report", trackerPath,
        "--output", output,
      ],
    };
  } catch (error) {
    if (trackerFixture) await rm(trackerFixture.directory, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    throw error;
  }
}

function baseConfig() {
  return {
    name: "For Mobile",
    slug: "for-mobile",
    version: "0.1.0",
    userInterfaceStyle: "light",
    android: { package: "com.luyao618.formobile", softwareKeyboardLayoutMode: "resize" },
    ios: { bundleIdentifier: "com.luyao618.formobile", supportsTablet: true },
    plugins: ["@react-native-vector-icons/lucide", ["expo-secure-store", { configureAndroidBackup: true, faceIDPermission: false }], ["expo-dev-client", { toolsButton: false, skipOnboarding: true, showMenuAtLaunch: false }]],
    sdkVersion: "57.0.0",
    platforms: ["ios", "android"],
  };
}

function configReport(flavor: "production" | "e2e") {
  const config: any = baseConfig();
  if (flavor === "e2e") {
    config.scheme = "formobile-test";
    config.extra = { e2eFaults: true };
  }
  return { schemaVersion: 1, reportType: "resolved-app-config", platform: "android", flavor, checkedOutSha: sha, expectedSha: sha, configSha256: hash(JSON.stringify(config)), config };
}

function schemeReport(flavor: "production" | "e2e", bytes: string) {
  return {
    schemaVersion: 1,
    reportType: "native-scheme",
    platform: "android",
    flavor,
    checkedOutSha: sha,
    expectedSha: sha,
    scheme: "formobile-test",
    count: flavor === "e2e" ? 1 : 0,
    placement: NATIVE_SCHEME_PLACEMENTS.android,
    nativeInput: { path: NATIVE_EVIDENCE_PATHS.android[flavor], sha256: hash(bytes) },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "g018-evidence-"));
  for (const [flavor, bytes] of [["production", productionBytes], ["e2e", e2eBytes]] as const) {
    const path = join(root, NATIVE_EVIDENCE_PATHS.android[flavor]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return {
    root,
    value: {
      platform: "android",
      expectedSha: sha,
      root,
      configReports: { production: configReport("production"), e2e: configReport("e2e") },
      schemeReports: { production: schemeReport("production", productionBytes), e2e: schemeReport("e2e", e2eBytes) },
    },
  };
}

function rehashConfig(report: any) {
  report.configSha256 = hash(JSON.stringify(report.config));
}

test("CI evidence reparses and hashes both canonical retained native files", async () => {
  const { root, value } = await fixture();
  try {
    const result: any = await validateNativeReports(value);
    assert.equal(result.scheme.production.count, 0);
    assert.equal(result.scheme.e2e.count, 1);
    assert.equal(result.nativeFiles.production.path, NATIVE_EVIDENCE_PATHS.android.production);
    assert.equal(result.nativeFiles.production.sha256, hash(productionBytes));
    assert.equal(result.nativeFiles.e2e.sha256, hash(e2eBytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI evidence rejects forged config identity, privacy, plugins, native placement, paths, and counts", async () => {
  const mutations = [
    (value: any) => { value.configReports.production.config.android.package = "com.attacker.fake"; rehashConfig(value.configReports.production); },
    (value: any) => { value.configReports.e2e.config.ios.infoPlist = { NSCameraUsageDescription: "fake" }; rehashConfig(value.configReports.e2e); },
    (value: any) => { value.configReports.production.config.plugins = []; rehashConfig(value.configReports.production); },
    (value: any) => { value.schemeReports.production.placement = "not-structural"; },
    (value: any) => { value.schemeReports.e2e.nativeInput.path = "android/app/src/main/AndroidManifest.xml"; },
    (value: any) => { delete value.schemeReports.production.nativeInput.path; },
    (value: any) => { value.schemeReports.e2e.count = 0; },
    (value: any) => { value.schemeReports.production = null; },
  ];
  for (const mutate of mutations) {
    const { root, value } = await fixture();
    try {
      mutate(value);
      await assert.rejects(validateNativeReports(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});


test("CI evidence rejects hostile links, telemetry, and undeclared nested or root config fields", async () => {
  const mutations = [
    (config: any) => { config.android.intentFilters = [{ action: "VIEW", data: [{ scheme: "https", host: "attacker.example" }] }]; },
    (config: any) => { config.ios.associatedDomains = ["applinks:attacker.example"]; },
    (config: any) => { config.extra = { telemetryUrl: "https://attacker.example/collect" }; },
    (config: any) => { config.android.adaptiveIcon = { foregroundImage: "./attacker.png" }; },
    (config: any) => { config.ios.config = { usesNonExemptEncryption: false }; },
    (config: any) => { config.web = { bundler: "metro" }; },
    (config: any) => { config.experiments = { typedRoutes: true }; },
  ];
  for (const mutate of mutations) {
    const { root, value } = await fixture();
    try {
      mutate(value.configReports.production.config);
      rehashConfig(value.configReports.production);
      await assert.rejects(validateNativeReports(value), /exactly match|resolved public config/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("CI evidence rejects stale or forged production bytes and mismatched E2E bytes", async () => {
  for (const [flavor, replacement] of [["production", e2eBytes], ["e2e", productionBytes]] as const) {
    const { root, value } = await fixture();
    try {
      await writeFile(join(root, NATIVE_EVIDENCE_PATHS.android[flavor]), replacement);
      await assert.rejects(validateNativeReports(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("same-commit provenance rejects tracked, index, and nonignored untracked dirtiness and requires a hashed explicit passing result", () => {
  assert.deepEqual(CLEAN_REPOSITORY_STATUS_ARGS, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.doesNotThrow(() => assertCleanTrackedStatus(""));
  for (const status of [" M App.tsx", "M  App.tsx", "MM App.tsx", "?? rogue.txt"]) assert.throws(() => assertCleanTrackedStatus(status), /clean/);
  const result = validateTestResultInput("pass", ".artifacts/test-results/static.log", Buffer.from("real gate output\n"));
  assert.equal(result.status, "pass");
  assert.equal(result.file.sha256, hash("real gate output\n"));
  assert.throws(() => validateTestResultInput(undefined, "result.log", Buffer.from("output")), /test-result pass/);
  assert.throws(() => validateTestResultInput("pass", null, Buffer.from("output")), /test-result-file/);
  assert.throws(() => validateTestResultInput("pass", "result.log", Buffer.alloc(0)), /nonempty/);
});

test("schema-v4 fault bundle collector preserves established sentinel leaves exactly", () => {
  const leaf = { path: "bundle.js", bytes: 12, sha256: "f".repeat(64), sentinelOccurrences: 1 };
  const bundles = {
    android: { production: { ...leaf, sentinelOccurrences: 0 }, e2e: leaf },
    ios: { production: { ...leaf, sentinelOccurrences: 0 }, e2e: leaf },
  };
  const evidence = collectFaultBundleEvidence({ path: "proof.json", sha256: "e".repeat(64) }, bundles);
  assert.deepEqual(evidence.bundles, bundles);
  for (const platform of ["android", "ios"] as const) {
    for (const flavor of ["production", "e2e"] as const) {
      assert.deepEqual(Object.keys(evidence.bundles[platform][flavor]), ["path", "bytes", "sha256", "sentinelOccurrences"]);
      assert.equal((evidence.bundles[platform][flavor] as any).observedMarkerCounts, undefined);
      assert.equal((evidence.bundles[platform][flavor] as any).moduleGraph, undefined);
    }
  }
});

test("schema-v6 aggregate binds profile restart only through its validated report leaf", () => {
  assert.equal(CI_EVIDENCE_SCHEMA_VERSION, 6);
  assert.deepEqual(collectProfileRestartEvidence(".artifacts/android-profile-restart.json", "a".repeat(64)), {
    path: ".artifacts/android-profile-restart.json",
    sha256: "a".repeat(64),
  });
  assert.throws(() => collectProfileRestartEvidence("", "a".repeat(64)), /path/);
  assert.throws(() => collectProfileRestartEvidence("profile.json", "not-a-hash"), /SHA/);
});

function poisonSnapshot() {
  const column = (cid: number, name: string, notnull = 0, pk = 0) => ({ cid, name, type: "TEXT", notnull, dflt_value: null, pk });
  return {
    objects: ["chat_turns", "committed_job_effects", "local_jobs", "messages", "pending_agent_tasks", "photos"].map((name) => ({ type: "table", name })),
    columns: {
      chat_turns: [column(0, "id", 0, 1), column(1, "conversation_id", 1), column(2, "status", 1), column(3, "error_code"), column(4, "completed_at"), column(5, "updated_at", 1)],
      committed_job_effects: [column(0, "effect_key", 0, 1)],
      local_jobs: [column(0, "id", 0, 1), column(1, "effect_key", 1), column(2, "status", 1), column(3, "lease_owner"), column(4, "lease_expires_at"), column(5, "next_attempt_at"), column(6, "last_error_code"), column(7, "updated_at", 1)],
      messages: [column(0, "id", 0, 1), column(1, "conversation_id", 1), column(2, "turn_id", 1), column(3, "role", 1)],
      pending_agent_tasks: [column(0, "id", 0, 1), column(1, "status", 1), column(2, "expires_at", 1), column(3, "updated_at", 1)],
      photos: [column(0, "id", 0, 1), column(1, "import_state", 1)],
    },
    rows: {
      chat_turns: [{ id: "poison-turn", conversation_id: "poison-conversation", status: "completed", error_code: null, completed_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
      messages: [{ id: "poison-message", conversation_id: "poison-conversation", turn_id: "poison-turn", role: "user" }],
      pending_agent_tasks: [{ id: "poison-task", status: "completed", expires_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
      local_jobs: [{ id: "poison-job", effect_key: "poison-effect", status: "queued", lease_owner: null, lease_expires_at: null, next_attempt_at: null, last_error_code: null, updated_at: "2026-01-01T00:00:00.000Z" }],
      committed_job_effects: [{ effect_key: "poison-effect" }],
      photos: [{ id: "poison-photo", import_state: "committed" }],
    },
    foreignKeyViolations: [], journalMode: "wal",
  };
}


test("native persistence evidence requires exact nested same-SHA startup facts", () => {
  const sha = "a".repeat(40);
  const migrationSha = "b".repeat(64);
  const snapshot = {
    sha256: "c".repeat(64), migration: [{ version: 1, name: "initial-schema", sha256: migrationSha }], journalMode: "wal",
    objectTypes: [{ type: "index", total: 14 }, { type: "table", total: 26 }, { type: "trigger", total: 3 }],
    meta: null, jobs: [], turns: [], tasks: [],
  };
  const recovered = { ...snapshot, meta: { value_json: '"preserved"' },
    jobs: [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }],
    turns: [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }],
    tasks: [{ id: "e2e-p", status: "expired" }],
  };
  const poison = poisonSnapshot();
  const report = {
    schemaVersion: 2, reportType: "startup-persistence", platform: "android",
    checkedOutSha: sha, expectedSha: sha, migrationSha256: migrationSha, skipped: [],
    scenarios: {
      firstOpen: { status: "pass", snapshot },
      recoveryRelaunch: { status: "pass", snapshot: structuredClone(recovered), noOpSnapshot: structuredClone(recovered) },
      migrationHashRetry: { status: "pass", snapshot: structuredClone(recovered) },
      failedMigrationRollback: { status: "pass", collisionObject: "chat_turns", beforeSnapshot: structuredClone(poison), afterSnapshot: structuredClone(poison) },
    },
  };
  assert.deepEqual(validatePersistenceReport(report, "android", sha, migrationSha).scenarios, [
    "firstOpen", "recoveryRelaunch", "migrationHashRetry", "failedMigrationRollback",
  ]);
  assert.throws(() => validatePersistenceReport({ ...report, skipped: ["failedMigrationRollback"] }, "android", sha, migrationSha), /cannot be skipped/);
  assert.throws(() => validatePersistenceReport({ ...report, checkedOutSha: "d".repeat(40) }, "android", sha, migrationSha), /checked-out SHA/);
  assert.throws(() => validatePersistenceReport({ ...report, migrationSha256: "e".repeat(64) }, "android", sha, migrationSha), /frozen source/);
  for (const key of ["meta", "jobs", "turns", "tasks"] as const) {
    const hostile = structuredClone(report);
    (hostile.scenarios.migrationHashRetry.snapshot as Record<string, unknown>)[key] = key === "meta" ? null : [];
    assert.throws(() => validatePersistenceReport(hostile, "android", sha, migrationSha), new RegExp(`migration retry ${key}`));
  }
  const hostileRecovery = structuredClone(report); hostileRecovery.scenarios.recoveryRelaunch.snapshot.jobs[0].status = "leased";
  assert.throws(() => validatePersistenceReport(hostileRecovery, "android", sha, migrationSha), /recovery jobs/);
  const extra = structuredClone(report); (extra.scenarios.firstOpen.snapshot as Record<string, unknown>).databasePath = "private";
  assert.throws(() => validatePersistenceReport(extra, "android", sha, migrationSha), /snapshot keys/);
  const poisonMutations = [
    (value: any) => { value.scenarios.failedMigrationRollback.collisionObject = "messages"; },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.objects.push({ type: "table", name: "schema_migrations" }); },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.columns.chat_turns.pop(); },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.rows.local_jobs[0].status = "leased"; },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.foreignKeyViolations = [{ table: "messages" }]; },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.journalMode = "delete"; },
    (value: any) => { value.scenarios.failedMigrationRollback.beforeSnapshot.rows.photos = []; },
  ];
  for (const mutate of poisonMutations) {
    const hostile = structuredClone(report);
    mutate(hostile);
    assert.throws(() => validatePersistenceReport(hostile, "android", sha, migrationSha));
  }
});

async function profileReport(platform: "android" | "ios", root = resolve(".")) {
  const valueSha256 = "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db";
  const row = {
    singleton_id: 1, name: "G031LeapBaby", sex: "female", birth_date: "2024-02-29",
    birth_weight_g: 3200, birth_height_cm: 50.5, birth_head_cm: 34.2, is_premature: 1,
    gestational_weeks: 36, created_at: "2026-07-18T01:02:03.000Z", updated_at: "2026-07-18T01:02:03.000Z",
  };
  const rowSha256 = hash(JSON.stringify(row));
  const savePath = "e2e/maestro/profile-save.yaml";
  const restartPath = "e2e/maestro/profile-restart.yaml";
  const binary = platform === "android"
    ? {
        kind: "apk",
        embeddedJsBundle: true,
        localBeforeSha256: "1".repeat(64), installedBeforeSha256: "1".repeat(64),
        localAfterSha256: "1".repeat(64), installedAfterSha256: "1".repeat(64),
      }
    : {
        kind: "ios-app",
        embeddedJsBundle: true,
        before: { executableSha256: "1".repeat(64), mainJsBundleSha256: "2".repeat(64), infoPlistSha256: "3".repeat(64) },
        after: { executableSha256: "1".repeat(64), mainJsBundleSha256: "2".repeat(64), infoPlistSha256: "3".repeat(64) },
      };
  const populated = { babyProfileCount: 1, modelConfigCount: 0, modelCapabilitiesCount: 0, row, valueSha256, rowSha256 };
  return {
    schemaVersion: 1,
    reportType: "baby-profile-offline-restart",
    platform,
    flavor: "e2e-release",
    checkedOutSha: sha,
    expectedSha: sha,
    testId: "E2E-001/profile",
    fixture: {
      id: "synthetic-leap-day-v1",
      values: { birthDate: "2024-02-29", birthHeadCm: 34.2, birthHeightCm: 50.5, birthWeightG: 3200, gestationalWeeks: 36, isPremature: true, name: "G031LeapBaby", sex: "female" },
      valueSha256,
    },
    calendar: { source: "device-local-date", beforeSave: "2026-07-18", afterSave: "2026-07-18", afterRelaunch: "2026-07-18", timeZone: "Asia/Shanghai", stable: true },
    ageOracle: { algorithm: "independent-gregorian-v1", birthDate: "2024-02-29", localDate: "2026-07-18", ageDays: 870, completedMonths: 28, remainingDays: 19, display: "28个月19天" },
    binary,
    database: {
      preSave: { babyProfileCount: 0, modelConfigCount: 0, modelCapabilitiesCount: 0, row: null, valueSha256: null, rowSha256: null },
      postSave: structuredClone(populated),
      postRelaunch: structuredClone(populated),
    },
    lifecycle: {
      releaseInstalledFresh: true,
      metro: { killCount: 1, waitCount: 1, pidCleared: true, androidReverseRemoved: platform === "android", negativeProbe: true },
      directLaunches: { preSavePid: "101", savePid: "202", relaunchPid: "303" },
      terminatedBeforeEmptySnapshot: true,
      savePidGone: true,
      relaunchPidDifferent: true,
      postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 },
    },
    privacy: await collectProfilePrivacyProof(root),
    migration: {
      recordedSha256: "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec",
      sourceSha256: "c45896b3eb02762c0cf8f62c584889951a15fadc13fd34b9183bfa717ec75975",
      sqlBytes: 10526,
      inventory: { tables: 26, indexes: 14, triggers: 3 },
    },
    evidence: {
      saveFlow: { path: savePath, sha256: hash(await readFile(join(root, savePath), "utf8")) },
      restartFlow: { path: restartPath, sha256: hash(await readFile(join(root, restartPath), "utf8")) },
    },
    status: "pass",
    skipped: [],
  };
}

test("schema-v6 profile evidence independently binds the exact offline Release restart proof", async () => {
  for (const platform of ["android", "ios"] as const) {
    const report = await profileReport(platform);
    assert.deepEqual(await validateProfileRestartReport(report, platform, sha), {
      testId: "E2E-001/profile",
      fixtureId: "synthetic-leap-day-v1",
      valueSha256: "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db",
    });
    const mutations = [
      (value: any) => { value.database.preSave.babyProfileCount = 1; },
      (value: any) => { value.database.postRelaunch.row.updated_at = "2026-07-18T01:02:04.000Z"; },
      (value: any) => { value.calendar.afterRelaunch = "2026-07-19"; },
      (value: any) => { value.ageOracle.display = "app-reported"; },
      (value: any) => { value.lifecycle.directLaunches.relaunchPid = value.lifecycle.directLaunches.savePid; },
      (value: any) => { value.lifecycle.metro.negativeProbe = false; },
      (value: any) => { value.lifecycle.postInstallMutations.metroRestart = 1; },
      (value: any) => { value.privacy.requestPrimitiveMatches = ["src/hostile.ts:fetch("]; },
      (value: any) => { value.binary.embeddedJsBundle = false; },
      (value: any) => { value.evidence.saveFlow.sha256 = "0".repeat(64); },
      (value: any) => { value.skipped = ["profile"]; },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(report);
      mutate(hostile);
      await assert.rejects(validateProfileRestartReport(hostile, platform, sha));
    }
  }
});

test("G035 C3 aggregate schema is exactly v6 and emits only the canonical tracker leaf", async () => {
  const api = ciEvidence as typeof ciEvidence & {
    collectTrackerRestartEvidence?: (path: string, reportSha256: string, platform: "android" | "ios") => unknown;
  };
  assert.equal(CI_EVIDENCE_SCHEMA_VERSION, 6);
  const collectTrackerRestartEvidence = api.collectTrackerRestartEvidence;
  assert.equal(typeof collectTrackerRestartEvidence, "function", "C3 tracker aggregate leaf collector is absent");
  assert(collectTrackerRestartEvidence);
  for (const platform of ["android", "ios"] as const) {
    const fixture = await trackerReportFixture(platform);
    try {
      const path = `.artifacts/${platform}-tracker-restart.json`;
      assert.deepEqual(collectTrackerRestartEvidence(path, hash(fixture.bytes), platform), {
        path,
        sha256: hash(fixture.bytes),
      });
      assert.deepEqual(Object.keys(collectTrackerRestartEvidence(path, hash(fixture.bytes), platform) as object), ["path", "sha256"]);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
    assert.equal(existsSync(fixture.directory), false);
  }
  for (const [path, reportSha256, platform] of [
    [".artifacts/android-tracker-restart.json", "a".repeat(64), "host"],
    [".artifacts/ios-tracker-restart.json", "a".repeat(64), "android"],
    [".artifacts/./android-tracker-restart.json", "a".repeat(64), "android"],
    [".artifacts/nested/../ios-tracker-restart.json", "a".repeat(64), "ios"],
    [".artifacts/android-tracker-restart.json", "not-a-hash", "android"],
  ] as const) {
    assert.throws(() => collectTrackerRestartEvidence(path, reportSha256, platform),
      `accepted tracker leaf ${platform} ${path} ${reportSha256}`);
  }
  const source = await readFile("tools/collect-ci-evidence.mjs", "utf8");
  assert.match(source, /trackerRestart/);
  assert.match(source, /trackerRestart\s*=\s*null/);
});

test("G035 C3 tracker binding independently validates canonical bytes and hostile full reports", async () => {
  const api = ciEvidence as typeof ciEvidence & {
    validateTrackerRestartReport?: (
      bytes: Buffer,
      platform: "android" | "ios",
      expectedSha: string,
      root?: string,
    ) => unknown;
  };
  const validateTrackerRestartReport = api.validateTrackerRestartReport;
  assert.equal(typeof validateTrackerRestartReport, "function", "C3 tracker report validator integration is absent");
  assert(validateTrackerRestartReport);
  for (const platform of ["android", "ios"] as const) {
    const fixture = await trackerReportFixture(platform);
    try {
      assert.equal(canonicalJson(validateTrackerRestartReport(fixture.bytes, platform, sha)), canonicalJson(fixture.report));
      const hostileReports = [
        Buffer.from(`${JSON.stringify(fixture.report, null, 2)}\n`),
        Buffer.from("{malformed"),
        Buffer.from(canonicalJson({ ...fixture.report, platform: platform === "android" ? "ios" : "android" })),
        Buffer.from(canonicalJson({ ...fixture.report, checkedOutSha: "b".repeat(40) })),
        Buffer.from(canonicalJson({ ...fixture.report, privateTrackerRows: fixture.report.database.postSave.rows })),
      ];
      for (const bytes of hostileReports) assert.throws(() => validateTrackerRestartReport(bytes, platform, sha));
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
    assert.equal(existsSync(fixture.directory), false);
  }
});

test("G035 C3 real collector CLI emits privacy-minimal schema-v6 host and native evidence", async () => {
  const exactKeys = [
    "schemaVersion", "checkedOutSha", "expectedSha", "platform", "flavor", "testResult",
    "packageLockSha256", "knowledgeManifestSha256", "nativeFiles", "reports", "faultBundles",
    "persistence", "profileRestart", "trackerRestart", "runner", "node", "xcode",
  ];
  for (const platform of ["host", "android", "ios"] as const) {
    const fixture = await collectorSuccessFixture(platform);
    const trackerDirectory = fixture.trackerFixture?.directory ?? null;
    try {
      if (platform === "host") assert.equal(fixture.args.includes("--tracker-restart-report"), false);
      const result = fixture.run(fixture.args);
      assert.equal(result.status, 0, `${platform}: ${result.stderr}`);
      const evidence = JSON.parse(await readFile(join(fixture.root, fixture.output), "utf8"));
      assert.deepEqual(Object.keys(evidence), exactKeys);
      assert.equal(evidence.schemaVersion, 6);
      assert.equal(evidence.platform, platform);
      if (platform === "host") {
        assert.equal(evidence.profileRestart, null);
        assert.equal(evidence.trackerRestart, null);
      } else {
        assert(fixture.trackerFixture);
        assert(fixture.profilePath && fixture.trackerPath);
        assert.deepEqual(evidence.profileRestart, {
          path: fixture.profilePath,
          sha256: hash(await readFile(join(fixture.root, fixture.profilePath))),
        });
        assert.deepEqual(Object.keys(evidence.profileRestart), ["path", "sha256"]);
        assert.deepEqual(evidence.trackerRestart, {
          path: fixture.trackerPath,
          sha256: hash(fixture.trackerFixture.bytes),
        });
        assert.deepEqual(Object.keys(evidence.trackerRestart), ["path", "sha256"]);
        const aggregateBytes = JSON.stringify(evidence);
        for (const rows of Object.values(fixture.trackerFixture.report.database.postSave.rows)) {
          for (const row of rows as { id: string }[]) assert.equal(aggregateBytes.includes(row.id), false);
        }
        for (const privateKey of ["canonicalBusinessFacts", "localInputs", "manualProjectionSha256", "fullRowsSha256"]) {
          assert.equal(aggregateBytes.includes(privateKey), false, `${platform} aggregate duplicated ${privateKey}`);
        }
      }
    } finally {
      if (trackerDirectory) await rm(trackerDirectory, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
    assert.equal(existsSync(fixture.root), false);
    if (trackerDirectory) assert.equal(existsSync(trackerDirectory), false);
  }
});

test("G035 C3 real collector CLI rejects missing, forbidden, aliased, and traversal tracker flags", async () => {
  const fixture = await collectorCliFixture();
  try {
    const cases = [
    ["native missing", ["--platform", "android"]],
    ["native alias", ["--platform", "android", "--tracker-restart-report", ".artifacts/./android-tracker-restart.json"]],
    ["native traversal", ["--platform", "ios", "--tracker-restart-report", ".artifacts/nested/../ios-tracker-restart.json"]],
    ["native wrong platform", ["--platform", "android", "--tracker-restart-report", ".artifacts/ios-tracker-restart.json"]],
    ["native duplicate", ["--platform", "android", "--tracker-restart-report", ".artifacts/android-tracker-restart.json", "--tracker-restart-report", ".artifacts/android-tracker-restart.json"]],
    ["native missing value", ["--platform", "android", "--tracker-restart-report"]],
    ["native equals alias", ["--platform", "android", "--tracker-restart-report=.artifacts/android-tracker-restart.json"]],
    ["host forbidden", ["--platform", "host", "--tracker-restart-report", ".artifacts/host-tracker-restart.json"]],
    ] as const;
    const moduleResolutionFailure = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|module resolution|module not found/i;
    const trackerOptionPolicy = /(?:--tracker-restart-report[\s\S]{0,240}(?:required|forbidden|reject(?:ed|s)?|must|noncanonical|canonical|invalid)|(?:required|forbidden|reject(?:ed|s)?|must|noncanonical|canonical|invalid)[\s\S]{0,240}--tracker-restart-report)/i;
    for (const [label, args] of cases) {
      const result = fixture.run([...args]);
      assert.notEqual(result.status, 0, label);
      assert.doesNotMatch(result.stderr, moduleResolutionFailure, `${label} failed through module resolution: ${result.stderr}`);
      assert.match(result.stderr, trackerOptionPolicy, `${label} did not fail through --tracker-restart-report policy: ${result.stderr}`);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
  assert.equal(existsSync(fixture.root), false);
});
