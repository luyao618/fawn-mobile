import type {
  TrackerCreateInputByDomain,
  TrackerDomain,
  TrackerRecordByDomain,
  TrackerUpdateInputByDomain,
  TrackerValuesByDomain,
} from "../../domain/tracker/types.ts";
import {
  normalizeTrackerCreateInput,
  normalizeTrackerUpdateInput,
  TrackerValidationError,
} from "../../domain/tracker/validation.ts";
import {
  formatInstantForDeviceZone,
  parseStrictDecimalText,
  parseStrictIntegerText,
  parseStrictTrackerDate,
  resolveLocalMinute,
} from "./trackerLocalTime.ts";

type DraftBase<D extends TrackerDomain> = Readonly<{
  domain: D;
  timeZone: string;
  dateText: string;
}>;

export type GrowthTrackerDraft = DraftBase<"growth"> & Readonly<{
  weightG: string;
  heightCm: string;
  headCm: string;
  notes: string;
}>;

export type FeedingTrackerDraft = DraftBase<"feeding"> & Readonly<{
  timeText: string;
  feedType: "" | "breast" | "formula" | "solid";
  amountMl: string;
  durationMin: string;
  notes: string;
}>;

export type SleepTrackerDraft = DraftBase<"sleep"> & Readonly<{
  timeText: string;
  endDateText: string;
  endTimeText: string;
  sleepType: "" | "nap" | "night";
  nightWakings: string;
  notes: string;
}>;

export type DiaperTrackerDraft = DraftBase<"diaper"> & Readonly<{
  timeText: string;
  diaperType: "" | "poop" | "pee" | "mixed";
  notes: string;
}>;

export type HealthTrackerDraft = DraftBase<"health"> & Readonly<{
  recordType: "" | "vaccination" | "illness" | "checkup";
  title: string;
  description: string;
}>;

export interface TrackerEditorDraftByDomain {
  readonly growth: GrowthTrackerDraft;
  readonly feeding: FeedingTrackerDraft;
  readonly sleep: SleepTrackerDraft;
  readonly diaper: DiaperTrackerDraft;
  readonly health: HealthTrackerDraft;
}

export type TrackerEditorDraft = TrackerEditorDraftByDomain[TrackerDomain];

export type DraftBuildResult<D extends TrackerDomain> =
  | Readonly<{ status: "ready"; draft: TrackerEditorDraftByDomain[D] }>
  | Readonly<{
    status: "invalid";
    field: "timeZone" | "instant";
    reason: "invalid_zone" | "invalid_instant" | "out_of_range";
    error: string;
  }>;

export type DraftInputFailure = Readonly<{
  status: "invalid";
  field: string;
  reason: "required" | "syntax" | "range" | "changed" | "gap" | "fold" | "invalid_zone" | "invalid_value";
  error: string;
}>;

export type DraftConversionResult<T> = Readonly<{ status: "valid"; input: T }> | DraftInputFailure;

const INVALID_TIME_ZONE = "无法确认本机时区，暂不能显示或编辑这类记录。";
const CHANGED_TIME_ZONE = "本机时区已变化，请重新打开记录后再保存。";
const INSTANT_TOO_EARLY = "本机时间仅支持 2000-01-01 及之后的日期。";
const INSTANT_OUT_OF_RANGE = "这个本机时间超出可保存范围，请换一个时间。";
const INSTANT_GAP = "这个本机时间不存在（夏令时调整），请换一个时间。";
const INSTANT_FOLD = "这个本机时间对应两个时刻，请换一个时间以避免歧义。";

function invalidBuild(reason: "invalid_zone" | "invalid_instant" | "out_of_range"): DraftBuildResult<never> {
  return Object.freeze({
    status: "invalid",
    field: reason === "invalid_zone" ? "timeZone" : "instant",
    reason,
    error: reason === "invalid_zone" ? INVALID_TIME_ZONE : INSTANT_OUT_OF_RANGE,
  });
}

function invalidInput(
  field: string,
  reason: DraftInputFailure["reason"],
  error: string,
): DraftInputFailure {
  return Object.freeze({ status: "invalid", field, reason, error });
}

