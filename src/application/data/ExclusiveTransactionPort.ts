export type SqlValue = string | number | null | Uint8Array;
export type SqlParameters = readonly SqlValue[];

export type SqlRunResult = Readonly<{
  changes: number;
  lastInsertRowId: number;
}>;

export interface QueryRunHandle {
  query<T extends object>(sql: string, parameters?: SqlParameters): Promise<readonly T[]>;
  run(sql: string, parameters?: SqlParameters): Promise<SqlRunResult>;
}

export interface ExclusiveTransactionPort {
  runExclusive<T>(operation: (transaction: QueryRunHandle) => Promise<T>): Promise<T>;
}
