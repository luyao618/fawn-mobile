import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateResolvedConfigs } from "./check-app-config.mjs";
import { validateFaultBundleProof } from "./check-fault-bundles.mjs";
import { inspectNativeScheme, NATIVE_EVIDENCE_PATHS } from "./check-native-schemes.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CI_EVIDENCE_SCHEMA_VERSION = 5;
const PROFILE_VALUE_SHA256 = "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db";
const PROFILE_VALUES = Object.freeze({
  birthDate: "2024-02-29",
  birthHeadCm: 34.2,
  birthHeightCm: 50.5,
  birthWeightG: 3200,
  gestationalWeeks: 36,
  isPremature: true,
  name: "G031LeapBaby",
  sex: "female",
});
const PROFILE_REPORT_KEYS = ["schemaVersion", "reportType", "platform", "flavor", "checkedOutSha", "expectedSha", "testId", "fixture", "calendar", "ageOracle", "binary", "database", "lifecycle", "privacy", "migration", "evidence", "status", "skipped"];

export const CLEAN_REPOSITORY_STATUS_ARGS = ["status", "--porcelain=v1", "--untracked-files=all"];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function command(commandName, args) {
  const result = spawnSync(commandName, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} is malformed`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys are invalid`);
}

function parseOracleDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  assert(match, "Profile device local date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  assert(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day, "Profile device local date is invalid");
  return { year, month, day, time, iso: value };
}

function oracleDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function oracleAddMonths(date, count) {
  const monthIndex = date.year * 12 + date.month - 1 + count;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const day = Math.min(date.day, oracleDaysInMonth(year, month));
  return parseOracleDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

function independentAgeOracle(localDate) {
  const birth = parseOracleDate(PROFILE_VALUES.birthDate);
  const today = parseOracleDate(localDate);
  assert(today.time >= birth.time, "Profile local date predates the fixture");
  let completedMonths = (today.year - birth.year) * 12 + today.month - birth.month;
  let anchor = oracleAddMonths(birth, completedMonths);
  if (anchor.time > today.time) {
    completedMonths -= 1;
    anchor = oracleAddMonths(birth, completedMonths);
  }
  const dayMilliseconds = 86_400_000;
  const remainingDays = (today.time - anchor.time) / dayMilliseconds;
  return {
    algorithm: "independent-gregorian-v1",
    birthDate: PROFILE_VALUES.birthDate,
    localDate: today.iso,
    ageDays: (today.time - birth.time) / dayMilliseconds,
    completedMonths,
    remainingDays,
    display: `${completedMonths}个月${remainingDays}天`,
  };
}

export function collectProfilePrivacyProof(root = repoRoot) {
  const listed = spawnSync("git", ["ls-files", "-z", "App*", "index*", "src/**", "app.config.*"], { cwd: root, encoding: "buffer" });
  assert.equal(listed.status, 0, "Unable to enumerate tracked profile runtime sources");
  const files = listed.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  const requestPrimitiveMatches = [];
  const primitive = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\baxios\b|\b(?:http|https)\s*\.\s*(?:request|get)\s*\(|\b(?:ky|superagent|got)\s*\(/gi;
  for (const file of files) {
    const bytes = readFileSync(resolve(root, file));
    digest.update(file).update("\0").update(bytes).update("\0");
    bytes.toString("utf8").split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(primitive)) requestPrimitiveMatches.push(`${file}:${index + 1}:${match[0]}`);
    });
  }
  return {
    claim: "structural-absence-of-product-request-path",
    trackedSourceCount: files.length,
    trackedSourceSha256: digest.digest("hex"),
    requestPrimitiveMatches,
    modelConfigCount: 0,
    modelCapabilitiesCount: 0,
  };
}

