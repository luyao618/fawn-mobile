export const TRACKER_LOCAL_MINIMUM_OFFSET_MINUTES = -1_440;
export const TRACKER_LOCAL_MAXIMUM_OFFSET_MINUTES = 1_440;
export const TRACKER_LOCAL_RAW_CANDIDATE_COUNT = 2_881;

export type StrictTrackerDate = Readonly<{
  year: number;
  month: number;
  day: number;
  iso: string;
}>;

export type StrictParseResult<T> =
  | Readonly<{ status: "valid"; value: T }>
  | Readonly<{ status: "invalid"; reason: "syntax" | "range" }>;

export type DeviceTimeZoneResult =
  | Readonly<{ status: "available"; zone: string }>
  | Readonly<{ status: "unavailable"; reason: "missing" | "invalid" }>;

export type LocalMinuteResolution =
  | Readonly<{ status: "unique"; instant: string }>
  | Readonly<{ status: "gap" | "fold" | "invalid_date" | "invalid_time" | "invalid_zone" | "out_of_range" }>;

export type LocalMinuteDraftResult =
  | Readonly<{ status: "formatted"; dateText: string; timeText: string }>
  | Readonly<{ status: "invalid_zone" | "invalid_instant" | "out_of_range" }>;

type LocalMinute = Readonly<{ hour: number; minute: number }>;
type NumericDateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

const CANONICAL_TRACKER_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const MINIMUM_INSTANT_DATE = "2000-01-01";
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_DAY = 86_400_000;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function monthLength(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function parseStrictTrackerDate(text: string): StrictParseResult<StrictTrackerDate> {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (match === null) return Object.freeze({ status: "invalid", reason: "syntax" });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9_999 || month < 1 || month > 12 || day < 1 || day > monthLength(year, month)) {
    return Object.freeze({ status: "invalid", reason: "range" });
  }
  return Object.freeze({ status: "valid", value: Object.freeze({ year, month, day, iso: text }) });
}

export function parseStrictIntegerText(text: string): StrictParseResult<number> {
  if (!/^[0-9]+$/.test(text)) return Object.freeze({ status: "invalid", reason: "syntax" });
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return Object.freeze({ status: "invalid", reason: "range" });
  return Object.freeze({ status: "valid", value });
}

export function parseStrictDecimalText(text: string): StrictParseResult<number> {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) return Object.freeze({ status: "invalid", reason: "syntax" });
  const value = Number(text);
  if (!Number.isFinite(value)) return Object.freeze({ status: "invalid", reason: "range" });
  return Object.freeze({ status: "valid", value: value === 0 ? 0 : value });
}

function parseStrictLocalMinute(text: string): LocalMinute | null {
  const match = /^([0-9]{2}):([0-9]{2})$/.exec(text);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? Object.freeze({ hour, minute }) : null;
}

function createLocalMinuteFormatter(zone: string): Intl.DateTimeFormat | null {
  if (typeof zone !== "string" || zone.length === 0) return null;
  try {
    return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: zone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
}

export function isUsableIanaZone(zone: unknown): zone is string {
  return typeof zone === "string" && createLocalMinuteFormatter(zone) !== null;
}

export function captureDeviceTimeZone(): DeviceTimeZoneResult {
  let zone: unknown;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return Object.freeze({ status: "unavailable", reason: "invalid" });
  }
  if (typeof zone !== "string" || zone.length === 0) {
    return Object.freeze({ status: "unavailable", reason: "missing" });
  }
  return isUsableIanaZone(zone)
    ? Object.freeze({ status: "available", zone })
    : Object.freeze({ status: "unavailable", reason: "invalid" });
}

function civilDayOrdinal(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365
    + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100)
    + dayOfYear;
  return era * 146_097 + dayOfEra;
}

const UNIX_EPOCH_ORDINAL = civilDayOrdinal(1970, 1, 1);

function wallMinuteMilliseconds(date: StrictTrackerDate, time: LocalMinute): number {
  const dayOffset = civilDayOrdinal(date.year, date.month, date.day) - UNIX_EPOCH_ORDINAL;
  return dayOffset * MILLISECONDS_PER_DAY + (time.hour * 60 + time.minute) * MILLISECONDS_PER_MINUTE;
}

