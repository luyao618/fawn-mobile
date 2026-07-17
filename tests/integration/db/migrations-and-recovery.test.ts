import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { recoverAndOpen } from "../../../src/application/bootstrap/recoverAndOpen.ts";
import { DataMutationCoordinator } from "../../../src/application/data/DataMutationCoordinator.ts";
import { ExpoSqliteExclusiveTransactionAdapter, type ExpoTransactionDatabase } from "../../../src/infrastructure/db/exclusiveTransaction.ts";
import { StartupRecoveryRepository } from "../../../src/infrastructure/db/repositories/startupRecoveryRepository.ts";
import { RejectPendingAlbumRecovery } from "../../../src/infrastructure/bootstrap/albumRecoveryBoundary.ts";

import {
  applyUserDatabaseMigrations,
  type MigrationDatabase,
  USER_DATABASE_MIGRATIONS,
} from "../../../src/infrastructure/db/migrations/index.ts";
import { MIGRATION_1_SQL } from "../../../src/infrastructure/db/migrations/migration1.ts";
import { sha256 } from "../../../src/infrastructure/db/migrations/sha256.ts";
import {
  configureUserDatabase,
  initializeUserDatabase,
  USER_DATABASE_NAME,
  USER_DATABASE_OPEN_OPTIONS,
  type UserDatabaseConnection,
} from "../../../src/infrastructure/db/initializeDatabase.ts";

function toSqliteParams(params: readonly unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (
      value === null
      || typeof value === "number"
      || typeof value === "bigint"
      || typeof value === "string"
      || ArrayBuffer.isView(value)
    ) {
      return value as SQLInputValue;
    }
    throw new TypeError(`Unsupported SQLite test parameter: ${typeof value}`);
  });
}

class RealDatabase implements MigrationDatabase, UserDatabaseConnection {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
  }

  async closeAsync(): Promise<void> {
    this.raw.close();
  }

  async execAsync(source: string): Promise<void> {
    this.raw.exec(source);
  }

  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    return this.raw.prepare(source).all(...toSqliteParams(params)) as T[];
  }

  async runAsync(source: string, ...params: unknown[]): Promise<unknown> {
    return this.raw.prepare(source).run(...toSqliteParams(params));
  }

  async withExclusiveTransactionAsync(operation: (transaction: ExpoTransactionDatabase) => Promise<void>): Promise<void> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      await operation(this as ExpoTransactionDatabase);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

class AsyncWriteLock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}

class ConcurrentRealDatabase extends RealDatabase {
  private releaseWriteLock: (() => void) | undefined;

  constructor(path: string, private readonly writeLock: AsyncWriteLock) {
    super(path);
  }

  override async execAsync(source: string): Promise<void> {
    if (source === "BEGIN IMMEDIATE") {
      this.releaseWriteLock = await this.writeLock.acquire();
      try {
        await super.execAsync(source);
      } catch (error) {
        this.releaseWriteLock();
        this.releaseWriteLock = undefined;
        throw error;
      }
      return;
    }
    try {
      await super.execAsync(source);
    } finally {
      if (source === "COMMIT" || source === "ROLLBACK") {
        this.releaseWriteLock?.();
        this.releaseWriteLock = undefined;
      }
    }
  }
}

const fixedNow = () => "2026-07-16T00:00:00.000Z";

async function migratedDatabase(path = ":memory:"): Promise<RealDatabase> {
  const database = new RealDatabase(path);
  if (path === ":memory:") {
    await database.execAsync(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
  } else {
    await configureUserDatabase(database);
  }
  await applyUserDatabaseMigrations(database, USER_DATABASE_MIGRATIONS, fixedNow);
  return database;
}

async function count(database: MigrationDatabase, source: string, ...params: unknown[]): Promise<number> {
  const [row] = await database.getAllAsync<{ total: number }>(source, ...params);
  return row!.total;
}

function assertAggregate(error: unknown, primary: Error, secondary: Error): boolean {
  assert(error instanceof AggregateError);
  assert.deepEqual(error.errors, [primary, secondary]);
  return true;
}

test("user.db initialization uses the approved open contract", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-initialize-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let openedName = "";
  let openedOptions: unknown;
  const opened = await initializeUserDatabase(async (name, options) => {
    openedName = name;
    openedOptions = options;
    return new RealDatabase(join(directory, name));
  });
  context.after(() => opened.closeAsync());

  assert.equal(openedName, USER_DATABASE_NAME);
  assert.deepEqual(openedOptions, USER_DATABASE_OPEN_OPTIONS);
  assert.equal(USER_DATABASE_OPEN_OPTIONS.enableChangeListener, true);
  assert.equal(USER_DATABASE_OPEN_OPTIONS.finalizeUnusedStatementsBeforeClosing, false);
});

