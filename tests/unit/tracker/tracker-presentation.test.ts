import assert from "node:assert/strict";
import test from "node:test";

import type { TrackerRecordByDomain } from "../../../src/domain/tracker/types.ts";
import {
  formatTrackerConfirmationFields,
  formatTrackerRecordSummary,
  formatTrackerUpdateDiffs,
} from "../../../src/features/tracker/trackerPresentation.ts";

const metadata = { id: "secret-id", sourceMessageId: "message-secret", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T01:00:00.000Z" };
const records = {
  growth: { ...metadata, measurementDate: "2026-07-02", weightG: 7200, heightCm: 68.5, headCm: 43.2, weightPercentile: 0, heightPercentile: 50, headPercentile: 60, notes: "full private note" },
  feeding: { ...metadata, feedTime: "2026-07-20T00:10:00.000Z", feedType: "formula", amountMl: 0, durationMin: 12, notes: "note" },
  sleep: { ...metadata, sleepStart: "2026-07-20T01:00:00.000Z", sleepEnd: null, sleepType: "night", nightWakings: 2, notes: "note" },
  diaper: { ...metadata, diaperTime: "2026-07-20T03:00:00.000Z", diaperType: "mixed", notes: null },
  health: { ...metadata, recordDate: "2026-07-03", recordType: "checkup", title: "常规检查", description: "full private description" },
} as const satisfies TrackerRecordByDomain;

test("all five row summaries use stable Chinese formats without technical or private fields", () => {
  assert.deepEqual(formatTrackerRecordSummary("growth", records.growth, "Asia/Shanghai"), { status: "formatted", primary: "2026年7月2日", secondary: "体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米 · 有备注", accessibilityLabel: "2026年7月2日，体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米 · 有备注" });
  assert.deepEqual(formatTrackerRecordSummary("feeding", records.feeding, "Asia/Shanghai"), { status: "formatted", primary: "2026年7月20日 08:10（本机时间）", secondary: "配方奶 · 量 0 毫升 · 时长 12 分钟 · 有备注", accessibilityLabel: "2026年7月20日 08:10（本机时间），配方奶 · 量 0 毫升 · 时长 12 分钟 · 有备注" });
  assert.deepEqual(formatTrackerRecordSummary("sleep", records.sleep, "Asia/Shanghai"), { status: "formatted", primary: "2026年7月20日 09:00（本机时间）", secondary: "夜间睡眠 · 尚未填写结束时间 · 夜醒 2 次 · 有备注", accessibilityLabel: "2026年7月20日 09:00（本机时间），夜间睡眠 · 尚未填写结束时间 · 夜醒 2 次 · 有备注" });
  assert.deepEqual(formatTrackerRecordSummary("diaper", records.diaper, "Asia/Shanghai"), { status: "formatted", primary: "2026年7月20日 11:00（本机时间）", secondary: "混合", accessibilityLabel: "2026年7月20日 11:00（本机时间），混合" });
  assert.deepEqual(formatTrackerRecordSummary("health", records.health, "Asia/Shanghai"), { status: "formatted", primary: "2026年7月3日", secondary: "常规检查 · 常规检查 · 有说明", accessibilityLabel: "2026年7月3日，常规检查 · 常规检查 · 有说明" });
  const serialized = JSON.stringify(Object.values(records).map((record, index) => formatTrackerRecordSummary((["growth", "feeding", "sleep", "diaper", "health"] as const)[index]!, record as never, "Asia/Shanghai")));
  for (const forbidden of ["secret-id", "message-secret", "full private note", "full private description", "Percentile", "2026-07-20T"])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("sleep end wording and all enum labels are exact", () => {
  const ended = formatTrackerRecordSummary("sleep", { ...records.sleep, sleepType: "nap", sleepEnd: "2026-07-20T02:00:00.000Z", nightWakings: 0, notes: null }, "Asia/Shanghai");
  assert.equal(ended.status, "formatted");
  if (ended.status === "formatted") assert.equal(ended.secondary, "小睡 · 至 2026年7月20日 10:00（本机时间）");
  const variants = [
    [formatTrackerRecordSummary("feeding", { ...records.feeding, feedType: "breast" }, "UTC"), "母乳 · 量 0 毫升 · 时长 12 分钟 · 有备注"],
    [formatTrackerRecordSummary("feeding", { ...records.feeding, feedType: "solid" }, "UTC"), "辅食 · 量 0 毫升 · 时长 12 分钟 · 有备注"],
    [formatTrackerRecordSummary("diaper", { ...records.diaper, diaperType: "poop" }, "UTC"), "大便"],
    [formatTrackerRecordSummary("diaper", { ...records.diaper, diaperType: "pee" }, "UTC"), "小便"],
    [formatTrackerRecordSummary("health", { ...records.health, recordType: "vaccination" }, "UTC"), "疫苗接种 · 常规检查 · 有说明"],
    [formatTrackerRecordSummary("health", { ...records.health, recordType: "illness" }, "UTC"), "身体不适 · 常规检查 · 有说明"],
  ] as const;
  for (const [result, expected] of variants) {
    assert.equal(result.status, "formatted");
    if (result.status === "formatted") assert.equal(result.secondary, expected);
  }
});

test("date-only years stay four-digit and arbitrary canonical seconds display by local minute", () => {
  const growth = formatTrackerRecordSummary("growth", { ...records.growth, measurementDate: "0001-01-01" }, "UTC");
  assert.equal(growth.status, "formatted");
  if (growth.status === "formatted") assert.equal(growth.primary, "0001年1月1日");
  const feeding = formatTrackerRecordSummary("feeding", { ...records.feeding, feedTime: "1999-12-31T10:00:37.456Z" }, "UTC");
  assert.equal(feeding.status, "formatted");
  if (feeding.status === "formatted") assert.equal(feeding.primary, "1999年12月31日 10:00（本机时间）");
  const shifted = formatTrackerRecordSummary("feeding", { ...records.feeding, feedTime: "1999-12-31T10:00:37.456Z" }, "Pacific/Kiritimati");
  assert.equal(shifted.status, "formatted");
  if (shifted.status === "formatted") assert.equal(shifted.primary, "2000年1月1日 00:00（本机时间）");
});

test("confirmation fields use full visible values, stable order, units, and 未填写", () => {
  const growth = formatTrackerConfirmationFields("growth", records.growth, "UTC");
  assert.deepEqual(growth, { status: "formatted", fields: [
    { label: "测量日期", value: "2026年7月2日" }, { label: "体重（克）", value: "7200 克" },
    { label: "身长（厘米）", value: "68.5 厘米" }, { label: "头围（厘米）", value: "43.2 厘米" },
    { label: "备注", value: "full private note" },
  ] });
  const sleep = formatTrackerConfirmationFields("sleep", records.sleep, "Asia/Shanghai");
  assert.deepEqual(sleep, { status: "formatted", fields: [
    { label: "开始时间", value: "2026年7月20日 09:00（本机时间）" }, { label: "结束时间", value: "未填写" },
    { label: "睡眠类型", value: "夜间睡眠" }, { label: "夜醒次数", value: "2 次" }, { label: "备注", value: "note" },
  ] });
  const diaper = formatTrackerConfirmationFields("diaper", records.diaper, "Asia/Shanghai");
  assert.deepEqual(diaper, { status: "formatted", fields: [
    { label: "记录时间", value: "2026年7月20日 11:00（本机时间）" }, { label: "类型", value: "混合" }, { label: "备注", value: "未填写" },
  ] });
  assert.deepEqual(formatTrackerConfirmationFields("feeding", records.feeding, "Asia/Shanghai"), { status: "formatted", fields: [
    { label: "喂养时间", value: "2026年7月20日 08:10（本机时间）" }, { label: "喂养类型", value: "配方奶" },
    { label: "量（毫升）", value: "0 毫升" }, { label: "时长（分钟）", value: "12 分钟" }, { label: "备注", value: "note" },
  ] });
  assert.deepEqual(formatTrackerConfirmationFields("health", records.health, "UTC"), { status: "formatted", fields: [
    { label: "记录日期", value: "2026年7月3日" }, { label: "健康记录类型", value: "常规检查" },
    { label: "标题", value: "常规检查" }, { label: "说明", value: "full private description" },
  ] });
  assert.equal(JSON.stringify(growth).includes("Percentile"), false);
});

test("update diffs include only changed visible fields in stable order", () => {
  const growth = formatTrackerUpdateDiffs("growth", records.growth, { ...records.growth, weightG: 7300, headCm: null, weightPercentile: 99 }, "UTC");
  assert.deepEqual(growth, { status: "formatted", diffs: [
    { label: "体重（克）", previousValue: "7200 克", nextValue: "7300 克" },
    { label: "头围（厘米）", previousValue: "43.2 厘米", nextValue: "未填写" },
  ] });
  const health = formatTrackerUpdateDiffs("health", records.health, { ...records.health, title: "复查", description: null }, "UTC");
  assert.deepEqual(health, { status: "formatted", diffs: [
    { label: "标题", previousValue: "常规检查", nextValue: "复查" },
    { label: "说明", previousValue: "full private description", nextValue: "未填写" },
  ] });
  assert.deepEqual(formatTrackerUpdateDiffs("feeding", records.feeding, { ...records.feeding, feedType: "solid", amountMl: null, notes: null }, "UTC"), { status: "formatted", diffs: [
    { label: "喂养类型", previousValue: "配方奶", nextValue: "辅食" },
    { label: "量（毫升）", previousValue: "0 毫升", nextValue: "未填写" },
    { label: "备注", previousValue: "note", nextValue: "未填写" },
  ] });
  assert.deepEqual(formatTrackerUpdateDiffs("sleep", records.sleep, { ...records.sleep, sleepType: "nap", nightWakings: 0, notes: null }, "UTC"), { status: "formatted", diffs: [
    { label: "睡眠类型", previousValue: "夜间睡眠", nextValue: "小睡" },
    { label: "夜醒次数", previousValue: "2 次", nextValue: "0 次" },
    { label: "备注", previousValue: "note", nextValue: "未填写" },
  ] });
  assert.deepEqual(formatTrackerUpdateDiffs("diaper", records.diaper, { ...records.diaper, diaperType: "pee", notes: "说明" }, "UTC"), { status: "formatted", diffs: [
    { label: "类型", previousValue: "混合", nextValue: "小便" },
    { label: "备注", previousValue: "未填写", nextValue: "说明" },
  ] });
});

test("presentation fails closed instead of exposing raw UTC for bad zone or instant", () => {
  assert.equal(formatTrackerRecordSummary("feeding", records.feeding, "bad").status, "invalid");
  assert.equal(formatTrackerConfirmationFields("feeding", { ...records.feeding, feedTime: "bad" }, "UTC").status, "invalid");
  assert.equal(formatTrackerUpdateDiffs("feeding", records.feeding, { ...records.feeding, feedTime: "bad" }, "UTC").status, "invalid");
});

test("update diffs ignore hidden instant seconds when formatted visible values are unchanged", () => {
  assert.deepEqual(formatTrackerUpdateDiffs(
    "feeding",
    { ...records.feeding, feedTime: "2026-07-20T00:10:01.001Z" },
    { ...records.feeding, feedTime: "2026-07-20T00:10:59.999Z" },
    "UTC",
  ), { status: "formatted", diffs: [] });
  assert.deepEqual(formatTrackerUpdateDiffs(
    "sleep",
    { ...records.sleep, sleepStart: "2026-07-20T01:00:01.001Z", sleepEnd: "2026-07-20T02:00:01.001Z" },
    { ...records.sleep, sleepStart: "2026-07-20T01:00:59.999Z", sleepEnd: "2026-07-20T02:00:59.999Z" },
    "UTC",
  ), { status: "formatted", diffs: [] });
});
