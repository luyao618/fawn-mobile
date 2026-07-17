import { applyUserDatabaseMigrations, type MigrationDatabase } from "./migrations/index.ts";
import { cleanupFailure } from "../../shared/errors/cleanupFailure.ts";

export const USER_DATABASE_NAME = "user.db";
export const USER_DATABASE_BUSY_TIMEOUT_MS = 5_000;

export const USER_DATABASE_OPEN_OPTIONS = Object.freeze({
  enableChangeListener: true,
  finalizeUnusedStatementsBeforeClosing: false,
});

export interface UserDatabaseConnection extends MigrationDatabase {
  closeAsync(): Promise<void>;
}

export type OpenUserDatabase = (
  databaseName: string,
  options: typeof USER_DATABASE_OPEN_OPTIONS,
) => Promise<UserDatabaseConnection>;

export async function configureUserDatabase(database: UserDatabaseConnection): Promise<void> {
  await database.execAsync(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = ${USER_DATABASE_BUSY_TIMEOUT_MS};
`);

  const [foreignKeys] = await database.getAllAsync<{ foreign_keys: number }>("PRAGMA foreign_keys");
  const [journalMode] = await database.getAllAsync<{ journal_mode: string }>("PRAGMA journal_mode");
  const [busyTimeout] = await database.getAllAsync<{ timeout: number }>("PRAGMA busy_timeout");
  if (
    foreignKeys?.foreign_keys !== 1
    || journalMode?.journal_mode !== "wal"
    || busyTimeout?.timeout !== USER_DATABASE_BUSY_TIMEOUT_MS
  ) {
    throw new Error(
      `User database pragma verification failed: expected foreign_keys=1, journal_mode=wal, busy_timeout=${USER_DATABASE_BUSY_TIMEOUT_MS}`,
    );
  }
}

export async function openConfiguredUserDatabase(
  openDatabase: OpenUserDatabase,
): Promise<UserDatabaseConnection> {
  const database = await openDatabase(USER_DATABASE_NAME, USER_DATABASE_OPEN_OPTIONS);
  try {
    await configureUserDatabase(database);
    return database;
  } catch (initializationError) {
    try {
      await database.closeAsync();
    } catch (closeError) {
      throw cleanupFailure(
        [initializationError, closeError],
        "User database configuration failed and closing the connection also failed",
      );
    }
    throw initializationError;
  }
}

export async function initializeUserDatabase(
  openDatabase: OpenUserDatabase,
): Promise<UserDatabaseConnection> {
  const database = await openConfiguredUserDatabase(openDatabase);
  try {
    await applyUserDatabaseMigrations(database);
    return database;
  } catch (initializationError) {
    try {
      await database.closeAsync();
    } catch (closeError) {
      throw cleanupFailure(
        [initializationError, closeError],
        "User database initialization failed and closing the connection also failed",
      );
    }
    throw initializationError;
  }
}