function isDraftInputFailure(value: unknown): value is DraftInputFailure {
  return value !== null && typeof value === "object" && "status" in value && value.status === "invalid";
}

function minuteInstant(now: string | Date): string | null {
  if (typeof now === "string" && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(now)) {
    return null;
  }
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(instant.getTime())) return null;
  if (typeof now === "string" && instant.toISOString() !== now) return null;
  instant.setUTCSeconds(0, 0);
  const canonical = instant.toISOString();
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\.000Z$/.test(canonical) ? canonical : null;
}

function localDefault(now: string | Date, zone: string) {
  const instant = minuteInstant(now);
  return instant === null ? Object.freeze({ status: "invalid_instant" as const }) : formatInstantForDeviceZone(instant, zone);
}

function deviceLocalDateDefault(now: string | Date): Readonly<{ status: "formatted"; dateText: string; timeText: "" }> | Readonly<{ status: "invalid_instant" }> {
  const instant = minuteInstant(now);
  if (instant === null) return Object.freeze({ status: "invalid_instant" as const });
  const date = new Date(instant);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return Object.freeze({ status: "formatted" as const, dateText: `${year}-${month}-${day}`, timeText: "" as const });
}

export function createInitialDraft<D extends TrackerDomain>(
  domain: D,
  now: string | Date,
  zone: string,
): DraftBuildResult<D> {
  const local = domain === "growth" || domain === "health"
    ? deviceLocalDateDefault(now)
    : localDefault(now, zone);
  if (local.status !== "formatted") return invalidBuild(local.status) as DraftBuildResult<D>;
  const base = { domain, timeZone: zone, dateText: local.dateText };
  switch (domain) {
    case "growth":
      return Object.freeze({ status: "ready", draft: Object.freeze({
        ...base, domain, weightG: "", heightCm: "", headCm: "", notes: "",
      }) }) as unknown as DraftBuildResult<D>;
    case "feeding":
      return Object.freeze({ status: "ready", draft: Object.freeze({
        ...base, domain, timeText: local.timeText, feedType: "", amountMl: "", durationMin: "", notes: "",
      }) }) as unknown as DraftBuildResult<D>;
    case "sleep":
      return Object.freeze({ status: "ready", draft: Object.freeze({
        ...base, domain, timeText: local.timeText, endDateText: "", endTimeText: "",
        sleepType: "", nightWakings: "0", notes: "",
      }) }) as unknown as DraftBuildResult<D>;
    case "diaper":
      return Object.freeze({ status: "ready", draft: Object.freeze({
        ...base, domain, timeText: local.timeText, diaperType: "", notes: "",
      }) }) as unknown as DraftBuildResult<D>;
    case "health":
      return Object.freeze({ status: "ready", draft: Object.freeze({
        ...base, domain, recordType: "", title: "", description: "",
      }) }) as unknown as DraftBuildResult<D>;
  }
}

function numberText(value: number | null): string {
  return value === null ? "" : String(value);
}

function textDraft(value: string | null): string {
  return value ?? "";
}

function recordInstantDraft(instant: string, zone: string): DraftBuildResult<never> | Readonly<{ dateText: string; timeText: string }> {
  const local = formatInstantForDeviceZone(instant, zone);
  return local.status === "formatted" ? Object.freeze({ dateText: local.dateText, timeText: local.timeText }) : invalidBuild(local.status);
}

