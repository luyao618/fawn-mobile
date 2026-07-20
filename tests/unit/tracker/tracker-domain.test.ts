import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeOperationGate } from "../../../src/application/bootstrap/appRuntime.ts";
import { DataMutationCoordinator } from "../../../src/application/data/DataMutationCoordinator.ts";
import type { QueryRunHandle } from "../../../src/application/data/ExclusiveTransactionPort.ts";
import {
  ManualTrackerService,
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
import {
  assertTrackerListLimit,
  normalizeTrackerCreateInput,
  normalizeTrackerUpdateInput,
  TrackerValidationError,
} from "../../../src/domain/tracker/validation.ts";

const growth = Object.freeze({
  measurementDate: "2026-07-20", weightG: 100, heightCm: 10, headCm: 10,
  weightPercentile: 0, heightPercentile: 0, headPercentile: 0, notes: null,
});
const feeding = Object.freeze({
  feedTime: "2026-07-20T01:00:00.000Z", feedType: "formula" as const,
  amountMl: 0, durationMin: null, notes: null,
});
const sleep = Object.freeze({
  sleepStart: "2026-07-20T01:00:00.000Z", sleepEnd: null,
  sleepType: "nap" as const, nightWakings: 0, notes: null,
});
const diaper = Object.freeze({
  diaperTime: "2026-07-20T01:00:00.000Z", diaperType: "pee" as const, notes: null,
});
const health = Object.freeze({
  recordDate: "2026-07-20", recordType: "checkup" as const,
  title: "Synthetic checkup", description: null,
});

function validationError(domain: TrackerDomain, field: string) {
  return (error: unknown): boolean => (
    error instanceof TrackerValidationError && error.domain === domain && error.field === field
  );
}

test("UT-TRACK-001 enforces all migration numeric boundaries and safe integers", () => {
  for (const [field, minimum, maximum, integer] of [
    ["weightG", 100, 50_000, true],
    ["heightCm", 10, 150, false],
    ["headCm", 10, 100, false],
    ["weightPercentile", 0, 100, false],
    ["heightPercentile", 0, 100, false],
    ["headPercentile", 0, 100, false],
  ] as const) {
    assert.equal(normalizeTrackerUpdateInput("growth", { ...growth, [field]: minimum })[field], minimum);
    assert.equal(normalizeTrackerUpdateInput("growth", { ...growth, [field]: maximum })[field], maximum);
    assert.throws(() => normalizeTrackerUpdateInput("growth", { ...growth, [field]: minimum - 0.01 }), validationError("growth", field));
    assert.throws(() => normalizeTrackerUpdateInput("growth", { ...growth, [field]: maximum + 0.01 }), validationError("growth", field));
    if (integer) assert.throws(() => normalizeTrackerUpdateInput("growth", { ...growth, [field]: 100.5 }), validationError("growth", field));
  }
  for (const [field, maximum] of [["amountMl", 2_000], ["durationMin", 1_440]] as const) {
    assert.equal(normalizeTrackerUpdateInput("feeding", { ...feeding, [field]: 0 })[field], 0);
    assert.equal(normalizeTrackerUpdateInput("feeding", { ...feeding, [field]: maximum })[field], maximum);
    assert.throws(() => normalizeTrackerUpdateInput("feeding", { ...feeding, [field]: -1 }), validationError("feeding", field));
    assert.throws(() => normalizeTrackerUpdateInput("feeding", { ...feeding, [field]: maximum + 1 }), validationError("feeding", field));
    assert.throws(() => normalizeTrackerUpdateInput("feeding", { ...feeding, [field]: 0.5 }), validationError("feeding", field));
  }
  assert.equal(normalizeTrackerUpdateInput("sleep", { ...sleep, sleepType: "night", nightWakings: 100 }).nightWakings, 100);
  for (const value of [-1, 101, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalizeTrackerUpdateInput("sleep", { ...sleep, sleepType: "night", nightWakings: value }), validationError("sleep", "nightWakings"));
  }
});

test("UT-TRACK-001 accepts exact enums and rejects every unknown enum", () => {
  for (const feedType of ["breast", "formula", "solid"] as const) {
    const input = feedType === "breast"
      ? { ...feeding, feedType, amountMl: null, durationMin: 0 }
      : { ...feeding, feedType };
    assert.equal(normalizeTrackerUpdateInput("feeding", input).feedType, feedType);
  }
  for (const sleepType of ["nap", "night"] as const) {
    assert.equal(normalizeTrackerUpdateInput("sleep", { ...sleep, sleepType }).sleepType, sleepType);
  }
  for (const diaperType of ["poop", "pee", "mixed"] as const) {
    assert.equal(normalizeTrackerUpdateInput("diaper", { ...diaper, diaperType }).diaperType, diaperType);
  }
  for (const recordType of ["vaccination", "illness", "checkup"] as const) {
    assert.equal(normalizeTrackerUpdateInput("health", { ...health, recordType }).recordType, recordType);
  }
  assert.throws(() => normalizeTrackerUpdateInput("feeding", { ...feeding, feedType: "bottle" } as never), validationError("feeding", "feedType"));
  assert.throws(() => normalizeTrackerUpdateInput("sleep", { ...sleep, sleepType: "rest" } as never), validationError("sleep", "sleepType"));
  assert.throws(() => normalizeTrackerUpdateInput("diaper", { ...diaper, diaperType: "dry" } as never), validationError("diaper", "diaperType"));
  assert.throws(() => normalizeTrackerUpdateInput("health", { ...health, recordType: "medicine" } as never), validationError("health", "recordType"));
});

test("UT-TRACK-002 enforces cross-field requirements while preserving valid zero", () => {
  assert.throws(() => normalizeTrackerUpdateInput("growth", {
    ...growth, weightG: null, heightCm: null, headCm: null,
  }), validationError("growth", "measurements"));
  assert.throws(() => normalizeTrackerUpdateInput("feeding", {
    ...feeding, feedType: "formula", amountMl: null,
  }), validationError("feeding", "amountMl"));
  assert.throws(() => normalizeTrackerUpdateInput("feeding", {
    ...feeding, feedType: "breast", amountMl: null, durationMin: null,
  }), validationError("feeding", "durationMin"));
  assert.equal(normalizeTrackerUpdateInput("feeding", { ...feeding, amountMl: 0 }).amountMl, 0);
  assert.equal(normalizeTrackerUpdateInput("feeding", { ...feeding, amountMl: -0 }).amountMl, 0);
  assert.equal(normalizeTrackerUpdateInput("feeding", {
    ...feeding, feedType: "breast", amountMl: null, durationMin: 0,
  }).durationMin, 0);
  assert.throws(() => normalizeTrackerUpdateInput("sleep", {
    ...sleep, sleepType: "nap", nightWakings: 1,
  }), validationError("sleep", "nightWakings"));
});

test("UT-TRACK-001 validates strict dates, canonical instants, and sleep ordering", () => {
  for (const value of ["2026-02-29", "2026-7-20", "0000-01-01", "2026-13-01"]) {
    assert.throws(() => normalizeTrackerUpdateInput("growth", { ...growth, measurementDate: value }), validationError("growth", "measurementDate"));
    assert.throws(() => normalizeTrackerUpdateInput("health", { ...health, recordDate: value }), validationError("health", "recordDate"));
  }
  assert.equal(normalizeTrackerUpdateInput("growth", { ...growth, measurementDate: "2024-02-29" }).measurementDate, "2024-02-29");
  for (const value of ["2026-07-20T01:00:00Z", "2026-07-20T01:00:00.000+00:00", "invalid"]) {
    assert.throws(() => normalizeTrackerUpdateInput("feeding", { ...feeding, feedTime: value }), validationError("feeding", "feedTime"));
    assert.throws(() => normalizeTrackerUpdateInput("diaper", { ...diaper, diaperTime: value }), validationError("diaper", "diaperTime"));
  }
  for (const sleepEnd of [sleep.sleepStart, "2026-07-20T00:59:59.999Z"]) {
    assert.throws(() => normalizeTrackerUpdateInput("sleep", { ...sleep, sleepEnd }), validationError("sleep", "sleepEnd"));
  }
  assert.equal(normalizeTrackerUpdateInput("sleep", {
    ...sleep, sleepEnd: "2026-07-20T01:00:00.001Z",
  }).sleepEnd, "2026-07-20T01:00:00.001Z");
});

test("UT-TRACK-001 trims Unicode health titles, freezes DTOs, and rejects non-camelCase shapes", () => {
  const normalized = normalizeTrackerCreateInput("health", {
    ...health, title: "  宝宝检查  ", sourceMessageId: null,
  });
  assert.equal(normalized.title, "宝宝检查");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal([...normalizeTrackerUpdateInput("health", { ...health, title: "😀" }).title].length, 1);
  assert.throws(() => normalizeTrackerUpdateInput("health", { ...health, title: " ".repeat(3) }), validationError("health", "title"));
  assert.throws(() => normalizeTrackerUpdateInput("health", { ...health, title: "😀".repeat(201) }), validationError("health", "title"));
  assert.throws(() => normalizeTrackerCreateInput("health", {
    ...health, sourceMessageId: null, record_date: "2026-07-20",
  } as never), validationError("health", "input"));
});

test("bounded list limits reject unsafe, fractional, zero, and excessive values", () => {
  for (const value of [1, 100]) assert.doesNotThrow(() => assertTrackerListLimit(value));
  for (const value of [0, 101, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertTrackerListLimit(value), RangeError);
  }
});

test("UT-TRACK-003 and manual UT-TRACK-006 policy validate first and perform no premature effects", async () => {
  const calls = { transactions: 0, ids: 0, clocks: 0, creates: 0, updates: 0, deletes: 0 };
  const transaction = {} as QueryRunHandle;
  const transactions = {
    async runExclusive<T>(operation: (handle: QueryRunHandle) => Promise<T>): Promise<T> {
      calls.transactions += 1;
      return operation(transaction);
    },
  };
  const store: TrackerStore = {
    async getById() { return null; },
    async list() { return Object.freeze([]); },
  };
  const writer: TrackerWriter = {
    async create<D extends TrackerDomain>(
      _transaction: QueryRunHandle,
      domain: D,
      id: string,
      input: TrackerCreateInputByDomain[D],
      now: string,
    ): Promise<TrackerRecordByDomain[D]> {
      calls.creates += 1;
      return Object.freeze({ ...input, id, createdAt: now, updatedAt: now }) as TrackerRecordByDomain[D];
    },
    async update<D extends TrackerDomain>(
      _transaction: QueryRunHandle,
      domain: D,
      id: string,
      input: TrackerUpdateInputByDomain[D],
      _expectedUpdatedAt: string,
      now: string,
    ): Promise<TrackerRecordByDomain[D]> {
      calls.updates += 1;
      return Object.freeze({ ...input, id, sourceMessageId: null, createdAt: now, updatedAt: now }) as TrackerRecordByDomain[D];
    },
    async softDelete(_transaction, domain, id, _expectedUpdatedAt, now): Promise<TrackerDeletion> {
      calls.deletes += 1;
      return Object.freeze({ domain, id, updatedAt: now, deletedAt: now });
    },
  };
  const service = new ManualTrackerService(
    transactions,
    new DataMutationCoordinator(),
    store,
    writer,
    { now: () => { calls.clocks += 1; return "2026-07-20T02:00:00.000Z"; } },
    { nextId: () => { calls.ids += 1; return "generated-1"; } },
    new RuntimeOperationGate(),
  );

  const created = await service.create("feeding", { ...feeding, sourceMessageId: null });
  assert.equal(created.status, "completed");
  assert.deepEqual(created.summary, {
    action: "create", domain: "feeding", input: { ...feeding, sourceMessageId: null },
  });
  assert.deepEqual(calls, { transactions: 1, ids: 1, clocks: 1, creates: 1, updates: 0, deletes: 0 });

  const healthPending = await service.create("health", { ...health, sourceMessageId: null });
  const updatePending = await service.update("feeding", "feeding-1", feeding, "2026-07-20T01:00:00.000Z");
  const deletePending = await service.delete("feeding", "feeding-1", "2026-07-20T01:00:00.000Z");
  assert.equal(healthPending.status, "confirmation_required");
  assert.equal(updatePending.status, "confirmation_required");
  assert.equal(deletePending.status, "confirmation_required");
  assert.deepEqual(calls, { transactions: 1, ids: 1, clocks: 1, creates: 1, updates: 0, deletes: 0 });

  await assert.rejects(service.create("health", { ...health, title: " ", sourceMessageId: null }), validationError("health", "title"));
  assert.deepEqual(calls, { transactions: 1, ids: 1, clocks: 1, creates: 1, updates: 0, deletes: 0 });

  await service.create("health", { ...health, sourceMessageId: null }, "confirmed");
  await service.update("feeding", "feeding-1", feeding, "2026-07-20T01:00:00.000Z", "confirmed");
  await service.delete("feeding", "feeding-1", "2026-07-20T01:00:00.000Z", "confirmed");
  assert.deepEqual(calls, { transactions: 4, ids: 2, clocks: 4, creates: 2, updates: 1, deletes: 1 });
});
