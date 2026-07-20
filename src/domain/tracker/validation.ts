import { parseLocalDate } from "../baby/localDate.ts";
import type {
  TrackerCreateInputByDomain,
  TrackerDomain,
  TrackerRecordByDomain,
  TrackerUpdateInputByDomain,
  TrackerValuesByDomain,
} from "./types.ts";

export class TrackerValidationError extends TypeError {
  constructor(
    readonly domain: TrackerDomain,
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "TrackerValidationError";
  }
}

export function assertTrackerDomain(value: unknown): asserts value is TrackerDomain {
  if (value !== "growth" && value !== "feeding" && value !== "sleep" && value !== "diaper" && value !== "health") {
    throw new TypeError("Tracker domain is not supported");
  }
}

const valueFields = Object.freeze({
  growth: Object.freeze([
    "measurementDate", "weightG", "heightCm", "headCm",
    "weightPercentile", "heightPercentile", "headPercentile", "notes",
  ]),
  feeding: Object.freeze(["feedTime", "feedType", "amountMl", "durationMin", "notes"]),
  sleep: Object.freeze(["sleepStart", "sleepEnd", "sleepType", "nightWakings", "notes"]),
  diaper: Object.freeze(["diaperTime", "diaperType", "notes"]),
  health: Object.freeze(["recordDate", "recordType", "title", "description"]),
} satisfies Record<TrackerDomain, readonly string[]>);

function objectInput(domain: TrackerDomain, input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TrackerValidationError(domain, "input", "Tracker input must be an object");
  }
  return input as Record<string, unknown>;
}

function exactFields(domain: TrackerDomain, input: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = objectInput(domain, input);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TrackerValidationError(domain, "input", "Tracker input fields must match the camelCase contract exactly");
  }
  return value;
}

function localDate(domain: TrackerDomain, field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TrackerValidationError(domain, field, `${field} must be a strict Gregorian local date`);
  }
  try {
    return parseLocalDate(value).iso;
  } catch {
    throw new TrackerValidationError(domain, field, `${field} must be a strict Gregorian local date`);
  }
}

export function canonicalTrackerInstant(domain: TrackerDomain, field: string, value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TrackerValidationError(domain, field, `${field} must be a canonical millisecond UTC instant`);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) {
    throw new TrackerValidationError(domain, field, `${field} must be a canonical millisecond UTC instant`);
  }
  return value;
}

function nullableText(domain: TrackerDomain, field: string, value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new TrackerValidationError(domain, field, `${field} must be text or null`);
}

function nullableNumber(
  domain: TrackerDomain,
  field: string,
  value: unknown,
  minimum: number,
  maximum: number,
  integer: boolean,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || (integer && !Number.isSafeInteger(value))
    || value < minimum
    || value > maximum
  ) {
    throw new TrackerValidationError(domain, field, `${field} is outside the supported range`);
  }
  return value === 0 ? 0 : value;
}

function integer(domain: TrackerDomain, field: string, value: unknown, minimum: number, maximum: number): number {
  const normalized = nullableNumber(domain, field, value, minimum, maximum, true);
  if (normalized === null) throw new TrackerValidationError(domain, field, `${field} must be an integer`);
  return normalized;
}

function exactEnum<T extends string>(
  domain: TrackerDomain,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  throw new TrackerValidationError(domain, field, `${field} is not a supported value`);
}