test("initialization preserves pragma failure and secondary close failure", async () => {
  const primary = new Error("pragma failed");
  const closeFailure = new Error("close failed");
  let closeAttempted = false;

  await assert.rejects(
    initializeUserDatabase(async () => ({
      async closeAsync() { closeAttempted = true; throw closeFailure; },
      async execAsync() { throw primary; },
      async getAllAsync<T>() { return [] as T[]; },
      async runAsync() {},
    })),
    (error) => assertAggregate(error, primary, closeFailure),
  );
  assert.equal(closeAttempted, true);
});

test("initialization closes the failed connection when pragma read-back is hostile", async () => {
  let closed = false;
  await assert.rejects(
    initializeUserDatabase(async () => ({
      async closeAsync() { closed = true; },
      async execAsync() {},
      async getAllAsync<T>(source: string) {
        if (source === "PRAGMA foreign_keys") return [{ foreign_keys: 0 }] as T[];
        if (source === "PRAGMA journal_mode") return [{ journal_mode: "wal" }] as T[];
        return [{ timeout: 5_000 }] as T[];
      },
      async runAsync() {},
    })),
    /pragma verification failed/,
  );
  assert.equal(closed, true);
});

test("empty database applies migration 1 once and records its frozen identity", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  const records = await database.getAllAsync<{ version: number; name: string; sha256: string; applied_at: string }>(
    "SELECT version, name, sha256, applied_at FROM schema_migrations",
  );
  assert.deepEqual(records.map((record) => ({ ...record })), [{
    version: 1,
    name: "initial-schema",
    sha256: USER_DATABASE_MIGRATIONS[0]!.sha256,
    applied_at: fixedNow(),
  }]);
});

test("closing and reopening a migrated file is idempotent", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-migration-reopen-"));
  const path = join(directory, USER_DATABASE_NAME);
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = await migratedDatabase(path);
  await first.closeAsync();
  const second = await migratedDatabase(path);
  context.after(() => second.closeAsync());

  assert.equal(await count(second, "SELECT count(*) AS total FROM schema_migrations"), 1);
});

test("two real connections serialize concurrent first-open migration history", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-migration-concurrent-"));
  const path = join(directory, USER_DATABASE_NAME);
  const writeLock = new AsyncWriteLock();
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const opened = await Promise.all([
    initializeUserDatabase(async () => new ConcurrentRealDatabase(path, writeLock)),
    initializeUserDatabase(async () => new ConcurrentRealDatabase(path, writeLock)),
  ]);
  context.after(async () => Promise.all(opened.map((database) => database.closeAsync())));

  assert.equal(await count(opened[0]!, "SELECT count(*) AS total FROM schema_migrations"), 1);
  assert.equal(await count(opened[1]!, "SELECT count(*) AS total FROM schema_migrations"), 1);
});

test("all pending migrations share one transaction acquired before history reads", async (context) => {
  const database = new RealDatabase();
  context.after(() => database.closeAsync());
  const commands: string[] = [];
  const originalExec = database.execAsync.bind(database);
  const originalGetAll = database.getAllAsync.bind(database);
  database.execAsync = async (source) => { commands.push(source); await originalExec(source); };
  database.getAllAsync = async <T>(source: string, ...params: unknown[]) => {
    commands.push(`READ:${source}`);
    return originalGetAll<T>(source, ...params);
  };
  const firstSql = "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL); CREATE TABLE first_table(id INTEGER PRIMARY KEY);";
  const secondSql = "CREATE TABLE second_table(id INTEGER PRIMARY KEY);";
  const migrations = [
    { version: 1, name: "first", sql: firstSql, sha256: sha256(firstSql) },
    { version: 2, name: "second", sql: secondSql, sha256: sha256(secondSql) },
  ];

  await applyUserDatabaseMigrations(database, migrations, fixedNow);

  assert.equal(commands[0], "BEGIN IMMEDIATE");
  assert.match(commands[1]!, /^READ:/);
  assert.equal(commands.filter((command) => command === "BEGIN IMMEDIATE").length, 1);
  assert.equal(commands.filter((command) => command === "COMMIT").length, 1);
  assert.equal(await count(database, "SELECT count(*) AS total FROM schema_migrations"), 2);
});

test("stored migration hash mismatch rolls back without applying work", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("UPDATE schema_migrations SET sha256 = ? WHERE version = 1", "0".repeat(64));

  await assert.rejects(
    applyUserDatabaseMigrations(database, USER_DATABASE_MIGRATIONS, fixedNow),
    /does not match the frozen name and SHA-256/,
  );
  assert.equal(await count(database, "SELECT count(*) AS total FROM schema_migrations"), 1);
});

