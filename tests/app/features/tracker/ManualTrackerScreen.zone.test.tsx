import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ManualTrackerConflictError, type ManualTrackerServicePort } from "../../../../src/application/tracker/manualTrackerService";
import type { TrackerDomain, TrackerRecordByDomain } from "../../../../src/domain/tracker/types";
import { ManualTrackerScreen } from "../../../../src/features/tracker/ManualTrackerScreen";
import { ManualTrackerServiceProvider } from "../../../../src/features/tracker/ManualTrackerServiceContext";
import * as trackerLocalTime from "../../../../src/features/tracker/trackerLocalTime";
import * as trackerAccessibility from "../../../../src/features/tracker/trackerAccessibility";
import * as trackerEditorModel from "../../../../src/features/tracker/trackerEditorModel";
import * as trackerScreenState from "../../../../src/features/tracker/trackerScreenState";
import type {
  CreateEditorSnapshot,
  ExactEditableState,
  ListFact,
  TrackerScreenAction,
  TrackerScreenState,
  ZoneBlockedSave,
} from "../../../../src/features/tracker/trackerScreenState";
import { PrimaryAction } from "../../../../src/features/tracker/TrackerFormPrimitives";
import { TrackerDomainSwitcher } from "../../../../src/features/tracker/TrackerDomainSwitcher";

jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  const React = jest.requireActual("react");
  return { ...actual, useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]) };
});

const KATHMANDU = "Asia/Kathmandu";
const INVALID = Object.freeze({ status: "unavailable" as const, reason: "invalid" as const });
const INVALID_COPY = "无法确认本机时区，暂不能显示或编辑这类记录。";
const CHANGED_COPY = "本机时区已变化，请重新打开记录后再保存。";
const metadata = Object.freeze({ sourceMessageId: null, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:01:00.000Z" });
const records = Object.freeze({
  growth: Object.freeze({ ...metadata, id: "growth-id", measurementDate: "2026-07-20", weightG: 7000, heightCm: 68, headCm: null, weightPercentile: 50, heightPercentile: 50, headPercentile: null, notes: "loaded" }),
  feeding: Object.freeze({ ...metadata, id: "feeding-id", feedTime: "2026-07-20T00:10:00.000Z", feedType: "formula", amountMl: 0, durationMin: 15, notes: "loaded" }),
  sleep: Object.freeze({ ...metadata, id: "sleep-id", sleepStart: "2026-07-20T05:00:00.000Z", sleepEnd: null, sleepType: "nap", nightWakings: 0, notes: null }),
  diaper: Object.freeze({ ...metadata, id: "diaper-id", diaperTime: "2026-07-20T01:30:00.000Z", diaperType: "mixed", notes: null }),
  health: Object.freeze({ ...metadata, id: "health-id", recordDate: "2026-07-20", recordType: "checkup", title: "体检", description: "loaded" }),
}) satisfies { readonly [D in TrackerDomain]: TrackerRecordByDomain[D] };

function assertZoneActionTypeBoundaries(
  feedingFact: ListFact<"feeding">,
  sleepFact: ListFact<"sleep">,
  feedingEditor: CreateEditorSnapshot<"feeding">,
  sleepEditor: CreateEditorSnapshot<"sleep">,
) {
  const feedingEditable: ExactEditableState<"feeding"> = { tag: "create.editing", editor: feedingEditor };
  const sleepEditable: ExactEditableState<"sleep"> = { tag: "create.editing", editor: sleepEditor };
  const sleepGetSource = { tag: "list.ready.empty", fact: sleepFact } satisfies TrackerScreenState;
  const feedingBlocked: ZoneBlockedSave<"feeding"> = { tag: "zone.blocked.save", domain: "feeding", source: feedingEditable };
  const sleepBlocked: ZoneBlockedSave<"sleep"> = { tag: "zone.blocked.save", domain: "sleep", source: sleepEditable };
  // @ts-expect-error entry domain and fact domain must stay correlated
  const wrongEntry: TrackerScreenAction = { type: "ZONE_ENTRY_BLOCKED", source: feedingEditable, next: { tag: "zone.blocked.entry", domain: "feeding", intent: { kind: "create", fact: sleepFact } } };
  // @ts-expect-error a valid sleep GET source cannot be paired with a feeding destination fact
  const wrongGetSource = trackerScreenState.zoneGetBlockedAction(sleepGetSource, "feeding-id", feedingFact);
  // @ts-expect-error blocked-save source and destination domains must stay correlated
  const wrongSave: TrackerScreenAction = { type: "ZONE_SAVE_BLOCKED", source: feedingEditable, next: sleepBlocked };
  // @ts-expect-error restored editor must match the blocked source domain
  const wrongRestore: TrackerScreenAction = { type: "ZONE_SAVE_RESTORED", source: feedingBlocked, next: sleepEditable };
  void [wrongEntry, wrongGetSource, wrongSave, wrongRestore];
}
void assertZoneActionTypeBoundaries;

function serviceMock(overrides: Partial<ManualTrackerServicePort> = {}): ManualTrackerServicePort {
  return {
    list: jest.fn(async () => []),
    getById: jest.fn(async () => null),
    create: jest.fn(async () => { throw new Error("unexpected create"); }),
    update: jest.fn(async () => { throw new Error("unexpected update"); }),
    delete: jest.fn(async () => { throw new Error("unexpected delete"); }),
    ...overrides,
  } as ManualTrackerServicePort;
}

function renderTracker(service: ManualTrackerServicePort) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}>
      <ManualTrackerServiceProvider service={service}><ManualTrackerScreen /></ManualTrackerServiceProvider>
    </SafeAreaProvider>,
  );
}

async function enterDomain(label: "喂养" | "睡眠" | "大小便") {
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("tab", { name: label }));
  await screen.findByText(`还没有${label}记录`);
}

function fillFeeding() {
  fireEvent.changeText(screen.getByLabelText("喂养日期"), "2026-07-20");
  fireEvent.changeText(screen.getByLabelText("喂养时间"), "08:10");
  fireEvent.press(screen.getByRole("radio", { name: "喂养类型配方奶" }));
  fireEvent.changeText(screen.getByLabelText("量（毫升）"), "0");
  fireEvent.changeText(screen.getByLabelText("时长（分钟）"), "15");
  fireEvent.changeText(screen.getByLabelText("备注"), "zone notes");
}

function fillSleep() {
  fireEvent.changeText(screen.getByLabelText("开始日期"), "2026-07-20");
  fireEvent.changeText(screen.getByLabelText("开始时间"), "08:10");
  fireEvent.changeText(screen.getByLabelText("结束日期"), "2026-07-20");
  fireEvent.changeText(screen.getByLabelText("结束时间"), "09:40");
  fireEvent.press(screen.getByRole("radio", { name: "睡眠类型夜间睡眠" }));
  fireEvent.changeText(screen.getByLabelText("夜醒次数"), "3");
  fireEvent.changeText(screen.getByLabelText("备注"), "zone notes");
}

function fillDiaper() {
  fireEvent.changeText(screen.getByLabelText("记录日期"), "2026-07-20");
  fireEvent.changeText(screen.getByLabelText("记录时间"), "08:10");
  fireEvent.press(screen.getByRole("radio", { name: "类型混合" }));
  fireEvent.changeText(screen.getByLabelText("备注"), "zone notes");
}

