import { RuntimeClosingError } from "../../src/application/bootstrap/appRuntime";
import { ManualTrackerConflictError } from "../../src/application/tracker/manualTrackerService";
import { cleanupFailure, isCleanupFailure } from "../../src/shared/errors/cleanupFailure";
import { createProductionBootstrap } from "../../src/infrastructure/bootstrap/createProductionBootstrap";

const mockOpenConfiguredDatabase = jest.fn();
const mockApplyUserDatabaseMigrations = jest.fn(async () => {});

jest.mock("../../src/infrastructure/db/openDatabase", () => ({
  openConfiguredDatabase: () => mockOpenConfiguredDatabase(),
}));

jest.mock("../../src/infrastructure/db/migrations/index", () => ({
  applyUserDatabaseMigrations: () => mockApplyUserDatabaseMigrations(),
}));

function database(closeAsync: () => Promise<void>) {
  return {
    closeAsync,
    async withExclusiveTransactionAsync(operation: (transaction: unknown) => Promise<void>) {
      await operation({
        async getAllAsync(source: string) {
          return source.includes("baby_profile") || source.includes("_records") ? [] : [{ total: 0 }];
        },
        async runAsync() { return { changes: 0, lastInsertRowId: 0 }; },
      });
    },
  };
}

beforeEach(() => {
  mockOpenConfiguredDatabase.mockReset();
  mockApplyUserDatabaseMigrations.mockClear();
});

test("production bootstrap latches a later runtime cleanup failure before any future open", async () => {
  const privateClose = new Error("private native close");
  const closeAsync = jest.fn(async () => { throw privateClose; });
  mockOpenConfiguredDatabase.mockResolvedValue(database(closeAsync));
  const bootstrap = createProductionBootstrap();
  const runtime = await bootstrap(new AbortController().signal);
  let marked: unknown;
  await runtime.close().catch((error: unknown) => {
    marked = error;
    expect(isCleanupFailure(error)).toBe(true);
    if (isCleanupFailure(error)) expect(error.errors[0]).toBe(privateClose);
  });
  await expect(bootstrap(new AbortController().signal)).rejects.toBe(marked);
  expect(mockOpenConfiguredDatabase).toHaveBeenCalledTimes(1);
  expect(closeAsync).toHaveBeenCalledTimes(1);
});

test("production bootstrap does not classify an arbitrary marked-looking aggregate", async () => {
  const generic = new AggregateError([new Error("migration"), new Error("rollback")], "cleanup failed");
  Object.defineProperty(generic, "cleanupFailure", { value: "not-the-fixed-marker" });
  expect(isCleanupFailure(generic)).toBe(false);
  expect(isCleanupFailure(cleanupFailure([generic], "real cleanup"))).toBe(true);
});

test("production bootstrap exposes profile and tracker services only on its ready runtime and closes their lifetime", async () => {
  const closeAsync = jest.fn(async () => {});
  mockOpenConfiguredDatabase.mockResolvedValue(database(closeAsync));
  const bootstrap = createProductionBootstrap();
  const runtime = await bootstrap(new AbortController().signal);

  await expect(runtime.services.babyProfile.load()).resolves.toEqual({
    profile: null,
    exactAge: expect.objectContaining({ status: "unknown", reason: "birth_date_missing" }),
  });
  const tracker = runtime.services.tracker;
  await expect(tracker.list("feeding", 10)).resolves.toEqual([]);
  await expect(tracker.create("health", {
    recordDate: "2026-07-20",
    recordType: "checkup",
    title: "Synthetic checkup",
    description: null,
    sourceMessageId: null,
  })).resolves.toEqual(expect.objectContaining({ status: "confirmation_required" }));
  const missingDelete = tracker.delete(
    "feeding",
    "missing-feeding",
    "2026-07-20T01:00:00.000Z",
    "confirmed",
  );
  await expect(missingDelete).rejects.toMatchObject({ code: "not_found" });
  await expect(missingDelete).rejects.toBeInstanceOf(ManualTrackerConflictError);
  const first = runtime.close();
  const second = runtime.close();
  expect(first).toBe(second);
  await expect(runtime.services.babyProfile.load()).rejects.toBeInstanceOf(RuntimeClosingError);
  await expect(tracker.getById("feeding", "feeding-1")).rejects.toBeInstanceOf(RuntimeClosingError);
  await expect(tracker.list("feeding", 10)).rejects.toBeInstanceOf(RuntimeClosingError);
  await expect(tracker.create("feeding", {
    feedTime: "2026-07-20T01:00:00.000Z",
    feedType: "formula",
    amountMl: 90,
    durationMin: null,
    notes: null,
    sourceMessageId: null,
  })).rejects.toBeInstanceOf(RuntimeClosingError);
  await expect(tracker.update("feeding", "feeding-1", {
    feedTime: "2026-07-20T01:00:00.000Z",
    feedType: "formula",
    amountMl: 100,
    durationMin: null,
    notes: null,
  }, "2026-07-20T01:00:00.000Z")).rejects.toBeInstanceOf(RuntimeClosingError);
  await expect(tracker.delete(
    "feeding",
    "feeding-1",
    "2026-07-20T01:00:00.000Z",
  )).rejects.toBeInstanceOf(RuntimeClosingError);
  await first;
  expect(closeAsync).toHaveBeenCalledTimes(1);
});


