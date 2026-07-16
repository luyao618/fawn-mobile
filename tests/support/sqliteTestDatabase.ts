import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { QueryRunHandle, SqlParameters } from "../../src/application/data/ExclusiveTransactionPort.ts";
import type { ExpoExclusiveDatabase, ExpoTransactionDatabase } from "../../src/infrastructure/db/exclusiveTransaction.ts";
import { applyUserDatabaseMigrations, USER_DATABASE_MIGRATIONS } from "../../src/infrastructure/db/migrations/index.ts";
import type { UserDatabaseConnection } from "../../src/infrastructure/db/initializeDatabase.ts";

function sqliteParameters(parameters: readonly unknown[]): SQLInputValue[] {
  return parameters.map((value) => {
    if (value === null || typeof value === "number" || typeof value === "bigint" || typeof value === "string" || ArrayBuffer.isView(value)) {
      return value as SQLInputValue;
    }
    throw new TypeError(`Unsupported SQLite test parameter: ${typeof value}`);
  });
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}

export class SQLiteTestDatabase implements UserDatabaseConnection, ExpoExclusiveDatabase, QueryRunHandle {
  readonly raw: DatabaseSync;
  readonly statements: string[] = [];
  private readonly transactionLock = new AsyncLock();

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
  }

  async migrate(now = () => "2026-07-16T00:00:00.000Z"): Promise<void> {
    await this.execAsync("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    await applyUserDatabaseMigrations(this, USER_DATABASE_MIGRATIONS, now);
  }

  async closeAsync(): Promise<void> {
    this.raw.close();
  }

  async execAsync(source: string): Promise<void> {
    this.statements.push(source);
    this.raw.exec(source);
  }

  async getAllAsync<T>(source: string, ...parameters: unknown[]): Promise<T[]> {
    this.statements.push(source);
    return this.raw.prepare(source).all(...sqliteParameters(parameters)) as T[];
  }

  async runAsync(source: string, ...parameters: unknown[]): Promise<{ changes: number; lastInsertRowId: number }> {
    this.statements.push(source);
    const result = this.raw.prepare(source).run(...sqliteParameters(parameters));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  query<T extends object>(sql: string, parameters: SqlParameters = []): Promise<readonly T[]> {
    return this.getAllAsync<T>(sql, ...parameters);
  }

  run(sql: string, parameters: SqlParameters = []): Promise<{ changes: number; lastInsertRowId: number }> {
    return this.runAsync(sql, ...parameters);
  }

  async withExclusiveTransactionAsync(operation: (transaction: ExpoTransactionDatabase) => Promise<void>): Promise<void> {
    const release = await this.transactionLock.acquire();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      await operation(this);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  }
}

export async function migratedTestDatabase(path = ":memory:"): Promise<SQLiteTestDatabase> {
  const database = new SQLiteTestDatabase(path);
  await database.migrate();
  return database;
}