test("migration source hash mismatch fails before touching an empty database", async (context) => {
  const database = new RealDatabase();
  context.after(() => database.closeAsync());
  const migration = { ...USER_DATABASE_MIGRATIONS[0]!, sql: `${MIGRATION_1_SQL}\nSELECT 1;` };

  await assert.rejects(applyUserDatabaseMigrations(database, [migration], fixedNow), /source hash/);
  assert.equal(await count(database, "SELECT count(*) AS total FROM sqlite_master"), 0);
});

test("failed migration rolls back every migration-1 DDL object", async (context) => {
  const database = new RealDatabase();
  context.after(() => database.closeAsync());
  const sql = `${MIGRATION_1_SQL}\nTHIS IS NOT SQL;`;
  const migration = { version: 1, name: "rollback-proof", sql, sha256: sha256(sql) };

  await assert.rejects(applyUserDatabaseMigrations(database, [migration], fixedNow));
  assert.equal(await count(
    database,
    "SELECT count(*) AS total FROM sqlite_master WHERE name IN ('schema_migrations', 'baby_profile', 'messages')",
  ), 0);
});

test("migration failure preserves secondary rollback failure", async () => {
  const primary = new Error("migration failed");
  const rollbackFailure = new Error("rollback failed");
  const sql = "BROKEN";
  const database: MigrationDatabase = {
    async execAsync(source) {
      if (source === sql) throw primary;
      if (source === "ROLLBACK") throw rollbackFailure;
    },
    async getAllAsync<T>() { return [] as T[]; },
    async runAsync() {},
  };

  await assert.rejects(
    applyUserDatabaseMigrations(database, [{ version: 1, name: "broken", sql, sha256: sha256(sql) }], fixedNow),
    (error) => assertAggregate(error, primary, rollbackFailure),
  );
});

test("startup runs the frozen recovery order and closes idempotently", async () => {
  const transcript: string[] = [];
  let closeCount = 0;
  const transactions = { async runExclusive<T>(operation: (transaction: never) => Promise<T>) {
    transcript.push("transaction");
    return operation({} as never);
  } };
  const recovery = {
    async recoverExpiredLeases() { transcript.push("leases"); },
    async assertInterruptedTurnsConsistent() { transcript.push("turn-proof"); },
    async failInterruptedTurns() { transcript.push("turn-fail"); },
    async expireStaleTasks() { transcript.push("tasks"); },
    async validateCoreInvariants() { transcript.push("validate"); },
  };
  const runtime = await recoverAndOpen({
    coordinator: new DataMutationCoordinator(),
    restore: { async recover() { transcript.push("restore"); } },
    database: { async openConfigured() {
      transcript.push("open");
      return {
        transactions,
        async migrate() { transcript.push("migration"); },
        async close() { closeCount += 1; },
      };
    } },
    album: { async reconcile() { transcript.push("album"); } },
    recovery,
    clock: { now: () => "2026-07-16T00:00:00.000Z" },
  }, new AbortController().signal);
  assert.deepEqual(transcript, ["restore", "open", "migration", "album", "transaction", "leases", "turn-proof", "turn-fail", "tasks", "validate"]);
  await runtime.close();
  await runtime.close();
  assert.equal(closeCount, 1);
});

test("startup recovery updates expired durable state in one real transaction and is idempotent", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  await database.execAsync(`
    INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('c', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('t', 'c', 'k', 'generating', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES ('p', 'c', 't', 'tracker_create', 'pending', 'low', '{}', '[]', '2026-07-15T01:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, attempt_count, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('j1', 'memory', 'd1', 'e1', 'leased', '{}', 1, 'old', '2026-07-15T01:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, attempt_count, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('j2', 'memory', 'd2', 'e2', 'leased', '{}', 1, 'old', '2026-07-15T01:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO committed_job_effects(effect_key, job_id, result_hash, committed_at) VALUES ('e2', 'j2', NULL, '2026-07-15T00:30:00.000Z');
  `);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database as ConcurrentRealDatabase);
  const recovery = new StartupRecoveryRepository();
  const now = "2026-07-16T00:00:00.000Z";
  const run = () => transactions.runExclusive(async (transaction) => {
    await recovery.recoverExpiredLeases(transaction, now);
    await recovery.assertInterruptedTurnsConsistent(transaction);
    await recovery.failInterruptedTurns(transaction, now);
    await recovery.expireStaleTasks(transaction, now);
    await recovery.validateCoreInvariants(transaction, now);
  });
  await run();
  await run();
  assert.deepEqual((await database.getAllAsync<Record<string, unknown>>("SELECT id, status, lease_owner, lease_expires_at FROM local_jobs ORDER BY id")).map((row) => ({ ...row })), [
    { id: "j1", status: "queued", lease_owner: null, lease_expires_at: null },
    { id: "j2", status: "succeeded", lease_owner: null, lease_expires_at: null },
  ]);
  assert.deepEqual((await database.getAllAsync<Record<string, unknown>>("SELECT status, error_code FROM chat_turns WHERE id = 't'")).map((row) => ({ ...row })), [{ status: "failed", error_code: "startup_interrupted" }]);
  assert.deepEqual((await database.getAllAsync<Record<string, unknown>>("SELECT status FROM pending_agent_tasks WHERE id = 'p'")).map((row) => ({ ...row })), [{ status: "expired" }]);
});

