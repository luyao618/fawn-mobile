import assert from "node:assert/strict";
import test from "node:test";

import type { TrackerRecordByDomain } from "../../../src/domain/tracker/types.ts";
import {
  areVisibleTrackerValuesEqual,
  createInitialDraft,
  type FeedingTrackerDraft,
  isDraftDirty,
  isNormalizedUpdateNoop,
  parseDraftToCreateInput,
  parseDraftToUpdateInput,
  recordToEditorDraft,
} from "../../../src/features/tracker/trackerEditorModel.ts";

const metadata = { id: "private-id", sourceMessageId: "private-source", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T01:00:00.000Z" };

const records = {
  growth: { ...metadata, measurementDate: "2026-07-20", weightG: 7200, heightCm: 68.5, headCm: null, weightPercentile: 0, heightPercentile: 55.5, headPercentile: null, notes: "稳定" },
  feeding: { ...metadata, feedTime: "2026-07-20T00:10:00.000Z", feedType: "formula", amountMl: 0, durationMin: 12, notes: null },
  sleep: { ...metadata, sleepStart: "2026-07-20T01:00:00.000Z", sleepEnd: "2026-07-20T02:00:00.000Z", sleepType: "night", nightWakings: 0, notes: null },
  diaper: { ...metadata, diaperTime: "2026-07-20T03:00:00.000Z", diaperType: "mixed", notes: null },
  health: { ...metadata, recordDate: "2026-07-20", recordType: "checkup", title: "常规检查", description: null },
} as const satisfies TrackerRecordByDomain;

function withHostileMetadata<T>(draft: T, metadata: object): T {
  return Object.assign({}, draft, metadata);
}

test("initial drafts cover all domains with local defaults and no enum guesses", () => {
  for (const domain of ["growth", "feeding", "sleep", "diaper", "health"] as const) {
    const result = createInitialDraft(domain, "2026-07-20T00:10:42.000Z", "Asia/Shanghai");
    assert.equal(result.status, "ready", domain);
    if (result.status !== "ready") continue;
    assert.equal(result.draft.domain, domain);
    assert.equal(result.draft.timeZone, "Asia/Shanghai");
    assert.equal(result.draft.dateText, "2026-07-20");
  }
  const feeding = createInitialDraft("feeding", "2026-07-20T00:10:42.000Z", "Asia/Shanghai");
  assert.equal(feeding.status, "ready");
  if (feeding.status === "ready") assert.deepEqual({ time: feeding.draft.timeText, type: feeding.draft.feedType }, { time: "08:10", type: "" });
  const sleep = createInitialDraft("sleep", "2026-07-20T00:10:42.000Z", "Asia/Shanghai");
  assert.equal(sleep.status, "ready");
  if (sleep.status === "ready") assert.deepEqual({ endDate: sleep.draft.endDateText, endTime: sleep.draft.endTimeText, wakings: sleep.draft.nightWakings }, { endDate: "", endTime: "", wakings: "0" });
  assert.equal(createInitialDraft("feeding", "bad", "UTC").status, "invalid");
  assert.equal(createInitialDraft("feeding", "2026-07-20T00:10:42.000Z", "bad").status, "invalid");
});

test("record drafts convert every domain without carrying trusted hidden metadata", () => {
  for (const domain of ["growth", "feeding", "sleep", "diaper", "health"] as const) {
    assert.equal(recordToEditorDraft(domain, records[domain], "Asia/Shanghai").status, "ready");
  }
  const result = recordToEditorDraft("growth", records.growth, "Asia/Shanghai");
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(Object.keys(result.draft).some((key) => /percentile|preserved/i.test(key)), false);
});

test("create conversion emits exact G032 DTOs, null source, strict values, and retained zero", () => {
  const growth = createInitialDraft("growth", "2026-07-20T00:10:00.000Z", "UTC");
  assert.equal(growth.status, "ready");
  if (growth.status !== "ready") return;
  const result = parseDraftToCreateInput("growth", { ...growth.draft, weightG: "100", heightCm: "", headCm: "10.5", notes: "" }, "UTC");
  assert.deepEqual(result, { status: "valid", input: { measurementDate: "2026-07-20", weightG: 100, heightCm: null, headCm: 10.5, weightPercentile: null, heightPercentile: null, headPercentile: null, notes: null, sourceMessageId: null } });

  const feeding = createInitialDraft("feeding", "2026-07-20T00:10:00.000Z", "UTC");
  assert.equal(feeding.status, "ready");
  if (feeding.status !== "ready") return;
  const formula = parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "formula", amountMl: "0", durationMin: "12" }, "UTC");
  assert.deepEqual(formula, { status: "valid", input: { feedTime: "2026-07-20T00:10:00.000Z", feedType: "formula", amountMl: 0, durationMin: 12, notes: null, sourceMessageId: null } });
  assert.equal(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "formula", amountMl: "" }, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "breast", durationMin: "" }, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "solid", amountMl: "1e2" }, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "solid" }, "Asia/Shanghai").status, "invalid");
});

