import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";

import {
  initializeUserDatabase,
  openConfiguredUserDatabase,
} from "./initializeDatabase.ts";

export async function openConfiguredDatabase(): Promise<SQLiteDatabase> {
  return openConfiguredUserDatabase(
    (databaseName, options) => openDatabaseAsync(databaseName, options),
  ) as Promise<SQLiteDatabase>;
}

export async function openUserDatabase(): Promise<SQLiteDatabase> {
  return initializeUserDatabase(
    (databaseName, options) => openDatabaseAsync(databaseName, options),
  ) as Promise<SQLiteDatabase>;
}