const instantCases = [
  {
    domain: "feeding" as const, label: "喂养" as const, record: records.feeding, dateLabel: "喂养日期", timeLabel: "喂养时间", loadedTime: "05:55", fill: fillFeeding,
    input: { feedTime: "2026-07-20T02:25:00.000Z", feedType: "formula", amountMl: 0, durationMin: 15, notes: "zone notes" },
  },
  {
    domain: "sleep" as const, label: "睡眠" as const, record: records.sleep, dateLabel: "开始日期", timeLabel: "开始时间", loadedTime: "10:45", fill: fillSleep,
    input: { sleepStart: "2026-07-20T02:25:00.000Z", sleepEnd: "2026-07-20T03:55:00.000Z", sleepType: "night", nightWakings: 3, notes: "zone notes" },
  },
  {
    domain: "diaper" as const, label: "大小便" as const, record: records.diaper, dateLabel: "记录日期", timeLabel: "记录时间", loadedTime: "07:15", fill: fillDiaper,
    input: { diaperTime: "2026-07-20T02:25:00.000Z", diaperType: "mixed", notes: "zone notes" },
  },
] as const;

type ServiceCounts = Readonly<Record<"list" | "getById" | "create" | "update" | "delete", number>>;

function serviceCounts(service: ManualTrackerServicePort): ServiceCounts {
  return Object.freeze({
    list: (service.list as jest.Mock).mock.calls.length,
    getById: (service.getById as jest.Mock).mock.calls.length,
    create: (service.create as jest.Mock).mock.calls.length,
    update: (service.update as jest.Mock).mock.calls.length,
    delete: (service.delete as jest.Mock).mock.calls.length,
  });
}