function validateCommonReport(report, reportType, platform, flavor, expectedSha) {
  assert(report && typeof report === "object" && !Array.isArray(report), `${reportType} ${flavor} report is malformed`);
  assert.equal(report.schemaVersion, 1, `${reportType} ${flavor} report schema is invalid`);
  assert.equal(report.reportType, reportType, `${flavor} report type is invalid`);
  assert.equal(report.platform, platform, `${reportType} ${flavor} report platform is invalid`);
  assert.equal(report.flavor, flavor, `${reportType} report flavor is invalid`);
  assert.equal(report.checkedOutSha, expectedSha, `${reportType} ${flavor} checked-out SHA disagrees`);
  assert.equal(report.expectedSha, expectedSha, `${reportType} ${flavor} expected SHA disagrees`);
}

export function assertCleanTrackedStatus(status) {
  assert.equal(status, "", "Evidence collection requires a clean worktree and index, including nonignored untracked files");
}

export function validateTestResultInput(status, path, bytes) {
  assert.equal(status, "pass", "--test-result pass is required");
  assert(path, "--test-result-file is required");
  assert(bytes.length > 0, "--test-result-file must be nonempty");
  return {
    status,
    file: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

export function collectFaultBundleEvidence(proof, bundles) {
  return { proof, bundles };
}

export function collectProfileRestartEvidence(path, reportSha256) {
  assert(path, "Profile restart report path is absent");
  assert.match(reportSha256, /^[0-9a-f]{64}$/, "Profile restart report SHA is invalid");
  return { path, sha256: reportSha256 };
}

export async function validateNativeReports({ platform, expectedSha, configReports, schemeReports, root = repoRoot }) {
  assert(["android", "ios"].includes(platform), "Native evidence platform must be android or ios");
  const canonicalPaths = NATIVE_EVIDENCE_PATHS[platform];
  for (const flavor of ["production", "e2e"]) {
    validateCommonReport(configReports?.[flavor], "resolved-app-config", platform, flavor, expectedSha);
    const config = configReports[flavor].config;
    assert(config && typeof config === "object" && !Array.isArray(config), `${flavor} resolved config is absent`);
    assert.equal(configReports[flavor].configSha256, hashJson(config), `${flavor} resolved config hash is invalid`);
  }
  validateResolvedConfigs(configReports.production.config, configReports.e2e.config);

  const summary = { config: {}, scheme: {}, nativeFiles: {} };
  for (const flavor of ["production", "e2e"]) {
    const configReport = configReports[flavor];
    const schemeReport = schemeReports?.[flavor];
    validateCommonReport(schemeReport, "native-scheme", platform, flavor, expectedSha);
    const canonicalPath = canonicalPaths[flavor];
    assert.equal(schemeReport.nativeInput?.path, canonicalPath, `${flavor} native input path is noncanonical`);
    const inspected = await inspectNativeScheme(platform, flavor, resolve(root, canonicalPath));
    assert.equal(schemeReport.nativeInput?.sha256, inspected.nativeInputSha256, `${flavor} native input hash disagrees with retained bytes`);
    assert.equal(schemeReport.scheme, inspected.structure.scheme, `${flavor} structural scheme name is invalid`);
    assert.equal(schemeReport.count, inspected.structure.count, `${flavor} structural scheme count is invalid`);
    assert.equal(schemeReport.placement, inspected.structure.placement, `${flavor} structural scheme placement is invalid`);
    summary.config[flavor] = { configSha256: configReport.configSha256 };
    summary.scheme[flavor] = { count: inspected.structure.count, placement: inspected.structure.placement };
    summary.nativeFiles[flavor] = { path: canonicalPath, sha256: inspected.nativeInputSha256 };
  }
  return summary;
}

export function validatePersistenceReport(report, platform, expectedSha, expectedMigrationSha) {
  assert(report && typeof report === "object" && !Array.isArray(report), "Persistence report is malformed");
  assert.deepEqual(Object.keys(report).sort(), ["checkedOutSha", "expectedSha", "migrationSha256", "platform", "reportType", "scenarios", "schemaVersion", "skipped"].sort(), "Persistence report keys are invalid");
  assert.equal(report.schemaVersion, 2, "Persistence report schema is invalid");
  assert.equal(report.reportType, "startup-persistence", "Persistence report type is invalid");
  assert.equal(report.platform, platform, "Persistence report platform disagrees");
  assert.equal(report.checkedOutSha, expectedSha, "Persistence checked-out SHA disagrees");
  assert.equal(report.expectedSha, expectedSha, "Persistence expected SHA disagrees");
  assert.match(report.migrationSha256, /^[0-9a-f]{64}$/, "Persistence migration SHA is invalid");
  assert.equal(report.migrationSha256, expectedMigrationSha, "Persistence migration SHA disagrees with frozen source");
  assert.deepEqual(report.skipped, [], "Persistence scenarios cannot be skipped");
  const expectedScenarios = ["firstOpen", "recoveryRelaunch", "migrationHashRetry", "failedMigrationRollback"];
  assert.deepEqual(Object.keys(report.scenarios ?? {}).sort(), [...expectedScenarios].sort(), "Persistence scenario inventory is invalid");
  const exactObjects = [{ type: "index", total: 14 }, { type: "table", total: 26 }, { type: "trigger", total: 3 }];
  const exactMigration = [{ version: 1, name: "initial-schema", sha256: expectedMigrationSha }];
  const validateSnapshot = (snapshot, name) => {
    assert.deepEqual(Object.keys(snapshot ?? {}).sort(), ["jobs", "journalMode", "meta", "migration", "objectTypes", "sha256", "tasks", "turns"].sort(), `${name} snapshot keys are invalid`);
    assert.match(snapshot.sha256, /^[0-9a-f]{64}$/, `${name} database hash is malformed`);
    assert.deepEqual(snapshot.migration, exactMigration, `${name} migration identity is invalid`);
    assert.equal(snapshot.journalMode, "wal", `${name} did not retain WAL mode`);
    assert.deepEqual(snapshot.objectTypes, exactObjects, `${name} DDL inventory is invalid`);
  };
  const first = report.scenarios.firstOpen;
  assert.deepEqual(Object.keys(first ?? {}).sort(), ["snapshot", "status"], "firstOpen keys are invalid");
  assert.equal(first.status, "pass"); validateSnapshot(first.snapshot, "firstOpen");
  assert.equal(first.snapshot.meta, null); assert.deepEqual(first.snapshot.jobs, []); assert.deepEqual(first.snapshot.turns, []); assert.deepEqual(first.snapshot.tasks, []);
  const recovery = report.scenarios.recoveryRelaunch;
  assert.deepEqual(Object.keys(recovery ?? {}).sort(), ["noOpSnapshot", "snapshot", "status"], "recoveryRelaunch keys are invalid");
  assert.equal(recovery.status, "pass"); validateSnapshot(recovery.snapshot, "recoveryRelaunch"); validateSnapshot(recovery.noOpSnapshot, "recoveryNoOp");
  const recoveredFacts = {
    meta: { value_json: '"preserved"' },
    jobs: [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }],
    turns: [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }],
    tasks: [{ id: "e2e-p", status: "expired" }],
  };
  for (const [key, value] of Object.entries(recoveredFacts)) {
    assert.deepEqual(recovery.snapshot[key], value, `recovery ${key} is invalid`);
    assert.deepEqual(recovery.noOpSnapshot[key], value, `no-op recovery ${key} is invalid`);
  }
  const retry = report.scenarios.migrationHashRetry;
  assert.deepEqual(Object.keys(retry ?? {}).sort(), ["snapshot", "status"], "migrationHashRetry keys are invalid");
  assert.equal(retry.status, "pass"); validateSnapshot(retry.snapshot, "migrationHashRetry");
  for (const [key, value] of Object.entries(recoveredFacts)) {
    assert.deepEqual(retry.snapshot[key], value, `migration retry ${key} is invalid`);
  }
  const rollback = report.scenarios.failedMigrationRollback;
  assert.deepEqual(Object.keys(rollback ?? {}).sort(), ["afterSnapshot", "beforeSnapshot", "collisionObject", "status"].sort(), "failedMigrationRollback keys are invalid");
  assert.equal(rollback.status, "pass");
  assert.equal(rollback.collisionObject, "chat_turns", "Failed migration collision object is invalid");
  const column = (cid, name, notnull = 0, pk = 0) => ({ cid, name, type: "TEXT", notnull, dflt_value: null, pk });
  const exactPoison = {
    objects: ["chat_turns", "committed_job_effects", "local_jobs", "messages", "pending_agent_tasks", "photos"]
      .map((name) => ({ type: "table", name })),
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
    foreignKeyViolations: [],
    journalMode: "wal",
  };
  for (const [name, poison] of [["before", rollback.beforeSnapshot], ["after", rollback.afterSnapshot]]) {
    assert.deepEqual(Object.keys(poison ?? {}).sort(), ["columns", "foreignKeyViolations", "journalMode", "objects", "rows"].sort(), `Failed migration ${name} snapshot keys are invalid`);
    assert.deepEqual(poison, exactPoison, `Failed migration ${name} snapshot is invalid`);
    for (const prefix of ["schema_migrations", "app_meta", "baby_profile", "conversations"]) {
      assert.equal(poison.objects.some((object) => object.name === prefix), false, `Failed migration retained transaction-created ${prefix}`);
    }
  }
  assert.deepEqual(rollback.afterSnapshot, rollback.beforeSnapshot, "Failed migration changed the poison database");
  return { migrationSha256: report.migrationSha256, scenarios: expectedScenarios };
}

