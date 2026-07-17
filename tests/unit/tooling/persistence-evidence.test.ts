import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  assert.deepEqual(JSON.parse(readFileSync(poisonReport, "utf8")), { objects: ["diagnostic_events"] });
});