test("sleep conversion enforces paired end, UTC ordering, and nap zero wakings", () => {
  const initial = createInitialDraft("sleep", "2026-11-01T05:30:00.000Z", "UTC");
  assert.equal(initial.status, "ready");
  if (initial.status !== "ready") return;
  assert.equal(parseDraftToCreateInput("sleep", { ...initial.draft, sleepType: "night", endDateText: "2026-11-01" }, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("sleep", { ...initial.draft, sleepType: "night", endDateText: "2026-11-01", endTimeText: "05:29" }, "UTC").status, "invalid");
  const nap = parseDraftToCreateInput("sleep", { ...initial.draft, sleepType: "nap", nightWakings: "7" }, "UTC");
  assert.equal(nap.status, "valid");
  if (nap.status === "valid") assert.equal(nap.input.nightWakings, 0);
});

test("all create domains set sourceMessageId null and expected failures are field/reason results without code", () => {
  const diaper = createInitialDraft("diaper", "2026-07-20T03:00:00.000Z", "UTC");
  const health = createInitialDraft("health", "2026-07-20T03:00:00.000Z", "UTC");
  assert.equal(diaper.status, "ready"); assert.equal(health.status, "ready");
  if (diaper.status !== "ready" || health.status !== "ready") return;
  const diaperInput = parseDraftToCreateInput("diaper", { ...diaper.draft, diaperType: "pee" }, "UTC");
  const healthInput = parseDraftToCreateInput("health", { ...health.draft, recordType: "checkup", title: "  宝宝检查  " }, "UTC");
  assert.equal(diaperInput.status, "valid"); assert.equal(healthInput.status, "valid");
  if (diaperInput.status === "valid") assert.equal(diaperInput.input.sourceMessageId, null);
  if (healthInput.status === "valid") { assert.equal(healthInput.input.sourceMessageId, null); assert.equal(healthInput.input.title, "宝宝检查"); }
  const failure = parseDraftToCreateInput("health", { ...health.draft, recordType: "checkup", title: " " }, "UTC");
  assert.equal(failure.status, "invalid");
  assert.equal(Object.hasOwn(failure, "code"), false);
  if (failure.status === "invalid") assert.deepEqual(Object.keys(failure).sort(), ["error", "field", "reason", "status"]);
});

test("update conversion preserves loaded hidden percentiles and exact normalized no-op semantics", () => {
  const result = recordToEditorDraft("growth", records.growth, "UTC");
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const parsed = parseDraftToUpdateInput("growth", { ...result.draft, notes: "changed" }, records.growth, "UTC");
  assert.equal(parsed.status, "valid");
  if (parsed.status !== "valid") return;
  assert.deepEqual({ weight: parsed.input.weightPercentile, height: parsed.input.heightPercentile, head: parsed.input.headPercentile }, { weight: 0, height: 55.5, head: null });
  assert.equal(areVisibleTrackerValuesEqual("growth", records.growth, parsed.input), false);
  assert.equal(areVisibleTrackerValuesEqual("growth", records.growth, { ...parsed.input, notes: records.growth.notes, weightPercentile: 99 }), true);
  assert.equal(isNormalizedUpdateNoop("growth", records.growth, { ...parsed.input, notes: records.growth.notes, weightPercentile: 99 }), true);

  const healthDraft = recordToEditorDraft("health", records.health, "UTC");
  assert.equal(healthDraft.status, "ready");
  if (healthDraft.status !== "ready") return;
  const normalized = parseDraftToUpdateInput("health", { ...healthDraft.draft, title: "  常规检查  " }, records.health, "UTC");
  assert.equal(normalized.status, "valid");
  if (normalized.status === "valid") assert.equal(isNormalizedUpdateNoop("health", records.health, normalized.input), true);
});

test("dirty comparison is visible-only and keeps null distinct from zero", () => {
  const result = recordToEditorDraft("growth", records.growth, "UTC");
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(isDraftDirty("growth", result.draft, withHostileMetadata(result.draft, {
    hiddenPercentiles: { weightPercentile: 99, heightPercentile: null, headPercentile: 0 },
  })), false);
  assert.equal(isDraftDirty("growth", result.draft, { ...result.draft, weightG: "" }), true);
  assert.equal(areVisibleTrackerValuesEqual("feeding", records.feeding, { ...records.feeding, amountMl: null }), false);
});

test("growth create always clears hostile hidden percentiles while update preserves the loaded values", () => {
  const initial = createInitialDraft("growth", "2026-07-20T00:00:00.000Z", "UTC");
  assert.equal(initial.status, "ready");
  if (initial.status !== "ready") return;
  const created = parseDraftToCreateInput("growth", withHostileMetadata(initial.draft, {
    weightG: "7200",
    hiddenPercentiles: { weightPercentile: 99, heightPercentile: 88, headPercentile: 77 },
  }), "UTC");
  assert.equal(created.status, "valid");
  if (created.status === "valid") assert.deepEqual({
    weightPercentile: created.input.weightPercentile,
    heightPercentile: created.input.heightPercentile,
    headPercentile: created.input.headPercentile,
  }, { weightPercentile: null, heightPercentile: null, headPercentile: null });

  const loaded = recordToEditorDraft("growth", records.growth, "UTC");
  assert.equal(loaded.status, "ready");
  if (loaded.status !== "ready") return;
  const updated = parseDraftToUpdateInput("growth", { ...loaded.draft, weightG: "7300" }, records.growth, "UTC");
  assert.equal(updated.status, "valid");
  if (updated.status === "valid") assert.deepEqual({
    weightPercentile: updated.input.weightPercentile,
    heightPercentile: updated.input.heightPercentile,
    headPercentile: updated.input.headPercentile,
  }, { weightPercentile: 0, heightPercentile: 55.5, headPercentile: null });
});

test("all five create conversions produce exact G032 DTOs", () => {
  const now = "2026-07-20T08:10:37.456Z";
  const growth = createInitialDraft("growth", now, "UTC");
  const feeding = createInitialDraft("feeding", now, "UTC");
  const sleep = createInitialDraft("sleep", now, "UTC");
  const diaper = createInitialDraft("diaper", now, "UTC");
  const health = createInitialDraft("health", now, "UTC");
  assert.equal(growth.status, "ready"); assert.equal(feeding.status, "ready"); assert.equal(sleep.status, "ready");
  assert.equal(diaper.status, "ready"); assert.equal(health.status, "ready");
  if (growth.status !== "ready" || feeding.status !== "ready" || sleep.status !== "ready" || diaper.status !== "ready" || health.status !== "ready") return;
  assert.deepEqual(parseDraftToCreateInput("growth", { ...growth.draft, dateText: "0001-01-01", heightCm: "10" }, "UTC"), {
    status: "valid", input: { measurementDate: "0001-01-01", weightG: null, heightCm: 10, headCm: null, weightPercentile: null, heightPercentile: null, headPercentile: null, notes: null, sourceMessageId: null },
  });
  assert.deepEqual(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "solid", amountMl: "0", durationMin: "1440", notes: "保留" }, "UTC"), {
    status: "valid", input: { feedTime: "2026-07-20T08:10:00.000Z", feedType: "solid", amountMl: 0, durationMin: 1440, notes: "保留", sourceMessageId: null },
  });
  assert.deepEqual(parseDraftToCreateInput("sleep", { ...sleep.draft, sleepType: "night", nightWakings: "100" }, "UTC"), {
    status: "valid", input: { sleepStart: "2026-07-20T08:10:00.000Z", sleepEnd: null, sleepType: "night", nightWakings: 100, notes: null, sourceMessageId: null },
  });
  assert.deepEqual(parseDraftToCreateInput("diaper", { ...diaper.draft, diaperType: "poop" }, "UTC"), {
    status: "valid", input: { diaperTime: "2026-07-20T08:10:00.000Z", diaperType: "poop", notes: null, sourceMessageId: null },
  });
  assert.deepEqual(parseDraftToCreateInput("health", { ...health.draft, dateText: "0001-01-01", recordType: "vaccination", title: "  疫苗  ", description: "说明" }, "UTC"), {
    status: "valid", input: { recordDate: "0001-01-01", recordType: "vaccination", title: "疫苗", description: "说明", sourceMessageId: null },
  });
});

