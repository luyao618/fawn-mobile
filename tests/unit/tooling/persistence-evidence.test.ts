import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { applyUserDatabaseMigrations, USER_DATABASE_MIGRATIONS } from "../../../src/infrastructure/db/migrations/index.ts";

function parameters(values: readonly unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

function tool(...args: string[]) {
  const result = spawnSync(process.execPath, [resolve("tools/persistence-evidence.mjs"), ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("persistence evidence tool checkpoints WAL and keeps exact frozen identities", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-persistence-evidence-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "user.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const adapter = {
    async execAsync(sql: string) { db.exec(sql); },
    async getAllAsync<T>(sql: string, ...values: unknown[]) { return db.prepare(sql).all(...parameters(values)) as T[]; },
    async runAsync(sql: string, ...values: unknown[]) { return db.prepare(sql).run(...parameters(values)); },
  };
  await applyUserDatabaseMigrations(adapter);
  db.close();

  const first = join(directory, "first.json");
  tool("--action", "snapshot", "--database", path, "--output", first);
  const snapshot = JSON.parse(readFileSync(first, "utf8"));
  assert.deepEqual(snapshot.migration, [{ version: 1, name: "initial-schema", sha256: USER_DATABASE_MIGRATIONS[0]!.sha256 }]);
  assert.deepEqual(snapshot.objectTypes, [{ type: "index", total: 14 }, { type: "table", total: 26 }, { type: "trigger", total: 3 }]);

  tool("--action", "corrupt-hash", "--database", path);
  let inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare("SELECT sha256 FROM schema_migrations WHERE version=1").get()?.sha256, "0".repeat(64));
  inspect.close();
  tool("--action", "repair-hash", "--database", path);
  inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare("SELECT sha256 FROM schema_migrations WHERE version=1").get()?.sha256, USER_DATABASE_MIGRATIONS[0]!.sha256);
  inspect.close();

  const poisonPath = join(directory, "poison.db");
  const poisonReport = join(directory, "poison.json");
  tool("--action", "create-poison", "--database", poisonPath);
  tool("--action", "poison-snapshot", "--database", poisonPath, "--output", poisonReport);
  const poison = JSON.parse(readFileSync(poisonReport, "utf8"));
  assert.deepEqual(poison.objects, ["chat_turns", "committed_job_effects", "local_jobs", "messages", "pending_agent_tasks", "photos"]
    .map((name) => ({ type: "table", name })));
  assert.deepEqual(Object.fromEntries(Object.entries(poison.columns).map(([table, columns]: [string, any]) => [table, columns.map((column: any) => column.name)])), {
    chat_turns: ["id", "conversation_id", "status", "error_code", "completed_at", "updated_at"],
    committed_job_effects: ["effect_key"],
    local_jobs: ["id", "effect_key", "status", "lease_owner", "lease_expires_at", "next_attempt_at", "last_error_code", "updated_at"],
    messages: ["id", "conversation_id", "turn_id", "role"],
    pending_agent_tasks: ["id", "status", "expires_at", "updated_at"],
    photos: ["id", "import_state"],
  });
  assert.deepEqual(poison.rows.chat_turns.map(({ status }: any) => status), ["completed"]);
  assert.deepEqual(poison.rows.messages.map(({ role }: any) => role), ["user"]);
  assert.deepEqual(poison.rows.pending_agent_tasks.map(({ status }: any) => status), ["completed"]);
  assert.deepEqual(poison.rows.local_jobs.map(({ status, effect_key }: any) => ({ status, effect_key })), [{ status: "queued", effect_key: "poison-effect" }]);
  assert.deepEqual(poison.rows.committed_job_effects, [{ effect_key: "poison-effect" }]);
  assert.deepEqual(poison.rows.photos, [{ id: "poison-photo", import_state: "committed" }]);
  assert.deepEqual(poison.foreignKeyViolations, []);
  assert.equal(poison.journalMode, "wal");

  const recovered = {
    ...snapshot,
    meta: { value_json: '"preserved"' },
    jobs: [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }],
    turns: [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }],
    tasks: [{ id: "e2e-p", status: "expired" }],
  };
  const recoveredPath = join(directory, "recovered.json");
  const reportPath = join(directory, "report.json");
  writeFileSync(recoveredPath, JSON.stringify(recovered));
  tool(
    "--action", "report", "--platform", "android", "--expected-sha", "a".repeat(40),
    "--first", first, "--recovered", recoveredPath, "--recovered-noop", recoveredPath, "--retried", recoveredPath,
    "--poison-before", poisonReport, "--poison-after", poisonReport, "--output", reportPath,
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.scenarios.failedMigrationRollback, {
    status: "pass", collisionObject: "chat_turns", beforeSnapshot: poison, afterSnapshot: poison,
  });
});
