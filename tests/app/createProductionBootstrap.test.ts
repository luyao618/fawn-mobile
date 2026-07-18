import { RuntimeClosingError } from "../../src/application/bootstrap/appRuntime";
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
          return source.includes("baby_profile") ? [] : [{ total: 0 }];
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

test("production bootstrap exposes profile services only on its ready runtime and closes their lifetime", async () => {
  const closeAsync = jest.fn(async () => {});
  mockOpenConfiguredDatabase.mockResolvedValue(database(closeAsync));
  const bootstrap = createProductionBootstrap();
  const runtime = await bootstrap(new AbortController().signal);

  await expect(runtime.services.babyProfile.load()).resolves.toEqual({
    profile: null,
    exactAge: expect.objectContaining({ status: "unknown", reason: "birth_date_missing" }),
  });
  const first = runtime.close();
  const second = runtime.close();
  expect(first).toBe(second);
  await expect(runtime.services.babyProfile.load()).rejects.toBeInstanceOf(RuntimeClosingError);
  await first;
  expect(closeAsync).toHaveBeenCalledTimes(1);
});