test("editor parsing enforces G032 boundaries and exact enums on the feature path", () => {
  const growth = createInitialDraft("growth", "2026-07-20T08:10:00.000Z", "UTC");
  const feeding = createInitialDraft("feeding", "2026-07-20T08:10:00.000Z", "UTC");
  const sleep = createInitialDraft("sleep", "2026-07-20T08:10:00.000Z", "UTC");
  const diaper = createInitialDraft("diaper", "2026-07-20T08:10:00.000Z", "UTC");
  const health = createInitialDraft("health", "2026-07-20T08:10:00.000Z", "UTC");
  if (growth.status !== "ready" || feeding.status !== "ready" || sleep.status !== "ready" || diaper.status !== "ready" || health.status !== "ready") assert.fail("expected ready drafts");

  for (const [field, accepted, rejected] of [
    ["weightG", ["100", "50000"], ["99", "50001", "100.5"]],
    ["heightCm", ["10", "150"], ["9.99", "150.01"]],
    ["headCm", ["10", "100"], ["9.99", "100.01"]],
  ] as const) {
    for (const value of accepted) assert.equal(parseDraftToCreateInput("growth", { ...growth.draft, [field]: value }, "UTC").status, "valid");
    for (const value of rejected) assert.equal(parseDraftToCreateInput("growth", { ...growth.draft, [field]: value }, "UTC").status, "invalid");
  }
  for (const feedType of ["breast", "formula", "solid"] as const) {
    const feedDraft: FeedingTrackerDraft = { ...feeding.draft, feedType, amountMl: feedType === "formula" ? "0" : "", durationMin: feedType === "breast" ? "0" : "" };
    assert.equal(parseDraftToCreateInput("feeding", feedDraft, "UTC").status, "valid");
  }
  assert.equal(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "invalid" } as never, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "solid", amountMl: "2001" }, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("feeding", { ...feeding.draft, feedType: "solid", durationMin: "1441" }, "UTC").status, "invalid");
  for (const sleepType of ["nap", "night"] as const) assert.equal(parseDraftToCreateInput("sleep", { ...sleep.draft, sleepType }, "UTC").status, "valid");
  assert.equal(parseDraftToCreateInput("sleep", { ...sleep.draft, sleepType: "night", nightWakings: "101" }, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("sleep", { ...sleep.draft, sleepType: "invalid" } as never, "UTC").status, "invalid");
  for (const diaperType of ["poop", "pee", "mixed"] as const) assert.equal(parseDraftToCreateInput("diaper", { ...diaper.draft, diaperType }, "UTC").status, "valid");
  assert.equal(parseDraftToCreateInput("diaper", { ...diaper.draft, diaperType: "invalid" } as never, "UTC").status, "invalid");
  for (const recordType of ["vaccination", "illness", "checkup"] as const) assert.equal(parseDraftToCreateInput("health", { ...health.draft, recordType, title: "标题" }, "UTC").status, "valid");
  assert.equal(parseDraftToCreateInput("health", { ...health.draft, recordType: "invalid", title: "标题" } as never, "UTC").status, "invalid");
  assert.equal(parseDraftToCreateInput("health", { ...health.draft, recordType: "checkup", title: "😀".repeat(200) }, "UTC").status, "valid");
  assert.equal(parseDraftToCreateInput("health", { ...health.draft, recordType: "checkup", title: "😀".repeat(201) }, "UTC").status, "invalid");
});