function numericFormatterParts(formatter: Intl.DateTimeFormat, instant: Date): NumericDateTimeParts | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(instant);
  } catch {
    return null;
  }
  if (parts.some((part) => part.type === "era")) return null;
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const names = ["year", "month", "day", "hour", "minute", "second"] as const;
  const numbers = names.map((name) => {
    const value = values.get(name);
    return value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  });
  if (numbers.some((value) => !Number.isSafeInteger(value))) return null;
  return Object.freeze({
    year: numbers[0]!, month: numbers[1]!, day: numbers[2]!,
    hour: numbers[3]!, minute: numbers[4]!, second: numbers[5]!,
  });
}

function matchesRequestedMinute(
  parts: NumericDateTimeParts | null,
  date: StrictTrackerDate,
  time: LocalMinute,
): boolean {
  return parts !== null
    && parts.year === date.year
    && parts.month === date.month
    && parts.day === date.day
    && parts.hour === time.hour
    && parts.minute === time.minute
    && parts.second === 0;
}

function canonicalInstantAt(candidateMs: number): string | null {
  let iso: string;
  try {
    iso = new Date(candidateMs).toISOString();
  } catch {
    return null;
  }
  if (!CANONICAL_TRACKER_INSTANT.test(iso)) return null;
  const roundTrip = new Date(iso);
  return roundTrip.getTime() === candidateMs && roundTrip.toISOString() === iso ? iso : null;
}

function isCommonEraInstant(instant: Date, zone: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: zone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      era: "short",
    });
    return formatter.formatToParts(instant).find((part) => part.type === "era")?.value === "AD";
  } catch {
    return false;
  }
}

export function resolveLocalMinute(dateText: string, timeText: string, ianaZone: string): LocalMinuteResolution {
  const date = parseStrictTrackerDate(dateText);
  if (date.status === "invalid") return Object.freeze({ status: "invalid_date" });
  const time = parseStrictLocalMinute(timeText);
  if (time === null) return Object.freeze({ status: "invalid_time" });
  const formatter = createLocalMinuteFormatter(ianaZone);
  if (formatter === null) return Object.freeze({ status: "invalid_zone" });
  if (date.value.iso < MINIMUM_INSTANT_DATE) return Object.freeze({ status: "out_of_range" });

  const wallMinuteUtc = wallMinuteMilliseconds(date.value, time);
  const matchingCandidates = new Set<number>();
  for (
    let offsetMinutes = TRACKER_LOCAL_MINIMUM_OFFSET_MINUTES;
    offsetMinutes <= TRACKER_LOCAL_MAXIMUM_OFFSET_MINUTES;
    offsetMinutes += 1
  ) {
    const candidateMs = wallMinuteUtc - offsetMinutes * MILLISECONDS_PER_MINUTE;
    if (!Number.isFinite(candidateMs)) continue;
    const parts = numericFormatterParts(formatter, new Date(candidateMs));
    if (matchesRequestedMinute(parts, date.value, time)) matchingCandidates.add(candidateMs);
  }

  if (matchingCandidates.size === 0) return Object.freeze({ status: "gap" });
  const representable = [...matchingCandidates]
    .map((candidateMs) => canonicalInstantAt(candidateMs))
    .filter((instant): instant is string => instant !== null);
  if (representable.length === 0) return Object.freeze({ status: "out_of_range" });
  if (representable.length > 1) return Object.freeze({ status: "fold" });
  return Object.freeze({ status: "unique", instant: representable[0]! });
}

export function formatInstantForDeviceZone(instant: string, ianaZone: string): LocalMinuteDraftResult {
  const formatter = createLocalMinuteFormatter(ianaZone);
  if (formatter === null) return Object.freeze({ status: "invalid_zone" });
  if (!CANONICAL_TRACKER_INSTANT.test(instant)) return Object.freeze({ status: "invalid_instant" });
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== instant) {
    return Object.freeze({ status: "invalid_instant" });
  }
  if (!isCommonEraInstant(parsed, ianaZone)) return Object.freeze({ status: "out_of_range" });
  const parts = numericFormatterParts(formatter, parsed);
  if (parts === null) return Object.freeze({ status: "out_of_range" });
  const dateText = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  if (parts.year < 1 || parts.year > 9_999) return Object.freeze({ status: "out_of_range" });
  const date = parseStrictTrackerDate(dateText);
  if (date.status === "invalid") return Object.freeze({ status: "out_of_range" });
  return Object.freeze({
    status: "formatted",
    dateText,
    timeText: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
  });
}

export function instantToLocalMinuteDraft(instant: string, ianaZone: string): LocalMinuteDraftResult {
  return formatInstantForDeviceZone(instant, ianaZone);
}
