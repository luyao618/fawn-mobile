import {
  RuntimeOperationGate,
  type AppRuntime,
  type AppServicesFactory,
} from "./appRuntime.ts";
import type { DataMutationCoordinator } from "../data/DataMutationCoordinator.ts";
import type { ExclusiveTransactionPort, QueryRunHandle } from "../data/ExclusiveTransactionPort.ts";
import { cleanupFailure } from "../../shared/errors/cleanupFailure.ts";

export interface RestoreRecoveryPort {
  recover(signal: AbortSignal): Promise<void>;
}

export interface StartupDatabaseHandle {
  readonly transactions: ExclusiveTransactionPort;
  migrate(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface StartupDatabasePort {
  openConfigured(signal: AbortSignal): Promise<StartupDatabaseHandle>;
}

export interface AlbumRecoveryPort {
  reconcile(database: StartupDatabaseHandle, signal: AbortSignal): Promise<void>;
}

export interface StartupRecoveryPort {
  recoverExpiredLeases(transaction: QueryRunHandle, now: string): Promise<void>;
  assertInterruptedTurnsConsistent(transaction: QueryRunHandle): Promise<void>;
  failInterruptedTurns(transaction: QueryRunHandle, now: string): Promise<void>;
  expireStaleTasks(transaction: QueryRunHandle, now: string): Promise<void>;
  validateCoreInvariants(transaction: QueryRunHandle, now: string): Promise<void>;
}

export interface ClockPort {
  now(): string;
}

export type { AppRuntime } from "./appRuntime.ts";

export type RecoverAndOpenDependencies<TServices> = Readonly<{
  coordinator: DataMutationCoordinator;
  restore: RestoreRecoveryPort;
  database: StartupDatabasePort;
  album: AlbumRecoveryPort;
  recovery: StartupRecoveryPort;
  clock: ClockPort;
  services: AppServicesFactory<TServices>;
}>;

function abortError(): Error {
  const error = new Error("Startup was aborted");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function assertCanonicalInstant(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    throw new TypeError("Startup clock must return a canonical UTC instant");
  }
}

function idempotentRuntime<TServices>(
  database: StartupDatabaseHandle,
  services: TServices,
  operations: RuntimeOperationGate,
): AppRuntime<TServices> {
  let closing: Promise<void> | undefined;
  return Object.freeze({
    services,
    close(): Promise<void> {
      closing ??= operations.close(() => database.close()).catch((closeError: unknown) => {
        throw cleanupFailure(
          [closeError],
          "Closing the application database failed",
        );
      });
      return closing;
    },
  });
}

export async function recoverAndOpen<TServices>(
  dependencies: RecoverAndOpenDependencies<TServices>,
  signal: AbortSignal,
): Promise<AppRuntime<TServices>> {
  let database: StartupDatabaseHandle | undefined;
  try {
    assertNotAborted(signal);
    await dependencies.coordinator.runMaintenance("restore", async () => {
      assertNotAborted(signal);
      await dependencies.restore.recover(signal);
    });
    assertNotAborted(signal);
    database = await dependencies.database.openConfigured(signal);
    assertNotAborted(signal);
    await dependencies.coordinator.runMaintenance("migration", async () => {
      assertNotAborted(signal);
      await database!.migrate(signal);
    });
    assertNotAborted(signal);
    await dependencies.coordinator.runMaintenance("album", async () => {
      assertNotAborted(signal);
      await dependencies.album.reconcile(database!, signal);
    });
    assertNotAborted(signal);
    const now = dependencies.clock.now();
    assertCanonicalInstant(now);
    await database.transactions.runExclusive(async (transaction) => {
      assertNotAborted(signal);
      await dependencies.recovery.recoverExpiredLeases(transaction, now);
      await dependencies.recovery.assertInterruptedTurnsConsistent(transaction);
      await dependencies.recovery.failInterruptedTurns(transaction, now);
      await dependencies.recovery.expireStaleTasks(transaction, now);
      await dependencies.recovery.validateCoreInvariants(transaction, now);
      assertNotAborted(signal);
    });
    assertNotAborted(signal);
    const operations = new RuntimeOperationGate();
    const services = dependencies.services.create(database.transactions, operations);
    return idempotentRuntime(database, services, operations);
  } catch (startupError) {
    if (!database) throw startupError;
    try {
      await database.close();
    } catch (closeError) {
      throw cleanupFailure(
        [startupError, closeError],
        "Application startup failed and closing the database also failed",
      );
    }
    throw startupError;
  }
}