test("loaded arbitrary canonical seconds survive unrelated edits losslessly", () => {
  const feedingRecord = { ...records.feeding, feedTime: "2026-07-20T00:10:37.456Z" };
  const sleepRecord = { ...records.sleep, sleepStart: "2026-07-20T01:00:12.345Z", sleepEnd: "2026-07-20T02:00:59.999Z" };
  const diaperRecord = { ...records.diaper, diaperTime: "2026-07-20T03:00:01.001Z" };
  const feeding = recordToEditorDraft("feeding", feedingRecord, "Asia/Shanghai");
  const sleep = recordToEditorDraft("sleep", sleepRecord, "Asia/Shanghai");
  const diaper = recordToEditorDraft("diaper", diaperRecord, "Asia/Shanghai");
  assert.equal(feeding.status, "ready"); assert.equal(sleep.status, "ready"); assert.equal(diaper.status, "ready");
  if (feeding.status !== "ready" || sleep.status !== "ready" || diaper.status !== "ready") return;
  const feedingUpdate = parseDraftToUpdateInput("feeding", { ...feeding.draft, notes: "changed" }, feedingRecord, "Asia/Shanghai");
  const sleepUpdate = parseDraftToUpdateInput("sleep", { ...sleep.draft, notes: "changed" }, sleepRecord, "Asia/Shanghai");
  const diaperUpdate = parseDraftToUpdateInput("diaper", { ...diaper.draft, notes: "changed" }, diaperRecord, "Asia/Shanghai");
  assert.equal(feedingUpdate.status, "valid"); assert.equal(sleepUpdate.status, "valid"); assert.equal(diaperUpdate.status, "valid");
  if (feedingUpdate.status === "valid") assert.equal(feedingUpdate.input.feedTime, feedingRecord.feedTime);
  if (sleepUpdate.status === "valid") assert.deepEqual([sleepUpdate.input.sleepStart, sleepUpdate.input.sleepEnd], [sleepRecord.sleepStart, sleepRecord.sleepEnd]);
  if (diaperUpdate.status === "valid") assert.equal(diaperUpdate.input.diaperTime, diaperRecord.diaperTime);
  const changedMinute = parseDraftToUpdateInput("feeding", { ...feeding.draft, timeText: "08:11" }, feedingRecord, "Asia/Shanghai");
  assert.equal(changedMinute.status, "valid");
  if (changedMinute.status === "valid") assert.equal(changedMinute.input.feedTime, "2026-07-20T00:11:00.000Z");

  const crossZone = recordToEditorDraft("feeding", { ...feedingRecord, feedTime: "1999-12-31T10:00:37.456Z" }, "UTC");
  assert.equal(crossZone.status, "ready");
  if (crossZone.status === "ready") assert.deepEqual([crossZone.draft.dateText, crossZone.draft.timeText], ["1999-12-31", "10:00"]);
});

