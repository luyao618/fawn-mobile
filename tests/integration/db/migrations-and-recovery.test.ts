import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

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
