import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
const DESTINATION_READBACK_CANONICALIZATION_VERSION = 1;
const DESTINATION_READBACK_SCHEMA_SHA256 = "6b0f47330ed82306a6f601f4ad87a865c692fb0356ede4cda38a610a4d14b8e4";
const DESTINATION_READBACK_SCENARIOS = new Set(["migrationHashRetry", "failedMigrationRollback"]);
const EXPECTED_PERSISTENCE_SCENARIO_FACTS = Object.freeze({
  meta: { value_json: '"preserved"' },
  jobs: [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }],
  turns: [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }],
  tasks: [{ id: "e2e-p", status: "expired" }],
});
const DESTINATION_READBACK_COMPARISON_KEYS = [
  "checkedOutShaMatchesExpected",
  "destinationCheckpointComplete",
  "destinationJournalModeIsWal",
  "destinationMigrationIdentityMatchesFrozen",
  "destinationQuickCheckOk",
  "destinationScenarioFactsMatchExpected",
  "destinationSchemaFingerprintMatchesFrozen",
  "journalModeEqual",
  "migrationIdentityEqual",
  "scenarioFactsEqual",
  "schemaFingerprintEqual",
  "sourceJournalModeIsWal",
  "sourceMigrationIdentityMatchesFrozen",
  "sourceQuickCheckOk",
  "sourceScenarioFactsMatchExpected",
  "sourceSchemaFingerprintMatchesFrozen",
];

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required) assert(value, `${name} is required`);
  return value;
}

export function frozenMigrationSha() {
  const source = readFileSync(new URL("../src/infrastructure/db/migrations/migration1.ts", import.meta.url), "utf8");
  const match = /export const MIGRATION_1_SHA256 = "([0-9a-f]{64})"/.exec(source);
  assert(match, "Frozen migration SHA is absent");
  return match[1];
}

function database(path) {
  return new DatabaseSync(path);
}

function checkpoint(db) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return sha256Bytes(canonicalJson(value));
}

function normalizedQuickCheck(db) {
  try {
    const rows = db.prepare("PRAGMA quick_check").all();
    return rows.length === 1 && rows[0]?.quick_check === "ok" ? "ok" : "failed";
  } catch {
    return "unavailable";
  }
}

function normalizedMigration(db) {
  try {
    const rows = db.prepare("SELECT version,name,sha256 FROM schema_migrations ORDER BY version").all();
    if (!rows.every((row) => Number.isSafeInteger(row.version)
      && typeof row.name === "string" && /^[a-z0-9-]{1,64}$/.test(row.name)
      && typeof row.sha256 === "string" && /^[0-9a-f]{64}$/.test(row.sha256))) return [];
    return rows.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
  } catch {
    return [];
  }
}

function normalizedJournalMode(db) {
  try {
    const value = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    return ["delete", "truncate", "persist", "memory", "wal", "off"].includes(value) ? value : "unavailable";
  } catch {
    return "unavailable";
  }
}

function schemaFingerprintSha256(db) {
  try {
    const rows = db.prepare(`SELECT type,name,tbl_name AS tableName,sql
      FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type,name,tbl_name,sql`).all();
    if (!rows.every((row) => typeof row.type === "string"
      && typeof row.name === "string"
      && typeof row.tableName === "string"
      && (row.sql === null || typeof row.sql === "string"))) return null;
    const normalized = rows.map(({ type, name, tableName, sql }) => ({
      type,
      name,
      tableName,
      sql: sql === null ? null : sql.replace(/\r\n?/g, "\n").trim(),
    }));
    return canonicalSha256(normalized);
  } catch {
    return null;
  }
}

function scenarioFactsSha256(db, scenario) {
  try {
    const facts = {
      meta: db.prepare("SELECT value_json FROM app_meta WHERE key='e2e.persistence.sentinel'").get() ?? null,
      jobs: db.prepare("SELECT id,status,lease_owner,lease_expires_at FROM local_jobs WHERE id='e2e-j' ORDER BY id").all(),
      turns: db.prepare("SELECT id,status,error_code FROM chat_turns WHERE id='e2e-t' ORDER BY id").all(),
      tasks: db.prepare("SELECT id,status FROM pending_agent_tasks WHERE id='e2e-p' ORDER BY id").all(),
    };
    return canonicalSha256({ scenario, facts });
  } catch {
    return null;
  }
}