test("create conversion ignores hostile preserved instant metadata in every instant domain", () => {
  const feeding = createInitialDraft("feeding", "2026-07-20T08:10:37.456Z", "UTC");
  const sleep = createInitialDraft("sleep", "2026-07-20T08:10:37.456Z", "UTC");
  const diaper = createInitialDraft("diaper", "2026-07-20T08:10:37.456Z", "UTC");
  assert.equal(feeding.status, "ready"); assert.equal(sleep.status, "ready"); assert.equal(diaper.status, "ready");
  if (feeding.status !== "ready" || sleep.status !== "ready" || diaper.status !== "ready") return;

  const feedingInput = parseDraftToCreateInput("feeding", withHostileMetadata(feeding.draft, {
    feedType: "solid",
    preservedFeedTime: { instant: "2026-07-20T08:10:37.456Z", dateText: "2026-07-20", timeText: "08:10" },
  }), "UTC");
  assert.equal(feedingInput.status, "valid");
  if (feedingInput.status === "valid") assert.equal(feedingInput.input.feedTime, "2026-07-20T08:10:00.000Z");

  const sleepInput = parseDraftToCreateInput("sleep", withHostileMetadata(sleep.draft, {
    sleepType: "night",
    endDateText: "2026-07-20",
    endTimeText: "09:10",
    preservedSleepStart: { instant: "2026-07-20T08:10:37.456Z", dateText: "2026-07-20", timeText: "08:10" },
    preservedSleepEnd: { instant: "2026-07-20T09:10:59.999Z", dateText: "2026-07-20", timeText: "09:10" },
  }), "UTC");
  assert.equal(sleepInput.status, "valid");
  if (sleepInput.status === "valid") assert.deepEqual(
    [sleepInput.input.sleepStart, sleepInput.input.sleepEnd],
    ["2026-07-20T08:10:00.000Z", "2026-07-20T09:10:00.000Z"],
  );

  const diaperInput = parseDraftToCreateInput("diaper", withHostileMetadata(diaper.draft, {
    diaperType: "mixed",
    preservedDiaperTime: { instant: "2026-07-20T08:10:01.001Z", dateText: "2026-07-20", timeText: "08:10" },
  }), "UTC");
  assert.equal(diaperInput.status, "valid");
  if (diaperInput.status === "valid") assert.equal(diaperInput.input.diaperTime, "2026-07-20T08:10:00.000Z");
});

