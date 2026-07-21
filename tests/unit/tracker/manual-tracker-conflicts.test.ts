import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeOperationGate } from "../../../src/application/bootstrap/appRuntime.ts";
import { DataMutationCoordinator } from "../../../src/application/data/DataMutationCoordinator.ts";
import type { QueryRunHandle } from "../../../src/application/data/ExclusiveTransactionPort.ts";
import {
  isManualTrackerConflictError,
  ManualTrackerConflictError,
  ManualTrackerService,
  type ManualTrackerConflictClassifierPort,
  type TrackerStore,
  type TrackerWriter,
} from "../../../src/application/tracker/manualTrackerService.ts";
import type {
  TrackerCreateInputByDomain,
  TrackerDeletion,
  TrackerDomain,
  TrackerRecordByDomain,
  TrackerUpdateInputByDomain,
} from "../../../src/domain/tracker/types.ts";
import { RepositoryConflictError } from "../../../src/infrastructure/db/repositories/conflicts.ts";
import { RepositoryTrackerConflictClassifier } from "../../../src/infrastructure/db/repositories/trackerConflictClassifier.ts";

const feeding = Object.freeze({
  feedTime: "2026-07-20T01:00:00.000Z",
  feedType: "formula" as const,
  amountMl: 90,
  durationMin: null,
  notes: null,
});

test("repository classifier maps only supported tracker persistence conflicts", () => {
  const classifier = new RepositoryTrackerConflictClassifier();
  for (const code of ["stale_write", "not_found"] as const) {
    assert.equal(classifier.classify(new RepositoryConflictError(code, "feeding_record", "feeding-1")), code);
  }
  for (const code of ["duplicate", "illegal_transition"] as const) {
    assert.equal(classifier.classify(new RepositoryConflictError(code, "feeding_record", "feeding-1")), null);
  }
  assert.equal(classifier.classify(new Error("generic")), null);
  assert.equal(classifier.classify({ code: "stale_write" }), null);
  assert.equal(classifier.classify(null), null);
});

test("manual tracker conflict guard recognizes only the application error", () => {
  assert.equal(isManualTrackerConflictError(new ManualTrackerConflictError("stale_write")), true);
  assert.equal(isManualTrackerConflictError(new ManualTrackerConflictError("not_found")), true);
  assert.equal(isManualTrackerConflictError({ code: "stale_write" }), false);
  assert.equal(
    isManualTrackerConflictError(new RepositoryConflictError("stale_write", "feeding_record", "feeding-1")),
    false,
  );
  assert.equal(isManualTrackerConflictError(new Error("generic")), false);
});

function serviceWithWriterFailure(
  failure: unknown,
  classifier: ManualTrackerConflictClassifierPort,
): ManualTrackerService {
  const transactions = {
    async runExclusive<T>(operation: (transaction: QueryRunHandle) => Promise<T>): Promise<T> {
      return operation({} as QueryRunHandle);
    },
  };
  const store: TrackerStore = {
    async getById() { return null; },
    async list() { return []; },
  };
  const writer: TrackerWriter = {
    async create<D extends TrackerDomain>(
      _transaction: QueryRunHandle,
      _domain: D,
      _id: string,
      _input: TrackerCreateInputByDomain[D],
      _now: string,
    ): Promise<TrackerRecordByDomain[D]> {
      throw failure;
    },
    async update<D extends TrackerDomain>(
      _transaction: QueryRunHandle,
      _domain: D,
      _id: string,
      _input: TrackerUpdateInputByDomain[D],
      _expectedUpdatedAt: string,
      _now: string,
    ): Promise<TrackerRecordByDomain[D]> {
      throw failure;
    },
    async softDelete(): Promise<TrackerDeletion> {
      throw failure;
    },
  };
  return new ManualTrackerService(
    transactions,
    new DataMutationCoordinator(),
    store,
    writer,
    classifier,
    { now: () => "2026-07-20T02:00:00.000Z" },
    { nextId: () => "feeding-1" },
    new RuntimeOperationGate(),
  );
}

for (const operation of ["update", "delete"] as const) {
  test(`confirmed ${operation} wraps a classified persistence failure`, async () => {
    const repositoryFailure = new RepositoryConflictError("stale_write", "feeding_record", "feeding-1");
    const service = serviceWithWriterFailure(repositoryFailure, {
      classify: (error) => error === repositoryFailure ? "stale_write" : null,
    });
    const promise = operation === "update"
      ? service.update("feeding", "feeding-1", feeding, "2026-07-20T01:00:00.000Z", "confirmed")
      : service.delete("feeding", "feeding-1", "2026-07-20T01:00:00.000Z", "confirmed");
    await assert.rejects(promise, (error) => {
      assert(error instanceof ManualTrackerConflictError);
      assert.equal(error.code, "stale_write");
      assert.equal("entity" in error, false);
      assert.equal("entityId" in error, false);
      assert.equal("currentState" in error, false);
      return true;
    });
  });
}

test("unmatched confirmed update and delete failures retain object identity", async () => {
  const failure = new Error("generic persistence failure");
  const service = serviceWithWriterFailure(failure, { classify: () => null });
  await assert.rejects(
    service.update("feeding", "feeding-1", feeding, "2026-07-20T01:00:00.000Z", "confirmed"),
    (error) => error === failure,
  );
  await assert.rejects(
    service.delete("feeding", "feeding-1", "2026-07-20T01:00:00.000Z", "confirmed"),
    (error) => error === failure,
  );
});

test("create failures are never translated by the update/delete conflict boundary", async () => {
  const failure = new RepositoryConflictError("stale_write", "feeding_record", "feeding-1");
  const service = serviceWithWriterFailure(failure, { classify: () => "stale_write" });
  await assert.rejects(
    service.create("feeding", { ...feeding, sourceMessageId: null }),
    (error) => error === failure,
  );
});
