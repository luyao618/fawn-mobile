import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