test("update reuses preserved instants only when canonical metadata matches the captured-zone minute", () => {
  const feeding = recordToEditorDraft("feeding", { ...records.feeding, feedTime: "2026-07-20T00:10:37.456Z" }, "Asia/Shanghai");
  const sleep = recordToEditorDraft("sleep", {
    ...records.sleep,
    sleepStart: "2026-07-20T01:00:12.345Z",
    sleepEnd: "2026-07-20T02:00:59.999Z",
  }, "Asia/Shanghai");
  const diaper = recordToEditorDraft("diaper", { ...records.diaper, diaperTime: "2026-07-20T03:00:01.001Z" }, "Asia/Shanghai");
  assert.equal(feeding.status, "ready"); assert.equal(sleep.status, "ready"); assert.equal(diaper.status, "ready");
  if (feeding.status !== "ready" || sleep.status !== "ready" || diaper.status !== "ready") return;

  const feedingBaseline = { ...records.feeding, feedTime: "2026-07-20T00:10:37.456Z" };
  const sleepBaseline = {
    ...records.sleep,
    sleepStart: "2026-07-20T01:00:12.345Z",
    sleepEnd: "2026-07-20T02:00:59.999Z",
  };
  const diaperBaseline = { ...records.diaper, diaperTime: "2026-07-20T03:00:01.001Z" };
  const feedingInput = parseDraftToUpdateInput("feeding", withHostileMetadata(feeding.draft, {
    preservedFeedTime: { instant: "2026-07-20T01:10:37.456Z", dateText: feeding.draft.dateText, timeText: feeding.draft.timeText },
  }), feedingBaseline, "Asia/Shanghai");
  assert.equal(feedingInput.status, "valid");
  if (feedingInput.status === "valid") assert.equal(feedingInput.input.feedTime, feedingBaseline.feedTime);

  const sleepInput = parseDraftToUpdateInput("sleep", withHostileMetadata(sleep.draft, {
    preservedSleepStart: { instant: "not-canonical", dateText: sleep.draft.dateText, timeText: sleep.draft.timeText },
    preservedSleepEnd: { instant: "2026-07-20T03:00:59.999Z", dateText: sleep.draft.endDateText, timeText: sleep.draft.endTimeText },
  }), sleepBaseline, "Asia/Shanghai");
  assert.equal(sleepInput.status, "valid");
  if (sleepInput.status === "valid") assert.deepEqual(
    [sleepInput.input.sleepStart, sleepInput.input.sleepEnd],
    [sleepBaseline.sleepStart, sleepBaseline.sleepEnd],
  );

  const diaperInput = parseDraftToUpdateInput("diaper", withHostileMetadata(diaper.draft, {
    preservedDiaperTime: { instant: "2026-07-20T04:00:01.001Z", dateText: diaper.draft.dateText, timeText: diaper.draft.timeText },
  }), diaperBaseline, "Asia/Shanghai");
  assert.equal(diaperInput.status, "valid");
  if (diaperInput.status === "valid") assert.equal(diaperInput.input.diaperTime, diaperBaseline.diaperTime);

  const growth = recordToEditorDraft("growth", records.growth, "UTC");
  assert.equal(growth.status, "ready");
  if (growth.status === "ready") {
    const growthInput = parseDraftToUpdateInput("growth", withHostileMetadata(growth.draft, {
      hiddenPercentiles: { weightPercentile: 99, heightPercentile: 88, headPercentile: 77 },
    }), records.growth, "UTC");
    assert.equal(growthInput.status, "valid");
    if (growthInput.status === "valid") assert.deepEqual({
      weightPercentile: growthInput.input.weightPercentile,
      heightPercentile: growthInput.input.heightPercentile,
      headPercentile: growthInput.input.headPercentile,
    }, { weightPercentile: 0, heightPercentile: 55.5, headPercentile: null });
  }
});

