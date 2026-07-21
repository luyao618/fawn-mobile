import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  captureDeviceTimeZone,
  formatInstantForDeviceZone,
  instantToLocalMinuteDraft,
  isUsableIanaZone,
  parseStrictDecimalText,
  parseStrictIntegerText,
  parseStrictTrackerDate,
  resolveLocalMinute,
  TRACKER_LOCAL_MAXIMUM_OFFSET_MINUTES,
  TRACKER_LOCAL_MINIMUM_OFFSET_MINUTES,
  TRACKER_LOCAL_RAW_CANDIDATE_COUNT,
} from "../../../src/features/tracker/trackerLocalTime.ts";

test("strict tracker parsers accept only real ASCII dates and unsigned finite numbers", () => {
  assert.deepEqual(parseStrictTrackerDate("2024-02-29"), {
    status: "valid", value: { year: 2024, month: 2, day: 29, iso: "2024-02-29" },
  });
  for (const value of ["2023-02-29", "2024-2-29", "0000-01-01", "２０２４-02-29", " 2024-02-29"])
    assert.equal(parseStrictTrackerDate(value).status, "invalid");

  assert.deepEqual(parseStrictIntegerText("0"), { status: "valid", value: 0 });
  assert.deepEqual(parseStrictIntegerText("2000"), { status: "valid", value: 2000 });
  assert.deepEqual(parseStrictDecimalText("0"), { status: "valid", value: 0 });
  assert.deepEqual(parseStrictDecimalText("68.5"), { status: "valid", value: 68.5 });
  for (const value of ["", "+1", "-1", "1.0", "1e2", "1,000", " 1", "１"])
    assert.equal(parseStrictIntegerText(value).status, "invalid", value);
  for (const value of ["", ".5", "5.", "+1", "-1", "1e2", "1,000", " 1", "１", "9".repeat(400)])
    assert.equal(parseStrictDecimalText(value).status, "invalid", value);
});

test("device zones are validated and captured without substituting a fallback", () => {
  assert.equal(isUsableIanaZone("UTC"), true);
  assert.equal(isUsableIanaZone("Asia/Kathmandu"), true);
  assert.equal(isUsableIanaZone("Not/A_Zone"), false);
  assert.equal(isUsableIanaZone(""), false);
  const captured = captureDeviceTimeZone();
  assert.equal(captured.status, "available");
  if (captured.status === "available") assert.equal(isUsableIanaZone(captured.zone), true);
});

test("device zone capture reports missing and invalid zones without a UTC fallback", () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function MissingZoneDateTimeFormat() {
    return { resolvedOptions: () => ({ timeZone: "" }) };
  } as unknown as typeof Intl.DateTimeFormat;
  try {
    assert.deepEqual(captureDeviceTimeZone(), { status: "unavailable", reason: "missing" });
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }

  Intl.DateTimeFormat = function InvalidZoneDateTimeFormat(_locale?: unknown, options?: Intl.DateTimeFormatOptions) {
    if (options === undefined) return { resolvedOptions: () => ({ timeZone: "Not/A_Zone" }) };
    throw new RangeError("invalid zone");
  } as unknown as typeof Intl.DateTimeFormat;
  try {
    assert.deepEqual(captureDeviceTimeZone(), { status: "unavailable", reason: "invalid" });
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
});

test("finite local-minute resolution handles UTC, non-hour offsets, gaps, folds, and bounds", () => {
  assert.deepEqual(resolveLocalMinute("2026-07-20", "08:10", "UTC"), {
    status: "unique", instant: "2026-07-20T08:10:00.000Z",
  });
  assert.deepEqual(resolveLocalMinute("2026-07-20", "08:10", "Asia/Kathmandu"), {
    status: "unique", instant: "2026-07-20T02:25:00.000Z",
  });
  assert.deepEqual(resolveLocalMinute("2026-03-08", "02:30", "America/New_York"), { status: "gap" });
  assert.deepEqual(resolveLocalMinute("2026-11-01", "01:30", "America/New_York"), { status: "fold" });
  assert.deepEqual(resolveLocalMinute("1999-12-31", "23:59", "UTC"), { status: "out_of_range" });
  assert.deepEqual(resolveLocalMinute("9999-12-31", "23:59", "Etc/GMT+12"), { status: "out_of_range" });
  assert.deepEqual(resolveLocalMinute("2026-02-29", "08:10", "UTC"), { status: "invalid_date" });
  assert.deepEqual(resolveLocalMinute("2026-07-20", "24:00", "UTC"), { status: "invalid_time" });
  assert.deepEqual(resolveLocalMinute("2026-07-20", "08:10", "Not/A_Zone"), { status: "invalid_zone" });
});

