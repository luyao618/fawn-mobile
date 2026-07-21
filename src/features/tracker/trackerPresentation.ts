import type { TrackerDomain, TrackerValuesByDomain } from "../../domain/tracker/types.ts";
import { formatInstantForDeviceZone, parseStrictTrackerDate } from "./trackerLocalTime.ts";

export type TrackerRecordSummary = Readonly<{
  primary: string;
  secondary: string;
  accessibilityLabel: string;
}>;

export type TrackerConfirmationField = Readonly<{ label: string; value: string }>;
export type TrackerUpdateDiff = Readonly<{
  label: string;
  previousValue: string;
  nextValue: string;
}>;

type PresentationFailure = Readonly<{ status: "invalid"; reason: "invalid_zone" | "invalid_value" }>;
export type TrackerRecordSummaryResult = Readonly<{ status: "formatted" }> & TrackerRecordSummary | PresentationFailure;
export type TrackerConfirmationFieldsResult = Readonly<{
  status: "formatted";
  fields: readonly TrackerConfirmationField[];
}> | PresentationFailure;
export type TrackerUpdateDiffsResult = Readonly<{
  status: "formatted";
  diffs: readonly TrackerUpdateDiff[];
}> | PresentationFailure;

const FEEDING_TYPES = Object.freeze({ breast: "母乳", formula: "配方奶", solid: "辅食" } as const);
const SLEEP_TYPES = Object.freeze({ nap: "小睡", night: "夜间睡眠" } as const);
const DIAPER_TYPES = Object.freeze({ poop: "大便", pee: "小便", mixed: "混合" } as const);
const HEALTH_TYPES = Object.freeze({ vaccination: "疫苗接种", illness: "身体不适", checkup: "常规检查" } as const);
const INVALID_VALUE: PresentationFailure = Object.freeze({ status: "invalid", reason: "invalid_value" });

function invalidZone(): PresentationFailure {
  return Object.freeze({ status: "invalid", reason: "invalid_zone" });
}

function formatDateOnly(value: string): string | null {
  const parsed = parseStrictTrackerDate(value);
  return parsed.status === "valid"
    ? `${String(parsed.value.year).padStart(4, "0")}年${parsed.value.month}月${parsed.value.day}日`
    : null;
}

function formatLocalInstant(value: string, zone: string): string | PresentationFailure {
  const local = formatInstantForDeviceZone(value, zone);
  if (local.status === "invalid_zone") return invalidZone();
  if (local.status !== "formatted") return INVALID_VALUE;
  const date = formatDateOnly(local.dateText);
  return date === null ? INVALID_VALUE : `${date} ${local.timeText}（本机时间）`;
}

function isFailure(value: unknown): value is PresentationFailure {
  return value !== null && typeof value === "object" && "status" in value && value.status === "invalid";
}

function presentOptionalNumber(value: number | null, unit: string): string {
  return value === null ? "未填写" : `${String(value)} ${unit}`;
}

function presentOptionalText(value: string | null): string {
  return value === null ? "未填写" : value;
}

function formattedSummary(primary: string, secondary: string): TrackerRecordSummaryResult {
  return Object.freeze({ status: "formatted", primary, secondary, accessibilityLabel: `${primary}，${secondary}` });
}

export function formatTrackerRecordSummary<D extends TrackerDomain>(
  domain: D,
  values: TrackerValuesByDomain[D],
  zone: string,
): TrackerRecordSummaryResult {
  switch (domain) {
    case "growth": {
      const value = values as TrackerValuesByDomain["growth"];
      const primary = formatDateOnly(value.measurementDate);
      if (primary === null) return INVALID_VALUE;
      const details: string[] = [];
      if (value.weightG !== null) details.push(`体重 ${String(value.weightG)} 克`);
      if (value.heightCm !== null) details.push(`身长 ${String(value.heightCm)} 厘米`);
      if (value.headCm !== null) details.push(`头围 ${String(value.headCm)} 厘米`);
      if (value.notes !== null) details.push("有备注");
      return formattedSummary(primary, details.join(" · "));
    }
    case "feeding": {
      const value = values as TrackerValuesByDomain["feeding"];
      const primary = formatLocalInstant(value.feedTime, zone);
      if (isFailure(primary)) return primary;
      const details: string[] = [FEEDING_TYPES[value.feedType]];
      if (value.amountMl !== null) details.push(`量 ${String(value.amountMl)} 毫升`);
      if (value.durationMin !== null) details.push(`时长 ${String(value.durationMin)} 分钟`);
      if (value.notes !== null) details.push("有备注");
      return formattedSummary(primary, details.join(" · "));
    }
    case "sleep": {
      const value = values as TrackerValuesByDomain["sleep"];
      const primary = formatLocalInstant(value.sleepStart, zone);
      if (isFailure(primary)) return primary;
      const details: string[] = [SLEEP_TYPES[value.sleepType]];
      if (value.sleepEnd === null) {
        details.push("尚未填写结束时间");
      } else {
        const end = formatLocalInstant(value.sleepEnd, zone);
        if (isFailure(end)) return end;
        details.push(`至 ${end}`);
      }
      if (value.sleepType === "night") details.push(`夜醒 ${String(value.nightWakings)} 次`);
      if (value.notes !== null) details.push("有备注");
      return formattedSummary(primary, details.join(" · "));
    }
    case "diaper": {
      const value = values as TrackerValuesByDomain["diaper"];
      const primary = formatLocalInstant(value.diaperTime, zone);
      if (isFailure(primary)) return primary;
      const details: string[] = [DIAPER_TYPES[value.diaperType]];
      if (value.notes !== null) details.push("有备注");
      return formattedSummary(primary, details.join(" · "));
    }
    case "health": {
      const value = values as TrackerValuesByDomain["health"];
      const primary = formatDateOnly(value.recordDate);
      if (primary === null) return INVALID_VALUE;
      const details = [HEALTH_TYPES[value.recordType], value.title];
      if (value.description !== null) details.push("有说明");
      return formattedSummary(primary, details.join(" · "));
    }
  }
}