test("sleep pairing, DST errors, and all-domain no-op behavior remain explicit", () => {
  const initial = createInitialDraft("sleep", "2026-03-08T06:00:00.000Z", "America/New_York");
  assert.equal(initial.status, "ready");
  if (initial.status !== "ready") return;
  for (const draft of [
    { ...initial.draft, sleepType: "night" as const, endDateText: "2026-03-08", endTimeText: "" },
    { ...initial.draft, sleepType: "night" as const, endDateText: "", endTimeText: "03:30" },
  ]) {
    const result = parseDraftToCreateInput("sleep", draft, "America/New_York");
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") assert.equal(result.error, "结束日期和结束时间需要一起填写。");
  }
  const gap = parseDraftToCreateInput("sleep", { ...initial.draft, dateText: "2026-03-08", timeText: "02:30", sleepType: "night" }, "America/New_York");
  assert.equal(gap.status, "invalid"); if (gap.status === "invalid") assert.equal(gap.error, "这个本机时间不存在（夏令时调整），请换一个时间。");
  const fold = parseDraftToCreateInput("sleep", { ...initial.draft, dateText: "2026-11-01", timeText: "01:30", sleepType: "night" }, "America/New_York");
  assert.equal(fold.status, "invalid"); if (fold.status === "invalid") assert.equal(fold.error, "这个本机时间对应两个时刻，请换一个时间以避免歧义。");

  for (const domain of ["growth", "feeding", "sleep", "diaper", "health"] as const) {
    const draft = recordToEditorDraft(domain, records[domain], "UTC");
    assert.equal(draft.status, "ready", domain);
    if (draft.status !== "ready") continue;
    const parsed = parseDraftToUpdateInput(domain, draft.draft as never, records[domain] as never, "UTC");
    assert.equal(parsed.status, "valid", domain);
    if (parsed.status === "valid") assert.equal(isNormalizedUpdateNoop(domain, records[domain] as never, parsed.input as never), true, domain);
  }
  assert.equal(isNormalizedUpdateNoop("growth", records.growth, { ...records.growth, weightPercentile: 99 }), true);
});