export function recordToEditorDraft<D extends TrackerDomain>(
  domain: D,
  record: TrackerRecordByDomain[D],
  zone: string,
): DraftBuildResult<D> {
  switch (domain) {
    case "growth": {
      const value = record as TrackerRecordByDomain["growth"];
      return Object.freeze({ status: "ready", draft: Object.freeze({
        domain, timeZone: zone, dateText: value.measurementDate,
        weightG: numberText(value.weightG), heightCm: numberText(value.heightCm), headCm: numberText(value.headCm),
        notes: textDraft(value.notes),
      }) }) as unknown as DraftBuildResult<D>;
    }
    case "feeding": {
      const value = record as TrackerRecordByDomain["feeding"];
      const local = recordInstantDraft(value.feedTime, zone);
      if ("status" in local) return local as DraftBuildResult<D>;
      return Object.freeze({ status: "ready", draft: Object.freeze({
        domain, timeZone: zone, dateText: local.dateText, timeText: local.timeText,
        feedType: value.feedType, amountMl: numberText(value.amountMl), durationMin: numberText(value.durationMin), notes: textDraft(value.notes),
      }) }) as unknown as DraftBuildResult<D>;
    }
    case "sleep": {
      const value = record as TrackerRecordByDomain["sleep"];
      const start = recordInstantDraft(value.sleepStart, zone);
      if ("status" in start) return start as DraftBuildResult<D>;
      const end = value.sleepEnd === null ? null : recordInstantDraft(value.sleepEnd, zone);
      if (end !== null && "status" in end) return end as DraftBuildResult<D>;
      return Object.freeze({ status: "ready", draft: Object.freeze({
        domain, timeZone: zone, dateText: start.dateText, timeText: start.timeText,
        endDateText: end?.dateText ?? "", endTimeText: end?.timeText ?? "",
        sleepType: value.sleepType, nightWakings: String(value.nightWakings), notes: textDraft(value.notes),
      }) }) as unknown as DraftBuildResult<D>;
    }
    case "diaper": {
      const value = record as TrackerRecordByDomain["diaper"];
      const local = recordInstantDraft(value.diaperTime, zone);
      if ("status" in local) return local as DraftBuildResult<D>;
      return Object.freeze({ status: "ready", draft: Object.freeze({
        domain, timeZone: zone, dateText: local.dateText, timeText: local.timeText,
        diaperType: value.diaperType, notes: textDraft(value.notes),
      }) }) as unknown as DraftBuildResult<D>;
    }
    case "health": {
      const value = record as TrackerRecordByDomain["health"];
      return Object.freeze({ status: "ready", draft: Object.freeze({
        domain, timeZone: zone, dateText: value.recordDate, recordType: value.recordType,
        title: value.title, description: textDraft(value.description),
      }) }) as unknown as DraftBuildResult<D>;
    }
  }
}

function optionalInteger(text: string, field: string, label: string): number | null | DraftInputFailure {
  if (text === "") return null;
  const result = parseStrictIntegerText(text);
  return result.status === "valid" ? result.value : invalidInput(field, result.reason, `${label}需要填写不带符号的整数。`);
}

function requiredInteger(text: string, field: string, label: string): number | DraftInputFailure {
  if (text === "") return invalidInput(field, "required", `${label}需要填写。`);
  return optionalInteger(text, field, label) as number | DraftInputFailure;
}

function optionalDecimal(text: string, field: string, label: string): number | null | DraftInputFailure {
  if (text === "") return null;
  const result = parseStrictDecimalText(text);
  return result.status === "valid" ? result.value : invalidInput(field, result.reason, `${label}需要填写不带符号的数字。`);
}

function strictDate(text: string, field: string, label: string): string | DraftInputFailure {
  const result = parseStrictTrackerDate(text);
  return result.status === "valid" ? result.value.iso : invalidInput(field, result.reason, `${label}需要使用 YYYY-MM-DD 格式。`);
}

function localInstant(
  dateText: string,
  timeText: string,
  capturedZone: string,
  currentZone: string,
  field: string,
  baselineInstant: string | null,
): string | DraftInputFailure {
  if (currentZone !== capturedZone) return invalidInput("timeZone", "changed", CHANGED_TIME_ZONE);
  if (baselineInstant !== null) {
    const formatted = formatInstantForDeviceZone(baselineInstant, capturedZone);
    if (
      formatted.status === "formatted"
      && formatted.dateText === dateText
      && formatted.timeText === timeText
    ) return baselineInstant;
  }
  const resolution = resolveLocalMinute(dateText, timeText, capturedZone);
  switch (resolution.status) {
    case "unique": return resolution.instant;
    case "invalid_date":
      return invalidInput(field, "syntax", "日期需要使用 YYYY-MM-DD 格式。");
    case "invalid_time": return invalidInput(field, "syntax", "时间需要使用 HH:mm 格式。");
    case "invalid_zone": return invalidInput("timeZone", "invalid_zone", INVALID_TIME_ZONE);
    case "out_of_range": return invalidInput(field, "range", dateText < "2000-01-01" ? INSTANT_TOO_EARLY : INSTANT_OUT_OF_RANGE);
    case "gap": return invalidInput(field, "gap", INSTANT_GAP);
    case "fold": return invalidInput(field, "fold", INSTANT_FOLD);
  }
}

