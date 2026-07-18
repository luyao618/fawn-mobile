import { compareLocalDates, parseLocalDate, type LocalDate } from "./localDate.ts";

export const BABY_PROFILE_LIMITS = Object.freeze({
  nameLength: 200,
  birthWeightG: Object.freeze({ minimum: 100, maximum: 10_000 }),
  birthHeightCm: Object.freeze({ minimum: 10, maximum: 100 }),
  birthHeadCm: Object.freeze({ minimum: 10, maximum: 80 }),
  gestationalWeeks: Object.freeze({ minimum: 20, maximum: 45 }),
});

export type BabySex = "male" | "female";
export type BabyProfileField =
  | "name"
  | "sex"
  | "birthDate"
  | "birthWeightG"
  | "birthHeightCm"
  | "birthHeadCm"
  | "isPremature"
  | "gestationalWeeks"
  | "createdAt"
  | "updatedAt";

export type BabyProfileInput = Readonly<{
  name: string | null;
  sex: BabySex | null;
  birthDate: string | null;
  birthWeightG: number | null;
  birthHeightCm: number | null;
  birthHeadCm: number | null;
  isPremature: boolean;
  gestationalWeeks: number | null;
}>;

export type BabyProfile = BabyProfileInput & Readonly<{
  createdAt: string;
  updatedAt: string;
}>;

export class BabyProfileValidationError extends TypeError {
  constructor(readonly field: BabyProfileField, message: string) {
    super(message);
    this.name = "BabyProfileValidationError";
  }
}

function nullableName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new BabyProfileValidationError("name", "Baby profile name must be text or null");
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if ([...normalized].length > BABY_PROFILE_LIMITS.nameLength) {
    throw new BabyProfileValidationError("name", "Baby profile name is too long");
  }
  return normalized;
}

function nullableNumber(
  value: unknown,
  field: "birthWeightG" | "birthHeightCm" | "birthHeadCm" | "gestationalWeeks",
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
    throw new BabyProfileValidationError(field, `Baby profile ${field} is outside the supported range`);
  }
  return value;
}

function birthDate(value: unknown, today: LocalDate): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BabyProfileValidationError("birthDate", "Baby birth date must be a local date or null");
  }
  let parsed: LocalDate;
  try {
    parsed = parseLocalDate(value);
  } catch {
    throw new BabyProfileValidationError("birthDate", "Baby birth date must be a strict Gregorian local date");
  }
  if (compareLocalDates(parsed, today) > 0) {
    throw new BabyProfileValidationError("birthDate", "Baby birth date cannot be in the future");
  }
  return parsed.iso;
}

export function normalizeBabyProfileInput(input: BabyProfileInput, today: LocalDate): BabyProfileInput {
  if (input === null || typeof input !== "object") {
    throw new BabyProfileValidationError("name", "Baby profile input must be an object");
  }
  const sex = input.sex;
  if (sex !== null && sex !== "male" && sex !== "female") {
    throw new BabyProfileValidationError("sex", "Baby profile sex must be male, female, or null");
  }
  if (typeof input.isPremature !== "boolean") {
    throw new BabyProfileValidationError("isPremature", "Prematurity must be an explicit boolean");
  }
  return Object.freeze({
    name: nullableName(input.name),
    sex,
    birthDate: birthDate(input.birthDate, today),
    birthWeightG: nullableNumber(
      input.birthWeightG,
      "birthWeightG",
      BABY_PROFILE_LIMITS.birthWeightG.minimum,
      BABY_PROFILE_LIMITS.birthWeightG.maximum,
      true,
    ),
    birthHeightCm: nullableNumber(
      input.birthHeightCm,
      "birthHeightCm",
      BABY_PROFILE_LIMITS.birthHeightCm.minimum,
      BABY_PROFILE_LIMITS.birthHeightCm.maximum,
      false,
    ),
    birthHeadCm: nullableNumber(
      input.birthHeadCm,
      "birthHeadCm",
      BABY_PROFILE_LIMITS.birthHeadCm.minimum,
      BABY_PROFILE_LIMITS.birthHeadCm.maximum,
      false,
    ),
    isPremature: input.isPremature,
    gestationalWeeks: nullableNumber(
      input.gestationalWeeks,
      "gestationalWeeks",
      BABY_PROFILE_LIMITS.gestationalWeeks.minimum,
      BABY_PROFILE_LIMITS.gestationalWeeks.maximum,
      true,
    ),
  });
}

export function validatePersistedBabyProfileInput(input: BabyProfileInput): BabyProfileInput {
  const normalized = normalizeBabyProfileInput(input, parseLocalDate("9999-12-31"));
  if (normalized.name !== input.name) {
    throw new BabyProfileValidationError("name", "Stored baby profile name is not canonical");
  }
  return normalized;
}

export function sameBabyProfileInput(left: BabyProfileInput, right: BabyProfileInput): boolean {
  return left.name === right.name
    && left.sex === right.sex
    && left.birthDate === right.birthDate
    && left.birthWeightG === right.birthWeightG
    && left.birthHeightCm === right.birthHeightCm
    && left.birthHeadCm === right.birthHeadCm
    && left.isPremature === right.isPremature
    && left.gestationalWeeks === right.gestationalWeeks;
}
