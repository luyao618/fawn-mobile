export type LocalDate = Readonly<{
  year: number;
  month: number;
  day: number;
  iso: string;
}>;

export class InvalidLocalDateError extends TypeError {
  constructor(message = "Value must be a strict Gregorian local date in YYYY-MM-DD form") {
    super(message);
    this.name = "InvalidLocalDateError";
  }
}

export class InvalidTimeZoneError extends RangeError {
  constructor() {
    super("Value must be a valid IANA time zone");
    this.name = "InvalidTimeZoneError";
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9_999) throw new InvalidLocalDateError();
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) throw new InvalidLocalDateError();
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseLocalDate(value: string): LocalDate {
  if (typeof value !== "string") throw new InvalidLocalDateError();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new InvalidLocalDateError();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new InvalidLocalDateError();
  }
  return Object.freeze({ year, month, day, iso: value });
}

export function compareLocalDates(left: LocalDate, right: LocalDate): number {
  return Math.sign(civilDateOrdinal(left) - civilDateOrdinal(right));
}

export function civilDateOrdinal(value: LocalDate): number {
  let year = value.year;
  const month = value.month;
  const day = value.day;
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365
    + Math.floor(yearOfEra / 4)
    - Math.floor(yearOfEra / 100)
    + dayOfYear;
  return era * 146_097 + dayOfEra;
}

export function addCalendarMonths(value: LocalDate, months: number): LocalDate {
  if (!Number.isSafeInteger(months) || months < 0) {
    throw new RangeError("Calendar month offset must be a non-negative safe integer");
  }
  const monthIndex = (value.year - 1) * 12 + value.month - 1 + months;
  const year = Math.floor(monthIndex / 12) + 1;
  const month = monthIndex % 12 + 1;
  if (year > 9_999) throw new RangeError("Calendar month offset exceeds the supported local-date range");
  const day = Math.min(value.day, daysInMonth(year, month));
  return parseLocalDate(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

function canonicalInstant(value: string | Date): Date {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (
    Number.isNaN(instant.getTime())
    || (typeof value === "string" && (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || instant.toISOString() !== value
    ))
  ) {
    throw new TypeError("Instant must be a canonical UTC timestamp");
  }
  return instant;
}

export function localDateAtInstant(value: string | Date, timeZone: string): LocalDate {
  if (typeof timeZone !== "string" || timeZone.length === 0) throw new InvalidTimeZoneError();
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new InvalidTimeZoneError();
  }
  const parts = formatter.formatToParts(canonicalInstant(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined => (
    parts.find((item) => item.type === type)?.value
  );
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new InvalidLocalDateError("Time zone conversion did not produce a local date");
  return parseLocalDate(`${year.padStart(4, "0")}-${month}-${day}`);
}
