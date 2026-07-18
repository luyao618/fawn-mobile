import {
  addCalendarMonths,
  civilDateOrdinal,
  compareLocalDates,
  localDateAtInstant,
  parseLocalDate,
} from "./localDate.ts";

export type UnknownExactAge = Readonly<{
  status: "unknown";
  reason: "birth_date_missing";
  localDate: string;
  timeZone: string;
}>;

export type KnownExactAge = Readonly<{
  status: "known";
  localDate: string;
  timeZone: string;
  ageDays: number;
  completedMonths: number;
  remainingDays: number;
}>;

export type ExactAge = UnknownExactAge | KnownExactAge;

export function calculateExactAge(
  birthDate: string | null,
  instant: string | Date,
  timeZone: string,
): ExactAge {
  const today = localDateAtInstant(instant, timeZone);
  if (birthDate === null) {
    return Object.freeze({
      status: "unknown",
      reason: "birth_date_missing",
      localDate: today.iso,
      timeZone,
    });
  }
  const birth = parseLocalDate(birthDate);
  if (compareLocalDates(birth, today) > 0) throw new RangeError("Baby birth date cannot be in the future");

  let completedMonths = (today.year - birth.year) * 12 + today.month - birth.month;
  let anchor = addCalendarMonths(birth, completedMonths);
  if (compareLocalDates(anchor, today) > 0) {
    completedMonths -= 1;
    anchor = addCalendarMonths(birth, completedMonths);
  }
  return Object.freeze({
    status: "known",
    localDate: today.iso,
    timeZone,
    ageDays: civilDateOrdinal(today) - civilDateOrdinal(birth),
    completedMonths,
    remainingDays: civilDateOrdinal(today) - civilDateOrdinal(anchor),
  });
}

export function formatExactAge(age: ExactAge): string | null {
  if (age.status === "unknown") return null;
  return `${age.completedMonths}个月${age.remainingDays}天`;
}