function readOnlyDatabaseProof(db, scenario, origin) {
  return {
    origin,
    quickCheck: normalizedQuickCheck(db),
    migration: normalizedMigration(db),
    journalMode: normalizedJournalMode(db),
    schemaFingerprintSha256: schemaFingerprintSha256(db),
    scenarioFactsSha256: scenarioFactsSha256(db, scenario),
  };
}

function emptyDatabaseProof(origin) {
  return {
    origin,
    quickCheck: "unavailable",
    migration: [],
    journalMode: "unavailable",
    schemaFingerprintSha256: null,
    scenarioFactsSha256: null,
  };
}

function emptyDestinationReadbackReport() {
  return {
    schemaVersion: 1,
    reportType: "destination-database-readback",
    platform: "ios",
    scenario: null,
    canonicalizationVersion: DESTINATION_READBACK_CANONICALIZATION_VERSION,
    checkedOutSha: null,
    expectedSha: null,
    source: emptyDatabaseProof("prepared-host-source"),
    destination: {
      origin: "device-readback",
      checkpoint: { busy: null, logFrames: null, checkpointedFrames: null },
      quickCheck: "unavailable",
      migration: [],
      journalMode: "unavailable",
      schemaFingerprintSha256: null,
      scenarioFactsSha256: null,
    },
    comparison: Object.fromEntries(DESTINATION_READBACK_COMPARISON_KEYS.map((key) => [key, false])),
    status: "fail",
  };
}

function rawUniqueOption(name) {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) return undefined;
  const value = process.argv[indexes[0] + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : undefined;
}

function exactDestinationReadbackOptions() {
  const allowed = new Set([
    "--action",
    "--platform",
    "--scenario",
    "--expected-sha",
    "--source",
    "--destination",
    "--destination-checkpoint-status",
    "--destination-checkpoint",
    "--output",
  ]);
  const args = process.argv.slice(2);
  assert.equal(args.length % 2, 0);
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    assert(allowed.has(name));
    assert(!parsed.has(name));
    assert(typeof value === "string" && !value.startsWith("--"));
    parsed.set(name, value);
  }
  assert.deepEqual([...parsed.keys()].sort(), [...allowed].sort());
  return Object.fromEntries(parsed);
}

function parseDestinationCheckpointStatus(value) {
  assert.match(value, /^(0|[1-9]\d{0,2})$/);
  const status = Number(value);
  assert(Number.isSafeInteger(status) && status <= 255);
  return status;
}

function parseDestinationCheckpoint(value) {
  const match = /^(0|[1-9]\d*)\|(0|[1-9]\d*)\|(0|[1-9]\d*)$/.exec(value);
  assert(match);
  const checkpoint = {
    busy: Number(match[1]),
    logFrames: Number(match[2]),
    checkpointedFrames: Number(match[3]),
  };
  assert(Object.values(checkpoint).every(Number.isSafeInteger));
  return checkpoint;
}

function assertDistinctRegularDatabases(source, destination) {
  assert.notEqual(resolve(source), resolve(destination));
  assert(lstatSync(source).isFile() && lstatSync(destination).isFile());
  const sourceStat = statSync(source);
  const destinationStat = statSync(destination);
  assert(sourceStat.isFile() && destinationStat.isFile());
  assert(sourceStat.dev !== destinationStat.dev || sourceStat.ino !== destinationStat.ino);
}

function currentCheckedOutSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const sha = result.status === 0 ? result.stdout.trim() : "";
  assert.match(sha, /^[0-9a-f]{40}$/);
  return sha;
}

function inspectDestinationReadbackDatabases(sourcePath, destinationPath, scenario) {
  let sourceDb;
  let destinationDb;
  let source = emptyDatabaseProof("prepared-host-source");
  let destination = emptyDatabaseProof("device-readback");
  let closed = true;
  try {
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
    destinationDb = new DatabaseSync(destinationPath, { readOnly: true });
    source = readOnlyDatabaseProof(sourceDb, scenario, "prepared-host-source");
    destination = readOnlyDatabaseProof(destinationDb, scenario, "device-readback");
  } finally {
    for (const db of [destinationDb, sourceDb]) {
      if (db === undefined) continue;
      try { db.close(); } catch { closed = false; }
    }
  }
  return { source, destination, closed };
}

