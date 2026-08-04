import {
  RuntimeOperationGate,
  type AppRuntime,
  type AppServicesFactory,
} from "./appRuntime.ts";
import type { DataMutationCoordinator } from "../data/DataMutationCoordinator.ts";
import type { ExclusiveTransactionPort, QueryRunHandle } from "../data/ExclusiveTransactionPort.ts";
import { cleanupFailure, isCleanupFailure } from "../../shared/errors/cleanupFailure.ts";

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

export type BootstrapTraceStage = "open-configure" | "migrate" | "post-migrate" | "ready";
export type BootstrapTraceCloseOutcome = "unobserved" | "succeeded" | "failed" | "not-attempted";
export type BootstrapTraceFailureCategory = "abort" | "cleanup" | "sqlite-open" | "sqlite" | "aggregate" | "uncoded";

export type BootstrapTraceTerminal = Readonly<{
  stage: "ready";
  outcome: "success";
  closeOutcome: "not-attempted";
} | {
  stage: Exclude<BootstrapTraceStage, "ready">;
  outcome: "failure";
  closeOutcome: Exclude<BootstrapTraceCloseOutcome, "not-attempted">;
  failureCategory: BootstrapTraceFailureCategory;
}>;

export type BootstrapTraceRecord = Readonly<
  { kind: "start"; attempt: number }
  | ({ kind: "terminal"; attempt: number } & BootstrapTraceTerminal)
>;

export type BootstrapTraceSink = (record: BootstrapTraceRecord) => void;

type BootstrapTraceTerminalSink = (record: BootstrapTraceTerminal) => void;

export type RecoverAndOpenDependencies<TServices> = Readonly<{
  coordinator: DataMutationCoordinator;
  restore: RestoreRecoveryPort;
  database: StartupDatabasePort;
  album: AlbumRecoveryPort;
  recovery: StartupRecoveryPort;
  clock: ClockPort;
  services: AppServicesFactory<TServices>;
  traceTerminal?: BootstrapTraceTerminalSink;
}>;


function failureCategory(error: unknown): BootstrapTraceFailureCategory {
  try {
    if (isCleanupFailure(error)) return "cleanup";
    if (error instanceof Error && error.name === "AbortError") return "abort";
    const code = typeof error === "object" && error !== null && "code" in error
      ? Reflect.get(error, "code")
      : undefined;
    if (code === "E_SQLITE_OPEN_DATABASE") return "sqlite-open";
    if (code === "ERR_INTERNAL_SQLITE_ERROR") return "sqlite";
    if (error instanceof AggregateError) return "aggregate";
  } catch {
    return "uncoded";
  }
  return "uncoded";
}

function emitTerminal(
  sink: BootstrapTraceTerminalSink | undefined,
  record: BootstrapTraceTerminal,
): void {
  try {
    sink?.(record);
  } catch {
    // Diagnostics must never alter bootstrap behavior.
  }
}

function emitFailureTerminal(
  sink: BootstrapTraceTerminalSink | undefined,
  record: Omit<Extract<BootstrapTraceTerminal, { outcome: "failure" }>, "failureCategory">,
  error: unknown,
): void {
  if (sink === undefined) return;
  emitTerminal(sink, { ...record, failureCategory: failureCategory(error) });
}

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
  let stage: Exclude<BootstrapTraceStage, "ready"> = "open-configure";
  try {
    assertNotAborted(signal);
    await dependencies.coordinator.runMaintenance("restore", async () => {
      assertNotAborted(signal);
      await dependencies.restore.recover(signal);
    });
    assertNotAborted(signal);
    database = await dependencies.database.openConfigured(signal);
    stage = "migrate";
    assertNotAborted(signal);
    await dependencies.coordinator.runMaintenance("migration", async () => {
      assertNotAborted(signal);
      await database!.migrate(signal);
    });
    stage = "post-migrate";
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
    emitTerminal(dependencies.traceTerminal, {
      stage: "ready",
      outcome: "success",
      closeOutcome: "not-attempted",
    });
    return idempotentRuntime(database, services, operations);
  } catch (startupError) {
    if (!database) {
      emitFailureTerminal(dependencies.traceTerminal, {
        stage,
        outcome: "failure",
        closeOutcome: "unobserved",
      }, startupError);
      throw startupError;
    }
    try {
      await database.close();
    } catch (closeError) {
      const failure = cleanupFailure(
        [startupError, closeError],
        "Application startup failed and closing the database also failed",
      );
      emitFailureTerminal(dependencies.traceTerminal, {
        stage,
        outcome: "failure",
        closeOutcome: "failed",
      }, failure);
      throw failure;
    }
    emitFailureTerminal(dependencies.traceTerminal, {
      stage,
      outcome: "failure",
      closeOutcome: "succeeded",
    }, startupError);
    throw startupError;
  }
}
