import { MIGRATION_1_SHA256, MIGRATION_1_SQL } from "./migration1.ts";
import { sha256 } from "./sha256.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

export interface MigrationDatabase {
  execAsync(source: string): Promise<void>;
  getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]>;
  runAsync(source: string, ...params: unknown[]): Promise<unknown>;
}

interface AppliedMigration {
  version: number;
  name: string;
  sha256: string;
}

export const USER_DATABASE_MIGRATIONS = Object.freeze<readonly Migration[]>([
  Object.freeze({
    version: 1,
    name: "initial-schema",
    sql: MIGRATION_1_SQL,
    sha256: MIGRATION_1_SHA256,
  }),
]);

function validateMigrationDefinitions(migrations: readonly Migration[]): void {
  let expectedVersion = 1;
  for (const migration of migrations) {
    if (migration.version !== expectedVersion) {
      throw new Error(`Migration definitions must be contiguous from version 1; expected ${expectedVersion}`);
    }
    if (sha256(migration.sql) !== migration.sha256) {
      throw new Error(`Migration ${migration.version} source hash does not match its frozen SHA-256`);
    }
    expectedVersion += 1;
  }
}

async function readAppliedMigrations(database: MigrationDatabase): Promise<AppliedMigration[]> {
  const table = await database.getAllAsync<{ found: number }>(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (table.length === 0) {
    return [];
  }
  return database.getAllAsync<AppliedMigration>(
    "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
  );
}

function validateAppliedMigrations(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): void {
  for (let index = 0; index < applied.length; index += 1) {
    const record = applied[index]!;
    const expected = migrations[index];
    if (!expected || record.version !== expected.version) {
      throw new Error(`Database contains unknown or non-contiguous migration version ${record.version}`);
    }
    if (record.name !== expected.name || record.sha256 !== expected.sha256) {
      throw new Error(`Database migration ${record.version} does not match the frozen name and SHA-256`);
    }
  }
}

export async function applyUserDatabaseMigrations(
  database: MigrationDatabase,
  migrations: readonly Migration[] = USER_DATABASE_MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  validateMigrationDefinitions(migrations);
  await database.execAsync("BEGIN IMMEDIATE");
  try {
    const applied = await readAppliedMigrations(database);
    validateAppliedMigrations(applied, migrations);

    for (const migration of migrations.slice(applied.length)) {
      await database.execAsync(migration.sql);
      await database.runAsync(
        "INSERT INTO schema_migrations(version, name, sha256, applied_at) VALUES (?, ?, ?, ?)",
        migration.version,
        migration.name,
        migration.sha256,
        now(),
      );
    }
    await database.execAsync("COMMIT");
  } catch (migrationError) {
    try {
      await database.execAsync("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [migrationError, rollbackError],
        "User database migration failed and its rollback also failed",
      );
    }
    throw migrationError;
  }
}