const TRACKER_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  measurementDate: "测量日期", weightG: "体重（克）", heightCm: "身长（厘米）", headCm: "头围（厘米）",
  measurements: "生长数据", feedTime: "喂养时间", feedType: "喂养类型", amountMl: "量（毫升）", durationMin: "时长（分钟）",
  sleepStart: "开始时间", sleepEnd: "结束时间", sleepType: "睡眠类型", nightWakings: "夜醒次数",
  diaperTime: "记录时间", diaperType: "类型", recordDate: "记录日期", recordType: "健康记录类型",
  title: "标题", notes: "备注", description: "说明",
});

function validationFailure(error: unknown): DraftInputFailure {
  if (!(error instanceof TrackerValidationError)) {
    return invalidInput("form", "invalid_value", "请检查标出的内容后再保存。");
  }
  const exactMessages: Readonly<Record<string, string>> = Object.freeze({
    measurements: "体重、身长、头围请至少填写一项。",
    amountMl: "配方奶需要填写量。",
    durationMin: "母乳需要填写时长。",
    sleepEnd: "结束时间需要晚于开始时间。",
    title: "标题需要填写，且最多 200 个字符。",
  });
  const label = TRACKER_FIELD_LABELS[error.field];
  return label === undefined
    ? invalidInput("form", "invalid_value", "请检查标出的内容后再保存。")
    : invalidInput(error.field, "range", exactMessages[error.field] ?? `${label}超出可填写范围。`);
}