export async function validateProfileRestartReport(report, platform, expectedSha, root = repoRoot) {
  exactKeys(report, PROFILE_REPORT_KEYS, "Profile restart report");
  assert.equal(report.schemaVersion, 1, "Profile restart report schema is invalid");
  assert.equal(report.reportType, "baby-profile-offline-restart", "Profile restart report type is invalid");
  assert.equal(report.platform, platform, "Profile restart platform disagrees");
  assert.equal(report.flavor, "e2e-release", "Profile restart flavor is invalid");
  assert.equal(report.checkedOutSha, expectedSha, "Profile restart checked-out SHA disagrees");
  assert.equal(report.expectedSha, expectedSha, "Profile restart expected SHA disagrees");
  assert.equal(report.testId, "E2E-001/profile", "Profile restart test ownership is invalid");
  assert.deepEqual(report.fixture, {
    id: "synthetic-leap-day-v1",
    values: PROFILE_VALUES,
    valueSha256: PROFILE_VALUE_SHA256,
  }, "Profile restart fixture is invalid");

  exactKeys(report.calendar, ["source", "beforeSave", "afterSave", "afterRelaunch", "timeZone", "stable"], "Profile calendar");
  assert.equal(report.calendar.source, "device-local-date", "Profile calendar source is invalid");
  assert.equal(typeof report.calendar.timeZone, "string");
  assert(report.calendar.timeZone.length > 0, "Profile device time zone is absent");
  assert.equal(report.calendar.stable, true, "Profile local date did not remain stable");
  assert.equal(report.calendar.beforeSave, report.calendar.afterSave, "Profile local date changed after save");
  assert.equal(report.calendar.beforeSave, report.calendar.afterRelaunch, "Profile local date changed after relaunch");
  assert.deepEqual(report.ageOracle, independentAgeOracle(report.calendar.beforeSave), "Profile independent age oracle is invalid");

  exactKeys(report.database, ["preSave", "postSave", "postRelaunch"], "Profile database");
  const emptySnapshot = { babyProfileCount: 0, modelConfigCount: 0, modelCapabilitiesCount: 0, row: null, valueSha256: null, rowSha256: null };
  assert.deepEqual(report.database?.preSave, emptySnapshot, "Profile pre-save database was not empty and private");
  const rowKeys = ["singleton_id", "name", "sex", "birth_date", "birth_weight_g", "birth_height_cm", "birth_head_cm", "is_premature", "gestational_weeks", "created_at", "updated_at"];
  const expectedInputRow = {
    singleton_id: 1,
    name: PROFILE_VALUES.name,
    sex: PROFILE_VALUES.sex,
    birth_date: PROFILE_VALUES.birthDate,
    birth_weight_g: PROFILE_VALUES.birthWeightG,
    birth_height_cm: PROFILE_VALUES.birthHeightCm,
    birth_head_cm: PROFILE_VALUES.birthHeadCm,
    is_premature: 1,
    gestational_weeks: PROFILE_VALUES.gestationalWeeks,
  };
  for (const [name, snapshot] of [["post-save", report.database?.postSave], ["post-relaunch", report.database?.postRelaunch]]) {
    exactKeys(snapshot, ["babyProfileCount", "modelConfigCount", "modelCapabilitiesCount", "row", "valueSha256", "rowSha256"], `Profile ${name} snapshot`);
    assert.equal(snapshot.babyProfileCount, 1, `Profile ${name} row count is invalid`);
    assert.equal(snapshot.modelConfigCount, 0, `Profile ${name} model_config count is invalid`);
    assert.equal(snapshot.modelCapabilitiesCount, 0, `Profile ${name} model_capabilities count is invalid`);
    exactKeys(snapshot.row, rowKeys, `Profile ${name} row`);
    for (const [key, value] of Object.entries(expectedInputRow)) assert.equal(snapshot.row[key], value, `Profile ${name} ${key} is invalid`);
    assert.match(snapshot.row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `Profile ${name} created_at is invalid`);
    assert.match(snapshot.row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `Profile ${name} updated_at is invalid`);
    const canonicalValues = {
      birthDate: snapshot.row.birth_date,
      birthHeadCm: snapshot.row.birth_head_cm,
      birthHeightCm: snapshot.row.birth_height_cm,
      birthWeightG: snapshot.row.birth_weight_g,
      gestationalWeeks: snapshot.row.gestational_weeks,
      isPremature: snapshot.row.is_premature === 1,
      name: snapshot.row.name,
      sex: snapshot.row.sex,
    };
    assert.equal(hashJson(canonicalValues), PROFILE_VALUE_SHA256, `Profile ${name} canonical values are invalid`);
    assert.equal(snapshot.valueSha256, PROFILE_VALUE_SHA256, `Profile ${name} value hash is invalid`);
    assert.equal(snapshot.rowSha256, hashJson(snapshot.row), `Profile ${name} row hash is invalid`);
  }
  assert.deepEqual(report.database.postRelaunch, report.database.postSave, "Profile row changed across relaunch");

  exactKeys(report.lifecycle, ["releaseInstalledFresh", "metro", "directLaunches", "terminatedBeforeEmptySnapshot", "savePidGone", "relaunchPidDifferent", "postInstallMutations"], "Profile lifecycle");
  assert.equal(report.lifecycle.releaseInstalledFresh, true, "Profile Release install was not fresh");
  assert.deepEqual(report.lifecycle.metro, {
    killCount: 1,
    waitCount: 1,
    pidCleared: true,
    androidReverseRemoved: platform === "android",
    negativeProbe: true,
  }, "Profile Metro teardown proof is invalid");
  exactKeys(report.lifecycle.directLaunches, ["preSavePid", "savePid", "relaunchPid"], "Profile direct launches");
  for (const pid of Object.values(report.lifecycle.directLaunches)) assert.match(String(pid), /^\d+$/, "Profile direct launch PID is invalid");
  assert.notEqual(report.lifecycle.directLaunches.savePid, report.lifecycle.directLaunches.relaunchPid, "Profile relaunch reused the save PID");
  assert.equal(report.lifecycle.terminatedBeforeEmptySnapshot, true, "Profile empty snapshot was not taken after termination");
  assert.equal(report.lifecycle.savePidGone, true, "Profile save PID survived termination");
  assert.equal(report.lifecycle.relaunchPidDifferent, true, "Profile relaunch PID transition is unproven");
  assert.deepEqual(report.lifecycle.postInstallMutations, { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 }, "Profile lifecycle contains a forbidden post-install mutation");

  exactKeys(report.binary, platform === "android"
    ? ["kind", "embeddedJsBundle", "localBeforeSha256", "installedBeforeSha256", "localAfterSha256", "installedAfterSha256"]
    : ["kind", "embeddedJsBundle", "before", "after"], "Profile binary");
  assert.equal(report.binary.embeddedJsBundle, true, "Profile Release binary lacks an embedded JS bundle");
  if (platform === "android") {
    assert.equal(report.binary.kind, "apk");
    for (const key of ["localBeforeSha256", "installedBeforeSha256", "localAfterSha256", "installedAfterSha256"]) assert.match(report.binary[key], /^[0-9a-f]{64}$/, `Profile Android ${key} is invalid`);
    assert.equal(report.binary.localBeforeSha256, report.binary.installedBeforeSha256, "Installed Android APK differs before save");
    assert.equal(report.binary.localBeforeSha256, report.binary.localAfterSha256, "Local Android APK changed after relaunch");
    assert.equal(report.binary.localBeforeSha256, report.binary.installedAfterSha256, "Installed Android APK changed after relaunch");
  } else {
    assert.equal(report.binary.kind, "ios-app");
    const binaryKeys = ["executableSha256", "mainJsBundleSha256", "infoPlistSha256"];
    exactKeys(report.binary.before, binaryKeys, "Profile iOS binary before");
    exactKeys(report.binary.after, binaryKeys, "Profile iOS binary after");
    for (const value of Object.values(report.binary.before)) assert.match(value, /^[0-9a-f]{64}$/, "Profile iOS binary hash is invalid");
    assert.deepEqual(report.binary.after, report.binary.before, "Profile iOS installed binary changed after relaunch");
  }

  const source = await readFile(resolve(root, "src/infrastructure/db/migrations/migration1.ts"));
  const sourceText = source.toString("utf8");
  const sqlStart = sourceText.indexOf("String.raw`") + "String.raw`".length;
  const sqlEnd = sourceText.indexOf("`;\n\nexport const MIGRATION_1_SHA256", sqlStart);
  assert(sqlStart >= "String.raw`".length && sqlEnd > sqlStart, "Profile migration source is malformed");
  const migrationMatch = /export const MIGRATION_1_SHA256 = "([0-9a-f]{64})"/.exec(sourceText);
  assert(migrationMatch, "Profile migration recorded SHA is absent");
  assert.deepEqual(report.migration, {
    recordedSha256: migrationMatch[1],
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    sqlBytes: Buffer.byteLength(sourceText.slice(sqlStart, sqlEnd)),
    inventory: { tables: 26, indexes: 14, triggers: 3 },
  }, "Profile migration identity is invalid");
  assert.deepEqual(report.privacy, collectProfilePrivacyProof(root), "Profile privacy source proof is invalid");
  assert.deepEqual(report.privacy.requestPrimitiveMatches, [], "Product request primitives are present");

  const exactFlows = { saveFlow: "e2e/maestro/profile-save.yaml", restartFlow: "e2e/maestro/profile-restart.yaml" };
  exactKeys(report.evidence, Object.keys(exactFlows), "Profile UI evidence");
  for (const [name, path] of Object.entries(exactFlows)) {
    assert.deepEqual(report.evidence[name], { path, sha256: await sha256(resolve(root, path)) }, `Profile ${name} evidence is invalid`);
  }
  assert.equal(report.status, "pass", "Profile restart did not pass");
  assert.deepEqual(report.skipped, [], "Profile restart cannot be skipped");
  return { testId: report.testId, fixtureId: report.fixture.id, valueSha256: report.fixture.valueSha256 };
}