function field(label: string, value: string): TrackerConfirmationField {
  return Object.freeze({ label, value });
}

function formattedFields(fields: readonly TrackerConfirmationField[]): TrackerConfirmationFieldsResult {
  return Object.freeze({ status: "formatted", fields: Object.freeze(fields) });
}

export function formatTrackerConfirmationFields<D extends TrackerDomain>(
  domain: D,
  values: TrackerValuesByDomain[D],
  zone: string,
): TrackerConfirmationFieldsResult {
  switch (domain) {
    case "growth": {
      const value = values as TrackerValuesByDomain["growth"];
      const date = formatDateOnly(value.measurementDate);
      return date === null ? INVALID_VALUE : formattedFields([
        field("测量日期", date),
        field("体重（克）", presentOptionalNumber(value.weightG, "克")),
        field("身长（厘米）", presentOptionalNumber(value.heightCm, "厘米")),
        field("头围（厘米）", presentOptionalNumber(value.headCm, "厘米")),
        field("备注", presentOptionalText(value.notes)),
      ]);
    }
    case "feeding": {
      const value = values as TrackerValuesByDomain["feeding"];
      const instant = formatLocalInstant(value.feedTime, zone);
      return isFailure(instant) ? instant : formattedFields([
        field("喂养时间", instant),
        field("喂养类型", FEEDING_TYPES[value.feedType]),
        field("量（毫升）", presentOptionalNumber(value.amountMl, "毫升")),
        field("时长（分钟）", presentOptionalNumber(value.durationMin, "分钟")),
        field("备注", presentOptionalText(value.notes)),
      ]);
    }
    case "sleep": {
      const value = values as TrackerValuesByDomain["sleep"];
      const start = formatLocalInstant(value.sleepStart, zone);
      if (isFailure(start)) return start;
      const end = value.sleepEnd === null ? "未填写" : formatLocalInstant(value.sleepEnd, zone);
      if (isFailure(end)) return end;
      return formattedFields([
        field("开始时间", start), field("结束时间", end), field("睡眠类型", SLEEP_TYPES[value.sleepType]),
        field("夜醒次数", `${String(value.nightWakings)} 次`), field("备注", presentOptionalText(value.notes)),
      ]);
    }
    case "diaper": {
      const value = values as TrackerValuesByDomain["diaper"];
      const instant = formatLocalInstant(value.diaperTime, zone);
      return isFailure(instant) ? instant : formattedFields([
        field("记录时间", instant), field("类型", DIAPER_TYPES[value.diaperType]), field("备注", presentOptionalText(value.notes)),
      ]);
    }
    case "health": {
      const value = values as TrackerValuesByDomain["health"];
      const date = formatDateOnly(value.recordDate);
      return date === null ? INVALID_VALUE : formattedFields([
        field("记录日期", date), field("健康记录类型", HEALTH_TYPES[value.recordType]), field("标题", value.title),
        field("说明", presentOptionalText(value.description)),
      ]);
    }
  }
}

function diff(label: string, previousValue: string, nextValue: string): TrackerUpdateDiff {
  return Object.freeze({ label, previousValue, nextValue });
}

function formattedDiffs(diffs: readonly TrackerUpdateDiff[]): TrackerUpdateDiffsResult {
  return Object.freeze({ status: "formatted", diffs: Object.freeze(diffs) });
}

export function formatTrackerUpdateDiffs<D extends TrackerDomain>(
  domain: D,
  baseline: TrackerValuesByDomain[D],
  updated: TrackerValuesByDomain[D],
  zone: string,
): TrackerUpdateDiffsResult {
  const before = formatTrackerConfirmationFields(domain, baseline, zone);
  if (before.status === "invalid") return before;
  const after = formatTrackerConfirmationFields(domain, updated, zone);
  if (after.status === "invalid") return after;
  return formattedDiffs(before.fields.flatMap((item, index) => (
    item.value !== after.fields[index]!.value ? [diff(item.label, item.value, after.fields[index]!.value)] : []
  )));
}
