import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";

import { initializeUserDatabase } from "./initializeDatabase.ts";

export async function openUserDatabase(): Promise<SQLiteDatabase> {
  return initializeUserDatabase((databaseName, options) => openDatabaseAsync(databaseName, options)) as Promise<SQLiteDatabase>;
}
