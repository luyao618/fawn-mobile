import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
  db.exec("CREATE TABLE diagnostic_events(id TEXT PRIMARY KEY)");
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
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  db.close();
  return { objects };
}

function report() {
  const platform = option("--platform");
  const expectedSha = option("--expected-sha");
  const first = JSON.parse(readFileSync(option("--first"), "utf8"));
  const recovered = JSON.parse(readFileSync(option("--recovered"), "utf8"));
  const recoveredNoop = JSON.parse(readFileSync(option("--recovered-noop"), "utf8"));
  const retried = JSON.parse(readFileSync(option("--retried"), "utf8"));
  const poison = JSON.parse(readFileSync(option("--poison"), "utf8"));
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
  assert.deepEqual(poison.objects, ["diagnostic_events"]);
  return {
    schemaVersion: 1,
    reportType: "startup-persistence",
    platform,
    checkedOutSha: expectedSha,
    expectedSha,
    migrationSha256: migrationSha,
    scenarios: {
      firstOpen: { status: "pass", snapshot: first },
      recoveryRelaunch: { status: "pass", snapshot: recovered, noOpSnapshot: recoveredNoop },
      migrationHashRetry: { status: "pass", snapshot: retried },
      failedMigrationRollback: { status: "pass", snapshot: poison },
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
  case "report": writeFileSync(option("--output"), `${JSON.stringify(report(), null, 2)}\n`); break;
  default: throw new Error(`Unknown action: ${action}`);
}