function parseDraftValues<D extends TrackerDomain>(
  domain: D,
  draft: TrackerEditorDraftByDomain[D],
  currentZone: string,
  baseline: TrackerValuesByDomain[D] | null,
): TrackerValuesByDomain[D] | DraftInputFailure {
  switch (domain) {
    case "growth": {
      const value = draft as GrowthTrackerDraft;
      const measurementDate = strictDate(value.dateText, "measurementDate", "测量日期");
      if (typeof measurementDate !== "string") return measurementDate;
      const weightG = optionalInteger(value.weightG, "weightG", "体重"); if (isDraftInputFailure(weightG)) return weightG;
      const heightCm = optionalDecimal(value.heightCm, "heightCm", "身长"); if (isDraftInputFailure(heightCm)) return heightCm;
      const headCm = optionalDecimal(value.headCm, "headCm", "头围"); if (isDraftInputFailure(headCm)) return headCm;
      const original = baseline as TrackerValuesByDomain["growth"] | null;
      return {
        measurementDate, weightG, heightCm, headCm,
        weightPercentile: original?.weightPercentile ?? null,
        heightPercentile: original?.heightPercentile ?? null,
        headPercentile: original?.headPercentile ?? null,
        notes: value.notes === "" ? null : value.notes,
      } as TrackerValuesByDomain[D];
    }
    case "feeding": {
      const value = draft as FeedingTrackerDraft;
      const feedTime = localInstant(
        value.dateText,
        value.timeText,
        value.timeZone,
        currentZone,
        "feedTime",
        (baseline as TrackerValuesByDomain["feeding"] | null)?.feedTime ?? null,
      );
      if (typeof feedTime !== "string") return feedTime;
      if (value.feedType === "") return invalidInput("feedType", "required", "请选择母乳、配方奶或辅食。");
      const amountMl = optionalInteger(value.amountMl, "amountMl", "量"); if (isDraftInputFailure(amountMl)) return amountMl;
      const durationMin = optionalInteger(value.durationMin, "durationMin", "时长"); if (isDraftInputFailure(durationMin)) return durationMin;
      if (value.feedType === "formula" && amountMl === null) return invalidInput("amountMl", "required", "配方奶需要填写量。");
      if (value.feedType === "breast" && durationMin === null) return invalidInput("durationMin", "required", "母乳需要填写时长。");
      return { feedTime, feedType: value.feedType, amountMl, durationMin, notes: value.notes === "" ? null : value.notes } as TrackerValuesByDomain[D];
    }
    case "sleep": {
      const value = draft as SleepTrackerDraft;
      const sleepStart = localInstant(
        value.dateText,
        value.timeText,
        value.timeZone,
        currentZone,
        "sleepStart",
        (baseline as TrackerValuesByDomain["sleep"] | null)?.sleepStart ?? null,
      );
      if (typeof sleepStart !== "string") return sleepStart;
      if ((value.endDateText === "") !== (value.endTimeText === "")) {
        return invalidInput("sleepEnd", "required", "结束日期和结束时间需要一起填写。");
      }
      const sleepEnd = value.endDateText === "" ? null : localInstant(
        value.endDateText,
        value.endTimeText,
        value.timeZone,
        currentZone,
        "sleepEnd",
        (baseline as TrackerValuesByDomain["sleep"] | null)?.sleepEnd ?? null,
      );
      if (isDraftInputFailure(sleepEnd)) return sleepEnd;
      if (sleepEnd !== null && sleepEnd <= sleepStart) return invalidInput("sleepEnd", "range", "结束时间需要晚于开始时间。");
      if (value.sleepType === "") return invalidInput("sleepType", "required", "请选择小睡或夜间睡眠。");
      const nightWakings = value.sleepType === "nap" ? 0 : requiredInteger(value.nightWakings, "nightWakings", "夜醒次数");
      if (isDraftInputFailure(nightWakings)) return nightWakings;
      return { sleepStart, sleepEnd, sleepType: value.sleepType, nightWakings, notes: value.notes === "" ? null : value.notes } as TrackerValuesByDomain[D];
    }
    case "diaper": {
      const value = draft as DiaperTrackerDraft;
      const diaperTime = localInstant(
        value.dateText,
        value.timeText,
        value.timeZone,
        currentZone,
        "diaperTime",
        (baseline as TrackerValuesByDomain["diaper"] | null)?.diaperTime ?? null,
      );
      if (typeof diaperTime !== "string") return diaperTime;
      if (value.diaperType === "") return invalidInput("diaperType", "required", "请选择大便、小便或混合。");
      return { diaperTime, diaperType: value.diaperType, notes: value.notes === "" ? null : value.notes } as TrackerValuesByDomain[D];
    }
    case "health": {
      const value = draft as HealthTrackerDraft;
      const recordDate = strictDate(value.dateText, "recordDate", "记录日期");
      if (typeof recordDate !== "string") return recordDate;
      if (value.recordType === "") return invalidInput("recordType", "required", "请选择疫苗接种、身体不适或常规检查。");
      return { recordDate, recordType: value.recordType, title: value.title, description: value.description === "" ? null : value.description } as TrackerValuesByDomain[D];
    }
  }
}

export function parseDraftToCreateInput<D extends TrackerDomain>(
  domain: D,
  draft: TrackerEditorDraftByDomain[D],
  currentZone: string,
): DraftConversionResult<TrackerCreateInputByDomain[D]> {
  const values = parseDraftValues(domain, draft, currentZone, null);
  if (isDraftInputFailure(values)) return values;
  const createValues = domain === "growth"
    ? { ...values, weightPercentile: null, heightPercentile: null, headPercentile: null }
    : values;
  const withCreateMetadata = { ...createValues, sourceMessageId: null } as TrackerCreateInputByDomain[D];
  try {
    return Object.freeze({ status: "valid", input: normalizeTrackerCreateInput(domain, withCreateMetadata) });
  } catch (error) {
    return validationFailure(error);
  }
}