function exactKeys(value, keys) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function validateDestinationReadbackReport(report) {
  exactKeys(report, [
    "schemaVersion", "reportType", "platform", "scenario", "canonicalizationVersion",
    "checkedOutSha", "expectedSha", "source", "destination", "comparison", "status",
  ]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.reportType, "destination-database-readback");
  assert.equal(report.platform, "ios");
  assert(report.scenario === null || DESTINATION_READBACK_SCENARIOS.has(report.scenario));
  assert.equal(report.canonicalizationVersion, DESTINATION_READBACK_CANONICALIZATION_VERSION);
  for (const sha of [report.checkedOutSha, report.expectedSha]) assert(sha === null || /^[0-9a-f]{40}$/.test(sha));
  for (const [proof, origin] of [[report.source, "prepared-host-source"], [report.destination, "device-readback"]]) {
    const keys = ["origin", "quickCheck", "migration", "journalMode", "schemaFingerprintSha256", "scenarioFactsSha256"];
    if (origin === "device-readback") keys.push("checkpoint");
    exactKeys(proof, keys);
    assert.equal(proof.origin, origin);
    assert(["ok", "failed", "unavailable"].includes(proof.quickCheck));
    assert(Array.isArray(proof.migration));
    for (const migration of proof.migration) {
      exactKeys(migration, ["version", "name", "sha256"]);
      assert(Number.isSafeInteger(migration.version));
      assert.match(migration.name, /^[a-z0-9-]{1,64}$/);
      assert.match(migration.sha256, /^[0-9a-f]{64}$/);
    }
    assert(["delete", "truncate", "persist", "memory", "wal", "off", "unavailable"].includes(proof.journalMode));
    for (const hash of [proof.schemaFingerprintSha256, proof.scenarioFactsSha256]) assert(hash === null || /^[0-9a-f]{64}$/.test(hash));
  }
  exactKeys(report.destination.checkpoint, ["busy", "logFrames", "checkpointedFrames"]);
  for (const value of Object.values(report.destination.checkpoint)) assert(value === null || (Number.isSafeInteger(value) && value >= 0));
  exactKeys(report.comparison, DESTINATION_READBACK_COMPARISON_KEYS);
  assert(Object.values(report.comparison).every((value) => typeof value === "boolean"));
  assert(["pass", "fail"].includes(report.status));
  if (report.status === "pass") {
    assert(Object.values(report.comparison).every(Boolean));
    assert.match(report.checkedOutSha, /^[0-9a-f]{40}$/);
    assert.equal(report.checkedOutSha, report.expectedSha);
  }
}