test("instant formatting accepts arbitrary canonical seconds and cross-zone local years before 2000", () => {
  assert.deepEqual(instantToLocalMinuteDraft("2026-07-20T02:25:00.000Z", "Asia/Kathmandu"), {
    status: "formatted", dateText: "2026-07-20", timeText: "08:10",
  });
  assert.deepEqual(formatInstantForDeviceZone("2026-07-20T02:25:37.456Z", "Asia/Kathmandu"), {
    status: "formatted", dateText: "2026-07-20", timeText: "08:10",
  });
  assert.deepEqual(formatInstantForDeviceZone("1999-12-31T10:00:37.456Z", "UTC"), {
    status: "formatted", dateText: "1999-12-31", timeText: "10:00",
  });
  assert.deepEqual(formatInstantForDeviceZone("1999-12-31T10:00:37.456Z", "Pacific/Kiritimati"), {
    status: "formatted", dateText: "2000-01-01", timeText: "00:00",
  });
  for (const malformed of [
    "2026-07-20T02:25:00Z", "2026-07-20T02:25:00.000+00:00", "2026-7-20T02:25:00.000Z",
    "2026-02-29T00:00:00.000Z", "not-an-instant",
  ]) assert.equal(formatInstantForDeviceZone(malformed, "UTC").status, "invalid_instant", malformed);
  assert.equal(formatInstantForDeviceZone("0000-01-01T00:00:00.000Z", "UTC").status, "out_of_range");
  assert.equal(formatInstantForDeviceZone("2026-07-20T02:25:00.000Z", "bad").status, "invalid_zone");
});

test("the resolver source proves the exhaustive 2,881-candidate bounded algorithm", () => {
  assert.equal(TRACKER_LOCAL_MINIMUM_OFFSET_MINUTES, -1440);
  assert.equal(TRACKER_LOCAL_MAXIMUM_OFFSET_MINUTES, 1440);
  assert.equal(TRACKER_LOCAL_RAW_CANDIDATE_COUNT, 2881);
  const source = readFileSync(new URL("../../../src/features/tracker/trackerLocalTime.ts", import.meta.url), "utf8");
  assert.match(source, /new Set<number>\(\)/);
  assert.match(source, /matchingCandidates\.add\(candidateMs\)/);
  assert.match(source, /matchingCandidates\.size/);
  assert.match(source, /\.\.\.matchingCandidates/);
  assert.match(source, /offsetMinutes <= TRACKER_LOCAL_MAXIMUM_OFFSET_MINUTES/);
  assert.doesNotMatch(source, /Date\.UTC\s*\(/);
  assert.doesNotMatch(source, /Date\.parse\s*\(/);
  assert.doesNotMatch(source, /new Date\s*\(\s*`|new Date\s*\(\s*dateText|new Date\s*\(\s*timeText/);
  assert.doesNotMatch(source, /while\s*\(/);
  assert.match(source, /second[^\n]*===?[^\n]*0|second[^\n]*!==?[^\n]*0/);
});

test("the resolver evaluates both offset endpoints and exactly 2,881 raw candidates", () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  const wallMinute = new Date("2026-07-20T08:10:00.000Z").getTime();
  const observed: number[] = [];
  const matchingParts = (matches: boolean): Intl.DateTimeFormatPart[] => [
    { type: "year", value: matches ? "2026" : "2001" },
    { type: "month", value: "07" }, { type: "day", value: "20" },
    { type: "hour", value: "08" }, { type: "minute", value: "10" }, { type: "second", value: "00" },
  ];
  Intl.DateTimeFormat = function FakeDateTimeFormat() {
    return { formatToParts(value: Date) { observed.push(value.getTime()); return matchingParts(value.getTime() === wallMinute); } };
  } as unknown as typeof Intl.DateTimeFormat;
  try {
    assert.deepEqual(resolveLocalMinute("2026-07-20", "08:10", "UTC"), { status: "unique", instant: "2026-07-20T08:10:00.000Z" });
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
  assert.equal(observed.length, 2_881);
  assert.equal(observed[0], wallMinute + 1_440 * 60_000);
  assert.equal(observed.at(-1), wallMinute - 1_440 * 60_000);
});

test("the resolver rejects formatter matches whose local second is not 00", () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let calls = 0;
  Intl.DateTimeFormat = function NonzeroSecondDateTimeFormat() {
    return { formatToParts() {
      calls += 1;
      return [
        { type: "year", value: "2026" }, { type: "month", value: "07" }, { type: "day", value: "20" },
        { type: "hour", value: "08" }, { type: "minute", value: "10" }, { type: "second", value: "37" },
      ];
    } };
  } as unknown as typeof Intl.DateTimeFormat;
  try {
    assert.deepEqual(resolveLocalMinute("2026-07-20", "08:10", "UTC"), { status: "gap" });
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
  assert.equal(calls, 2_881);
});