export function parseDraftToUpdateInput<D extends TrackerDomain>(
  domain: D,
  draft: TrackerEditorDraftByDomain[D],
  baseline: TrackerRecordByDomain[D],
  currentZone: string,
): DraftConversionResult<TrackerUpdateInputByDomain[D]> {
  const values = parseDraftValues(domain, draft, currentZone, baseline);
  if (isDraftInputFailure(values)) return values;
  try {
    return Object.freeze({ status: "valid", input: normalizeTrackerUpdateInput(domain, values as TrackerUpdateInputByDomain[D]) });
  } catch (error) {
    return validationFailure(error);
  }
}

function equal(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

export function areVisibleTrackerValuesEqual<D extends TrackerDomain>(
  domain: D,
  left: TrackerValuesByDomain[D],
  right: TrackerValuesByDomain[D],
): boolean {
  switch (domain) {
    case "growth": {
      const a = left as TrackerValuesByDomain["growth"]; const b = right as TrackerValuesByDomain["growth"];
      return equal(a.measurementDate, b.measurementDate) && equal(a.weightG, b.weightG) && equal(a.heightCm, b.heightCm)
        && equal(a.headCm, b.headCm) && equal(a.notes, b.notes);
    }
    case "feeding": {
      const a = left as TrackerValuesByDomain["feeding"]; const b = right as TrackerValuesByDomain["feeding"];
      return equal(a.feedTime, b.feedTime) && equal(a.feedType, b.feedType) && equal(a.amountMl, b.amountMl)
        && equal(a.durationMin, b.durationMin) && equal(a.notes, b.notes);
    }
    case "sleep": {
      const a = left as TrackerValuesByDomain["sleep"]; const b = right as TrackerValuesByDomain["sleep"];
      return equal(a.sleepStart, b.sleepStart) && equal(a.sleepEnd, b.sleepEnd) && equal(a.sleepType, b.sleepType)
        && equal(a.nightWakings, b.nightWakings) && equal(a.notes, b.notes);
    }
    case "diaper": {
      const a = left as TrackerValuesByDomain["diaper"]; const b = right as TrackerValuesByDomain["diaper"];
      return equal(a.diaperTime, b.diaperTime) && equal(a.diaperType, b.diaperType) && equal(a.notes, b.notes);
    }
    case "health": {
      const a = left as TrackerValuesByDomain["health"]; const b = right as TrackerValuesByDomain["health"];
      return equal(a.recordDate, b.recordDate) && equal(a.recordType, b.recordType) && equal(a.title, b.title)
        && equal(a.description, b.description);
    }
  }
}

export function isNormalizedUpdateNoop<D extends TrackerDomain>(
  domain: D,
  baseline: TrackerValuesByDomain[D],
  normalized: TrackerUpdateInputByDomain[D],
): boolean {
  return areVisibleTrackerValuesEqual(domain, baseline, normalized);
}

function visibleDraftValues(domain: TrackerDomain, draft: TrackerEditorDraft): readonly unknown[] {
  switch (domain) {
    case "growth": {
      const value = draft as GrowthTrackerDraft;
      return [value.dateText, value.weightG, value.heightCm, value.headCm, value.notes];
    }
    case "feeding": {
      const value = draft as FeedingTrackerDraft;
      return [value.dateText, value.timeText, value.feedType, value.amountMl, value.durationMin, value.notes];
    }
    case "sleep": {
      const value = draft as SleepTrackerDraft;
      return [value.dateText, value.timeText, value.endDateText, value.endTimeText, value.sleepType, value.nightWakings, value.notes];
    }
    case "diaper": {
      const value = draft as DiaperTrackerDraft;
      return [value.dateText, value.timeText, value.diaperType, value.notes];
    }
    case "health": {
      const value = draft as HealthTrackerDraft;
      return [value.dateText, value.recordType, value.title, value.description];
    }
  }
}

export function isDraftDirty<D extends TrackerDomain>(
  domain: D,
  draft: TrackerEditorDraftByDomain[D],
  baseline: TrackerEditorDraftByDomain[D],
): boolean {
  const current = visibleDraftValues(domain, draft);
  const original = visibleDraftValues(domain, baseline);
  return current.some((value, index) => !equal(value, original[index]));
}