test("production bootstrap traces exactly start and ready terminal records for each one-based attempt", async () => {
  const closeAsync = jest.fn(async () => {});
  mockOpenConfiguredDatabase.mockResolvedValue(database(closeAsync));
  const trace = jest.fn();
  const bootstrap = createProductionBootstrap(trace);

  const first = await bootstrap(new AbortController().signal);
  await first.close();
  const second = await bootstrap(new AbortController().signal);

  expect(trace.mock.calls.map(([record]) => record)).toEqual([
    { kind: "start", attempt: 1 },
    { kind: "terminal", attempt: 1, stage: "ready", outcome: "success", closeOutcome: "not-attempted" },
    { kind: "start", attempt: 2 },
    { kind: "terminal", attempt: 2, stage: "ready", outcome: "success", closeOutcome: "not-attempted" },
  ]);
  await second.close();
});

test("production bootstrap without an E2E trace sink never classifies startup errors", async () => {
  let codeAccesses = 0;
  const startupError = new Error("private startup failure");
  Object.defineProperty(startupError, "code", {
    get() {
      codeAccesses += 1;
      return "ERR_INTERNAL_SQLITE_ERROR";
    },
  });
  mockOpenConfiguredDatabase.mockRejectedValueOnce(startupError);

  await expect(createProductionBootstrap()(new AbortController().signal)).rejects.toBe(startupError);
  expect(codeAccesses).toBe(0);
});

test("bootstrap trace sink failure never alters successful bootstrap or close", async () => {
  const closeAsync = jest.fn(async () => {});
  mockOpenConfiguredDatabase.mockResolvedValue(database(closeAsync));
  const bootstrap = createProductionBootstrap(() => { throw new Error("synthetic sink failure"); });
  const runtime = await bootstrap(new AbortController().signal);
  await expect(runtime.close()).resolves.toBeUndefined();
  expect(closeAsync).toHaveBeenCalledTimes(1);
});

test("migration rejection traces a sanitized migrate terminal after successful cleanup", async () => {
  const closeAsync = jest.fn(async () => {});
  const migrationError = Object.assign(new Error("private SQL and path"), { code: "ERR_INTERNAL_SQLITE_ERROR" });
  mockOpenConfiguredDatabase.mockResolvedValue(database(closeAsync));
  mockApplyUserDatabaseMigrations.mockRejectedValueOnce(migrationError);
  const trace = jest.fn();
  const bootstrap = createProductionBootstrap(trace);

  await expect(bootstrap(new AbortController().signal)).rejects.toBe(migrationError);
  expect(trace.mock.calls.map(([record]) => record)).toEqual([
    { kind: "start", attempt: 1 },
    {
      kind: "terminal",
      attempt: 1,
      stage: "migrate",
      outcome: "failure",
      closeOutcome: "succeeded",
      failureCategory: "sqlite",
    },
  ]);
  expect(closeAsync).toHaveBeenCalledTimes(1);
});