function normalizeValues<D extends TrackerDomain>(
  domain: D,
  input: unknown,
): TrackerValuesByDomain[D] {
  const value = exactFields(domain, input, valueFields[domain]);
  switch (domain) {
    case "growth": {
      const weightG = nullableNumber(domain, "weightG", value.weightG, 100, 50_000, true);
      const heightCm = nullableNumber(domain, "heightCm", value.heightCm, 10, 150, false);
      const headCm = nullableNumber(domain, "headCm", value.headCm, 10, 100, false);
      if (weightG === null && heightCm === null && headCm === null) {
        throw new TrackerValidationError(domain, "measurements", "Growth requires at least one measurement");
      }
      return Object.freeze({
        measurementDate: localDate(domain, "measurementDate", value.measurementDate),
        weightG,
        heightCm,
        headCm,
        weightPercentile: nullableNumber(domain, "weightPercentile", value.weightPercentile, 0, 100, false),
        heightPercentile: nullableNumber(domain, "heightPercentile", value.heightPercentile, 0, 100, false),
        headPercentile: nullableNumber(domain, "headPercentile", value.headPercentile, 0, 100, false),
        notes: nullableText(domain, "notes", value.notes),
      }) as TrackerValuesByDomain[D];
    }
    case "feeding": {
      const feedType = exactEnum(domain, "feedType", value.feedType, ["breast", "formula", "solid"] as const);
      const amountMl = nullableNumber(domain, "amountMl", value.amountMl, 0, 2_000, true);
      const durationMin = nullableNumber(domain, "durationMin", value.durationMin, 0, 1_440, true);
      if (feedType === "formula" && amountMl === null) {
        throw new TrackerValidationError(domain, "amountMl", "Formula feeding requires amountMl");
      }
      if (feedType === "breast" && durationMin === null) {
        throw new TrackerValidationError(domain, "durationMin", "Breast feeding requires durationMin");
      }
      return Object.freeze({
        feedTime: canonicalTrackerInstant(domain, "feedTime", value.feedTime),
        feedType,
        amountMl,
        durationMin,
        notes: nullableText(domain, "notes", value.notes),
      }) as TrackerValuesByDomain[D];
    }
    case "sleep": {
      const sleepStart = canonicalTrackerInstant(domain, "sleepStart", value.sleepStart);
      const sleepEnd = value.sleepEnd === null
        ? null
        : canonicalTrackerInstant(domain, "sleepEnd", value.sleepEnd);
      if (sleepEnd !== null && sleepEnd <= sleepStart) {
        throw new TrackerValidationError(domain, "sleepEnd", "sleepEnd must be later than sleepStart");
      }
      const sleepType = exactEnum(domain, "sleepType", value.sleepType, ["nap", "night"] as const);
      const nightWakings = integer(domain, "nightWakings", value.nightWakings, 0, 100);
      if (sleepType === "nap" && nightWakings !== 0) {
        throw new TrackerValidationError(domain, "nightWakings", "Nap records require zero nightWakings");
      }
      return Object.freeze({
        sleepStart,
        sleepEnd,
        sleepType,
        nightWakings,
        notes: nullableText(domain, "notes", value.notes),
      }) as TrackerValuesByDomain[D];
    }
    case "diaper":
      return Object.freeze({
        diaperTime: canonicalTrackerInstant(domain, "diaperTime", value.diaperTime),
        diaperType: exactEnum(domain, "diaperType", value.diaperType, ["poop", "pee", "mixed"] as const),
        notes: nullableText(domain, "notes", value.notes),
      }) as TrackerValuesByDomain[D];
    case "health": {
      if (typeof value.title !== "string") {
        throw new TrackerValidationError(domain, "title", "Health title must be text");
      }
      const title = value.title.trim();
      if ([...title].length < 1 || [...title].length > 200) {
        throw new TrackerValidationError(domain, "title", "Health title must contain 1 to 200 Unicode code points");
      }
      return Object.freeze({
        recordDate: localDate(domain, "recordDate", value.recordDate),
        recordType: exactEnum(domain, "recordType", value.recordType, ["vaccination", "illness", "checkup"] as const),
        title,
        description: nullableText(domain, "description", value.description),
      }) as TrackerValuesByDomain[D];
    }
  }
}

export function normalizeTrackerCreateInput<D extends TrackerDomain>(
  domain: D,
  input: TrackerCreateInputByDomain[D],
): TrackerCreateInputByDomain[D] {
  const value = exactFields(domain, input, [...valueFields[domain], "sourceMessageId"]);
  const sourceMessageId = nullableText(domain, "sourceMessageId", value.sourceMessageId);
  const businessValues = Object.fromEntries(valueFields[domain].map((field) => [field, value[field]]));
  return Object.freeze({ ...normalizeValues(domain, businessValues), sourceMessageId }) as TrackerCreateInputByDomain[D];
}

export function normalizeTrackerUpdateInput<D extends TrackerDomain>(
  domain: D,
  input: TrackerUpdateInputByDomain[D],
): TrackerUpdateInputByDomain[D] {
  return normalizeValues(domain, input) as TrackerUpdateInputByDomain[D];
}

export function normalizePersistedTrackerRecord<D extends TrackerDomain>(
  domain: D,
  input: TrackerRecordByDomain[D],
): TrackerRecordByDomain[D] {
  const fields = [...valueFields[domain], "id", "sourceMessageId", "createdAt", "updatedAt"];
  const value = exactFields(domain, input, fields);
  if (typeof value.id !== "string") throw new TrackerValidationError(domain, "id", "Stored tracker id must be text");
  const sourceMessageId = nullableText(domain, "sourceMessageId", value.sourceMessageId);
  const createdAt = canonicalTrackerInstant(domain, "createdAt", value.createdAt);
  const updatedAt = canonicalTrackerInstant(domain, "updatedAt", value.updatedAt);
  if (createdAt > updatedAt) {
    throw new TrackerValidationError(domain, "updatedAt", "Stored tracker timestamps are invalid");
  }
  const businessValues = Object.fromEntries(valueFields[domain].map((field) => [field, value[field]]));
  return Object.freeze({
    ...normalizeValues(domain, businessValues),
    id: value.id,
    sourceMessageId,
    createdAt,
    updatedAt,
  }) as TrackerRecordByDomain[D];
}

export function assertTrackerListLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Tracker list limit must be a safe integer from 1 to 100");
  }
}