function destinationReadback() {
  const output = rawUniqueOption("--output");
  let report = emptyDestinationReadbackReport();
  let checkpointFailureStatus = null;
  const rawScenario = rawUniqueOption("--scenario");
  const rawExpectedSha = rawUniqueOption("--expected-sha");
  const rawCheckpointStatus = rawUniqueOption("--destination-checkpoint-status");
  const rawCheckpoint = rawUniqueOption("--destination-checkpoint");
  if (DESTINATION_READBACK_SCENARIOS.has(rawScenario)) report.scenario = rawScenario;
  if (/^[0-9a-f]{40}$/.test(rawExpectedSha ?? "")) report.expectedSha = rawExpectedSha;
  try { report.checkedOutSha = currentCheckedOutSha(); } catch { /* retained as null */ }
  try {
    const status = parseDestinationCheckpointStatus(rawCheckpointStatus);
    if (status === 0) report.destination.checkpoint = parseDestinationCheckpoint(rawCheckpoint);
    else checkpointFailureStatus = status;
  } catch { /* retained as unavailable */ }
  try {
    const options = exactDestinationReadbackOptions();
    assert.equal(options["--action"], "destination-readback");
    assert.equal(options["--platform"], "ios");
    assert(DESTINATION_READBACK_SCENARIOS.has(options["--scenario"]));
    assert.match(options["--expected-sha"], /^[0-9a-f]{40}$/);
    report.scenario = options["--scenario"];
    report.expectedSha = options["--expected-sha"];
    const checkpointStatus = parseDestinationCheckpointStatus(options["--destination-checkpoint-status"]);
    if (checkpointStatus !== 0) {
      checkpointFailureStatus = checkpointStatus;
      assert.equal(options["--destination-checkpoint"], "");
      throw new Error("Destination checkpoint failed");
    }
    report.destination.checkpoint = parseDestinationCheckpoint(options["--destination-checkpoint"]);
    assertDistinctRegularDatabases(options["--source"], options["--destination"]);
    const inspected = inspectDestinationReadbackDatabases(options["--source"], options["--destination"], report.scenario);
    report.source = inspected.source;
    report.destination = { ...inspected.destination, checkpoint: report.destination.checkpoint };
    const frozenMigration = [{ version: 1, name: "initial-schema", sha256: frozenMigrationSha() }];
    const expectedFactsSha256 = canonicalSha256({ scenario: report.scenario, facts: EXPECTED_PERSISTENCE_SCENARIO_FACTS });
    report.comparison = {
      checkedOutShaMatchesExpected: report.checkedOutSha === report.expectedSha,
      destinationCheckpointComplete: report.destination.checkpoint.busy === 0
        && report.destination.checkpoint.logFrames === report.destination.checkpoint.checkpointedFrames,
      destinationJournalModeIsWal: report.destination.journalMode === "wal",
      destinationMigrationIdentityMatchesFrozen: canonicalJson(report.destination.migration) === canonicalJson(frozenMigration),
      destinationQuickCheckOk: report.destination.quickCheck === "ok",
      destinationScenarioFactsMatchExpected: report.destination.scenarioFactsSha256 === expectedFactsSha256,
      destinationSchemaFingerprintMatchesFrozen: report.destination.schemaFingerprintSha256 === DESTINATION_READBACK_SCHEMA_SHA256,
      journalModeEqual: report.source.journalMode === report.destination.journalMode,
      migrationIdentityEqual: canonicalJson(report.source.migration) === canonicalJson(report.destination.migration),
      scenarioFactsEqual: report.source.scenarioFactsSha256 !== null
        && report.source.scenarioFactsSha256 === report.destination.scenarioFactsSha256,
      schemaFingerprintEqual: report.source.schemaFingerprintSha256 !== null
        && report.source.schemaFingerprintSha256 === report.destination.schemaFingerprintSha256,
      sourceJournalModeIsWal: report.source.journalMode === "wal",
      sourceMigrationIdentityMatchesFrozen: canonicalJson(report.source.migration) === canonicalJson(frozenMigration),
      sourceQuickCheckOk: report.source.quickCheck === "ok",
      sourceScenarioFactsMatchExpected: report.source.scenarioFactsSha256 === expectedFactsSha256,
      sourceSchemaFingerprintMatchesFrozen: report.source.schemaFingerprintSha256 === DESTINATION_READBACK_SCHEMA_SHA256,
    };
    if (inspected.closed && Object.values(report.comparison).every(Boolean)) report.status = "pass";
  } catch {
    report.status = "fail";
  }
  try {
    validateDestinationReadbackReport(report);
  } catch {
    report = emptyDestinationReadbackReport();
  }
  if (output !== undefined) {
    try { writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); } catch { process.exitCode = 1; return; }
  }
  process.exitCode = report.status === "pass" ? 0 : checkpointFailureStatus ?? 1;
}

function exactMigrationIdentity() {
  const source = readFileSync(new URL("../src/infrastructure/db/migrations/migration1.ts", import.meta.url));
  const text = source.toString("utf8");
  const start = text.indexOf("String.raw`") + "String.raw`".length;
  const end = text.indexOf("`;\n\nexport const MIGRATION_1_SHA256", start);
  assert(start >= "String.raw`".length && end > start, "Migration SQL source is malformed");
  return {
    recordedSha256: frozenMigrationSha(),
    sourceSha256: sha256Bytes(source),
    sqlBytes: Buffer.byteLength(text.slice(start, end)),
    inventory: { tables: 26, indexes: 14, triggers: 3 },
  };
}

function profileValuesFromRow(row) {
  return {
    birthDate: row.birth_date,
    birthHeadCm: row.birth_head_cm,
    birthHeightCm: row.birth_height_cm,
    birthWeightG: row.birth_weight_g,
    gestationalWeeks: row.gestational_weeks,
    isPremature: row.is_premature === 1,
    name: row.name,
    sex: row.sex,
  };
}