test("generating turn with an assistant fails closed and rolls back prior lease recovery", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  await database.execAsync(`
    INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('c', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('t', 'c', 'k', 'generating', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('a', 'c', 't', 'assistant', 1, 'persisted', 'text', '2026-07-15T00:10:00.000Z');
    INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, attempt_count, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('j', 'memory', 'd', 'e', 'leased', '{}', 1, 'old', '2026-07-15T01:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
  `);
  const recovery = new StartupRecoveryRepository();
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database as ConcurrentRealDatabase);
  await assert.rejects(transactions.runExclusive(async (transaction) => {
    await recovery.recoverExpiredLeases(transaction, "2026-07-16T00:00:00.000Z");
    await recovery.assertInterruptedTurnsConsistent(transaction);
  }), /already owns an assistant/);
  assert.deepEqual((await database.getAllAsync<Record<string, unknown>>("SELECT status, lease_owner FROM local_jobs WHERE id = 'j'")).map((row) => ({ ...row })), [{ status: "leased", lease_owner: "old" }]);
});

test("startup failure closes before a later retry can reopen", async () => {
  const closeCalls: number[] = [];
  let attempt = 0;
  const dependencies = () => ({
    coordinator: new DataMutationCoordinator(),
    restore: { async recover() {} },
    database: { async openConfigured() {
      const current = ++attempt;
      return {
        transactions: { async runExclusive<T>(operation: (transaction: never) => Promise<T>) { return operation({} as never); } },
        async migrate() { if (current === 1) throw new Error("migration drift"); },
        async close() { closeCalls.push(current); },
      };
    } },
    album: { async reconcile() {} },
    recovery: {
      async recoverExpiredLeases() {}, async assertInterruptedTurnsConsistent() {}, async failInterruptedTurns() {},
      async expireStaleTasks() {}, async validateCoreInvariants() {},
    },
    clock: { now: () => "2026-07-16T00:00:00.000Z" },
  });
  await assert.rejects(recoverAndOpen(dependencies(), new AbortController().signal), /migration drift/);
  const runtime = await recoverAndOpen(dependencies(), new AbortController().signal);
  assert.deepEqual(closeCalls, [1]);
  await runtime.close();
  assert.deepEqual(closeCalls, [1, 2]);
});


test("startup rejects a noncanonical clock before recovery SQL", async () => {
  let transactionStarted = false;
  await assert.rejects(recoverAndOpen({
    coordinator: new DataMutationCoordinator(), restore: { async recover() {} },
    database: { async openConfigured() { return {
      transactions: { async runExclusive() { transactionStarted = true; throw new Error("unreachable"); } },
      async migrate() {}, async close() {},
    }; } },
    album: { async reconcile() {} },
    recovery: { async recoverExpiredLeases() {}, async assertInterruptedTurnsConsistent() {}, async failInterruptedTurns() {}, async expireStaleTasks() {}, async validateCoreInvariants() {} },
    clock: { now: () => "2026-07-16T00:00:00Z" },
  }, new AbortController().signal), /canonical UTC instant/);
  assert.equal(transactionStarted, false);
});

test("core invariants reject every remaining generating turn", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  await database.execAsync(`
    INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('c-left', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('t-left', 'c-left', 'k-left', 'generating', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
  `);
  const recovery = new StartupRecoveryRepository();
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  await assert.rejects(transactions.runExclusive((transaction) => recovery.validateCoreInvariants(transaction, "2026-07-16T00:00:00.000Z")), /left an interrupted generating turn/);
});

test("album boundary fails closed while any photo mutation is noncommitted", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  await database.execAsync(`INSERT INTO photos(id, storage_path, original_filename, mime_type, file_size_bytes, taken_at, import_state, created_at, updated_at)
    VALUES ('photo', 'album/photo.jpg', 'photo.jpg', 'image/jpeg', 1, '2026-07-15T00:00:00.000Z', 'staging', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const album = new RejectPendingAlbumRecovery();
  await assert.rejects(album.reconcile({ transactions, async migrate() {}, async close() {} }), /Album reconciliation is required/);
  await database.runAsync("UPDATE photos SET import_state = 'committed' WHERE id = 'photo'");
  await album.reconcile({ transactions, async migrate() {}, async close() {} });
});