function expectServiceDelta(service: ManualTrackerServicePort, before: ServiceCounts, delta: Partial<ServiceCounts>) {
  const after = serviceCounts(service);
  expect(after).toEqual({
    list: before.list + (delta.list ?? 0),
    getById: before.getById + (delta.getById ?? 0),
    create: before.create + (delta.create ?? 0),
    update: before.update + (delta.update ?? 0),
    delete: before.delete + (delta.delete ?? 0),
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type FocusTargetSnapshot = Readonly<{ current: unknown; label: string }>;
const focusTargetSnapshots = new WeakMap<jest.SpyInstance, FocusTargetSnapshot[]>();

function focusTargetLabel(current: unknown): string {
  const target = current as { props?: { accessibilityLabel?: string; children?: unknown } } | null;
  const label = target?.props?.accessibilityLabel;
  if (typeof label === "string") return label;
  const text = (value: unknown): string => Array.isArray(value)
    ? value.map(text).join("")
    : typeof value === "string" || typeof value === "number" ? String(value) : "";
  return text(target?.props?.children);
}

function recordFocusTargets(): jest.SpyInstance {
  const snapshots: FocusTargetSnapshot[] = [];
  const focus = jest.spyOn(trackerAccessibility, "focusRefIfAvailable").mockImplementation((ref) => {
    const current = ref?.current ?? null;
    snapshots.push(Object.freeze({ current, label: focusTargetLabel(current) }));
  });
  focusTargetSnapshots.set(focus, snapshots);
  return focus;
}

function latestFocusSnapshot(focus: jest.SpyInstance): FocusTargetSnapshot | undefined {
  return focusTargetSnapshots.get(focus)?.at(-1);
}

function focusedLabel(focus: jest.SpyInstance): string {
  return latestFocusSnapshot(focus)?.label ?? "";
}

function latestReducerState(reducer: jest.SpyInstance) {
  return reducer.mock.results.at(-1)?.value as trackerScreenState.TrackerScreenState;
}

function expectSameEditorIdentities(
  before: trackerScreenState.AnyEditorSnapshot,
  after: trackerScreenState.AnyEditorSnapshot,
) {
  expect(after.draft).toBe(before.draft);
  expect(after.initialDraft).toBe(before.initialDraft);
  expect(after.baseline).toBe(before.baseline);
  expect(after.prior).toBe(before.prior);
  expect(after.capturedZone).toBe(before.capturedZone);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-07-20T00:10:00.000Z"));
  jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("captures a valid device zone on instant-domain create/edit entry and keeps that zone fixed for the entire draft", async () => {
  for (const item of instantCases) {
    for (const mode of ["create", "edit"] as const) {
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
      let resolveGet: ((record: TrackerRecordByDomain[typeof item.domain]) => void) | undefined;
      const getPromise = new Promise<TrackerRecordByDomain[typeof item.domain]>((resolve) => { resolveGet = resolve; });
      const getById = jest.fn(() => getPromise);
      const create = jest.fn(() => new Promise(() => undefined));
      const update = jest.fn(() => new Promise(() => undefined));
      const service = serviceMock({
        list: jest.fn(async (domain: TrackerDomain) => domain === item.domain && mode === "edit" ? [item.record] : []) as ManualTrackerServicePort["list"],
        getById: getById as ManualTrackerServicePort["getById"],
        create: create as ManualTrackerServicePort["create"],
        update: update as ManualTrackerServicePort["update"],
      });
      const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
      const view = renderTracker(service);
      await enterDomain(item.label);
      if (mode === "create") {
        fireEvent.press(screen.getByRole("button", { name: `新增${item.label}记录` }));
      } else {
        fireEvent.press(screen.getByRole("button", { name: new RegExp(`${item.label}记录，`) }));
        resolver.mockReturnValue({ status: "available", zone: "UTC" });
        await act(async () => { resolveGet?.(item.record); });
        expect(getById).toHaveBeenCalledWith(item.domain, item.record.id);
      }
      expect(await screen.findByLabelText(item.dateLabel)).toHaveProp("value", "2026-07-20");
      expect(screen.getByLabelText(item.timeLabel)).toHaveProp("value", mode === "create" ? "05:55" : item.loadedTime);
      item.fill();
      const fixedEditor = latestReducerState(reducer);
      if (fixedEditor.tag !== "create.editing" && fixedEditor.tag !== "edit.editing") throw new Error("expected fixed editor");
      expect(fixedEditor.editor.capturedZone).toBe(KATHMANDU);
      resolver.mockReturnValue({ status: "available", zone: "UTC" });
      const changedBefore = serviceCounts(service);
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }));
      const changedEditor = latestReducerState(reducer);
      if (changedEditor.tag !== "create.editing" && changedEditor.tag !== "edit.editing") throw new Error("expected retained editor");
      expectSameEditorIdentities(fixedEditor.editor, changedEditor.editor);
      expect(screen.getByLabelText(item.timeLabel)).toHaveProp("value", "08:10");
      expectServiceDelta(service, changedBefore, {});

      resolver.mockReturnValue({ status: "available", zone: KATHMANDU });
      const matchingBefore = serviceCounts(service);
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }));
      expectServiceDelta(service, matchingBefore, mode === "create" ? { create: 1 } : { update: 1 });
      if (mode === "create") expect(create.mock.calls).toEqual([[item.domain, { ...item.input, sourceMessageId: null }]]);
      else expect(update.mock.calls).toEqual([[item.domain, item.record.id, item.input, item.record.updatedAt]]);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expectServiceDelta(service, matchingBefore, mode === "create" ? { create: 1 } : { update: 1 });
      view.unmount();
    }
  }

  for (const domain of ["growth", "health"] as const) {
    for (const mode of ["create", "edit"] as const) {
      jest.restoreAllMocks();
      const label = domain === "growth" ? "生长" : "健康";
      const create = jest.fn(() => new Promise(() => undefined));
      const update = jest.fn(() => new Promise(() => undefined));
      const service = serviceMock({
        list: jest.fn(async (requested: TrackerDomain) => requested === domain && mode === "edit" ? [records[domain]] : []) as ManualTrackerServicePort["list"],
        getById: jest.fn(async () => records[domain]) as ManualTrackerServicePort["getById"],
        create: create as ManualTrackerServicePort["create"],
        update: update as ManualTrackerServicePort["update"],
      });
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue(INVALID);
      const view = renderTracker(service);
      if (domain === "health") {
        await screen.findByText("还没有生长记录");
        fireEvent.press(screen.getByRole("tab", { name: label }));
      }
      if (mode === "create") {
        await screen.findByText(`还没有${label}记录`);
        fireEvent.press(screen.getByRole("button", { name: `新增${label}记录` }));
        if (domain === "growth") fireEvent.changeText(screen.getByLabelText("体重（克）"), "7000");
        else {
          fireEvent.press(screen.getByRole("radio", { name: "健康记录类型身体不适" }));
          fireEvent.changeText(screen.getByLabelText("标题"), "轻微咳嗽");
        }
      } else {
        fireEvent.press(await screen.findByRole("button", { name: new RegExp(`${label}记录，`) }));
        await screen.findByRole("header", { name: `编辑${label}记录` });
        if (domain === "growth") fireEvent.changeText(screen.getByLabelText("备注"), "changed");
        else fireEvent.changeText(screen.getByLabelText("标题"), "复查");
      }
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${label}记录` : "保存修改" }));
      expect(resolver).not.toHaveBeenCalled();
      expect(service.list).toHaveBeenCalledWith(domain, 100);
      if (mode === "edit") expect(service.getById).toHaveBeenCalledWith(domain, records[domain].id);
      expect(mode === "create" ? create : update).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  }
});

test("rechecks the current device zone immediately before save and submits once when it still matches", async () => {
  for (const item of instantCases) {
    for (const mode of ["create", "edit"] as const) {
      const order: string[] = [];
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockImplementation(() => {
        order.push("zone");
        return { status: "available", zone: KATHMANDU };
      });
      const create = jest.fn(() => { order.push("create"); return new Promise(() => undefined); });
      const update = jest.fn(() => { order.push("update"); return new Promise(() => undefined); });
      const service = serviceMock({
        list: jest.fn(async (domain: TrackerDomain) => domain === item.domain && mode === "edit" ? [item.record] : []) as ManualTrackerServicePort["list"],
        getById: jest.fn(async () => item.record) as ManualTrackerServicePort["getById"],
        create: create as ManualTrackerServicePort["create"], update: update as ManualTrackerServicePort["update"],
      });
      const view = renderTracker(service);
      await enterDomain(item.label);
      if (mode === "create") fireEvent.press(screen.getByRole("button", { name: `新增${item.label}记录` }));
      else fireEvent.press(screen.getByRole("button", { name: new RegExp(`${item.label}记录，`) }));
      await screen.findByRole("header", { name: `${mode === "create" ? "新增" : "编辑"}${item.label}记录` });
      item.fill();
      const beforeServices = serviceCounts(service);
      const before = resolver.mock.calls.length;
      order.length = 0;
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }));
      expect(resolver.mock.calls.length - before).toBe(1);
      expect(order).toEqual(["zone", mode === "create" ? "create" : "update"]);
      expectServiceDelta(service, beforeServices, mode === "create" ? { create: 1 } : { update: 1 });
      if (mode === "create") {
        expect(create).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith(item.domain, { ...item.input, sourceMessageId: null });
        expect(update).not.toHaveBeenCalled();
      } else {
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(item.domain, item.record.id, item.input, item.record.updatedAt);
        expect(create).not.toHaveBeenCalled();
      }
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expectServiceDelta(service, beforeServices, mode === "create" ? { create: 1 } : { update: 1 });
      view.unmount();
    }
  }
});

test("blocks save after a device-zone change, retains every draft field, and performs zero service mutations", async () => {
  for (const item of instantCases) {
    for (const mode of ["create", "edit"] as const) {
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
      const service = serviceMock({
        list: jest.fn(async (domain: TrackerDomain) => domain === item.domain && mode === "edit" ? [item.record] : []) as ManualTrackerServicePort["list"],
        getById: jest.fn(async () => item.record) as ManualTrackerServicePort["getById"],
      });
      const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
      const focus = recordFocusTargets();
      const view = renderTracker(service);
      await enterDomain(item.label);
      const priorState = latestReducerState(reducer);
      if (priorState.tag !== "list.ready.empty" && priorState.tag !== "list.ready.rows") throw new Error("expected prior list");
      if (mode === "create") fireEvent.press(screen.getByRole("button", { name: `新增${item.label}记录` }));
      else fireEvent.press(screen.getByRole("button", { name: new RegExp(`${item.label}记录，`) }));
      await screen.findByRole("header", { name: `${mode === "create" ? "新增" : "编辑"}${item.label}记录` });
      item.fill();
      const editable = latestReducerState(reducer);
      if (editable.tag !== "create.editing" && editable.tag !== "edit.editing") throw new Error("expected editor");
      resolver.mockReturnValue({ status: "available", zone: "UTC" });
      const before = serviceCounts(service);
      const zoneBefore = resolver.mock.calls.length;
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }));
      expect(resolver).toHaveBeenCalledTimes(zoneBefore + 1);
      expectServiceDelta(service, before, {});
      const changed = latestReducerState(reducer);
      if (changed.tag !== "create.editing" && changed.tag !== "edit.editing") throw new Error("expected changed editor");
      expectSameEditorIdentities(editable.editor, changed.editor);
      const alert = screen.getByText(CHANGED_COPY);
      expect(alert.props).toMatchObject({ accessibilityRole: "alert", accessibilityLiveRegion: "assertive" });
      expect(screen.getByLabelText(item.timeLabel)).toHaveProp("value", "08:10");
      expect(screen.getByLabelText("备注")).toHaveProp("value", "zone notes");
      expect(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }).props.accessibilityState.disabled).toBe(false);
      expect(screen.queryByRole("button", { name: "重新读取本机时区" })).toBeNull();
      expect(focusedLabel(focus)).toBe(mode === "create" ? `保存${item.label}记录` : "保存修改");
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(service.delete).not.toHaveBeenCalled();

      const destination = mode === "create"
        ? { kind: "back" as const, label: item.label }
        : item.domain === "feeding"
          ? { kind: "domain" as const, label: "睡眠" as const }
          : { kind: "domain" as const, label: "喂养" as const };
      const initiateDiscard = () => fireEvent.press(destination.kind === "back"
        ? screen.getByRole("button", { name: `返回${destination.label}列表` })
        : screen.getByRole("tab", { name: destination.label }));
      initiateDiscard();
      await screen.findByRole("header", { name: "放弃未保存的更改？" });
      const confirmation = latestReducerState(reducer);
      if (confirmation.tag !== "confirm.discard") throw new Error("expected discard confirmation");
      expect(confirmation.decision.prior).toBe(changed);
      const oldAcceptButton = screen.getByRole("button", { name: "放弃更改" });
      const staleAccept = [oldAcceptButton.props.onPress, oldAcceptButton.parent?.props.onPress, oldAcceptButton.parent?.parent?.props.onPress]
        .find((candidate): candidate is () => void => typeof candidate === "function");
      if (staleAccept === undefined) throw new Error("expected stale discard callback");
      fireEvent.press(screen.getByRole("button", { name: "继续编辑" }));
      expect(latestReducerState(reducer)).toBe(changed);
      const staleCounts = serviceCounts(service);
      const staleZoneCount = resolver.mock.calls.length;
      act(() => staleAccept());
      expect(latestReducerState(reducer)).toBe(changed);
      expect(serviceCounts(service)).toEqual(staleCounts);
      expect(resolver).toHaveBeenCalledTimes(staleZoneCount);

      initiateDiscard();
      const secondConfirmation = latestReducerState(reducer);
      if (secondConfirmation.tag !== "confirm.discard") throw new Error("expected second discard confirmation");
      const beforeAccept = serviceCounts(service);
      const zoneBeforeAccept = resolver.mock.calls.length;
      resolver.mockReturnValue(INVALID);
      fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
      expect(resolver).toHaveBeenCalledTimes(zoneBeforeAccept + 1);
      expectServiceDelta(service, beforeAccept, {});
      const blockedDiscard = latestReducerState(reducer);
      if (blockedDiscard.tag !== "zone.blocked.entry") throw new Error("expected accepted discard zone block");
      expect(blockedDiscard.intent.kind).toBe(destination.kind === "back" ? "list-restore" : "list-load");
      if (blockedDiscard.intent.kind === "list-restore") {
        const malformed = {
          type: "ZONE_ENTRY_BLOCKED",
          source: secondConfirmation,
          next: blockedDiscard,
        } as unknown as TrackerScreenAction;
        expect(trackerScreenState.trackerScreenReducer(secondConfirmation, malformed)).toBe(secondConfirmation);
      }
      resolver.mockReturnValue({ status: "available", zone: KATHMANDU });
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      if (destination.kind === "back") {
        expectServiceDelta(service, beforeAccept, { list: 1 });
        await screen.findByText(`还没有${destination.label}记录`);
        const restored = latestReducerState(reducer);
        if (restored.tag !== "list.ready.empty" && restored.tag !== "list.ready.rows") throw new Error("expected restored list");
        expect(restored.fact.rows).toEqual(priorState.fact.rows);
      } else {
        expectServiceDelta(service, beforeAccept, { list: 1 });
        expect((service.list as jest.Mock).mock.calls.at(-1)).toEqual([destination.label === "睡眠" ? "sleep" : "feeding", 100]);
        await screen.findByText(`还没有${destination.label}记录`);
      }
      view.unmount();
    }
  }
});

test("blocks instant-domain list/create/edit when the entry zone is invalid", async () => {
  const cases = [
    ["feeding", "喂养", records.feeding],
    ["sleep", "睡眠", records.sleep],
    ["diaper", "大小便", records.diaper],
  ] as const;
  for (const [domain, label, record] of cases) {
    for (const entry of ["list", "create", "get"] as const) {
      const service = serviceMock({
        list: jest.fn(async (requested: TrackerDomain) => requested === domain && entry === "get" ? [record] : []) as ManualTrackerServicePort["list"],
      });
      const view = renderTracker(service);
      const focus = recordFocusTargets();
      const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
      await screen.findByText("还没有生长记录");
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
      if (entry === "list") {
        resolver.mockReturnValue(INVALID);
        fireEvent.press(screen.getByRole("tab", { name: label }));
        expect(service.list).toHaveBeenCalledTimes(1);
      } else {
        fireEvent.press(screen.getByRole("tab", { name: label }));
        if (entry === "create") await screen.findByText(`还没有${label}记录`);
        else await screen.findByRole("button", { name: new RegExp(`${label}记录，`) });
        resolver.mockReturnValue(INVALID);
        fireEvent.press(entry === "create"
          ? screen.getByRole("button", { name: `新增${label}记录` })
          : screen.getByRole("button", { name: new RegExp(`${label}记录，`) }));
        expect(service.list).toHaveBeenCalledTimes(2);
      }
      const alert = screen.getByText(INVALID_COPY);
      expect(alert.props).toMatchObject({ accessibilityRole: "alert", accessibilityLiveRegion: "assertive" });
      expect(screen.getByRole("button", { name: "重新读取本机时区" })).toBeTruthy();
      expect(screen.getAllByRole("button").filter((button) => button.props.accessibilityState?.disabled !== true).map((button) => button.props.accessibilityLabel)).toEqual(["重新读取本机时区"]);
      expect(focusedLabel(focus)).toBe("本机时区不可用");
      const blocked = latestReducerState(reducer);
      expect(blocked.tag).toBe("zone.blocked.entry");
      if (blocked.tag !== "zone.blocked.entry") throw new Error("expected blocked entry");
      expect(blocked.domain).toBe(domain);
      expect(blocked.intent.kind).toBe(entry === "list" ? "list-load" : entry);
      expect(blocked.intent.fact.domain).toBe(domain);
      if (entry === "get" && blocked.intent.kind === "get") expect(blocked.intent.id).toBe(record.id);
      const blockedActionCall = reducer.mock.calls.find(([, action]) => action.type === "ZONE_ENTRY_BLOCKED");
      if (blockedActionCall === undefined || blockedActionCall[1].type !== "ZONE_ENTRY_BLOCKED") throw new Error("expected blocked action evidence");
      const blockedAction = blockedActionCall[1];
      const wrongFact = Object.freeze({ ...blocked.intent.fact, domain: blocked.domain === "feeding" ? "sleep" as const : "feeding" as const });
      expect(trackerScreenState.trackerScreenReducer(blockedAction.source, {
        ...blockedAction,
        next: Object.freeze({ ...blocked, intent: Object.freeze({ ...blocked.intent, fact: wrongFact }) }),
      } as unknown as trackerScreenState.TrackerScreenAction)).toBe(blockedAction.source);
      expect(service.getById).not.toHaveBeenCalled();
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(service.delete).not.toHaveBeenCalled();
      view.unmount();
    }
  }

  for (const staleKind of ["row", "tab", "list-error"] as const) {
    const list = jest.fn((domain: TrackerDomain) => {
      if (domain === "feeding") return staleKind !== "list-error" ? Promise.resolve([records.feeding]) : Promise.reject(new Error("offline"));
      return Promise.resolve([]);
    });
    const service = serviceMock({ list: list as ManualTrackerServicePort["list"] });
    const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
    const focus = recordFocusTargets();
    const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
    const view = renderTracker(service);
    await screen.findByText("还没有生长记录");
    fireEvent.press(screen.getByRole("tab", { name: "喂养" }));
    if (staleKind === "list-error") await screen.findByText("暂时无法读取喂养记录。本机数据没有更改。");
    if (staleKind === "row" || staleKind === "tab") await screen.findByRole("button", { name: /喂养记录，/ });
    const staleCallback = staleKind === "tab"
      ? (() => {
        const onSelectDomain = view.UNSAFE_getByType(TrackerDomainSwitcher).props.onSelectDomain as (domain: TrackerDomain) => void;
        return () => onSelectDomain("sleep");
      })()
      : (() => {
        const staleControl = staleKind === "row"
          ? screen.getByRole("button", { name: /喂养记录，/ })
          : view.UNSAFE_getByType(PrimaryAction);
        return [staleControl.props.onPress, staleControl.parent?.props.onPress, staleControl.parent?.parent?.props.onPress]
          .find((candidate): candidate is () => void => typeof candidate === "function");
      })();
    if (staleCallback === undefined) throw new Error("expected stale list callback");
    fireEvent.press(screen.getByRole("tab", { name: "生长" }));
    await screen.findByText("还没有生长记录");
    resolver.mockReturnValue(INVALID);
    const stateBefore = latestReducerState(reducer);
    const countsBefore = serviceCounts(service);
    const zoneBefore = resolver.mock.calls.length;
    const focusBefore = focus.mock.calls.length;
    act(() => staleCallback());
    expect({ kind: staleKind, zoneDelta: resolver.mock.calls.length - zoneBefore }).toEqual({ kind: staleKind, zoneDelta: 0 });
    expect(serviceCounts(service)).toEqual(countsBefore);
    expect(latestReducerState(reducer)).toBe(stateBefore);
    expect(focus).toHaveBeenCalledTimes(focusBefore);
    view.unmount();
    jest.restoreAllMocks();
  }
});

test("blocks an instant-domain save when the current-zone recheck becomes invalid", async () => {
  const parseCreate = jest.spyOn(trackerEditorModel, "parseDraftToCreateInput");
  const parseUpdate = jest.spyOn(trackerEditorModel, "parseDraftToUpdateInput");
  const cases = [
    ["feeding", "喂养", records.feeding],
    ["sleep", "睡眠", records.sleep],
    ["diaper", "大小便", records.diaper],
  ] as const;
  for (const [domain, label, record] of cases) {
    const item = instantCases.find((candidate) => candidate.domain === domain);
    if (item === undefined) throw new Error("expected instant fixture");
    for (const mode of ["create", "edit"] as const) {
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
      const service = serviceMock({
        list: jest.fn(async (requested: TrackerDomain) => requested === domain && mode === "edit" ? [record] : []) as ManualTrackerServicePort["list"],
        getById: jest.fn(async () => record) as ManualTrackerServicePort["getById"],
      });
      const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
      const focus = recordFocusTargets();
      const view = renderTracker(service);
      await enterDomain(label);
      const priorState = latestReducerState(reducer);
      if (priorState.tag !== "list.ready.empty" && priorState.tag !== "list.ready.rows") throw new Error("expected prior list");
      if (mode === "create") fireEvent.press(screen.getByRole("button", { name: `新增${label}记录` }));
      else fireEvent.press(screen.getByRole("button", { name: new RegExp(`${label}记录，`) }));
      await screen.findByRole("header", { name: `${mode === "create" ? "新增" : "编辑"}${label}记录` });
      item.fill();
      const editable = latestReducerState(reducer);
      if (editable.tag !== "create.editing" && editable.tag !== "edit.editing") throw new Error("expected editor");
      resolver.mockReturnValue(INVALID);
      const before = serviceCounts(service);
      const zoneBefore = resolver.mock.calls.length;
      const parseCreateBefore = parseCreate.mock.calls.length;
      const parseUpdateBefore = parseUpdate.mock.calls.length;
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${label}记录` : "保存修改" }));
      expect(resolver).toHaveBeenCalledTimes(zoneBefore + 1);
      expectServiceDelta(service, before, {});
      expect(parseCreate).toHaveBeenCalledTimes(parseCreateBefore);
      expect(parseUpdate).toHaveBeenCalledTimes(parseUpdateBefore);
      expect(reducer.mock.calls.slice(-2).some(([, action]) => action.type === "MUTATION_STARTED")).toBe(false);
      expect(screen.getByText(INVALID_COPY).props).toMatchObject({ accessibilityRole: "alert", accessibilityLiveRegion: "assertive" });
      expect(screen.getByRole("button", { name: "重新读取本机时区" })).toBeTruthy();
      expect(screen.getAllByRole("button").filter((button) => button.props.accessibilityState?.disabled !== true).map((button) => button.props.accessibilityLabel)).toEqual(["重新读取本机时区"]);
      expect(focusedLabel(focus)).toBe("本机时区不可用");
      const blocked = latestReducerState(reducer);
      if (blocked.tag !== "zone.blocked.save") throw new Error("expected blocked save");
      expect(blocked.source).toBe(editable);
      expectSameEditorIdentities(editable.editor, blocked.source.editor);
      const wrongDomain = blocked.domain === "feeding" ? "sleep" as const : "feeding" as const;
      expect(trackerScreenState.trackerScreenReducer(editable, {
        type: "ZONE_SAVE_BLOCKED",
        source: editable,
        next: Object.freeze({ ...blocked, domain: wrongDomain }),
      } as unknown as trackerScreenState.TrackerScreenAction)).toBe(editable);
      resolver.mockReturnValue({ status: "available", zone: KATHMANDU });
      const retryBefore = serviceCounts(service);
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      expectServiceDelta(service, retryBefore, {});
      expect(latestReducerState(reducer)).toBe(editable);
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      await waitFor(() => expect(focusedLabel(focus)).toBe(mode === "create" ? `保存${label}记录` : "保存修改"));
      fireEvent.press(screen.getByRole("button", { name: `返回${label}列表` }));
      await screen.findByRole("header", { name: "放弃未保存的更改？" });
      const discard = latestReducerState(reducer);
      if (discard.tag !== "confirm.discard") throw new Error("expected retained discard authority");
      expect(discard.decision.prior).toBe(editable);
      const beforeDiscard = serviceCounts(service);
      fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
      expectServiceDelta(service, beforeDiscard, {});
      const restored = latestReducerState(reducer);
      if (restored.tag !== "list.ready.empty" && restored.tag !== "list.ready.rows") throw new Error("expected prior list restoration");
      expect(restored.fact).toBe(priorState.fact);
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(service.delete).not.toHaveBeenCalled();
      view.unmount();
    }
  }
});