async function frozenMigrationSha() {
  const source = await readFile(resolve(repoRoot, "src/infrastructure/db/migrations/migration1.ts"), "utf8");
  const match = /export const MIGRATION_1_SHA256 = "([0-9a-f]{64})"/.exec(source);
  assert(match, "Frozen migration SHA is absent from source");
  return match[1];
}

async function loadReport(path) {
  assert(path, "Required CI report path is absent");
  let report;
  try {
    report = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Required CI report is absent or malformed: ${path}`, { cause: error });
  }
  return { path, sha256: await sha256(path), report };
}

async function main() {
  const output = resolve(option("--output", ".artifacts/ci-evidence.json"));
  const expectedSha = option("--expected-sha", process.env.EXPECTED_SHA);
  const checkedOutSha = command("git", ["rev-parse", "HEAD"]);
  assert(checkedOutSha, "Unable to read checked-out SHA");
  assert(expectedSha, "Expected SHA is required");
  assert.equal(checkedOutSha, expectedSha, "Evidence checkout does not match expected SHA");
  const trackedStatus = command("git", CLEAN_REPOSITORY_STATUS_ARGS);
  assert.notEqual(trackedStatus, null, "Unable to inspect tracked worktree and index status");
  assertCleanTrackedStatus(trackedStatus);

  const testResultPath = option("--test-result-file", null);
  let testResultBytes;
  try {
    assert(testResultPath, "--test-result-file is required");
    testResultBytes = await readFile(testResultPath);
  } catch (error) {
    throw new Error(`Required test result file is absent: ${testResultPath ?? "<missing>"}`, { cause: error });
  }
  const testResult = validateTestResultInput(option("--test-result", null), testResultPath, testResultBytes);

  const platform = option("--platform", process.platform);
  const flavor = option("--flavor", "static");
  let reports = null;
  let nativeFiles = null;
  let faultBundles = null;
  let persistence = null;
  let profileRestart = null;
  if (platform === "host") {
    assert.equal(flavor, "static", "Host evidence must represent static gates");
    const faultBundleProof = await loadReport(option("--fault-bundle-proof", null));
    const bundles = await validateFaultBundleProof(faultBundleProof.report, { root: repoRoot, expectedSha });
    faultBundles = collectFaultBundleEvidence({ path: faultBundleProof.path, sha256: faultBundleProof.sha256 }, bundles);
  }
  if (["android", "ios"].includes(platform)) {
    assert.equal(flavor, "e2e", "Native evidence must represent the final E2E flavor");
    const configProduction = await loadReport(option("--config-report-production", null));
    const configE2e = await loadReport(option("--config-report-e2e", null));
    const schemeProduction = await loadReport(option("--scheme-report-production", null));
    const schemeE2e = await loadReport(option("--scheme-report-e2e", null));
    const validated = await validateNativeReports({
      platform,
      expectedSha,
      configReports: { production: configProduction.report, e2e: configE2e.report },
      schemeReports: { production: schemeProduction.report, e2e: schemeE2e.report },
    });
    reports = {
      config: { production: configProduction, e2e: configE2e },
      scheme: { production: schemeProduction, e2e: schemeE2e },
    };
    for (const group of Object.values(reports)) for (const entry of Object.values(group)) delete entry.report;
    nativeFiles = validated.nativeFiles;
    const persistenceReport = await loadReport(option("--persistence-report", null));
    persistence = {
      path: persistenceReport.path,
      sha256: persistenceReport.sha256,
      ...validatePersistenceReport(persistenceReport.report, platform, expectedSha, await frozenMigrationSha()),
    };
    const profileRestartReport = await loadReport(option("--profile-restart-report", null));
    assert.equal(profileRestartReport.path, `.artifacts/${platform}-profile-restart.json`, "Profile restart report path is noncanonical");
    await validateProfileRestartReport(profileRestartReport.report, platform, expectedSha);
    profileRestart = collectProfileRestartEvidence(profileRestartReport.path, profileRestartReport.sha256);
  }
  const evidence = {
    schemaVersion: CI_EVIDENCE_SCHEMA_VERSION,
    checkedOutSha,
    expectedSha,
    platform,
    flavor,
    testResult,
    packageLockSha256: await sha256("package-lock.json"),
    knowledgeManifestSha256: {
      public: await sha256("knowledge/manifest.public.yaml"),
      private: await sha256("knowledge/manifest.private.yaml"),
      source: await sha256("knowledge/sources/who-growth/source-manifest.json"),
    },
    nativeFiles,
    reports,
    faultBundles,
    persistence,
    profileRestart,
    runner: {
      os: process.env.RUNNER_OS ?? process.platform,
      arch: process.env.RUNNER_ARCH ?? process.arch,
      image: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      runnerName: process.env.RUNNER_NAME ?? null,
    },
    node: process.version,
    xcode: process.platform === "darwin" ? command("xcodebuild", ["-version"]) : null,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ evidence: "pass", output, checked_out_sha: checkedOutSha, test_result_sha256: testResult.file.sha256 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
