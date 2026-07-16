import type {
  ExclusiveTransactionPort,
  QueryRunHandle,
  SqlParameters,
  SqlRunResult,
} from "../../application/data/ExclusiveTransactionPort.ts";

type ExpoRunResult = Readonly<{ changes: number; lastInsertRowId: number }>;

export interface ExpoTransactionDatabase {
  getAllAsync<T>(sql: string, ...parameters: SqlParameters): Promise<T[]>;
  runAsync(sql: string, ...parameters: SqlParameters): Promise<ExpoRunResult>;
}

export interface ExpoExclusiveDatabase {
  withExclusiveTransactionAsync(operation: (transaction: ExpoTransactionDatabase) => Promise<void>): Promise<void>;
}

function queryRunHandle(
  database: ExpoTransactionDatabase,
  isActive: () => boolean,
  track: <T, R = T>(operation: Promise<T>, transform?: (value: T) => R) => Promise<R>,
): QueryRunHandle {
  function assertActive(): void {
    if (!isActive()) throw new Error("Exclusive transaction handle is no longer active");
  }
  return Object.freeze({
    query<T extends object>(sql: string, parameters: SqlParameters = []): Promise<readonly T[]> {
      try {
        assertActive();
      } catch (error) {
        return Promise.reject(error);
      }
      return track(database.getAllAsync<T>(sql, ...parameters));
    },
    run(sql: string, parameters: SqlParameters = []): Promise<SqlRunResult> {
      try {
        assertActive();
      } catch (error) {
        return Promise.reject(error);
      }
      return track(database.runAsync(sql, ...parameters), (result) => Object.freeze({
        changes: result.changes,
        lastInsertRowId: result.lastInsertRowId,
      }));
    },
  });
}

export class ExpoSqliteExclusiveTransactionAdapter implements ExclusiveTransactionPort {
  constructor(private readonly database: ExpoExclusiveDatabase) {}

  async runExclusive<T>(operation: (transaction: QueryRunHandle) => Promise<T>): Promise<T> {
    let completed = false;
    let value: T | undefined;
    await this.database.withExclusiveTransactionAsync(async (transaction) => {
      let active = true;
      const operations: Promise<PromiseSettledResult<unknown>>[] = [];
      const track = <R, U = R>(operation: Promise<R>, transform?: (value: R) => U): Promise<U> => {
        const rawOutcome = operation.then<PromiseSettledResult<R>, PromiseSettledResult<R>>(
          (result) => ({ status: "fulfilled", value: result }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
        const exposed = transform === undefined
          ? operation as unknown as Promise<U>
          : operation.then(transform);
        const exposedOutcome = exposed.then<PromiseSettledResult<U>, PromiseSettledResult<U>>(
          (result) => ({ status: "fulfilled", value: result }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
        operations.push(rawOutcome, exposedOutcome);
        return exposed;
      };
      try {
        let operationError: unknown;
        try {
          value = await operation(queryRunHandle(transaction, () => active, track));
        } catch (error) {
          operationError = error;
        }
        let trackedError: unknown;
        for (let settled = 0; settled < operations.length;) {
          const batch = operations.slice(settled);
          settled = operations.length;
          const results = await Promise.all(batch);
          trackedError ??= results.find((result) => result.status === "rejected")?.reason;
        }
        if (operationError !== undefined) throw operationError;
        if (trackedError !== undefined) throw trackedError;
        completed = true;
      } finally {
        active = false;
      }
    });
    if (!completed) throw new Error("Exclusive transaction completed without an application result");
    return value as T;
  }
}