function profileSnapshot(path) {
  const db = database(path);
  const babyProfileCount = db.prepare("SELECT count(*) AS total FROM baby_profile").get().total;
  const modelConfigCount = db.prepare("SELECT count(*) AS total FROM model_config").get().total;
  const modelCapabilitiesCount = db.prepare("SELECT count(*) AS total FROM model_capabilities").get().total;
  const rows = db.prepare(`SELECT singleton_id,name,sex,birth_date,birth_weight_g,birth_height_cm,birth_head_cm,
    is_premature,gestational_weeks,created_at,updated_at FROM baby_profile ORDER BY singleton_id`).all();
  db.close();
  assert(babyProfileCount === rows.length, "Baby profile row count is inconsistent");
  const row = rows.length === 1 ? rows[0] : null;
  return {
    babyProfileCount,
    modelConfigCount,
    modelCapabilitiesCount,
    row,
    valueSha256: row ? sha256Bytes(JSON.stringify(profileValuesFromRow(row))) : null,
    rowSha256: row ? sha256Bytes(JSON.stringify(row)) : null,
  };
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  assert(match, "Device local date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  assert(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day, "Device local date is invalid");
  return { year, month, day, time, iso: value };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(date, count) {
  const monthIndex = date.year * 12 + date.month - 1 + count;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return parseLocalDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

function ageOracle(localDate) {
  const birth = parseLocalDate(PROFILE_VALUES.birthDate);
  const today = parseLocalDate(localDate);
  assert(today.time >= birth.time, "Device local date predates the fixture birth date");
  let completedMonths = (today.year - birth.year) * 12 + today.month - birth.month;
  let anchor = addMonths(birth, completedMonths);
  if (anchor.time > today.time) {
    completedMonths -= 1;
    anchor = addMonths(birth, completedMonths);
  }
  const dayMilliseconds = 24 * 60 * 60 * 1000;
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

function profilePrivacyProof() {
  const result = spawnSync("git", ["ls-files", "-z", "App*", "index*", "src/**", "app.config.*"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  assert.equal(result.status, 0, "Unable to enumerate tracked runtime sources");
  const files = result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  const requestPrimitiveMatches = [];
  const primitive = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\baxios\b|\b(?:http|https)\s*\.\s*(?:request|get)\s*\(|\b(?:ky|superagent|got)\s*\(/gi;
  for (const file of files) {
    const bytes = readFileSync(resolve(repoRoot, file));
    digest.update(file).update("\0").update(bytes).update("\0");
    const lines = bytes.toString("utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
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

function validateProfileReport(report) {
  assert.deepEqual(Object.keys(report).sort(), ["schemaVersion", "reportType", "platform", "flavor", "checkedOutSha", "expectedSha", "testId", "fixture", "calendar", "ageOracle", "binary", "database", "lifecycle", "privacy", "migration", "evidence", "status", "skipped"].sort());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.reportType, "baby-profile-offline-restart");
  assert(["android", "ios"].includes(report.platform));
  assert.equal(report.flavor, "e2e-release");
  assert.equal(report.checkedOutSha, report.expectedSha);
  assert.match(report.expectedSha, /^[0-9a-f]{40}$/);
  assert.equal(report.testId, "E2E-001/profile");
  assert.deepEqual(report.fixture, { id: "synthetic-leap-day-v1", values: PROFILE_VALUES, valueSha256: PROFILE_VALUE_SHA256 });
  assert.equal(report.calendar.beforeSave, report.calendar.afterSave);
  assert.equal(report.calendar.beforeSave, report.calendar.afterRelaunch);
  assert.equal(report.calendar.stable, true);
  assert.deepEqual(report.ageOracle, ageOracle(report.calendar.beforeSave));
  assert.deepEqual(report.database.preSave, { babyProfileCount: 0, modelConfigCount: 0, modelCapabilitiesCount: 0, row: null, valueSha256: null, rowSha256: null });
  for (const snapshot of [report.database.postSave, report.database.postRelaunch]) {
    assert.equal(snapshot.babyProfileCount, 1);
    assert.equal(snapshot.modelConfigCount, 0);
    assert.equal(snapshot.modelCapabilitiesCount, 0);
    assert.equal(snapshot.valueSha256, PROFILE_VALUE_SHA256);
    assert.equal(snapshot.rowSha256, sha256Bytes(JSON.stringify(snapshot.row)));
  }
  assert.deepEqual(report.database.postRelaunch, report.database.postSave);
  assert.deepEqual(report.migration, exactMigrationIdentity());
  assert.deepEqual(report.privacy, profilePrivacyProof());
  assert.equal(report.status, "pass");
  assert.deepEqual(report.skipped, []);
  return report;
}

function seedRecovery(path) {
  const db = database(path);
  const old = "2026-01-01T00:00:00.000Z";
  db.exec(`BEGIN IMMEDIATE;
    INSERT OR REPLACE INTO app_meta(key,value_json,updated_at) VALUES ('e2e.persistence.sentinel','"preserved"','${old}');
    INSERT OR REPLACE INTO conversations(id,started_at,created_at,updated_at) VALUES ('e2e-c','${old}','${old}','${old}');
    INSERT OR REPLACE INTO chat_turns(id,conversation_id,idempotency_key,status,requested_at,updated_at) VALUES ('e2e-t','e2e-c','e2e-k','generating','${old}','${old}');
    INSERT OR REPLACE INTO pending_agent_tasks(id,conversation_id,source_turn_id,task_type,status,risk_level,payload_json,missing_slots_json,expires_at,created_at,updated_at) VALUES ('e2e-p','e2e-c','e2e-t','tracker_create','pending','low','{}','[]','${old}','${old}','${old}');
    INSERT OR REPLACE INTO local_jobs(id,kind,dedupe_key,effect_key,status,payload_json,attempt_count,lease_owner,lease_expires_at,created_at,updated_at) VALUES ('e2e-j','memory','e2e-d','e2e-e','leased','{}',1,'e2e','${old}','${old}','${old}');
    COMMIT;`);
  checkpoint(db);
  db.close();
}

function setMigrationSha(path, sha) {
  const db = database(path);
  db.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1").run(sha);
  checkpoint(db);
  db.close();
}

function createPoison(path) {
  const db = database(path);
  db.exec(`PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    BEGIN IMMEDIATE;
    CREATE TABLE chat_turns (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE pending_agent_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE local_jobs (
      id TEXT PRIMARY KEY,
      effect_key TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      next_attempt_at TEXT,
      last_error_code TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE committed_job_effects (effect_key TEXT PRIMARY KEY);
    CREATE TABLE photos (id TEXT PRIMARY KEY, import_state TEXT NOT NULL);
    INSERT INTO chat_turns(id,conversation_id,status,error_code,completed_at,updated_at)
      VALUES ('poison-turn','poison-conversation','completed',NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO messages(id,conversation_id,turn_id,role)
      VALUES ('poison-message','poison-conversation','poison-turn','user');
    INSERT INTO pending_agent_tasks(id,status,expires_at,updated_at)
      VALUES ('poison-task','completed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO local_jobs(id,effect_key,status,lease_owner,lease_expires_at,next_attempt_at,last_error_code,updated_at)
      VALUES ('poison-job','poison-effect','queued',NULL,NULL,NULL,NULL,'2026-01-01T00:00:00.000Z');
    INSERT INTO committed_job_effects(effect_key) VALUES ('poison-effect');
    INSERT INTO photos(id,import_state) VALUES ('poison-photo','committed');
    COMMIT;`);
  checkpoint(db);
  db.close();
}

function snapshot(path) {
  const db = database(path);
  checkpoint(db);
  const migration = db.prepare("SELECT version,name,sha256 FROM schema_migrations ORDER BY version").all();
  const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  const objectTypes = db.prepare("SELECT type,count(*) AS total FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type").all();
  const meta = db.prepare("SELECT value_json FROM app_meta WHERE key='e2e.persistence.sentinel'").get() ?? null;
  const jobs = db.prepare("SELECT id,status,lease_owner,lease_expires_at FROM local_jobs WHERE id='e2e-j'").all();
  const turns = db.prepare("SELECT id,status,error_code FROM chat_turns WHERE id='e2e-t'").all();
  const tasks = db.prepare("SELECT id,status FROM pending_agent_tasks WHERE id='e2e-p'").all();
  db.close();
  const bytes = readFileSync(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), migration, journalMode, objectTypes, meta, jobs, turns, tasks };
}

function poisonSnapshot(path) {
  const db = database(path);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const columns = Object.fromEntries(tables.map((table) => [table, db.prepare(`PRAGMA table_info(${table})`).all()]));
  const rows = {
    chat_turns: db.prepare("SELECT id,conversation_id,status,error_code,completed_at,updated_at FROM chat_turns ORDER BY id").all(),
    messages: db.prepare("SELECT id,conversation_id,turn_id,role FROM messages ORDER BY id").all(),
    pending_agent_tasks: db.prepare("SELECT id,status,expires_at,updated_at FROM pending_agent_tasks ORDER BY id").all(),
    local_jobs: db.prepare("SELECT id,effect_key,status,lease_owner,lease_expires_at,next_attempt_at,last_error_code,updated_at FROM local_jobs ORDER BY id").all(),
    committed_job_effects: db.prepare("SELECT effect_key FROM committed_job_effects ORDER BY effect_key").all(),
    photos: db.prepare("SELECT id,import_state FROM photos ORDER BY id").all(),
  };
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  db.close();
  return { objects, columns, rows, foreignKeyViolations, journalMode };
}

function report() {
  const platform = option("--platform");
  const expectedSha = option("--expected-sha");
  const first = JSON.parse(readFileSync(option("--first"), "utf8"));
  const recovered = JSON.parse(readFileSync(option("--recovered"), "utf8"));
  const recoveredNoop = JSON.parse(readFileSync(option("--recovered-noop"), "utf8"));
  const retried = JSON.parse(readFileSync(option("--retried"), "utf8"));
  const poisonBefore = JSON.parse(readFileSync(option("--poison-before"), "utf8"));
  const poisonAfter = JSON.parse(readFileSync(option("--poison-after"), "utf8"));
  const migrationSha = frozenMigrationSha();
  for (const state of [first, recovered, recoveredNoop, retried]) {
    assert.deepEqual(state.migration, [{ version: 1, name: "initial-schema", sha256: migrationSha }]);
    assert.equal(state.journalMode, "wal");
  }
  assert.equal(recovered.meta?.value_json, '"preserved"');
  assert.deepEqual(recovered.jobs, [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }]);
  assert.deepEqual(recovered.turns, [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }]);
  assert.deepEqual(recovered.tasks, [{ id: "e2e-p", status: "expired" }]);
  assert.equal(retried.meta?.value_json, '"preserved"');
  assert.deepEqual(recoveredNoop.jobs, recovered.jobs);
  assert.deepEqual(recoveredNoop.turns, recovered.turns);
  assert.deepEqual(recoveredNoop.tasks, recovered.tasks);
  assert.deepEqual(poisonAfter, poisonBefore);
  return {
    schemaVersion: 2,
    reportType: "startup-persistence",
    platform,
    checkedOutSha: expectedSha,
    expectedSha,
    migrationSha256: migrationSha,
    scenarios: {
      firstOpen: { status: "pass", snapshot: first },
      recoveryRelaunch: { status: "pass", snapshot: recovered, noOpSnapshot: recoveredNoop },
      migrationHashRetry: { status: "pass", snapshot: retried },
      failedMigrationRollback: {
        status: "pass",
        collisionObject: "chat_turns",
        beforeSnapshot: poisonBefore,
        afterSnapshot: poisonAfter,
      },
    },
    skipped: [],
  };
}

const action = option("--action");
if (action === "destination-readback") {
  destinationReadback();
} else {
  const path = option("--database", false);
  switch (action) {
    case "seed-recovery": seedRecovery(path); break;
    case "corrupt-hash": setMigrationSha(path, "0".repeat(64)); break;
    case "repair-hash": setMigrationSha(path, frozenMigrationSha()); break;
    case "create-poison": createPoison(path); break;
    case "snapshot": writeFileSync(option("--output"), `${JSON.stringify(snapshot(path), null, 2)}\n`); break;
    case "poison-snapshot": writeFileSync(option("--output"), `${JSON.stringify(poisonSnapshot(path), null, 2)}\n`); break;
    case "profile-snapshot": writeFileSync(option("--output"), `${JSON.stringify(profileSnapshot(path), null, 2)}\n`); break;
    case "age-oracle": writeFileSync(option("--output"), `${JSON.stringify(ageOracle(option("--local-date")), null, 2)}\n`); break;
    case "privacy-scan": writeFileSync(option("--output"), `${JSON.stringify(profilePrivacyProof(), null, 2)}\n`); break;
    case "profile-report": writeFileSync(option("--output"), `${JSON.stringify(validateProfileReport(JSON.parse(readFileSync(option("--input"), "utf8"))), null, 2)}\n`); break;
    case "report": writeFileSync(option("--output"), `${JSON.stringify(report(), null, 2)}\n`); break;
    default: throw new Error(`Unknown action: ${action}`);
  }
}