test("zone retry repeats only zone resolution and re-enters the requested state when valid", async () => {
  const exactRows = Object.freeze([records.feeding]);
  const exactFact = Object.freeze({ domain: "feeding" as const, rows: exactRows, presentationZone: KATHMANDU });
  const listReadySource = Object.freeze({ tag: "list.ready.rows" as const, fact: exactFact });
  const blockedAction = trackerScreenState.zoneListLoadBlockedAction(listReadySource, exactFact);
  if (blockedAction === null) throw new Error("expected feeding zone list-load block action");
  const blockedState = trackerScreenState.trackerScreenReducer(listReadySource, blockedAction);
  if (blockedState.tag !== "zone.blocked.entry") throw new Error("expected feeding zone list-load block");
  const substitutedFact: ListFact<"feeding"> = Object.freeze({ ...exactFact, presentationZone: "UTC" });
  const substitutedOwner = Object.freeze({
    mountEpoch: 1,
    generation: 1,
    domain: "feeding" as const,
    focusSession: 1,
    kind: "list" as const,
    recordId: undefined,
  });
  const substitutedNext = Object.freeze({
    tag: "list.loading" as const,
    source: "ordinary" as const,
    owner: substitutedOwner,
    prior: substitutedFact,
  });
  expect(substitutedFact.rows).toBe(exactFact.rows);
  expect(trackerScreenState.listEntryAuthorized(blockedState, substitutedFact, undefined)).toBe(false);
  expect(trackerScreenState.trackerScreenReducer(
    blockedState,
    trackerScreenState.listStartedAction(blockedState, substitutedNext),
  )).toBe(blockedState);

  for (const item of instantCases) {
    for (const entry of ["list", "create", "get"] as const) {
      const destinationList = deferred<readonly TrackerRecordByDomain[typeof item.domain][]>();
      const destinationGet = deferred<TrackerRecordByDomain[typeof item.domain] | null>();
      let destinationListCalls = 0;
      const list = jest.fn((domain: TrackerDomain) => {
        if (domain === "growth") return Promise.resolve([]);
        if (entry === "list") return ++destinationListCalls === 1 ? Promise.resolve([]) : destinationList.promise;
        return Promise.resolve(entry === "get" ? [item.record] : []);
      });
      const getById = jest.fn(() => destinationGet.promise);
      const service = serviceMock({ list: list as ManualTrackerServicePort["list"], getById: getById as ManualTrackerServicePort["getById"] });
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
      const focus = recordFocusTargets();
      const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
      const view = renderTracker(service);
      await screen.findByText("还没有生长记录");

      if (entry === "list") {
        fireEvent.press(screen.getByRole("tab", { name: item.label }));
        await screen.findByText(`还没有${item.label}记录`);
        fireEvent.press(screen.getByRole("tab", { name: "生长" }));
        await screen.findByText("还没有生长记录");
        resolver.mockClear();
        resolver.mockReturnValue(INVALID);
        fireEvent.press(screen.getByRole("tab", { name: item.label }));
      } else {
        fireEvent.press(screen.getByRole("tab", { name: item.label }));
        if (entry === "create") await screen.findByText(`还没有${item.label}记录`);
        else await screen.findByRole("button", { name: new RegExp(`${item.label}记录，`) });
        resolver.mockReturnValue(INVALID);
        fireEvent.press(entry === "create"
          ? screen.getByRole("button", { name: `新增${item.label}记录` })
          : screen.getByRole("button", { name: new RegExp(`${item.label}记录，`) }));
      }

      const blocked = latestReducerState(reducer);
      expect(blocked.tag).toBe("zone.blocked.entry");
      if (blocked.tag !== "zone.blocked.entry") throw new Error("expected blocked entry");
      expect(blocked.domain).toBe(item.domain);
      expect(blocked.intent.kind).toBe(entry === "list" ? "list-load" : entry);
      expect(blocked.intent.fact.domain).toBe(item.domain);
      let frozenListIntentFact: ListFact<typeof item.domain> | undefined;
      if (entry === "list") {
        if (blocked.intent.kind !== "list-load") throw new Error("expected blocked list-load intent");
        frozenListIntentFact = blocked.intent.fact;
        expect(Object.isFrozen(frozenListIntentFact)).toBe(true);
        expect(frozenListIntentFact.presentationZone).toBe("");
        expect(frozenListIntentFact.presentationZone).not.toBe("UTC");
      }
      if (entry === "get" && blocked.intent.kind === "get") expect(blocked.intent.id).toBe(item.record.id);
      expect(screen.getByText(INVALID_COPY).props).toMatchObject({ accessibilityRole: "alert", accessibilityLiveRegion: "assertive" });
      expect(screen.getAllByRole("button").filter((button) => button.props.accessibilityState?.disabled !== true).map((button) => button.props.accessibilityLabel)).toEqual(["重新读取本机时区"]);
      expect(focusedLabel(focus)).toBe("本机时区不可用");

      const beforeRetry = serviceCounts(service);
      const firstRetry = view.UNSAFE_getByType(PrimaryAction).props.onPress as () => void;
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      expect(resolver).toHaveBeenCalledTimes(entry === "list" ? 2 : 3);
      expect(latestReducerState(reducer)).toBe(blocked);
      expectServiceDelta(service, beforeRetry, {});
      expect(focusedLabel(focus)).toBe("重新读取本机时区");
      const secondRetry = view.UNSAFE_getByType(PrimaryAction).props.onPress as () => void;

      resolver.mockReturnValue({ status: "available", zone: entry === "list" ? "UTC" : KATHMANDU });
      const beforeSuccess = serviceCounts(service);
      const focusCountBeforeSuccess = focus.mock.calls.length;
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      expect(resolver).toHaveBeenCalledTimes(entry === "list" ? 3 : 4);
      if (entry === "list") {
        const loading = latestReducerState(reducer);
        expect(loading.tag).toBe("list.loading");
        if (loading.tag !== "list.loading") throw new Error("expected ordinary list loading");
        expect(loading.source).toBe("ordinary");
        if (loading.source !== "ordinary") throw new Error("expected ordinary list loading");
        expect(loading.prior).toBe(frozenListIntentFact);
        expectServiceDelta(service, beforeSuccess, { list: 1 });
        expect(list.mock.calls.at(-1)).toEqual([item.domain, 100]);
        expect(screen.getByText(`正在读取${item.label}记录…`).props.accessibilityLiveRegion).toBe("polite");
        expect(focus).toHaveBeenCalledTimes(focusCountBeforeSuccess);
        if (item.domain === "diaper") {
          await act(async () => destinationList.reject(new Error("offline")));
          await screen.findByText(`暂时无法读取${item.label}记录。本机数据没有更改。`);
        } else if (item.domain === "feeding") {
          const resolvedRows = Object.freeze([item.record]);
          await act(async () => destinationList.resolve(resolvedRows));
          await screen.findByRole("button", { name: new RegExp(`${item.label}记录，`) });
          const settled = latestReducerState(reducer);
          expect(settled.tag).toBe("list.ready.rows");
          if (settled.tag !== "list.ready.rows") throw new Error("expected settled feeding rows");
          expect(settled.fact.presentationZone).toBe("UTC");
          expect(settled.fact.rows).toBe(resolvedRows);
        } else {
          const resolvedEmptyRows: readonly TrackerRecordByDomain[typeof item.domain][] = Object.freeze([]);
          await act(async () => destinationList.resolve(resolvedEmptyRows));
          await screen.findByText(`还没有${item.label}记录`);
          const settled = latestReducerState(reducer);
          expect(settled.tag).toBe("list.ready.empty");
          if (settled.tag !== "list.ready.empty") throw new Error("expected settled sleep empty list");
          expect(settled.fact.presentationZone).toBe("UTC");
          expect(settled.fact.rows).toBe(resolvedEmptyRows);
        }
        await waitFor(() => expect(focusedLabel(focus)).toBe(`${item.label}记录`));
        expectServiceDelta(service, beforeSuccess, { list: 1 });
      } else if (entry === "get") {
        expectServiceDelta(service, beforeSuccess, { getById: 1 });
        expect(getById.mock.calls.at(-1)).toEqual([item.domain, item.record.id]);
        expect(screen.getByText(`正在读取这条${item.label}记录…`).props.accessibilityLiveRegion).toBe("polite");
        expect(focus).toHaveBeenCalledTimes(focusCountBeforeSuccess);
        if (item.domain === "sleep") {
          await act(async () => destinationGet.reject(new Error("offline")));
          await screen.findByText("暂时无法读取这条记录。本机数据没有更改。");
        } else if (item.domain === "diaper") {
          await act(async () => destinationGet.resolve(records.feeding));
          await screen.findByText("暂时无法读取这条记录。本机数据没有更改。");
        } else {
          await act(async () => destinationGet.resolve(item.record));
        }
        await screen.findByRole("header", { name: `编辑${item.label}记录` });
        await waitFor(() => expect(focusedLabel(focus)).toBe(`编辑${item.label}记录`));
        expect(latestFocusSnapshot(focus)?.current).not.toBeNull();
      } else {
        expectServiceDelta(service, beforeSuccess, {});
        await screen.findByRole("header", { name: `新增${item.label}记录` });
        await waitFor(() => expect(focusedLabel(focus)).toBe(`新增${item.label}记录`));
      }

      const afterSuccess = latestReducerState(reducer);
      const countsAfterSuccess = serviceCounts(service);
      const resolverAfterSuccess = resolver.mock.calls.length;
      const focusAfterSuccess = focus.mock.calls.length;
      act(() => { firstRetry(); secondRetry(); });
      expect(resolver).toHaveBeenCalledTimes(resolverAfterSuccess);
      expect(serviceCounts(service)).toEqual(countsAfterSuccess);
      expect(latestReducerState(reducer)).toBe(afterSuccess);
      expect(focus).toHaveBeenCalledTimes(focusAfterSuccess);
      view.unmount();
      jest.restoreAllMocks();
    }

    for (const mode of ["create", "edit"] as const) {
      const create = jest.fn(() => new Promise(() => undefined));
      const update = jest.fn(() => new Promise(() => undefined));
      const service = serviceMock({
        list: jest.fn(async (domain: TrackerDomain) => domain === item.domain && mode === "edit" ? [item.record] : []) as ManualTrackerServicePort["list"],
        getById: jest.fn(async () => item.record) as ManualTrackerServicePort["getById"],
        create: create as ManualTrackerServicePort["create"],
        update: update as ManualTrackerServicePort["update"],
      });
      const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
      const focus = recordFocusTargets();
      const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
      const view = renderTracker(service);
      await enterDomain(item.label);
      fireEvent.press(mode === "create"
        ? screen.getByRole("button", { name: `新增${item.label}记录` })
        : screen.getByRole("button", { name: new RegExp(`${item.label}记录，`) }));
      await screen.findByRole("header", { name: `${mode === "create" ? "新增" : "编辑"}${item.label}记录` });
      item.fill();
      const editable = latestReducerState(reducer);
      expect(editable.tag).toBe(mode === "create" ? "create.editing" : "edit.editing");
      if (editable.tag !== "create.editing" && editable.tag !== "edit.editing") throw new Error("expected editor");

      resolver.mockReturnValue(INVALID);
      const beforeInvalidSave = serviceCounts(service);
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }));
      const blocked = latestReducerState(reducer);
      expect(blocked.tag).toBe("zone.blocked.save");
      if (blocked.tag !== "zone.blocked.save") throw new Error("expected blocked save");
      expect(blocked.source).toBe(editable);
      expectSameEditorIdentities(editable.editor, blocked.source.editor);
      expectServiceDelta(service, beforeInvalidSave, {});
      expect(screen.getByText(INVALID_COPY).props.accessibilityLiveRegion).toBe("assertive");
      expect(screen.getAllByRole("button").filter((button) => button.props.accessibilityState?.disabled !== true).map((button) => button.props.accessibilityLabel)).toEqual(["重新读取本机时区"]);
      const firstRetry = view.UNSAFE_getByType(PrimaryAction).props.onPress as () => void;
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      expect(latestReducerState(reducer)).toBe(blocked);
      expect(focusedLabel(focus)).toBe("重新读取本机时区");
      const secondRetry = view.UNSAFE_getByType(PrimaryAction).props.onPress as () => void;

      resolver.mockReturnValue({ status: "available", zone: KATHMANDU });
      const beforeValidRetry = serviceCounts(service);
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      expectServiceDelta(service, beforeValidRetry, {});
      const restored = latestReducerState(reducer);
      expect(restored).toBe(editable);
      if (restored.tag !== "create.editing" && restored.tag !== "edit.editing") throw new Error("expected restored editor");
      expectSameEditorIdentities(editable.editor, restored.editor);
      await waitFor(() => expect(focusedLabel(focus)).toBe(mode === "create" ? `保存${item.label}记录` : "保存修改"));
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();

      const beforeExplicitSave = serviceCounts(service);
      const zoneBeforeExplicitSave = resolver.mock.calls.length;
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }));
      expect(resolver.mock.calls.length).toBe(zoneBeforeExplicitSave + 1);
      expectServiceDelta(service, beforeExplicitSave, mode === "create" ? { create: 1 } : { update: 1 });
      if (mode === "create") expect(create.mock.calls).toEqual([[item.domain, { ...item.input, sourceMessageId: null }]]);
      else expect(update.mock.calls).toEqual([[item.domain, item.record.id, item.input, item.record.updatedAt]]);
      const afterSubmit = latestReducerState(reducer);
      const countsAfterSubmit = serviceCounts(service);
      const resolverAfterSubmit = resolver.mock.calls.length;
      const focusAfterSubmit = focus.mock.calls.length;
      act(() => { firstRetry(); secondRetry(); });
      expect(resolver).toHaveBeenCalledTimes(resolverAfterSubmit);
      expect(serviceCounts(service)).toEqual(countsAfterSubmit);
      expect(latestReducerState(reducer)).toBe(afterSubmit);
      expect(focus).toHaveBeenCalledTimes(focusAfterSubmit);
      view.unmount();
      jest.restoreAllMocks();

      const changedService = serviceMock({
        list: jest.fn(async (domain: TrackerDomain) => domain === item.domain && mode === "edit" ? [item.record] : []) as ManualTrackerServicePort["list"],
        getById: jest.fn(async () => item.record) as ManualTrackerServicePort["getById"],
      });
      const changedResolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
      const changedFocus = recordFocusTargets();
      const changedReducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
      const changedView = renderTracker(changedService);
      await enterDomain(item.label);
      fireEvent.press(mode === "create"
        ? screen.getByRole("button", { name: `新增${item.label}记录` })
        : screen.getByRole("button", { name: new RegExp(`${item.label}记录，`) }));
      await screen.findByRole("header", { name: `${mode === "create" ? "新增" : "编辑"}${item.label}记录` });
      item.fill();
      changedResolver.mockReturnValue(INVALID);
      fireEvent.press(screen.getByRole("button", { name: mode === "create" ? `保存${item.label}记录` : "保存修改" }));
      const changedBlocked = latestReducerState(changedReducer);
      if (changedBlocked.tag !== "zone.blocked.save") throw new Error("expected changed blocked save");
      const changedBefore = serviceCounts(changedService);
      changedResolver.mockReturnValue({ status: "available", zone: "UTC" });
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      const changedRestored = latestReducerState(changedReducer);
      if (changedRestored.tag !== "create.editing" && changedRestored.tag !== "edit.editing") throw new Error("expected changed editor");
      expectSameEditorIdentities(changedBlocked.source.editor, changedRestored.editor);
      expect(screen.getByText(CHANGED_COPY).props).toMatchObject({ accessibilityRole: "alert", accessibilityLiveRegion: "assertive" });
      expect(screen.getByLabelText(item.timeLabel)).toHaveProp("value", "08:10");
      expectServiceDelta(changedService, changedBefore, {});
      await waitFor(() => expect(focusedLabel(changedFocus)).toBe(mode === "create" ? `保存${item.label}记录` : "保存修改"));
      changedView.unmount();
      jest.restoreAllMocks();
    }
  }

  const restoreList = deferred<readonly TrackerRecordByDomain["feeding"][]>();
  let feedingListCalls = 0;
  const restoreService = serviceMock({
    list: jest.fn((domain: TrackerDomain) => domain === "growth"
      ? Promise.resolve([])
      : ++feedingListCalls === 1 ? Promise.resolve([]) : restoreList.promise) as ManualTrackerServicePort["list"],
  });
  const restoreResolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
  const restoreFocus = recordFocusTargets();
  const restoreReducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
  const restoreView = renderTracker(restoreService);
  await enterDomain("喂养");
  fireEvent.press(screen.getByRole("button", { name: "新增喂养记录" }));
  fillFeeding();
  fireEvent.press(screen.getByRole("button", { name: "返回喂养列表" }));
  await screen.findByRole("header", { name: "放弃未保存的更改？" });
  const acceptButton = screen.getByRole("button", { name: "放弃更改" });
  const staleAccept = [acceptButton.props.onPress, acceptButton.parent?.props.onPress, acceptButton.parent?.parent?.props.onPress]
    .find((candidate): candidate is () => void => typeof candidate === "function");
  if (staleAccept === undefined) throw new Error("expected stale accept callback");
  restoreResolver.mockReturnValue(INVALID);
  const beforeAccept = serviceCounts(restoreService);
  fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
  const restoreBlocked = latestReducerState(restoreReducer);
  if (restoreBlocked.tag !== "zone.blocked.entry") throw new Error("expected list restore block");
  expect(restoreBlocked.intent.kind).toBe("list-restore");
  expectServiceDelta(restoreService, beforeAccept, {});
  expect(screen.queryByLabelText("喂养日期")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
  expect(latestReducerState(restoreReducer)).toBe(restoreBlocked);
  expect(focusedLabel(restoreFocus)).toBe("重新读取本机时区");
  const staleRetry = restoreView.UNSAFE_getByType(PrimaryAction).props.onPress as () => void;
  restoreResolver.mockReturnValue({ status: "available", zone: KATHMANDU });
  const beforeRestore = serviceCounts(restoreService);
  fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
  expectServiceDelta(restoreService, beforeRestore, { list: 1 });
  expect((restoreService.list as jest.Mock).mock.calls.at(-1)).toEqual(["feeding", 100]);
  expect(screen.getByText("正在读取喂养记录…").props.accessibilityLiveRegion).toBe("polite");
  await act(async () => restoreList.resolve([]));
  await screen.findByText("还没有喂养记录");
  const restoredState = latestReducerState(restoreReducer);
  const restoredCounts = serviceCounts(restoreService);
  const restoredZoneCount = restoreResolver.mock.calls.length;
  const restoredFocusCount = restoreFocus.mock.calls.length;
  act(() => { staleAccept(); staleRetry(); });
  expect(restoreResolver).toHaveBeenCalledTimes(restoredZoneCount);
  expect(serviceCounts(restoreService)).toEqual(restoredCounts);
  expect(latestReducerState(restoreReducer)).toBe(restoredState);
  expect(restoreFocus).toHaveBeenCalledTimes(restoredFocusCount);
  restoreView.unmount();

  for (const currentZone of [INVALID, { status: "available" as const, zone: "UTC" }] as const) {
    jest.restoreAllMocks();
    const missingGet = deferred<TrackerRecordByDomain["feeding"] | null>();
    const fallbackList = deferred<readonly TrackerRecordByDomain["feeding"][]>();
    let feedingLists = 0;
    const service = serviceMock({
      list: jest.fn((domain: TrackerDomain) => domain === "growth"
        ? Promise.resolve([])
        : ++feedingLists === 1 ? Promise.resolve([records.feeding]) : fallbackList.promise) as ManualTrackerServicePort["list"],
      getById: jest.fn(() => missingGet.promise) as ManualTrackerServicePort["getById"],
    });
    const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
    const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
    const view = renderTracker(service);
    await enterDomain("喂养");
    fireEvent.press(screen.getByRole("button", { name: /喂养记录，/ }));
    resolver.mockReturnValue(currentZone);
    const beforeMissing = serviceCounts(service);
    await act(async () => missingGet.resolve(null));
    if (currentZone.status === "unavailable") {
      const blocked = latestReducerState(reducer);
      if (blocked.tag !== "zone.blocked.entry" || blocked.intent.kind !== "list-load") throw new Error("expected missing-record list block");
      expect(blocked.intent.notice).toBe("这条记录已不存在，列表已重新读取。");
      expectServiceDelta(service, beforeMissing, {});
      expect(screen.getByText(INVALID_COPY)).toBeTruthy();
      resolver.mockReturnValue({ status: "available", zone: KATHMANDU });
      fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
      expectServiceDelta(service, beforeMissing, { list: 1 });
      const loading = latestReducerState(reducer);
      if (loading.tag !== "list.loading" || loading.source !== "ordinary") throw new Error("expected retried missing-record reload");
      expect(loading.prior.presentationZone).toBe(KATHMANDU);
      await act(async () => fallbackList.resolve([]));
      await screen.findByText("还没有喂养记录");
    } else {
      expectServiceDelta(service, beforeMissing, { list: 1 });
      const loading = latestReducerState(reducer);
      if (loading.tag !== "list.loading" || loading.source !== "ordinary") throw new Error("expected missing-record reload");
      expect(loading.prior.presentationZone).toBe("UTC");
      expect(loading.notice).toBe("这条记录已不存在，列表已重新读取。");
      await act(async () => fallbackList.resolve([]));
      await screen.findByText("还没有喂养记录");
    }
    view.unmount();
  }

  for (const destination of ["reload-list", "reload-record"] as const) {
    jest.restoreAllMocks();
    const service = serviceMock({
      list: jest.fn(async (domain: TrackerDomain) => domain === "feeding" ? [records.feeding] : []) as ManualTrackerServicePort["list"],
      getById: jest.fn(async () => records.feeding) as ManualTrackerServicePort["getById"],
      update: jest.fn(async () => { throw new ManualTrackerConflictError("stale_write"); }) as ManualTrackerServicePort["update"],
    });
    const resolver = jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone: KATHMANDU });
    const reducer = jest.spyOn(trackerScreenState, "trackerScreenReducer");
    const view = renderTracker(service);
    await enterDomain("喂养");
    fireEvent.press(screen.getByRole("button", { name: /喂养记录，/ }));
    await screen.findByRole("header", { name: "编辑喂养记录" });
    fireEvent.changeText(screen.getByLabelText("备注"), "dirty conflict");
    fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("这条记录已在其他位置更新。为避免覆盖，请重新读取后再修改。");
    const initiate = () => fireEvent.press(screen.getByRole("button", { name: destination === "reload-list" ? "返回列表" : "重新读取记录" }));
    initiate();
    await screen.findByRole("header", { name: "放弃未保存的更改？" });
    const accept = screen.getByRole("button", { name: "放弃更改" });
    const staleAccept = [accept.props.onPress, accept.parent?.props.onPress, accept.parent?.parent?.props.onPress]
      .find((candidate): candidate is () => void => typeof candidate === "function");
    if (staleAccept === undefined) throw new Error("expected conflict discard callback");
    fireEvent.press(screen.getByRole("button", { name: "继续编辑" }));
    const cancelled = latestReducerState(reducer);
    const cancelledZoneReads = resolver.mock.calls.length;
    act(() => staleAccept());
    expect(latestReducerState(reducer)).toBe(cancelled);
    expect(resolver).toHaveBeenCalledTimes(cancelledZoneReads);

    initiate();
    resolver.mockReturnValue(INVALID);
    const beforeAccept = serviceCounts(service);
    fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
    const blocked = latestReducerState(reducer);
    if (blocked.tag !== "zone.blocked.entry") throw new Error("expected conflict zone block");
    expect(blocked.intent.kind).toBe(destination === "reload-list" ? "list-load" : "get");
    expectServiceDelta(service, beforeAccept, {});
    const blockedZoneReads = resolver.mock.calls.length;
    act(() => staleAccept());
    expect(latestReducerState(reducer)).toBe(blocked);
    expect(resolver).toHaveBeenCalledTimes(blockedZoneReads);
    resolver.mockReturnValue({ status: "available", zone: KATHMANDU });
    fireEvent.press(screen.getByRole("button", { name: "重新读取本机时区" }));
    if (destination === "reload-list") expectServiceDelta(service, beforeAccept, { list: 1 });
    else expectServiceDelta(service, beforeAccept, { getById: 1 });
    view.unmount();
  }
});
