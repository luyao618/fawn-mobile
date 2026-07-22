import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as ts from "typescript";

import type {
  ManualTrackerServicePort,
  TrackerCreateSummary,
  TrackerDeleteSummary,
  TrackerUpdateSummary,
} from "../../../../src/application/tracker/manualTrackerService";
import { ManualTrackerConflictError } from "../../../../src/application/tracker/manualTrackerService";
import { RuntimeClosingError } from "../../../../src/application/bootstrap/appRuntime";
import type {
  TrackerDomain,
  TrackerRecordByDomain,
  TrackerUpdateInputByDomain,
} from "../../../../src/domain/tracker/types";
import { TrackerValidationError } from "../../../../src/domain/tracker/validation";
import { DiaperTrackerForm } from "../../../../src/features/tracker/forms/DiaperTrackerForm";
import { FeedingTrackerForm } from "../../../../src/features/tracker/forms/FeedingTrackerForm";
import { GrowthTrackerForm } from "../../../../src/features/tracker/forms/GrowthTrackerForm";
import { SleepTrackerForm } from "../../../../src/features/tracker/forms/SleepTrackerForm";
import { ManualTrackerScreen } from "../../../../src/features/tracker/ManualTrackerScreen";
import { ManualTrackerServiceProvider } from "../../../../src/features/tracker/ManualTrackerServiceContext";
import * as trackerLocalTime from "../../../../src/features/tracker/trackerLocalTime";
import {
  backDiscardDecision,
  acceptedDiscardGetStartedAction,
  acceptedDiscardListStartedAction,
  conflictDiscardDecision,
  createRequestedAction,
  discardRequestedAction,
  getStartedAction,
  isGetDiscardDecisionForDestination,
  isListDiscardDecisionForDestination,
  listStartedAction,
  trackerScreenReducer,
  type CreateEditorSnapshot,
  type EditEditorSnapshot,
  type ListFact,
  type OperationOwner,
  type TrackerScreenAction,
  type TrackerScreenState,
} from "../../../../src/features/tracker/trackerScreenState";

const mockTrackerReducerObserver = jest.fn(
  (_action: TrackerScreenAction, _state: TrackerScreenState): void => undefined,
);
const mockTrackerReducerRejector = jest.fn(
  (_action: TrackerScreenAction, _state: TrackerScreenState): boolean => false,
);

jest.mock("../../../../src/features/tracker/trackerScreenState", () => {
  const actual = jest.requireActual("../../../../src/features/tracker/trackerScreenState");
  return {
    ...actual,
    trackerScreenReducer: (state: TrackerScreenState, action: TrackerScreenAction) => {
      if (mockTrackerReducerRejector(action, state)) {
        mockTrackerReducerObserver(action, state);
        return state;
      }
      const next = actual.trackerScreenReducer(state, action) as TrackerScreenState;
      mockTrackerReducerObserver(action, next);
      return next;
    },
  };
});

jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  const React = jest.requireActual("react");
  return {
    ...actual,
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  };
});

const zone = "Asia/Shanghai";
const metadata = Object.freeze({
  sourceMessageId: null,
  createdAt: "2026-07-20T00:01:00.000Z",
  updatedAt: "2026-07-20T00:02:00.000Z",
});
const records = Object.freeze({
  growth: Object.freeze({
    ...metadata, id: "growth-private-id", measurementDate: "2026-07-20", weightG: 7200,
    heightCm: 68.5, headCm: null, weightPercentile: 0, heightPercentile: 42.5,
    headPercentile: null, notes: "生长备注",
  }),
  feeding: Object.freeze({
    ...metadata, id: "feeding-private-id", feedTime: "2026-07-20T00:10:00.000Z",
    feedType: "formula", amountMl: 0, durationMin: null, notes: "喂养备注",
  }),
  sleep: Object.freeze({
    ...metadata, id: "sleep-private-id", sleepStart: "2026-07-20T05:00:00.000Z",
    sleepEnd: "2026-07-20T06:00:00.000Z", sleepType: "night", nightWakings: 2, notes: null,
  }),
  diaper: Object.freeze({
    ...metadata, id: "diaper-private-id", diaperTime: "2026-07-20T01:30:00.000Z",
    diaperType: "mixed", notes: null,
  }),
  health: Object.freeze({
    ...metadata, id: "health-private-id", recordDate: "2026-07-20", recordType: "checkup",
    title: "常规检查", description: "健康说明",
  }),
}) satisfies { readonly [D in TrackerDomain]: TrackerRecordByDomain[D] };

const expectedUpdateInputs = Object.freeze({
  growth: Object.freeze({
    measurementDate: "2026-07-20", weightG: 7300, heightCm: 68.5, headCm: null,
    weightPercentile: 0, heightPercentile: 42.5, headPercentile: null, notes: "生长备注",
  }),
  feeding: Object.freeze({
    feedTime: "2026-07-20T00:10:00.000Z", feedType: "formula" as const,
    amountMl: 0, durationMin: null, notes: "更新喂养备注",
  }),
  sleep: Object.freeze({
    sleepStart: "2026-07-20T05:00:00.000Z", sleepEnd: "2026-07-20T06:00:00.000Z",
    sleepType: "night" as const, nightWakings: 3, notes: null,
  }),
  diaper: Object.freeze({
    diaperTime: "2026-07-20T01:30:00.000Z", diaperType: "mixed" as const, notes: "更换后备注",
  }),
  health: Object.freeze({
    recordDate: "2026-07-20", recordType: "checkup" as const, title: "复查", description: "健康说明",
  }),
}) satisfies { readonly [D in TrackerDomain]: TrackerUpdateInputByDomain[D] };

const baselineUpdateInputs = Object.freeze({
  growth: Object.freeze({
    measurementDate: records.growth.measurementDate, weightG: records.growth.weightG,
    heightCm: records.growth.heightCm, headCm: records.growth.headCm,
    weightPercentile: records.growth.weightPercentile, heightPercentile: records.growth.heightPercentile,
    headPercentile: records.growth.headPercentile, notes: records.growth.notes,
  }),
  feeding: Object.freeze({
    feedTime: records.feeding.feedTime, feedType: records.feeding.feedType,
    amountMl: records.feeding.amountMl, durationMin: records.feeding.durationMin, notes: records.feeding.notes,
  }),
  sleep: Object.freeze({
    sleepStart: records.sleep.sleepStart, sleepEnd: records.sleep.sleepEnd,
    sleepType: records.sleep.sleepType, nightWakings: records.sleep.nightWakings, notes: records.sleep.notes,
  }),
  diaper: Object.freeze({
    diaperTime: records.diaper.diaperTime, diaperType: records.diaper.diaperType, notes: records.diaper.notes,
  }),
  health: Object.freeze({
    recordDate: records.health.recordDate, recordType: records.health.recordType,
    title: records.health.title, description: records.health.description,
  }),
}) satisfies { readonly [D in TrackerDomain]: TrackerUpdateInputByDomain[D] };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createServiceMock(overrides: Partial<ManualTrackerServicePort> = {}): ManualTrackerServicePort {
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
    <SafeAreaProvider initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 20, left: 0, right: 0, bottom: 0 },
    }}>
      <ManualTrackerServiceProvider service={service}>
        <ManualTrackerScreen />
      </ManualTrackerServiceProvider>
    </SafeAreaProvider>,
  );
}

async function openHealthCreate() {
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("tab", { name: "健康" }));
  await screen.findByText("还没有健康记录");
  fireEvent.press(screen.getByRole("button", { name: "新增健康记录" }));
  fireEvent.press(screen.getByRole("radio", { name: "健康记录类型身体不适" }));
  fireEvent.changeText(screen.getByLabelText("标题"), "  轻微咳嗽  ");
  fireEvent.changeText(screen.getByLabelText("说明"), "居家观察");
}

async function openEditor<D extends TrackerDomain>(domain: D, label: string, service: ManualTrackerServicePort) {
  renderTracker(service);
  if (domain !== "growth") {
    await screen.findByText("还没有生长记录");
    fireEvent.press(screen.getByRole("tab", { name: label }));
  }
  fireEvent.press(await screen.findByRole("button", { name: new RegExp(`${label}记录，`) }));
  await screen.findByRole("header", { name: `编辑${label}记录` });
}

function visibleEditorSnapshot(domain: TrackerDomain) {
  const labels: Readonly<Record<TrackerDomain, readonly string[]>> = Object.freeze({
    growth: Object.freeze(["测量日期", "体重（克）", "身长（厘米）", "头围（厘米）", "备注"]),
    feeding: Object.freeze(["喂养日期", "喂养时间", "量（毫升）", "时长（分钟）", "备注"]),
    sleep: Object.freeze(["开始日期", "开始时间", "结束日期", "结束时间", "夜醒次数", "备注"]),
    diaper: Object.freeze(["记录日期", "记录时间", "备注"]),
    health: Object.freeze(["记录日期", "标题", "说明"]),
  });
  return Object.freeze({
    inputs: labels[domain].map((label) => Object.freeze({ label, value: screen.getByLabelText(label).props.value })),
    selectedRadios: screen.queryAllByRole("radio")
      .filter((radio) => radio.props.accessibilityState?.selected === true)
      .map((radio) => radio.props.accessibilityLabel),
  });
}

function observedStatesAfter(
  actionType: "MUTATION_COMPLETED" | "OPERATION_REFRESH_STARTED",
  kind: "update" | "delete",
): readonly TrackerScreenState[] {
  return mockTrackerReducerObserver.mock.calls.flatMap(([action, state]) => (
    action.type === actionType && action.owner.kind === kind ? [state] : []
  ));
}

beforeEach(() => {
  mockTrackerReducerObserver.mockClear();
  mockTrackerReducerRejector.mockReset();
  mockTrackerReducerRejector.mockReturnValue(false);
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-07-20T00:10:00.000Z"));
  jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("rejected missing-record reload transition suppresses its fallback list", async () => {
  const rows = Object.freeze([records.growth]);
  const list = jest.fn(async () => rows);
  const missingRecord = deferred<null>();
  const getById = jest.fn(() => missingRecord.promise);
  const service = createServiceMock({ list: list as ManualTrackerServicePort["list"], getById: getById as ManualTrackerServicePort["getById"] });
  renderTracker(service);
  mockTrackerReducerRejector.mockImplementation((action) => action.type === "GET_MISSING_RELOAD_STARTED");
  fireEvent.press(await screen.findByRole("button", { name: /生长记录，/ }));
  expect(getById).toHaveBeenCalledTimes(1);
  missingRecord.resolve(null);
  await Promise.resolve();
  expect(mockTrackerReducerRejector).toHaveBeenCalledWith(
    expect.objectContaining({ type: "GET_MISSING_RELOAD_STARTED" }),
    expect.objectContaining({ tag: "edit.loading" }),
  );
  expect(list).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("header", { name: "编辑生长记录" })).toBeTruthy();
});

test.each(["direct-create", "health-create", "update", "delete"] as const)("rejected %s start transition performs zero mutation service calls", async (path) => {
  const create = jest.fn();
  const update = jest.fn();
  const remove = jest.fn();
  const service = createServiceMock({
    list: jest.fn(async (domain) => domain === "growth" ? [records.growth] : []) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.growth) as ManualTrackerServicePort["getById"],
    create: create as ManualTrackerServicePort["create"],
    update: update as ManualTrackerServicePort["update"],
    delete: remove as ManualTrackerServicePort["delete"],
  });
  mockTrackerReducerRejector.mockImplementation((action) => action.type === "MUTATION_STARTED" && (
    path === "direct-create" ? action.owner.domain === "growth" && action.owner.kind === "create"
      : path === "health-create" ? action.owner.domain === "health" && action.owner.kind === "create" && action.phase === "probe"
        : action.owner.kind === path && action.phase === "probe"
  ));
  if (path === "direct-create") {
    renderTracker(service);
    await screen.findByRole("button", { name: /生长记录，/ });
    fireEvent.press(screen.getByRole("button", { name: "新增生长记录" }));
    fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
    fireEvent.press(screen.getByRole("button", { name: "保存生长记录" }));
  } else if (path === "health-create") {
    renderTracker(service);
    await openHealthCreate();
    fireEvent.press(screen.getByRole("button", { name: "保存健康记录" }));
  } else {
    await openEditor("growth", "生长", service);
    if (path === "update") fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
    fireEvent.press(screen.getByRole("button", { name: path === "update" ? "保存修改" : "删除这条记录" }));
  }
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(create).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test.each(["health-create", "update", "delete"] as const)("rejected confirmed %s transition performs zero confirmed mutation calls", async (path) => {
  const healthInput = Object.freeze({ recordDate: "2026-07-20", recordType: "illness" as const, title: "轻微咳嗽", description: "居家观察", sourceMessageId: null });
  const healthSummary: TrackerCreateSummary<"health"> = Object.freeze({ action: "create", domain: "health", input: healthInput });
  const updateInput = Object.freeze({ ...expectedUpdateInputs.growth, weightG: 7300 });
  const updateSummary: TrackerUpdateSummary<"growth"> = Object.freeze({ action: "update", domain: "growth", id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt, input: updateInput });
  const deleteSummary: TrackerDeleteSummary<"growth"> = Object.freeze({ action: "delete", domain: "growth", id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt });
  const create = jest.fn(async () => Object.freeze({ status: "confirmation_required" as const, summary: healthSummary }));
  const update = jest.fn(async () => Object.freeze({ status: "confirmation_required" as const, summary: updateSummary }));
  const remove = jest.fn(async () => Object.freeze({ status: "confirmation_required" as const, summary: deleteSummary }));
  const service = createServiceMock({
    list: jest.fn(async (domain) => domain === "growth" ? [records.growth] : []) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.growth) as ManualTrackerServicePort["getById"],
    create: create as ManualTrackerServicePort["create"], update: update as ManualTrackerServicePort["update"], delete: remove as ManualTrackerServicePort["delete"],
  });
  if (path === "health-create") {
    renderTracker(service);
    await openHealthCreate();
    fireEvent.press(screen.getByRole("button", { name: "保存健康记录" }));
    await screen.findByRole("button", { name: "确认保存" });
  } else {
    await openEditor("growth", "生长", service);
    if (path === "update") fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
    fireEvent.press(screen.getByRole("button", { name: path === "update" ? "保存修改" : "删除这条记录" }));
    await screen.findByRole("button", { name: path === "update" ? "确认保存" : "确认删除" });
  }
  mockTrackerReducerRejector.mockImplementation((action) => action.type === "MUTATION_STARTED" && action.phase === "confirmed");
  fireEvent.press(screen.getByRole("button", { name: path === "delete" ? "确认删除" : "确认保存" }));
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(create).toHaveBeenCalledTimes(path === "health-create" ? 1 : 0);
  expect(update).toHaveBeenCalledTimes(path === "update" ? 1 : 0);
  expect(remove).toHaveBeenCalledTimes(path === "delete" ? 1 : 0);
});

test.each(["MUTATION_COMPLETED", "OPERATION_REFRESH_STARTED"] as const)("rejected %s transition suppresses completion refresh list", async (rejectedType) => {
  const completed = Object.freeze({ ...records.growth, id: "created-growth", updatedAt: "2026-07-20T00:03:00.000Z", weightG: 7300 });
  const input = Object.freeze({ measurementDate: "2026-07-20", weightG: 7300, heightCm: null, headCm: null, weightPercentile: null, heightPercentile: null, headPercentile: null, notes: null, sourceMessageId: null });
  const summary: TrackerCreateSummary<"growth"> = Object.freeze({ action: "create", domain: "growth", input });
  const create = jest.fn(async () => Object.freeze({ status: "completed" as const, summary, record: completed }));
  const list = jest.fn(async () => Object.freeze([]));
  const service = createServiceMock({ list: list as ManualTrackerServicePort["list"], create: create as ManualTrackerServicePort["create"] });
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("button", { name: "新增生长记录" }));
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
  mockTrackerReducerRejector.mockImplementation((action) => action.type === rejectedType);
  fireEvent.press(screen.getByRole("button", { name: "保存生长记录" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(list).toHaveBeenCalledTimes(1);
});

test("health create cancel performs zero confirmed calls and restores the exact frozen draft", async () => {
  const normalizedInput = Object.freeze({
    recordDate: "2026-07-20", recordType: "illness" as const, title: "轻微咳嗽",
    description: "居家观察", sourceMessageId: null,
  });
  const summary: TrackerCreateSummary<"health"> = Object.freeze({ action: "create", domain: "health", input: normalizedInput });
  const create = jest.fn(async () => Object.freeze({ status: "confirmation_required" as const, summary }));
  const service = createServiceMock({ create: create as ManualTrackerServicePort["create"] });
  renderTracker(service);
  await openHealthCreate();
  const frozenEditor = visibleEditorSnapshot("health");

  fireEvent.press(screen.getByRole("button", { name: "保存健康记录" }));
  expect(await screen.findByRole("header", { name: "确认新增健康记录" })).toBeTruthy();
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual(["返回修改", "确认保存"]);
  expect(screen.queryByLabelText("标题")).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "返回修改" }));

  expect(visibleEditorSnapshot("health")).toEqual(frozenEditor);
  expect(screen.getByLabelText("标题").props.value).toBe("  轻微咳嗽  ");
  expect(screen.getByLabelText("说明").props.value).toBe("居家观察");
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith("health", normalizedInput);
});

test("health create accept reuses the exact returned summary input", async () => {
  const normalizedInput = Object.freeze({
    recordDate: "2026-07-20", recordType: "illness" as const, title: "轻微咳嗽",
    description: "居家观察", sourceMessageId: null,
  });
  const summary: TrackerCreateSummary<"health"> = Object.freeze({ action: "create", domain: "health", input: normalizedInput });
  const completedRecord = Object.freeze({ ...records.health, ...normalizedInput, id: records.health.id });
  const create = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required" as const, summary }))
    .mockResolvedValueOnce(Object.freeze({ status: "completed" as const, summary, record: completedRecord }));
  const list = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([completedRecord]);
  const service = createServiceMock({ create: create as ManualTrackerServicePort["create"], list });
  renderTracker(service);
  await openHealthCreate();
  fireEvent.press(screen.getByRole("button", { name: "保存健康记录" }));
  fireEvent.press(await screen.findByRole("button", { name: "确认保存" }));

  await screen.findByRole("header", { name: "健康记录" });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]).toEqual(["health", normalizedInput, "confirmed"]);
  expect(create.mock.calls[1]![1]).toBe(normalizedInput);
  expect(list).toHaveBeenLastCalledWith("health", 100);
});

test("accepted decisions stay interlocked and busy until the confirmed call settles", async () => {
  const normalizedInput = Object.freeze({
    recordDate: "2026-07-20", recordType: "illness" as const, title: "轻微咳嗽",
    description: "居家观察", sourceMessageId: null,
  });
  const summary: TrackerCreateSummary<"health"> = Object.freeze({ action: "create", domain: "health", input: normalizedInput });
  const confirmed = deferred<Readonly<{ status: "completed"; summary: TrackerCreateSummary<"health">; record: TrackerRecordByDomain["health"] }>>();
  const create = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required" as const, summary }))
    .mockReturnValueOnce(confirmed.promise);
  const service = createServiceMock({ create: create as ManualTrackerServicePort["create"] });
  renderTracker(service);
  await openHealthCreate();
  fireEvent.press(screen.getByRole("button", { name: "保存健康记录" }));
  fireEvent.press(await screen.findByRole("button", { name: "确认保存" }));

  expect(screen.getByRole("header", { name: "确认新增健康记录" })).toBeTruthy();
  expect(screen.queryByLabelText("标题")).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityState)).toEqual([
    { busy: true, disabled: true },
    { busy: true, disabled: true },
  ]);
  fireEvent.press(screen.getByRole("button", { name: "确认保存" }));
  fireEvent.press(screen.getByRole("button", { name: "返回修改" }));
  expect(create).toHaveBeenCalledTimes(2);

  await act(async () => confirmed.resolve(Object.freeze({
    status: "completed", summary, record: Object.freeze({ ...records.health, ...normalizedInput }),
  })));
});

test.each(["update", "delete"] as const)("accepted %s decisions reject duplicate accept and cancel actions while busy", async (kind) => {
  const updateSummary: TrackerUpdateSummary<"health"> = Object.freeze({
    action: "update", domain: "health", id: records.health.id,
    expectedUpdatedAt: records.health.updatedAt, input: expectedUpdateInputs.health,
  });
  const deleteSummary: TrackerDeleteSummary<"health"> = Object.freeze({
    action: "delete", domain: "health", id: records.health.id, expectedUpdatedAt: records.health.updatedAt,
  });
  const confirmed = deferred<unknown>();
  const update = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary: updateSummary }))
    .mockReturnValueOnce(confirmed.promise);
  const remove = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary: deleteSummary }))
    .mockReturnValueOnce(confirmed.promise);
  const service = createServiceMock({
    list: jest.fn(async (requested) => requested === "health" ? [records.health] : []) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.health) as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
    delete: remove as ManualTrackerServicePort["delete"],
  });
  await openEditor("health", "健康", service);
  if (kind === "update") {
    fireEvent.changeText(screen.getByLabelText("标题"), "复查");
    fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  } else {
    fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
  }
  const acceptLabel = kind === "update" ? "确认保存" : "确认删除";
  const cancelLabel = kind === "update" ? "返回修改" : "取消";
  fireEvent.press(await screen.findByRole("button", { name: acceptLabel }));

  expect(screen.getByRole("button", { name: acceptLabel }).props.accessibilityState).toEqual({ busy: true, disabled: true });
  expect(screen.getByRole("button", { name: cancelLabel }).props.accessibilityState).toEqual({ busy: true, disabled: true });
  fireEvent.press(screen.getByRole("button", { name: acceptLabel }));
  fireEvent.press(screen.getByRole("button", { name: cancelLabel }));
  expect(kind === "update" ? update : remove).toHaveBeenCalledTimes(2);

  await act(async () => confirmed.resolve(kind === "update"
    ? Object.freeze({
      status: "completed", summary: updateSummary,
      record: Object.freeze({ ...records.health, ...expectedUpdateInputs.health, updatedAt: "2026-07-20T00:03:00.000Z" }),
    })
    : Object.freeze({
      status: "completed", summary: deleteSummary,
      deletion: Object.freeze({ domain: "health", id: records.health.id, updatedAt: "2026-07-20T00:03:00.000Z", deletedAt: "2026-07-20T00:03:00.000Z" }),
    })));
});

const editCases = [
  {
    domain: "growth" as const, label: "生长", expectedInput: expectedUpdateInputs.growth,
    changedLabel: "体重（克）",
    change: () => fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300"),
    normalizeChange: () => fireEvent.changeText(screen.getByLabelText("体重（克）"), "07200"),
    normalizedLabel: "体重（克）", normalizedValue: "7200",
  },
  {
    domain: "feeding" as const, label: "喂养", expectedInput: expectedUpdateInputs.feeding,
    changedLabel: "备注",
    change: () => fireEvent.changeText(screen.getByLabelText("备注"), "更新喂养备注"),
    normalizeChange: () => fireEvent.changeText(screen.getByLabelText("量（毫升）"), "00"),
    normalizedLabel: "量（毫升）", normalizedValue: "0",
  },
  {
    domain: "sleep" as const, label: "睡眠", expectedInput: expectedUpdateInputs.sleep,
    changedLabel: "夜醒次数",
    change: () => fireEvent.changeText(screen.getByLabelText("夜醒次数"), "03"),
    normalizeChange: () => fireEvent.changeText(screen.getByLabelText("夜醒次数"), "02"),
    normalizedLabel: "夜醒次数", normalizedValue: "2",
  },
  {
    domain: "diaper" as const, label: "大小便", expectedInput: expectedUpdateInputs.diaper,
    changedLabel: "备注",
    change: () => fireEvent.changeText(screen.getByLabelText("备注"), "更换后备注"),
    normalizeChange: () => fireEvent.changeText(screen.getByLabelText("备注"), "   "),
    normalizedLabel: "备注", normalizedValue: "",
  },
  {
    domain: "health" as const, label: "健康", expectedInput: expectedUpdateInputs.health,
    changedLabel: "标题",
    change: () => fireEvent.changeText(screen.getByLabelText("标题"), "复查"),
    normalizeChange: () => fireEvent.changeText(screen.getByLabelText("标题"), `  ${records.health.title}  `),
    normalizedLabel: "标题", normalizedValue: records.health.title,
  },
];

test.each(editCases)("$domain local visible no-op makes zero update calls", async ({ domain, label }) => {
  const service = createServiceMock({
    list: jest.fn(async (requested) => requested === domain ? [records[domain]] : []) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records[domain]) as ManualTrackerServicePort["getById"],
  });
  await openEditor(domain, label, service);
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));

  expect(service.update).not.toHaveBeenCalled();
  expect(screen.getByText("内容没有更改。")).toBeTruthy();
  expect(screen.getByRole("header", { name: `编辑${label}记录` })).toBeTruthy();
});

test.each(editCases)("$domain update probe uses an independently specified full input and loaded token; cancel restores the editor", async ({ domain, label, changedLabel, change, expectedInput }) => {
  const update = jest.fn(async (requestedDomain, id, input, expectedUpdatedAt) => {
    const summary = Object.freeze({ action: "update" as const, domain: requestedDomain, id, input, expectedUpdatedAt });
    return Object.freeze({ status: "confirmation_required" as const, summary });
  });
  const service = createServiceMock({
    list: jest.fn(async (requested) => requested === domain ? [records[domain]] : []) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records[domain]) as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
  });
  await openEditor(domain, label, service);
  change();
  const frozenEditor = visibleEditorSnapshot(domain);
  const changedValue = screen.getByLabelText(changedLabel).props.value;
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));

  expect(await screen.findByRole("header", { name: "确认保存修改" })).toBeTruthy();
  expect(update).toHaveBeenCalledWith(domain, records[domain].id, expectedInput, records[domain].updatedAt);
  expect(update.mock.calls[0]![2]).toEqual(expectedInput);
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByRole("button", { name: "删除这条记录" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "返回修改" }));
  expect(visibleEditorSnapshot(domain)).toEqual(frozenEditor);
  const restoredValue = screen.getByLabelText(changedLabel).props.value;
  expect(restoredValue).toBe(changedValue);
  expect(update).toHaveBeenCalledTimes(1);
});

test.each(editCases)("$domain normalized semantic no-op restores normalized visible values without confirmation or revision", async ({ domain, label, normalizeChange, normalizedLabel, normalizedValue }) => {
  const normalizedInput = baselineUpdateInputs[domain];
  const update = jest.fn(async () => Object.freeze({
    status: "confirmation_required" as const,
    summary: Object.freeze({
      action: "update" as const, domain, id: records[domain].id,
      expectedUpdatedAt: records[domain].updatedAt, input: normalizedInput,
    }),
  }));
  const service = createServiceMock({
    list: jest.fn(async (requested) => requested === domain ? [records[domain]] : []) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records[domain]) as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
  });
  await openEditor(domain, label, service);
  normalizeChange();
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));

  expect(await screen.findByText("内容没有更改。")).toBeTruthy();
  expect(screen.getByLabelText(normalizedLabel).props.value).toBe(normalizedValue);
  expect(screen.queryByRole("header", { name: "确认保存修改" })).toBeNull();
  expect(update).toHaveBeenCalledTimes(1);
});

test.each(editCases)("$domain update accept uses only frozen summary fields plus confirmed", async ({ domain, label, change }) => {
  let summary: TrackerUpdateSummary<typeof domain> | undefined;
  let completedRecord: TrackerRecordByDomain[typeof domain] | undefined;
  const update = jest.fn()
    .mockImplementationOnce(async (requestedDomain, id, input, expectedUpdatedAt) => {
      summary = Object.freeze({ action: "update", domain: requestedDomain, id, input, expectedUpdatedAt });
      return Object.freeze({ status: "confirmation_required", summary });
    })
    .mockImplementationOnce(async () => {
      completedRecord = Object.freeze({
        ...records[domain], ...summary!.input, updatedAt: "2026-07-20T00:03:00.000Z",
      }) as TrackerRecordByDomain[typeof domain];
      return Object.freeze({ status: "completed", summary, record: completedRecord });
    });
  const list = jest.fn(async (requested) => requested === domain ? [completedRecord ?? records[domain]] : []);
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records[domain]) as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
  });
  await openEditor(domain, label, service);
  change();
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  fireEvent.press(await screen.findByRole("button", { name: "确认保存" }));
  await screen.findByRole("header", { name: `${label}记录` });

  expect(summary).toBeDefined();
  expect(update.mock.calls[1]).toEqual([
    summary!.domain, summary!.id, summary!.input, summary!.expectedUpdatedAt, "confirmed",
  ]);
  expect(update.mock.calls[1]![2]).toBe(summary!.input);
  expect(completedRecord?.updatedAt).toBe("2026-07-20T00:03:00.000Z");
  expect(observedStatesAfter("MUTATION_COMPLETED", "update")).toEqual(expect.arrayContaining([
    expect.objectContaining({
      tag: "mutation.completed",
      completion: expect.objectContaining({ kind: "update", record: completedRecord }),
    }),
  ]));
  for (const state of observedStatesAfter("MUTATION_COMPLETED", "update")) {
    if (state.tag === "mutation.completed" && state.completion.kind === "update") {
      expect(state.completion.record).toBe(completedRecord);
    }
  }
  const updateRefreshStates = observedStatesAfter("OPERATION_REFRESH_STARTED", "update");
  expect(updateRefreshStates.some((state) => (
    state.tag === "list.loading"
    && state.source === "mutation-refresh"
    && state.completion.kind === "update"
    && state.completion.record === completedRecord
  ))).toBe(true);
  expect(list).toHaveBeenLastCalledWith(domain, 100);
});

test("refresh success replaces the full workspace in exact service order and removes stale rows", async () => {
  const stale = Object.freeze({
    ...records.health, id: "stale-health-id", updatedAt: "2026-07-20T00:01:30.000Z", title: "陈旧记录",
  });
  const serviceSecond = Object.freeze({
    ...records.health, id: "service-second-id", updatedAt: "2026-07-20T00:04:00.000Z", title: "服务第二",
  });
  const serviceFirst = Object.freeze({
    ...records.health, id: "service-first-id", updatedAt: "2026-07-20T00:05:00.000Z", title: "服务第一",
  });
  const summary: TrackerUpdateSummary<"health"> = Object.freeze({
    action: "update", domain: "health", id: records.health.id,
    expectedUpdatedAt: records.health.updatedAt, input: expectedUpdateInputs.health,
  });
  const update = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary }))
    .mockResolvedValueOnce(Object.freeze({
      status: "completed", summary,
      record: Object.freeze({ ...records.health, ...summary.input, updatedAt: "2026-07-20T00:03:00.000Z" }),
    }));
  const list = jest.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([records.health, stale])
    .mockResolvedValueOnce([serviceSecond, serviceFirst]);
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.health) as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
  });
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("tab", { name: "健康" }));
  const priorRows = await screen.findAllByRole("button", { name: /健康记录，/ });
  expect(priorRows).toHaveLength(2);
  fireEvent.press(priorRows[0]!);
  await screen.findByRole("header", { name: "编辑健康记录" });
  fireEvent.changeText(screen.getByLabelText("标题"), "复查");
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  fireEvent.press(await screen.findByRole("button", { name: "确认保存" }));

  const refreshedRows = await screen.findAllByRole("button", { name: /健康记录，/ });
  expect(refreshedRows.map((row) => row.props.accessibilityLabel)).toEqual([
    expect.stringContaining("服务第二"),
    expect.stringContaining("服务第一"),
  ]);
  expect(screen.queryByText("陈旧记录")).toBeNull();
  expect(list).toHaveBeenLastCalledWith("health", 100);
});

test("delete cancel cannot leak its summary into a distinct record and failed refresh removes only the completed id", async () => {
  const second = Object.freeze({
    ...records.health,
    id: "second-health-private-id",
    updatedAt: "2026-07-20T00:07:00.000Z",
    title: "第二条健康记录",
  });
  const firstSummary: TrackerDeleteSummary<"health"> = Object.freeze({
    action: "delete", domain: "health", id: records.health.id, expectedUpdatedAt: records.health.updatedAt,
  });
  const secondSummary: TrackerDeleteSummary<"health"> = Object.freeze({
    action: "delete", domain: "health", id: second.id, expectedUpdatedAt: second.updatedAt,
  });
  let completed = false;
  const remove = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary: firstSummary }))
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary: secondSummary }))
    .mockImplementationOnce(async () => {
      completed = true;
      return Object.freeze({
        status: "completed", summary: secondSummary,
        deletion: Object.freeze({
          domain: "health" as const, id: second.id,
          updatedAt: "2026-07-20T00:08:00.000Z", deletedAt: "2026-07-20T00:08:00.000Z",
        }),
      });
    });
  const list = jest.fn(async (domain) => {
    if (completed && domain === "health") throw new Error("refresh unavailable");
    return domain === "health" ? [records.health, second] : [];
  });
  const create = jest.fn();
  const update = jest.fn();
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: jest.fn(async (_domain, id) => id === second.id ? second : records.health) as ManualTrackerServicePort["getById"],
    create: create as ManualTrackerServicePort["create"],
    update: update as ManualTrackerServicePort["update"],
    delete: remove as ManualTrackerServicePort["delete"],
  });
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("tab", { name: "健康" }));
  let rows = await screen.findAllByRole("button", { name: /健康记录，/ });
  fireEvent.press(rows[0]!);
  await screen.findByRole("header", { name: "编辑健康记录" });
  fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
  fireEvent.press(await screen.findByRole("button", { name: "取消" }));
  fireEvent.press(screen.getByRole("button", { name: "返回健康列表" }));

  rows = await screen.findAllByRole("button", { name: /健康记录，/ });
  fireEvent.press(rows[1]!);
  await screen.findByRole("header", { name: "编辑健康记录" });
  fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
  fireEvent.press(await screen.findByRole("button", { name: "确认删除" }));
  await screen.findByText("记录可能不是最新内容。");

  expect(remove.mock.calls).toEqual([
    ["health", firstSummary.id, firstSummary.expectedUpdatedAt],
    ["health", secondSummary.id, secondSummary.expectedUpdatedAt],
    ["health", secondSummary.id, secondSummary.expectedUpdatedAt, "confirmed"],
  ]);
  const retainedRows = screen.getAllByRole("button", { name: /健康记录，/ });
  expect(retainedRows).toHaveLength(1);
  expect(retainedRows[0]!.props.accessibilityLabel).toContain(records.health.title);
  expect(retainedRows[0]!.props.accessibilityLabel).not.toContain(second.title);
  const mutationCounts = Object.freeze({ create: create.mock.calls.length, update: update.mock.calls.length, delete: remove.mock.calls.length });
  const listCount = list.mock.calls.length;
  fireEvent.press(screen.getByRole("button", { name: "重新读取记录" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(listCount + 1));
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(create).toHaveBeenCalledTimes(mutationCounts.create);
  expect(update).toHaveBeenCalledTimes(mutationCounts.update);
  expect(remove).toHaveBeenCalledTimes(mutationCounts.delete);
});

test("completed delete preserves the exact returned deletion fact without enumerating or cloning it", async () => {
  const summary: TrackerDeleteSummary<"health"> = Object.freeze({
    action: "delete", domain: "health", id: records.health.id, expectedUpdatedAt: records.health.updatedAt,
  });
  const deletion = new Proxy(Object.freeze({
    domain: "health" as const,
    id: records.health.id,
    updatedAt: "2026-07-20T00:03:00.000Z",
    deletedAt: "2026-07-20T00:03:00.000Z",
  }), {
    ownKeys: () => { throw new Error("the completed deletion fact must not be cloned"); },
  });
  const remove = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary }))
    .mockResolvedValueOnce(Object.freeze({ status: "completed", summary, deletion }));
  const list = jest.fn(async (domain) => domain === "health" ? [records.health] : []);
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.health) as ManualTrackerServicePort["getById"],
    delete: remove as ManualTrackerServicePort["delete"],
  });
  await openEditor("health", "健康", service);
  fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
  fireEvent.press(await screen.findByRole("button", { name: "确认删除" }));

  await screen.findByRole("header", { name: "健康记录" });
  const completedStates = observedStatesAfter("MUTATION_COMPLETED", "delete");
  expect(completedStates.some((state) => (
    state.tag === "mutation.completed"
    && state.completion.kind === "delete"
    && state.completion.deletion === deletion
  ))).toBe(true);
  const refreshStates = observedStatesAfter("OPERATION_REFRESH_STARTED", "delete");
  expect(refreshStates.some((state) => (
    state.tag === "list.loading"
    && state.source === "mutation-refresh"
    && state.completion.kind === "delete"
    && state.completion.deletion === deletion
  ))).toBe(true);
  expect(list).toHaveBeenLastCalledWith("health", 100);
});

test.each(editCases)("$domain delete cancel retains the exact editor and accept uses the frozen revision", async ({ domain, label }) => {
  const summary: TrackerDeleteSummary<typeof domain> = Object.freeze({
    action: "delete", domain, id: records[domain].id, expectedUpdatedAt: records[domain].updatedAt,
  });
  let deleted = false;
  const remove = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary }))
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary }))
    .mockImplementationOnce(async () => {
      deleted = true;
      return Object.freeze({
        status: "completed", summary,
        deletion: Object.freeze({ domain, id: summary.id, updatedAt: "2026-07-20T00:03:00.000Z", deletedAt: "2026-07-20T00:03:00.000Z" }),
      });
    });
  const list = jest.fn(async (requested) => {
    if (deleted && requested === domain) throw new Error("refresh unavailable");
    return requested === domain ? [records[domain]] : [];
  });
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records[domain]) as ManualTrackerServicePort["getById"],
    delete: remove as ManualTrackerServicePort["delete"],
  });
  await openEditor(domain, label, service);
  const frozenEditor = visibleEditorSnapshot(domain);
  fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
  expect(await screen.findByText("删除后不会出现在记录列表中；当前版本没有恢复入口。")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "取消" }));
  expect(visibleEditorSnapshot(domain)).toEqual(frozenEditor);
  expect(screen.getByRole("header", { name: `编辑${label}记录` })).toBeTruthy();
  expect(remove).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
  fireEvent.press(await screen.findByRole("button", { name: "确认删除" }));
  await screen.findByText("记录可能不是最新内容。");
  expect(remove.mock.calls[2]).toEqual([domain, summary.id, summary.expectedUpdatedAt, "confirmed"]);
  expect(screen.queryByRole("button", { name: new RegExp(`${label}记录，`) })).toBeNull();
});

test("the reducer restores the exact editor and rejects confirmed-from-editor and pre-completion refresh transitions", () => {
  const prior: ListFact<"health"> = Object.freeze({ domain: "health", rows: Object.freeze([records.health]), presentationZone: zone });
  const draft = Object.freeze({
    domain: "health" as const, timeZone: zone, dateText: records.health.recordDate,
    recordType: records.health.recordType, title: "复查", description: records.health.description ?? "",
  });
  const editor: EditEditorSnapshot<"health"> = Object.freeze({
    mode: "edit", domain: "health", draft, initialDraft: Object.freeze({ ...draft, title: records.health.title }),
    baseline: records.health, capturedZone: zone, errors: Object.freeze({}), prior,
  });
  const owner: OperationOwner<"health", "update"> = Object.freeze({
    mountEpoch: 1, operationId: 7, domain: "health", kind: "update",
  });
  const summary: TrackerUpdateSummary<"health"> = Object.freeze({
    action: "update", domain: "health", id: records.health.id,
    expectedUpdatedAt: records.health.updatedAt, input: expectedUpdateInputs.health,
  });
  const decision = Object.freeze({
    kind: "update" as const, domain: "health" as const, prior: editor, baseline: records.health,
    initiatingControlRef: Object.freeze({ current: null }), serviceSummary: summary, presentationTimeZone: zone,
  });
  const editing: TrackerScreenState = Object.freeze({ tag: "edit.editing", editor });

  const illegalConfirmed = trackerScreenReducer(editing, {
    type: "MUTATION_STARTED", owner, prior: editor, phase: "confirmed", decision,
  } as TrackerScreenAction);
  expect(illegalConfirmed).toBe(editing);

  const probing = trackerScreenReducer(editing, { type: "MUTATION_STARTED", owner, prior: editor, phase: "probe" });
  expect(probing.tag).toBe("mutation.submitting");
  const prematureRefresh = trackerScreenReducer(probing, {
    type: "OPERATION_REFRESH_STARTED",
    owner,
    next: Object.freeze({
      tag: "list.loading", source: "mutation-refresh", owner, prior, success: "健康记录已更新",
    }),
  });
  expect(prematureRefresh).toBe(probing);

  const confirmation = trackerScreenReducer(probing, {
    type: "CONFIRMATION_REQUIRED",
    owner,
    next: Object.freeze({ tag: "confirm.update", owner, decision }),
    summary: decision.serviceSummary,
  });
  const restored = trackerScreenReducer(confirmation, { type: "CONFIRMATION_CANCELLED", decision });
  expect(restored).toEqual({ tag: "edit.editing", editor });
  if (restored.tag !== "edit.editing") throw new Error("expected restored editor");
  expect(restored.editor).toBe(editor);
  expect(restored.editor.draft).toBe(draft);
  expect(restored.editor.baseline).toBe(records.health);
  expect(restored.editor.baseline.updatedAt).toBe(records.health.updatedAt);

  const confirmed = trackerScreenReducer(confirmation, {
    type: "MUTATION_STARTED", owner, prior: editor, phase: "confirmed", decision,
  });
  const foreignRecord = Object.freeze({
    ...records.growth,
    id: records.health.id,
    updatedAt: "2026-07-20T00:04:00.000Z",
  });
  const foreignCompletion = Object.freeze({ kind: "update" as const, record: foreignRecord });
  expect(trackerScreenReducer(confirmed, {
    type: "MUTATION_COMPLETED", owner, completion: foreignCompletion,
  } as unknown as TrackerScreenAction)).toBe(confirmed);
  const completedRecord = Object.freeze({
    ...records.health, ...expectedUpdateInputs.health, updatedAt: "2026-07-20T00:04:00.000Z",
  });
  const completion = Object.freeze({ kind: "update" as const, record: completedRecord });
  const completed = trackerScreenReducer(confirmed, { type: "MUTATION_COMPLETED", owner, completion });
  expect(completed).toMatchObject({ tag: "mutation.completed", owner, completion });
  if (completed.tag !== "mutation.completed") throw new Error("expected completed mutation fact");
  expect(completed.completion).toBe(completion);
  expect(completed.completion.kind).toBe("update");
  if (completed.completion.kind !== "update") throw new Error("expected update completion");
  expect(completed.completion.record).toBe(completedRecord);
  expect(completed.completion.record.updatedAt).toBe("2026-07-20T00:04:00.000Z");

  const refreshing = trackerScreenReducer(completed, {
    type: "OPERATION_REFRESH_STARTED",
    owner,
    next: Object.freeze({
      tag: "list.loading", source: "mutation-refresh", owner, prior, success: "健康记录已更新",
    }),
  });
  const failedRefresh = trackerScreenReducer(refreshing, { type: "OPERATION_REFRESH_FAILED", owner });
  expect(failedRefresh).toMatchObject({ tag: "list.error", kind: "refresh", fact: prior, completion });
  if (failedRefresh.tag !== "list.error" || failedRefresh.kind !== "refresh") {
    throw new Error("expected refresh failure");
  }
  expect(failedRefresh.fact).toBe(prior);
  expect(failedRefresh.fact.rows).toBe(prior.rows);
  expect(failedRefresh.completion).toBe(completion);
});

test("protected states reject stale or unauthorized read/create starts while exact conflict and discard identities authorize only their destination", () => {
  const prior: ListFact<"health"> = Object.freeze({ domain: "health", rows: Object.freeze([records.health]), presentationZone: zone });
  const draft = Object.freeze({
    domain: "health" as const, timeZone: zone, dateText: records.health.recordDate,
    recordType: records.health.recordType, title: "复查", description: records.health.description ?? "",
  });
  const editor: EditEditorSnapshot<"health"> = Object.freeze({
    mode: "edit", domain: "health", draft, initialDraft: Object.freeze({ ...draft, title: records.health.title }),
    baseline: records.health, capturedZone: zone, errors: Object.freeze({}), prior,
  });
  const editing: TrackerScreenState = Object.freeze({ tag: "edit.editing", editor });
  const updateOwner: OperationOwner<"health", "update"> = Object.freeze({ mountEpoch: 1, operationId: 10, domain: "health", kind: "update" });
  const probing = trackerScreenReducer(editing, { type: "MUTATION_STARTED", owner: updateOwner, prior: editor, phase: "probe" });
  if (probing.tag !== "mutation.submitting") throw new Error("expected probe");
  const conflict = trackerScreenReducer(probing, { type: "MUTATION_CONFLICT", source: probing, conflictCode: "stale_write" });
  const listOwner = Object.freeze({ mountEpoch: 1, generation: 11, domain: "health" as const, focusSession: 1, kind: "list" as const, recordId: undefined });
  const listNext = Object.freeze({ tag: "list.loading" as const, source: "ordinary" as const, owner: listOwner, prior });
  const getOwner = Object.freeze({ mountEpoch: 1, generation: 12, domain: "health" as const, focusSession: 1, kind: "get" as const, recordId: records.health.id });
  const getNext = Object.freeze({ tag: "edit.loading" as const, owner: getOwner, id: records.health.id, capturedZone: zone, prior });

  expect(trackerScreenReducer(conflict, listStartedAction(editing, listNext))).toBe(conflict);
  expect(trackerScreenReducer(conflict, getStartedAction(editing, getNext))).toBe(conflict);
  expect(trackerScreenReducer(conflict, createRequestedAction(editing, Object.freeze({
    mode: "create", domain: "health", draft, initialDraft: draft, baseline: null,
    capturedZone: zone, errors: Object.freeze({}), prior,
  })))).toBe(conflict);
  expect(trackerScreenReducer(conflict, listStartedAction(conflict, listNext))).toBe(conflict);
  expect(trackerScreenReducer(conflict, getStartedAction(conflict, getNext))).toBe(conflict);
  expect(trackerScreenReducer(conflict, { type: "RETURN_TO_LIST" })).toBe(conflict);

  const cleanEditor = Object.freeze({ ...editor, draft: editor.initialDraft });
  const cleanProbe = Object.freeze({ tag: "mutation.submitting" as const, owner: updateOwner, prior: cleanEditor, phase: "probe" as const, decision: undefined });
  const cleanConflict: TrackerScreenState = Object.freeze({ tag: "conflict.stale", source: cleanProbe });
  expect(trackerScreenReducer(cleanConflict, getStartedAction(cleanConflict, getNext))).toBe(getNext);

  const feedingPrior: ListFact<"feeding"> = Object.freeze({ domain: "feeding", rows: Object.freeze([]), presentationZone: zone });
  const feedingOwner = Object.freeze({ ...listOwner, generation: 13, domain: "feeding" as const });
  const feedingNext = Object.freeze({ ...listNext, owner: feedingOwner, prior: feedingPrior });
  expect(trackerScreenReducer(editing, listStartedAction(editing, feedingNext))).toBe(editing);
  expect(trackerScreenReducer(editing, { type: "RETURN_TO_LIST" })).toBe(editing);

  const decision = backDiscardDecision(editing, Object.freeze({ current: null }));
  if (decision === null) throw new Error("expected discard decision");
  const cleanEditing: TrackerScreenState = Object.freeze({ tag: "edit.editing", editor: cleanEditor });
  const cleanDecision = backDiscardDecision(cleanEditing, Object.freeze({ current: null }));
  if (cleanDecision === null) throw new Error("expected clean discard decision");
  expect(trackerScreenReducer(cleanEditing, discardRequestedAction(cleanDecision))).toBe(cleanEditing);
  const discard = trackerScreenReducer(editing, discardRequestedAction(decision));
  if (discard.tag !== "confirm.discard") throw new Error("expected discard confirmation");
  const copied = Object.freeze({ ...decision });
  expect(trackerScreenReducer(discard, listStartedAction(discard, listNext))).toBe(discard);
  expect(trackerScreenReducer(discard, getStartedAction(discard, getNext))).toBe(discard);
  expect(trackerScreenReducer(discard, { type: "LIST_STARTED", source: discard, next: listNext, decision: copied } as unknown as TrackerScreenAction)).toBe(discard);
  const acceptedBack = isListDiscardDecisionForDestination(decision, prior)
    ? acceptedDiscardListStartedAction(discard, listNext, decision)
    : null;
  expect(acceptedBack).toBeNull();
  expect(trackerScreenReducer(discard, createRequestedAction(discard, Object.freeze({
    mode: "create", domain: "health", draft, initialDraft: draft, baseline: null,
    capturedZone: zone, errors: Object.freeze({}), prior,
  })))).toBe(discard);
});

test("accepted discard read helpers reject stale destination-equivalent decisions and preserve the exact current decision", () => {
  const prior: ListFact<"health"> = Object.freeze({ domain: "health", rows: Object.freeze([records.health]), presentationZone: zone });
  const draft = Object.freeze({
    domain: "health" as const, timeZone: zone, dateText: records.health.recordDate,
    recordType: records.health.recordType, title: "复查", description: records.health.description ?? "",
  });
  const editor: EditEditorSnapshot<"health"> = Object.freeze({
    mode: "edit", domain: "health", draft, initialDraft: Object.freeze({ ...draft, title: records.health.title }),
    baseline: records.health, capturedZone: zone, errors: Object.freeze({}), prior,
  });
  const owner: OperationOwner<"health", "update"> = Object.freeze({ mountEpoch: 1, operationId: 40, domain: "health", kind: "update" });
  const submitting = Object.freeze({ tag: "mutation.submitting" as const, owner, prior: editor, phase: "probe" as const, decision: undefined });
  const conflict: TrackerScreenState = Object.freeze({ tag: "conflict.stale", source: submitting });
  const oldRef = Object.freeze({ current: null });
  const currentRef = Object.freeze({ current: null });

  const listOld = conflictDiscardDecision(conflict, "reload-list", oldRef);
  const listCurrent = conflictDiscardDecision(conflict, "reload-list", currentRef);
  if (listOld === null || listCurrent === null) throw new Error("expected list discard decisions");
  expect(listOld).not.toBe(listCurrent);
  expect(listOld.destination).not.toBe(listCurrent.destination);
  if (!("kind" in listOld.destination) || !("kind" in listCurrent.destination)) throw new Error("expected list destinations");
  expect(listOld.destination.kind).toBe("reload-list");
  expect(listCurrent.destination.kind).toBe("reload-list");
  if (listOld.destination.kind !== "reload-list" || listCurrent.destination.kind !== "reload-list") throw new Error("expected reload-list destinations");
  expect(listOld.destination.fact).toBe(listCurrent.destination.fact);
  const listConfirmation = trackerScreenReducer(conflict, discardRequestedAction(listCurrent));
  if (listConfirmation.tag !== "confirm.discard") throw new Error("expected current list confirmation");
  const listOwner = Object.freeze({ mountEpoch: 1, generation: 41, domain: "health" as const, focusSession: 1, kind: "list" as const, recordId: undefined });
  const listNext = Object.freeze({ tag: "list.loading" as const, source: "ordinary" as const, owner: listOwner, prior });
  if (!isListDiscardDecisionForDestination(listOld, prior) || !isListDiscardDecisionForDestination(listCurrent, prior)) {
    throw new Error("expected correlated list decisions");
  }
  expect(acceptedDiscardListStartedAction(listConfirmation, listNext, listOld)).toBeNull();
  const acceptedList = acceptedDiscardListStartedAction(listConfirmation, listNext, listCurrent);
  expect(acceptedList).not.toBeNull();
  expect(acceptedList?.type === "LIST_STARTED" ? acceptedList.decision : null).toBe(listCurrent);
  expect(acceptedList === null ? listConfirmation : trackerScreenReducer(listConfirmation, acceptedList)).toBe(listNext);

  const getOld = conflictDiscardDecision(conflict, "reload-record", oldRef);
  const getCurrent = conflictDiscardDecision(conflict, "reload-record", currentRef);
  if (getOld === null || getCurrent === null) throw new Error("expected get discard decisions");
  expect(getOld).not.toBe(getCurrent);
  if (!("kind" in getOld.destination) || !("kind" in getCurrent.destination)) throw new Error("expected get destinations");
  if (getOld.destination.kind !== "reload-record" || getCurrent.destination.kind !== "reload-record") throw new Error("expected reload-record destinations");
  expect(getOld.destination.domain).toBe(getCurrent.destination.domain);
  expect(getOld.destination.id).toBe(getCurrent.destination.id);
  expect(getOld.destination.prior).toBe(getCurrent.destination.prior);
  const getConfirmation = trackerScreenReducer(conflict, discardRequestedAction(getCurrent));
  if (getConfirmation.tag !== "confirm.discard") throw new Error("expected current get confirmation");
  const getOwner = Object.freeze({ mountEpoch: 1, generation: 42, domain: "health" as const, focusSession: 1, kind: "get" as const, recordId: records.health.id });
  const getNext = Object.freeze({ tag: "edit.loading" as const, owner: getOwner, id: records.health.id, capturedZone: zone, prior });
  if (
    !isGetDiscardDecisionForDestination(getOld, "health", records.health.id, prior)
    || !isGetDiscardDecisionForDestination(getCurrent, "health", records.health.id, prior)
  ) throw new Error("expected correlated get decisions");
  expect(acceptedDiscardGetStartedAction(getConfirmation, getNext, getOld)).toBeNull();
  const acceptedGet = acceptedDiscardGetStartedAction(getConfirmation, getNext, getCurrent);
  expect(acceptedGet).not.toBeNull();
  expect(acceptedGet?.type === "GET_STARTED" ? acceptedGet.decision : null).toBe(getCurrent);
  expect(acceptedGet === null ? getConfirmation : trackerScreenReducer(getConfirmation, acceptedGet)).toBe(getNext);
});

test("mutation-error retry requires a fresh same-kind owner and the exact direct/probe protocol", () => {
  const prior: ListFact<"growth"> = Object.freeze({ domain: "growth", rows: Object.freeze([records.growth]), presentationZone: zone });
  const draft = Object.freeze({ domain: "growth" as const, timeZone: zone, dateText: records.growth.measurementDate, weightG: "7300", heightCm: "68.5", headCm: "", notes: records.growth.notes ?? "" });
  const editor: EditEditorSnapshot<"growth"> = Object.freeze({
    mode: "edit", domain: "growth", draft, initialDraft: Object.freeze({ ...draft, weightG: "7200" }), baseline: records.growth,
    capturedZone: zone, errors: Object.freeze({}), prior,
  });
  const editing: TrackerScreenState = Object.freeze({ tag: "edit.editing", editor });
  const owner: OperationOwner<"growth", "update"> = Object.freeze({ mountEpoch: 1, operationId: 20, domain: "growth", kind: "update" });
  const probing = trackerScreenReducer(editing, { type: "MUTATION_STARTED", owner, prior: editor, phase: "probe" });
  const failed = trackerScreenReducer(probing, { type: "MUTATION_REJECTED", owner, message: "保存失败" });
  expect(failed.tag).toBe("mutation.error");
  expect(trackerScreenReducer(failed, { type: "MUTATION_STARTED", owner, prior: editor, phase: "probe" })).toBe(failed);

  const older: OperationOwner<"growth", "update"> = Object.freeze({ ...owner, operationId: 19 });
  expect(trackerScreenReducer(failed, { type: "MUTATION_STARTED", owner: older, prior: editor, phase: "probe" })).toBe(failed);
  const crossMount: OperationOwner<"growth", "update"> = Object.freeze({ ...owner, mountEpoch: 2, operationId: 21 });
  expect(trackerScreenReducer(failed, { type: "MUTATION_STARTED", owner: crossMount, prior: editor, phase: "probe" })).toBe(failed);

  const wrongKind: OperationOwner<"growth", "delete"> = Object.freeze({ ...owner, operationId: 21, kind: "delete" });
  expect(trackerScreenReducer(failed, { type: "MUTATION_STARTED", owner: wrongKind, prior: editor, phase: "probe" })).toBe(failed);
  const fresh: OperationOwner<"growth", "update"> = Object.freeze({ ...owner, operationId: 22 });
  const retried = trackerScreenReducer(failed, { type: "MUTATION_STARTED", owner: fresh, prior: editor, phase: "probe" });
  expect(retried).toEqual({ tag: "mutation.submitting", owner: fresh, prior: editor, phase: "probe", decision: undefined });

  const malformedDirect = { type: "MUTATION_STARTED", owner: fresh, prior: editor, phase: "direct" } as unknown as TrackerScreenAction;
  expect(trackerScreenReducer(failed, malformedDirect)).toBe(failed);
});

test("retry freshness and exact-prior guards cover direct create, health create, and delete probes", () => {
  const growthPrior: ListFact<"growth"> = Object.freeze({ domain: "growth", rows: Object.freeze([records.growth]), presentationZone: zone });
  const growthDraft = Object.freeze({
    domain: "growth" as const, timeZone: zone, dateText: records.growth.measurementDate,
    weightG: "7300", heightCm: "68.5", headCm: "", notes: records.growth.notes ?? "",
  });
  const growthCreate: CreateEditorSnapshot<"growth"> = Object.freeze({
    mode: "create", domain: "growth", draft: growthDraft, initialDraft: growthDraft,
    baseline: null, capturedZone: zone, errors: Object.freeze({}), prior: growthPrior,
  });
  const growthOwner: OperationOwner<"growth", "create"> = Object.freeze({ mountEpoch: 3, operationId: 10, domain: "growth", kind: "create" });
  const growthSubmitting = trackerScreenReducer(Object.freeze({ tag: "create.editing", editor: growthCreate }), {
    type: "MUTATION_STARTED", owner: growthOwner, prior: growthCreate,
  });
  const growthFailed = trackerScreenReducer(growthSubmitting, { type: "MUTATION_REJECTED", owner: growthOwner, message: "保存失败" });
  if (growthFailed.tag !== "mutation.error") throw new Error("expected direct-create failure");
  const copiedGrowthCreate = Object.freeze({ ...growthCreate });
  expect(trackerScreenReducer(growthFailed, { type: "MUTATION_STARTED", owner: growthOwner, prior: growthCreate })).toBe(growthFailed);
  expect(trackerScreenReducer(growthFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...growthOwner, operationId: 9 }), prior: growthCreate })).toBe(growthFailed);
  expect(trackerScreenReducer(growthFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...growthOwner, mountEpoch: 4, operationId: 11 }), prior: growthCreate })).toBe(growthFailed);
  expect(trackerScreenReducer(growthFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...growthOwner, operationId: 11 }), prior: copiedGrowthCreate })).toBe(growthFailed);
  const growthFresh = Object.freeze({ ...growthOwner, operationId: 11 });
  expect(trackerScreenReducer(growthFailed, { type: "MUTATION_STARTED", owner: growthFresh, prior: growthCreate })).toEqual({
    tag: "mutation.submitting", owner: growthFresh, prior: growthCreate, phase: "direct", decision: undefined,
  });

  const healthPrior: ListFact<"health"> = Object.freeze({ domain: "health", rows: Object.freeze([]), presentationZone: zone });
  const healthDraft = Object.freeze({ domain: "health" as const, timeZone: zone, dateText: records.health.recordDate, recordType: "illness" as const, title: "轻微咳嗽", description: "居家观察" });
  const healthCreate: CreateEditorSnapshot<"health"> = Object.freeze({ mode: "create", domain: "health", draft: healthDraft, initialDraft: healthDraft, baseline: null, capturedZone: zone, errors: Object.freeze({}), prior: healthPrior });
  const healthOwner: OperationOwner<"health", "create"> = Object.freeze({ mountEpoch: 5, operationId: 20, domain: "health", kind: "create" });
  const healthSubmitting = trackerScreenReducer(Object.freeze({ tag: "create.editing", editor: healthCreate }), { type: "MUTATION_STARTED", owner: healthOwner, prior: healthCreate, phase: "probe" });
  const healthFailed = trackerScreenReducer(healthSubmitting, { type: "MUTATION_REJECTED", owner: healthOwner, message: "保存失败" });
  if (healthFailed.tag !== "mutation.error") throw new Error("expected health-create failure");
  const copiedHealthCreate = Object.freeze({ ...healthCreate });
  expect(trackerScreenReducer(healthFailed, { type: "MUTATION_STARTED", owner: healthOwner, prior: healthCreate, phase: "probe" })).toBe(healthFailed);
  expect(trackerScreenReducer(healthFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...healthOwner, operationId: 19 }), prior: healthCreate, phase: "probe" })).toBe(healthFailed);
  expect(trackerScreenReducer(healthFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...healthOwner, mountEpoch: 6, operationId: 21 }), prior: healthCreate, phase: "probe" })).toBe(healthFailed);
  expect(trackerScreenReducer(healthFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...healthOwner, operationId: 21 }), prior: copiedHealthCreate, phase: "probe" })).toBe(healthFailed);
  const healthFresh = Object.freeze({ ...healthOwner, operationId: 21 });
  expect(trackerScreenReducer(healthFailed, { type: "MUTATION_STARTED", owner: healthFresh, prior: healthCreate, phase: "probe" })).toEqual({
    tag: "mutation.submitting", owner: healthFresh, prior: healthCreate, phase: "probe", decision: undefined,
  });

  const editDraft = Object.freeze({ ...growthDraft, weightG: "7400" });
  const edit: EditEditorSnapshot<"growth"> = Object.freeze({ mode: "edit", domain: "growth", draft: editDraft, initialDraft: growthDraft, baseline: records.growth, capturedZone: zone, errors: Object.freeze({}), prior: growthPrior });
  const deleteOwner: OperationOwner<"growth", "delete"> = Object.freeze({ mountEpoch: 7, operationId: 30, domain: "growth", kind: "delete" });
  const deleteSubmitting = trackerScreenReducer(Object.freeze({ tag: "edit.editing", editor: edit }), { type: "MUTATION_STARTED", owner: deleteOwner, prior: edit, phase: "probe" });
  const deleteFailed = trackerScreenReducer(deleteSubmitting, { type: "MUTATION_REJECTED", owner: deleteOwner, message: "删除失败" });
  if (deleteFailed.tag !== "mutation.error") throw new Error("expected delete failure");
  const copiedEdit = Object.freeze({ ...edit });
  const wrongDecision = backDiscardDecision(Object.freeze({ tag: "edit.editing", editor: edit }), Object.freeze({ current: null }));
  expect(trackerScreenReducer(deleteFailed, { type: "MUTATION_STARTED", owner: deleteOwner, prior: edit, phase: "probe" })).toBe(deleteFailed);
  expect(trackerScreenReducer(deleteFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...deleteOwner, operationId: 29 }), prior: edit, phase: "probe" })).toBe(deleteFailed);
  expect(trackerScreenReducer(deleteFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...deleteOwner, mountEpoch: 8, operationId: 31 }), prior: edit, phase: "probe" })).toBe(deleteFailed);
  expect(trackerScreenReducer(deleteFailed, { type: "MUTATION_STARTED", owner: Object.freeze({ ...deleteOwner, operationId: 31 }), prior: copiedEdit, phase: "probe" })).toBe(deleteFailed);
  expect(trackerScreenReducer(deleteFailed, {
    type: "MUTATION_STARTED", owner: Object.freeze({ ...deleteOwner, operationId: 31 }), prior: edit, phase: "confirmed", decision: wrongDecision,
  } as unknown as TrackerScreenAction)).toBe(deleteFailed);
  const deleteFresh = Object.freeze({ ...deleteOwner, operationId: 31 });
  expect(trackerScreenReducer(deleteFailed, { type: "MUTATION_STARTED", owner: deleteFresh, prior: edit, phase: "probe" })).toEqual({
    tag: "mutation.submitting", owner: deleteFresh, prior: edit, phase: "probe", decision: undefined,
  });
});

test("confirmation boundary rejects copied baseline and mismatched kind, id, token, or owner", () => {
  const prior: ListFact<"growth"> = Object.freeze({ domain: "growth", rows: Object.freeze([records.growth]), presentationZone: zone });
  const draft = Object.freeze({ domain: "growth" as const, timeZone: zone, dateText: records.growth.measurementDate, weightG: "7300", heightCm: "68.5", headCm: "", notes: records.growth.notes ?? "" });
  const editor: EditEditorSnapshot<"growth"> = Object.freeze({ mode: "edit", domain: "growth", draft, initialDraft: Object.freeze({ ...draft, weightG: "7200" }), baseline: records.growth, capturedZone: zone, errors: Object.freeze({}), prior });
  const owner: OperationOwner<"growth", "update"> = Object.freeze({ mountEpoch: 1, operationId: 30, domain: "growth", kind: "update" });
  const probing = trackerScreenReducer(Object.freeze({ tag: "edit.editing", editor }), { type: "MUTATION_STARTED", owner, prior: editor, phase: "probe" });
  const summary: TrackerUpdateSummary<"growth"> = Object.freeze({ action: "update", domain: "growth", id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt, input: expectedUpdateInputs.growth });
  const baseDecision = Object.freeze({ kind: "update" as const, domain: "growth" as const, prior: editor, baseline: records.growth, initiatingControlRef: Object.freeze({ current: null }), serviceSummary: summary, presentationTimeZone: zone });
  const malformed = [
    Object.freeze({ ...baseDecision, baseline: Object.freeze({ ...records.growth }) }),
    Object.freeze({ ...baseDecision, serviceSummary: Object.freeze({ ...summary, id: "copied-id" }) }),
    Object.freeze({ ...baseDecision, serviceSummary: Object.freeze({ ...summary, expectedUpdatedAt: "copied-token" }) }),
  ];
  for (const decision of malformed) {
    expect(trackerScreenReducer(probing, { type: "CONFIRMATION_REQUIRED", owner, next: Object.freeze({ tag: "confirm.update", owner, decision }), summary } as TrackerScreenAction)).toBe(probing);
  }
  const deleteOwner: OperationOwner<"growth", "delete"> = Object.freeze({ ...owner, kind: "delete" });
  expect(trackerScreenReducer(probing, { type: "CONFIRMATION_REQUIRED", owner: deleteOwner, next: Object.freeze({ tag: "confirm.update", owner: deleteOwner, decision: baseDecision }), summary } as unknown as TrackerScreenAction)).toBe(probing);
  expect(trackerScreenReducer(probing, { type: "CONFIRMATION_REQUIRED", owner, next: Object.freeze({ tag: "confirm.delete", owner, decision: baseDecision }), summary } as unknown as TrackerScreenAction)).toBe(probing);
  expect(trackerScreenReducer(probing, { type: "CONFIRMATION_REQUIRED", owner, next: Object.freeze({ tag: "confirm.update", owner, decision: baseDecision }), summary })).not.toBe(probing);
});

test.each(editCases)("$domain normalized no-op retains the exact baseline, revision, and prior fact", ({ domain }) => {
  const baseline = records[domain];
  const prior = Object.freeze({
    domain,
    rows: Object.freeze([baseline]),
    presentationZone: zone,
  }) as ListFact<typeof domain>;
  const initialDraft = Object.freeze({ domain }) as unknown as EditEditorSnapshot<typeof domain>["initialDraft"];
  const editor = Object.freeze({
    mode: "edit" as const,
    domain,
    draft: initialDraft,
    initialDraft,
    baseline,
    capturedZone: zone,
    errors: Object.freeze({}),
    prior,
  }) as EditEditorSnapshot<typeof domain>;
  const owner = Object.freeze({
    mountEpoch: 1,
    operationId: 11,
    domain,
    kind: "update" as const,
  }) as OperationOwner<typeof domain, "update">;
  const editing = Object.freeze({ tag: "edit.editing" as const, editor }) as TrackerScreenState;
  const probing = trackerScreenReducer(editing, {
    type: "MUTATION_STARTED", owner, prior: editor, phase: "probe",
  } as TrackerScreenAction);
  const normalizedEditor = Object.freeze({
    ...editor,
    draft: Object.freeze({ domain, normalized: true }) as unknown as EditEditorSnapshot<typeof domain>["draft"],
  }) as EditEditorSnapshot<typeof domain>;
  const normalized = trackerScreenReducer(probing, {
    type: "NORMALIZED_NOOP", owner, editor: normalizedEditor,
  } as TrackerScreenAction);

  expect(normalized.tag).toBe("edit.editing");
  if (normalized.tag !== "edit.editing") throw new Error("expected normalized editor");
  expect(normalized.editor.baseline).toBe(baseline);
  expect(normalized.editor.baseline.updatedAt).toBe(baseline.updatedAt);
  expect(normalized.editor.initialDraft).toBe(initialDraft);
  expect(normalized.editor.prior).toBe(prior);
  expect(normalized.editor.prior.rows[0]).toBe(baseline);
});

test("delete refresh failure retains remaining row identity and order", () => {
  const first = Object.freeze({ ...records.health, id: "first-health-id", title: "第一条" });
  const deleted = Object.freeze({ ...records.health, id: "deleted-health-id", title: "删除条" });
  const third = Object.freeze({ ...records.health, id: "third-health-id", title: "第三条" });
  const rows = Object.freeze([first, deleted, third]);
  const prior: ListFact<"health"> = Object.freeze({ domain: "health", rows, presentationZone: zone });
  const draft = Object.freeze({ domain: "health" as const }) as unknown as EditEditorSnapshot<"health">["draft"];
  const editor: EditEditorSnapshot<"health"> = Object.freeze({
    mode: "edit", domain: "health", draft, initialDraft: draft, baseline: deleted,
    capturedZone: zone, errors: Object.freeze({}), prior,
  });
  const owner: OperationOwner<"health", "delete"> = Object.freeze({
    mountEpoch: 1, operationId: 12, domain: "health", kind: "delete",
  });
  const summary: TrackerDeleteSummary<"health"> = Object.freeze({
    action: "delete", domain: "health", id: deleted.id, expectedUpdatedAt: deleted.updatedAt,
  });
  const decision = Object.freeze({
    kind: "delete" as const, domain: "health" as const, prior: editor, baseline: deleted,
    initiatingControlRef: Object.freeze({ current: null }), serviceSummary: summary, presentationTimeZone: zone,
  });
  const editing: TrackerScreenState = Object.freeze({ tag: "edit.editing", editor });
  const probing = trackerScreenReducer(editing, { type: "MUTATION_STARTED", owner, prior: editor, phase: "probe" });
  const confirmation = trackerScreenReducer(probing, {
    type: "CONFIRMATION_REQUIRED", owner,
    next: Object.freeze({ tag: "confirm.delete", owner, decision }),
    summary: decision.serviceSummary,
  });
  const confirmed = trackerScreenReducer(confirmation, {
    type: "MUTATION_STARTED", owner, prior: editor, phase: "confirmed", decision,
  });
  const deletion = Object.freeze({
    domain: "health" as const, id: deleted.id,
    updatedAt: "2026-07-20T00:04:00.000Z", deletedAt: "2026-07-20T00:04:00.000Z",
  });
  const completion = Object.freeze({ kind: "delete" as const, deletion });
  const completed = trackerScreenReducer(confirmed, { type: "MUTATION_COMPLETED", owner, completion });
  const remainingRows = Object.freeze([first, third]);
  const reconciled = Object.freeze({ domain: "health" as const, rows: remainingRows, presentationZone: zone });
  const refreshing = trackerScreenReducer(completed, {
    type: "OPERATION_REFRESH_STARTED", owner,
    next: Object.freeze({
      tag: "list.loading", source: "mutation-refresh", owner, prior: reconciled, success: "健康记录已删除",
    }),
  });
  const failed = trackerScreenReducer(refreshing, { type: "OPERATION_REFRESH_FAILED", owner });

  expect(failed.tag).toBe("list.error");
  if (failed.tag !== "list.error") throw new Error("expected failed refresh");
  expect(failed.fact.rows).toEqual([first, third]);
  expect(failed.fact.rows[0]).toBe(first);
  expect(failed.fact.rows[1]).toBe(third);
});

test("tracker screen state types reject cross-domain decisions and impossible mutation combinations", () => {
  const fixturePath = `${process.cwd()}/__tracker_screen_state_typecheck__.tsx`;
  const source = `
    import { createTrackerDecisionSnapshot, type TrackerUpdateDecision } from "./src/features/tracker/InlineTrackerConfirmation";
    import type { TrackerDomain } from "./src/domain/tracker/types";
    import {
      acceptedDiscardGetStartedAction, acceptedDiscardListStartedAction, getStartedAction, getSucceededAction,
      listStartedAction, listSucceededAction, mutationCompletedAction,
      operationRefreshSucceededAction, updateConfirmationRequiredAction, updateProbeStartedAction,
      type CreateEditorSnapshot, type DiscardPriorByDomain, type DomainAction, type DomainState,
      type EditEditorSnapshot, type ListFact, type MutationCompletion, type OperationOwner,
      type ReadOwner, type ScreenDiscardDecision, type TrackerScreenAction, type TrackerScreenState,
    } from "./src/features/tracker/trackerScreenState";
    declare const growthCreate: CreateEditorSnapshot<"growth">;
    declare const growthEdit: EditEditorSnapshot<"growth">;
    declare const feedingEdit: EditEditorSnapshot<"feeding">;
    declare const growthCreateOwner: OperationOwner<"growth", "create">;
    declare const growthUpdateOwner: OperationOwner<"growth", "update">;
    declare const feedingUpdateOwner: OperationOwner<"feeding", "update">;
    declare const growthDecision: TrackerUpdateDecision<"growth", EditEditorSnapshot<"growth">>;
    declare const feedingDecision: TrackerUpdateDecision<"feeding", EditEditorSnapshot<"feeding">>;
    declare const widenedDomainUpdateOwner: OperationOwner<TrackerDomain, "update">;
    declare const widenedKindGrowthOwner: OperationOwner<"growth", "create" | "update">;
    declare const growthUpdateCompletion: MutationCompletion<"growth", "update">;
    declare const growthListOwner: ReadOwner<"growth", "list">;
    declare const growthGetOwner: ReadOwner<"growth", "get">;
    declare const growthFact: ListFact<"growth">;
    declare const feedingFact: ListFact<"feeding">;
    declare const growthPrior: DiscardPriorByDomain["growth"];
    declare const feedingPrior: DiscardPriorByDomain["feeding"];
    declare const growthDomainDecision: import("./src/features/tracker/InlineTrackerConfirmation").TrackerDiscardDecision<"growth", DiscardPriorByDomain["growth"], { readonly kind: "domain"; readonly fact: ListFact<"feeding"> }>;
    declare const growthReloadListDecision: import("./src/features/tracker/InlineTrackerConfirmation").TrackerDiscardDecision<"growth", DiscardPriorByDomain["growth"], { readonly kind: "reload-list"; readonly fact: ListFact<"growth"> }>;
    declare const growthReloadRecordDecision: import("./src/features/tracker/InlineTrackerConfirmation").TrackerDiscardDecision<"growth", DiscardPriorByDomain["growth"], { readonly kind: "reload-record"; readonly domain: "growth"; readonly id: string; readonly prior: ListFact<"growth"> }>;
    declare const feedingReloadListDecision: import("./src/features/tracker/InlineTrackerConfirmation").TrackerDiscardDecision<"feeding", DiscardPriorByDomain["feeding"], { readonly kind: "reload-list"; readonly fact: ListFact<"feeding"> }>;
    declare const feedingReloadRecordDecision: import("./src/features/tracker/InlineTrackerConfirmation").TrackerDiscardDecision<"feeding", DiscardPriorByDomain["feeding"], { readonly kind: "reload-record"; readonly domain: "feeding"; readonly id: string; readonly prior: ListFact<"feeding"> }>;
    const growthDomainSource: Extract<TrackerScreenState, { tag: "confirm.discard" }> = { tag: "confirm.discard", decision: growthDomainDecision };
    const growthReloadListSource: Extract<TrackerScreenState, { tag: "confirm.discard" }> = { tag: "confirm.discard", decision: growthReloadListDecision };
    const growthReloadRecordSource: Extract<TrackerScreenState, { tag: "confirm.discard" }> = { tag: "confirm.discard", decision: growthReloadRecordDecision };
    const feedingReloadListSource: Extract<TrackerScreenState, { tag: "confirm.discard" }> = { tag: "confirm.discard", decision: feedingReloadListDecision };
    const feedingReloadRecordSource: Extract<TrackerScreenState, { tag: "confirm.discard" }> = { tag: "confirm.discard", decision: feedingReloadRecordDecision };
    declare const growthListNext: import("./src/features/tracker/trackerScreenState").OrdinaryListLoading<"growth">;
    declare const feedingListNext: import("./src/features/tracker/trackerScreenState").OrdinaryListLoading<"feeding">;
    declare const growthGetNext: import("./src/features/tracker/trackerScreenState").EditLoading<"growth">;
    declare const feedingGetNext: import("./src/features/tracker/trackerScreenState").EditLoading<"feeding">;
    const valid: DomainState<"growth"> = { tag: "confirm.update", owner: growthUpdateOwner, decision: growthDecision };
    void valid;
    // @ts-expect-error a growth state cannot contain a feeding confirmation
    const foreignConfirmation: DomainState<"growth"> = { tag: "confirm.update", owner: feedingUpdateOwner, decision: feedingDecision };
    // @ts-expect-error direct submission requires create owner, create prior, and direct phase
    const impossibleState: DomainState<"growth"> = { tag: "mutation.submitting", owner: growthUpdateOwner, prior: growthCreate, phase: "direct", decision: feedingDecision };
    // @ts-expect-error confirmed update requires its exact correlated decision
    const impossibleAction: DomainAction<"growth"> = { type: "MUTATION_STARTED", owner: growthUpdateOwner, prior: growthEdit, phase: "confirmed", decision: feedingDecision };
    // @ts-expect-error owner kind and prior mode cannot be independently widened
    const wrongOwnerAction: DomainAction<"growth"> = { type: "MUTATION_STARTED", owner: growthCreateOwner, prior: growthEdit, phase: "probe" };
    // @ts-expect-error component action builders preserve the owner's exact domain at the dispatch boundary
    updateProbeStartedAction(growthUpdateOwner, feedingEdit);
    // @ts-expect-error component confirmation builders reject foreign-domain decisions
    updateConfirmationRequiredAction(growthUpdateOwner, feedingDecision);
    // @ts-expect-error widened domain owners cannot choose a correlated action tuple
    updateProbeStartedAction(widenedDomainUpdateOwner, growthEdit);
    // @ts-expect-error widened mutation-kind owners cannot choose a correlated completion tuple
    mutationCompletedAction(widenedKindGrowthOwner, growthUpdateCompletion);
    // @ts-expect-error list completion owner and fact domains are correlated
    listSucceededAction(growthListOwner, feedingFact);
    // @ts-expect-error get completion owner and editor domains are correlated
    getSucceededAction(growthGetOwner, feedingEdit);
    // @ts-expect-error mutation refresh owner and fact domains are correlated
    operationRefreshSucceededAction(growthUpdateOwner, feedingFact);
    // @ts-expect-error domain discard cannot target its source domain
    const sameDomainDiscard: ScreenDiscardDecision = { kind: "discard", domain: "growth", prior: growthPrior, destination: { kind: "domain", fact: growthFact }, initiatingControlRef: { current: null } };
    // @ts-expect-error the approved decision boundary rejects mixed-domain envelopes
    createTrackerDecisionSnapshot({ ...feedingDecision, domain: "growth", prior: growthEdit, baseline: growthEdit.baseline });
    listStartedAction(growthDomainSource, feedingListNext, growthDomainDecision);
    acceptedDiscardListStartedAction(growthDomainSource, feedingListNext, growthDomainDecision);
    listStartedAction(growthReloadListSource, growthListNext, growthReloadListDecision);
    acceptedDiscardListStartedAction(growthReloadListSource, growthListNext, growthReloadListDecision);
    listStartedAction(feedingReloadListSource, feedingListNext, feedingReloadListDecision);
    acceptedDiscardListStartedAction(feedingReloadListSource, feedingListNext, feedingReloadListDecision);
    getStartedAction(growthReloadRecordSource, growthGetNext, growthReloadRecordDecision);
    acceptedDiscardGetStartedAction(growthReloadRecordSource, growthGetNext, growthReloadRecordDecision);
    // @ts-expect-error a valid domain decision cannot start a list in a different destination domain
    listStartedAction(growthDomainSource, growthListNext, growthDomainDecision);
    // @ts-expect-error a valid reload-list decision cannot start another domain's list
    acceptedDiscardListStartedAction(growthReloadListSource, feedingListNext, growthReloadListDecision);
    // @ts-expect-error a valid reload-record decision cannot start another domain's get
    getStartedAction(growthReloadRecordSource, feedingGetNext, growthReloadRecordDecision);
    // @ts-expect-error accepted get helper preserves the reload-record destination domain
    acceptedDiscardGetStartedAction(feedingReloadRecordSource, growthGetNext, feedingReloadRecordDecision);
    // @ts-expect-error discard request prior and decision domains are correlated
    const mixedDiscard: TrackerScreenAction = { type: "DISCARD_REQUESTED", prior: growthPrior, decision: feedingReloadListDecision };
    void foreignConfirmation; void impossibleState; void impossibleAction; void wrongOwnerAction; void sameDomainDiscard; void feedingPrior; void mixedDiscard;
  `;
  const config = ts.readConfigFile(`${process.cwd()}/tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = ts.createCompilerHost(parsed.options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => fileName === fixturePath || originalFileExists(fileName);
  host.readFile = (fileName) => fileName === fixturePath ? source : originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => (
    fileName === fixturePath
      ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TSX)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram([fixturePath], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === fixturePath);

  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
});

test("component dispatch contains no broad action, list-fact, or discard-decision casts", () => {
  const source = readFileSync(
    `${process.cwd()}/src/features/tracker/ManualTrackerScreen.tsx`,
    "utf8",
  );
  expect(source).not.toMatch(/action\s+as\s+TrackerScreenAction/);
  expect(source).not.toMatch(/as\s+ListFact</);
  expect(source).not.toMatch(/as\s+DiscardDecision/);
});

test("stale update probe freezes the exact source and gates reload through discard before one get", async () => {
  const replacement = Object.freeze({
    ...records.growth,
    weightG: 7400,
    updatedAt: "2026-07-20T00:09:00.000Z",
  });
  const list = jest.fn(async () => [records.growth]);
  const getById = jest.fn()
    .mockResolvedValueOnce(records.growth)
    .mockResolvedValueOnce(replacement);
  const replacementInput = Object.freeze({ ...expectedUpdateInputs.growth, weightG: 7500 });
  const replacementSummary: TrackerUpdateSummary<"growth"> = Object.freeze({
    action: "update", domain: "growth", id: replacement.id,
    expectedUpdatedAt: replacement.updatedAt, input: replacementInput,
  });
  const update = jest.fn()
    .mockRejectedValueOnce(new ManualTrackerConflictError("stale_write"))
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary: replacementSummary }));
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: getById as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
  });
  await openEditor("growth", "生长", service);
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
  const editor = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));

  expect(await screen.findByText("这条记录已在其他位置更新。为避免覆盖，请重新读取后再修改。")).toBeTruthy();
  const conflict = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  expect(conflict.tag).toBe("conflict.stale");
  if (conflict.tag !== "conflict.stale" || editor.tag !== "edit.editing") throw new Error("expected stale conflict");
  expect(conflict.source.prior).toBe(editor.editor);
  expect(update).toHaveBeenCalledTimes(1);
  expect(getById).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByRole("button", { name: "重新读取记录" }));
  expect(await screen.findByRole("header", { name: "放弃未保存的更改？" })).toBeTruthy();
  expect(getById).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole("button", { name: "继续编辑" }));
  expect(mockTrackerReducerObserver.mock.calls.at(-1)?.[1]).toBe(conflict);

  fireEvent.press(screen.getByRole("button", { name: "重新读取记录" }));
  fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
  await screen.findByRole("header", { name: "编辑生长记录" });
  const reloaded = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  expect(reloaded.tag).toBe("edit.editing");
  if (reloaded.tag !== "edit.editing") throw new Error("expected editor");
  expect(reloaded.editor.baseline).toBe(replacement);
  expect(reloaded.editor.draft).not.toBe(editor.editor.draft);
  expect(reloaded.editor.initialDraft).not.toBe(editor.editor.initialDraft);
  expect(reloaded.editor.initialDraft).toEqual(reloaded.editor.draft);
  expect(reloaded.editor.prior).toBe(editor.editor.prior);
  expect(screen.getByLabelText("体重（克）").props.value).toBe("7400");
  expect(getById.mock.calls).toEqual([
    ["growth", records.growth.id],
    ["growth", records.growth.id],
  ]);
  expect(list).toHaveBeenCalledTimes(1);
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7500");
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByRole("button", { name: "确认保存" });
  expect(update.mock.calls[1]).toEqual(["growth", replacement.id, replacementInput, replacement.updatedAt]);
  expect(service.create).not.toHaveBeenCalled();
  expect(service.delete).not.toHaveBeenCalled();
});

test.each(["update", "delete"] as const)("confirmed %s stale conflict retains the exact returned summary without replay", async (kind) => {
  const updateSummary = Object.freeze({
    action: "update" as const,
    domain: "growth" as const,
    id: records.growth.id,
    expectedUpdatedAt: records.growth.updatedAt,
    input: expectedUpdateInputs.growth,
  });
  const deleteSummary = Object.freeze({
    action: "delete" as const,
    domain: "growth" as const,
    id: records.growth.id,
    expectedUpdatedAt: records.growth.updatedAt,
  });
  const update = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required" as const, summary: updateSummary }))
    .mockRejectedValueOnce(new ManualTrackerConflictError("stale_write"));
  const deleteRecord = jest.fn()
    .mockResolvedValueOnce(Object.freeze({ status: "confirmation_required" as const, summary: deleteSummary }))
    .mockRejectedValueOnce(new ManualTrackerConflictError("stale_write"));
  const service = createServiceMock({
    list: jest.fn(async () => [records.growth]) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.growth) as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
    delete: deleteRecord as ManualTrackerServicePort["delete"],
  });
  await openEditor("growth", "生长", service);
  if (kind === "update") {
    fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
    fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
    fireEvent.press(await screen.findByRole("button", { name: "确认保存" }));
  } else {
    fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
    fireEvent.press(await screen.findByRole("button", { name: "确认删除" }));
  }
  expect(await screen.findByText("这条记录已在其他位置更新。为避免覆盖，请重新读取后再修改。")).toBeTruthy();
  const conflict = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  expect(conflict.tag).toBe("conflict.stale");
  if (conflict.tag !== "conflict.stale") throw new Error("expected stale conflict");
  expect(conflict.source.phase).toBe("confirmed");
  expect(conflict.source.decision?.serviceSummary).toBe(kind === "update" ? updateSummary : deleteSummary);
  expect(kind === "update" ? update : deleteRecord).toHaveBeenCalledTimes(2);
  expect(service.list).toHaveBeenCalledTimes(1);
  expect(service.getById).toHaveBeenCalledTimes(1);
});

test("stale reload null performs get then list only and shows the approved missing notice", async () => {
  const refreshed = Object.freeze([records.growth]);
  const list = jest.fn().mockResolvedValueOnce([records.growth]).mockResolvedValueOnce(refreshed);
  const getById = jest.fn().mockResolvedValueOnce(records.growth).mockResolvedValueOnce(null);
  const update = jest.fn(async () => { throw new ManualTrackerConflictError("stale_write"); });
  const service = createServiceMock({ list, getById, update } as Partial<ManualTrackerServicePort>);
  await openEditor("growth", "生长", service);
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  fireEvent.press(await screen.findByRole("button", { name: "重新读取记录" }));
  fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
  expect(await screen.findByText("这条记录已不存在，列表已重新读取。")).toBeTruthy();
  expect(getById.mock.calls.at(-1)).toEqual(["growth", records.growth.id]);
  expect(list.mock.calls.at(-1)).toEqual(["growth", 100]);
  expect(update).toHaveBeenCalledTimes(1);
  expect(service.create).not.toHaveBeenCalled();
  expect(service.delete).not.toHaveBeenCalled();
  const recovered = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (recovered.tag !== "list.ready.rows") throw new Error("expected exact recovered rows");
  expect(recovered.fact.rows).toBe(refreshed);
  expect(recovered.fact.rows[0]).toBe(records.growth);
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(update).toHaveBeenCalledTimes(1);
});

test("not_found retains the exact source until explicit dirty discard and then lists without replay", async () => {
  const refreshed = Object.freeze([records.growth]);
  const list = jest.fn().mockResolvedValueOnce([records.growth]).mockResolvedValueOnce(refreshed);
  const getById = jest.fn(async () => records.growth);
  const update = jest.fn(async () => { throw new ManualTrackerConflictError("not_found"); });
  const service = createServiceMock({ list, getById, update } as Partial<ManualTrackerServicePort>);
  await openEditor("growth", "生长", service);
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  expect(await screen.findByText("这条记录已不存在，不能继续保存或删除。")).toBeTruthy();
  const conflict = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  expect(conflict.tag).toBe("conflict.notFound");
  expect(screen.queryByRole("button", { name: "重新读取记录" })).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole("button", { name: "返回列表" }));
  expect(await screen.findByRole("header", { name: "放弃未保存的更改？" })).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "继续编辑" }));
  expect(mockTrackerReducerObserver.mock.calls.at(-1)?.[1]).toBe(conflict);
  fireEvent.press(screen.getByRole("button", { name: "返回列表" }));
  fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
  await screen.findByRole("header", { name: "生长记录" });
  expect(list.mock.calls).toEqual([["growth", 100], ["growth", 100]]);
  expect(getById).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
  const recovered = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (recovered.tag !== "list.ready.rows") throw new Error("expected standalone not-found rows");
  expect(recovered.fact.rows).toBe(refreshed);
  expect(recovered.fact.rows[0]).toBe(records.growth);
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(update).toHaveBeenCalledTimes(1);
  expect(service.create).not.toHaveBeenCalled();
  expect(service.delete).not.toHaveBeenCalled();
});

test.each(["list", "get"] as const)("stale accepted %s discard decision cannot authorize an equivalent current destination or start a service read", async (kind) => {
  const initialRows = Object.freeze([records.growth]);
  const refreshedRows = Object.freeze([records.growth]);
  const list = jest.fn().mockResolvedValueOnce(initialRows).mockResolvedValueOnce(refreshedRows);
  const getById = jest.fn(async () => records.growth);
  const update = jest.fn(async () => { throw new ManualTrackerConflictError("stale_write"); });
  const service = createServiceMock({ list, getById, update } as Partial<ManualTrackerServicePort>);
  await openEditor("growth", "生长", service);
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByRole("header", { name: "记录冲突" });

  const initiate = () => fireEvent.press(screen.getByRole("button", { name: kind === "get" ? "重新读取记录" : "返回列表" }));
  initiate();
  await screen.findByRole("header", { name: "放弃未保存的更改？" });
  const oldConfirmation = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (oldConfirmation.tag !== "confirm.discard") throw new Error("expected old discard confirmation");
  const oldAcceptButton = screen.getByRole("button", { name: "放弃更改" });
  const staleAccept = [
    oldAcceptButton.props.onPress,
    oldAcceptButton.parent?.props.onPress,
    oldAcceptButton.parent?.parent?.props.onPress,
  ].find((candidate): candidate is () => void => typeof candidate === "function");
  if (staleAccept === undefined) throw new Error("expected stale accept callback");
  fireEvent.press(screen.getByRole("button", { name: "继续编辑" }));
  initiate();
  const currentConfirmation = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (currentConfirmation.tag !== "confirm.discard") throw new Error("expected current discard confirmation");
  expect(currentConfirmation.decision).not.toBe(oldConfirmation.decision);
  const oldDestination = oldConfirmation.decision.destination;
  const currentDestination = currentConfirmation.decision.destination;
  if (!("kind" in oldDestination) || !("kind" in currentDestination)) throw new Error("expected reload destinations");
  expect(oldDestination.kind).toBe(kind === "get" ? "reload-record" : "reload-list");
  expect(currentDestination.kind).toBe(oldDestination.kind);
  if (oldDestination.kind === "reload-record" && currentDestination.kind === "reload-record") {
    expect(currentDestination.domain).toBe(oldDestination.domain);
    expect(currentDestination.id).toBe(oldDestination.id);
    expect(currentDestination.prior).toBe(oldDestination.prior);
  } else if (oldDestination.kind === "reload-list" && currentDestination.kind === "reload-list") {
    expect(currentDestination.fact).toBe(oldDestination.fact);
  } else {
    throw new Error("expected destination-equivalent decisions");
  }
  const readCounts = Object.freeze({ list: list.mock.calls.length, get: getById.mock.calls.length });
  act(() => staleAccept());
  await act(async () => {
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mockTrackerReducerObserver.mock.calls.at(-1)?.[1]).toBe(currentConfirmation);
  expect(list).toHaveBeenCalledTimes(readCounts.list);
  expect(getById).toHaveBeenCalledTimes(readCounts.get);

  fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
  if (kind === "get") {
    await waitFor(() => expect(getById).toHaveBeenCalledTimes(readCounts.get + 1));
    expect(list).toHaveBeenCalledTimes(readCounts.list);
  } else {
    await waitFor(() => expect(list).toHaveBeenCalledTimes(readCounts.list + 1));
    expect(getById).toHaveBeenCalledTimes(readCounts.get);
  }
  expect(update).toHaveBeenCalledTimes(1);
});

const aggregateFormByField = Object.freeze({
  measurements: GrowthTrackerForm,
  feedTime: FeedingTrackerForm,
  sleepStart: SleepTrackerForm,
  sleepEnd: SleepTrackerForm,
  diaperTime: DiaperTrackerForm,
});

test.each([
  ["update", "probe", "stale_write"], ["update", "confirmed", "stale_write"],
  ["delete", "probe", "stale_write"], ["delete", "confirmed", "stale_write"],
  ["update", "probe", "not_found"], ["update", "confirmed", "not_found"],
  ["delete", "probe", "not_found"], ["delete", "confirmed", "not_found"],
] as const)("%s %s %s conflict preserves exact tuples and recovers to exact rows without mutation deltas", async (kind, phase, code) => {
  const initialRows = Object.freeze([records.growth]);
  const refreshedFirst = Object.freeze({ ...records.growth, id: "refreshed-first", updatedAt: "2026-07-20T00:20:00.000Z" });
  const refreshedSecond = Object.freeze({ ...records.growth, id: "refreshed-second", updatedAt: "2026-07-20T00:21:00.000Z" });
  const refreshedRows = Object.freeze([refreshedFirst, refreshedSecond]);
  const updateInput = Object.freeze({ ...expectedUpdateInputs.growth, weightG: 7300 });
  const summary = kind === "update"
    ? Object.freeze({ action: "update" as const, domain: "growth" as const, id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt, input: updateInput })
    : Object.freeze({ action: "delete" as const, domain: "growth" as const, id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt });
  const conflictError = new ManualTrackerConflictError(code);
  const mutation = phase === "probe"
    ? jest.fn().mockRejectedValueOnce(conflictError)
    : jest.fn().mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary })).mockRejectedValueOnce(conflictError);
  const list = jest.fn().mockResolvedValueOnce(initialRows).mockResolvedValueOnce(refreshedRows);
  const getById = jest.fn(async () => records.growth);
  const create = jest.fn(async () => { throw new Error("unexpected create"); });
  const otherMutation = jest.fn(async () => { throw new Error("unexpected other mutation"); });
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: getById as ManualTrackerServicePort["getById"],
    create: create as ManualTrackerServicePort["create"],
    update: (kind === "update" ? mutation : otherMutation) as ManualTrackerServicePort["update"],
    delete: (kind === "delete" ? mutation : otherMutation) as ManualTrackerServicePort["delete"],
  });
  await openEditor("growth", "生长", service);
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
  const editor = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  fireEvent.press(screen.getByRole("button", { name: kind === "update" ? "保存修改" : "删除这条记录" }));
  if (phase === "confirmed") fireEvent.press(await screen.findByRole("button", { name: kind === "update" ? "确认保存" : "确认删除" }));
  await screen.findByRole("header", { name: "记录冲突" });
  const conflict = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if ((conflict.tag !== "conflict.stale" && conflict.tag !== "conflict.notFound") || editor.tag !== "edit.editing") throw new Error("expected conflict");
  expect(conflict.source.prior).toBe(editor.editor);
  expect(conflict.source.phase).toBe(phase);
  expect(conflict.source.owner.kind).toBe(kind);
  if (phase === "confirmed") expect(conflict.source.decision?.serviceSummary).toBe(summary);
  const expectedProbe = kind === "update"
    ? ["growth", records.growth.id, updateInput, records.growth.updatedAt]
    : ["growth", records.growth.id, records.growth.updatedAt];
  expect(mutation.mock.calls[0]).toEqual(expectedProbe);
  if (phase === "confirmed") expect(mutation.mock.calls[1]).toEqual([...expectedProbe, "confirmed"]);

  const mutationCounts = [service.create, service.update, service.delete].map((fn) => (fn as jest.Mock).mock.calls.length);
  fireEvent.press(screen.getByRole("button", { name: "返回列表" }));
  await screen.findByRole("header", { name: "放弃未保存的更改？" });
  const discard = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (discard.tag !== "confirm.discard") throw new Error("expected discard");
  expect(discard.decision.prior).toBe(conflict);
  expect("kind" in discard.decision.destination && discard.decision.destination.kind).toBe("reload-list");
  const initiatingControlRef = discard.decision.initiatingControlRef;
  fireEvent.press(screen.getByRole("button", { name: "继续编辑" }));
  expect(mockTrackerReducerObserver.mock.calls.at(-1)?.[1]).toBe(conflict);
  fireEvent.press(screen.getByRole("button", { name: "返回列表" }));
  const repeatedDiscard = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (repeatedDiscard.tag !== "confirm.discard") throw new Error("expected repeated discard");
  expect(repeatedDiscard.decision.initiatingControlRef).toBe(initiatingControlRef);
  fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  const ready = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (ready.tag !== "list.ready.rows") throw new Error("expected rows");
  expect(ready.fact.rows).toBe(refreshedRows);
  expect(ready.fact.rows[0]).toBe(refreshedFirst);
  expect(ready.fact.rows[1]).toBe(refreshedSecond);
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect([service.create, service.update, service.delete].map((fn) => (fn as jest.Mock).mock.calls.length)).toEqual(mutationCounts);
  expect(list.mock.invocationCallOrder[1]).toBeGreaterThan(mutation.mock.invocationCallOrder.at(-1)!);
});

test.each([
  [new RuntimeClosingError(), "本机记录服务暂不可用，请返回后重试。"],
  [new Error("SQL tracker_records growth-private-id 2026-07-20T00:02:00.000Z"), "删除失败，本机记录没有更改。"],
  [{ name: "ManualTrackerConflictError", code: "stale_write", message: "private-id" }, "删除失败，本机记录没有更改。"],
] as const)("classifies delete failures nominally and privately", async (failure, copy) => {
  const deleteRecord = jest.fn(async () => { throw failure; });
  const service = createServiceMock({
    list: jest.fn(async () => [records.growth]) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.growth) as ManualTrackerServicePort["getById"],
    delete: deleteRecord as ManualTrackerServicePort["delete"],
  });
  await openEditor("growth", "生长", service);
  fireEvent.press(screen.getByRole("button", { name: "删除这条记录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  expect(screen.queryByText(/tracker_records|growth-private-id|private-id|stale_write|SQL/)).toBeNull();
  expect(deleteRecord).toHaveBeenCalledTimes(1);
  expect(service.create).not.toHaveBeenCalled();
  expect(service.update).not.toHaveBeenCalled();
});

test.each([
  ["probe", new RuntimeClosingError(), "本机记录服务暂不可用，请返回后重试。"],
  ["probe", new Error("private health probe"), "保存失败，本机记录没有更改。"],
  ["probe", { name: "ManualTrackerConflictError", code: "stale_write", message: "private health probe impostor" }, "保存失败，本机记录没有更改。"],
  ["confirmed", new RuntimeClosingError(), "本机记录服务暂不可用，请返回后重试。"],
  ["confirmed", new Error("private health confirmed"), "保存失败，本机记录没有更改。"],
  ["confirmed", { name: "ManualTrackerConflictError", code: "stale_write", message: "private health confirmed impostor" }, "保存失败，本机记录没有更改。"],
] as const)("health create %s failure is retained without replay and retries with a fresh probe", async (phase, failure, copy) => {
  const input = Object.freeze({ recordDate: "2026-07-20", recordType: "illness" as const, title: "轻微咳嗽", description: "居家观察", sourceMessageId: null });
  const summary: TrackerCreateSummary<"health"> = Object.freeze({ action: "create", domain: "health", input });
  const create = phase === "probe"
    ? jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary }))
    : jest.fn().mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary })).mockRejectedValueOnce(failure).mockResolvedValueOnce(Object.freeze({ status: "confirmation_required", summary }));
  const service = createServiceMock({ create: create as ManualTrackerServicePort["create"] });
  renderTracker(service);
  await openHealthCreate();
  fireEvent.press(screen.getByRole("button", { name: "保存健康记录" }));
  let confirmedDecision: unknown;
  if (phase === "confirmed") {
    const confirmButton = await screen.findByRole("button", { name: "确认保存" });
    const confirmation = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
    if (confirmation.tag !== "confirm.healthCreate") throw new Error("expected health confirmation");
    confirmedDecision = confirmation.decision;
    fireEvent.press(confirmButton);
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  const failed = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (failed.tag !== "mutation.error") throw new Error("expected mutation error");
  const failedOwner = failed.source.owner;
  const failedPrior = failed.source.prior;
  expect(create.mock.calls[0]).toEqual(["health", input]);
  if (phase === "confirmed") {
    expect(create.mock.calls[1]).toEqual(["health", input, "confirmed"]);
    expect(failed.source.decision).toBe(confirmedDecision);
    expect(failed.source.decision?.serviceSummary).toBe(summary);
    expect(failed.source.decision && failed.source.decision.kind === "healthCreate" ? failed.source.decision.serviceSummary : null).toBe(summary);
  } else {
    expect(failed.source.decision).toBeUndefined();
  }
  const beforeRetryCalls = create.mock.calls.length;
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(create).toHaveBeenCalledTimes(beforeRetryCalls);
  fireEvent.press(screen.getByRole("button", { name: "保存健康记录" }));
  await screen.findByRole("header", { name: "确认新增健康记录" });
  const retried = mockTrackerReducerObserver.mock.calls.findLast((call) => call[1].tag === "mutation.submitting")?.[1] as TrackerScreenState;
  if (retried.tag !== "mutation.submitting") throw new Error("expected retry");
  expect(retried.prior).toBe(failedPrior);
  expect(retried.owner).not.toBe(failedOwner);
  expect(retried.owner.mountEpoch).toBe(failedOwner.mountEpoch);
  expect(retried.owner.operationId).toBeGreaterThan(failedOwner.operationId);
  expect(retried.phase).toBe("probe");
  expect(retried.decision).toBeUndefined();
  expect(create.mock.calls.at(-1)).toEqual(["health", input]);
});

test.each([
  ["update", "probe", new RuntimeClosingError(), "本机记录服务暂不可用，请返回后重试。"],
  ["update", "probe", new Error("private update probe"), "保存失败，本机记录没有更改。"],
  ["update", "probe", { name: "ManualTrackerConflictError", code: "stale_write", message: "private update impostor" }, "保存失败，本机记录没有更改。"],
  ["update", "confirmed", new RuntimeClosingError(), "本机记录服务暂不可用，请返回后重试。"],
  ["update", "confirmed", new Error("private update confirmed"), "保存失败，本机记录没有更改。"],
  ["update", "confirmed", { name: "ManualTrackerConflictError", code: "stale_write", message: "private update confirmed impostor" }, "保存失败，本机记录没有更改。"],
  ["delete", "probe", new RuntimeClosingError(), "本机记录服务暂不可用，请返回后重试。"],
  ["delete", "probe", new Error("private delete probe"), "删除失败，本机记录没有更改。"],
  ["delete", "confirmed", new RuntimeClosingError(), "本机记录服务暂不可用，请返回后重试。"],
  ["delete", "confirmed", new Error("private delete confirmed"), "删除失败，本机记录没有更改。"],
  ["delete", "confirmed", { name: "ManualTrackerConflictError", code: "not_found", message: "private delete confirmed impostor" }, "删除失败，本机记录没有更改。"],
] as const)("%s %s failure preserves exact facts, never replays, and retries through one fresh probe", async (kind, phase, failure, copy) => {
  const updateInput = Object.freeze({ ...expectedUpdateInputs.growth, weightG: 7300 });
  const updateSummary: TrackerUpdateSummary<"growth"> = Object.freeze({ action: "update", domain: "growth", id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt, input: updateInput });
  const deleteSummary: TrackerDeleteSummary<"growth"> = Object.freeze({ action: "delete", domain: "growth", id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt });
  const summaryResult = Object.freeze({ status: "confirmation_required" as const, summary: kind === "update" ? updateSummary : deleteSummary });
  const mutation = phase === "probe"
    ? jest.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(summaryResult)
    : jest.fn().mockResolvedValueOnce(summaryResult).mockRejectedValueOnce(failure).mockResolvedValueOnce(summaryResult);
  const service = createServiceMock({
    list: jest.fn(async () => [records.growth]) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records.growth) as ManualTrackerServicePort["getById"],
    [kind]: mutation,
  });
  await openEditor("growth", "生长", service);
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7300");
  fireEvent.press(screen.getByRole("button", { name: kind === "update" ? "保存修改" : "删除这条记录" }));
  let confirmedDecision: unknown;
  if (phase === "confirmed") {
    const confirmButton = await screen.findByRole("button", { name: kind === "update" ? "确认保存" : "确认删除" });
    const confirmation = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
    if (confirmation.tag !== (kind === "update" ? "confirm.update" : "confirm.delete")) throw new Error("expected mutation confirmation");
    confirmedDecision = confirmation.decision;
    fireEvent.press(confirmButton);
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  const failed = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (failed.tag !== "mutation.error") throw new Error("expected mutation error");
  const { baseline, draft, initialDraft, prior } = failed.source.prior;
  const expectedTuple = kind === "update"
    ? ["growth", records.growth.id, updateInput, records.growth.updatedAt]
    : ["growth", records.growth.id, records.growth.updatedAt];
  expect(mutation.mock.calls[0]).toEqual(expectedTuple);
  if (phase === "confirmed") {
    expect(mutation.mock.calls[1]).toEqual([...expectedTuple, "confirmed"]);
    expect(failed.source.decision).toBe(confirmedDecision);
    expect(failed.source.decision?.serviceSummary).toBe(kind === "update" ? updateSummary : deleteSummary);
  } else {
    expect(failed.source.decision).toBeUndefined();
  }
  const beforeRetryCalls = mutation.mock.calls.length;
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(mutation).toHaveBeenCalledTimes(beforeRetryCalls);
  fireEvent.press(screen.getByRole("button", { name: kind === "update" ? "保存修改" : "删除这条记录" }));
  await screen.findByRole("button", { name: kind === "update" ? "确认保存" : "确认删除" });
  const retry = mockTrackerReducerObserver.mock.calls.findLast((call) => call[1].tag === "mutation.submitting")?.[1] as TrackerScreenState;
  if (retry.tag !== "mutation.submitting") throw new Error("expected retry");
  expect(retry.prior.baseline).toBe(baseline);
  expect(retry.prior.draft).toBe(draft);
  expect(retry.prior.initialDraft).toBe(initialDraft);
  expect(retry.prior.prior).toBe(prior);
  expect(retry.owner.operationId).not.toBe(failed.source.owner.operationId);
  expect(retry.owner.kind).toBe(kind);
  expect(retry.owner.mountEpoch).toBe(failed.source.owner.mountEpoch);
  expect(retry.owner.operationId).toBeGreaterThan(failed.source.owner.operationId);
  expect(retry.phase).toBe("probe");
  expect(retry.decision).toBeUndefined();
  expect(mutation.mock.calls.at(-1)).toEqual(expectedTuple);
});

test.each([
  ["growth", "生长", "measurementDate", "测量日期", "体重（克）", "7300", "请检查标出的内容后再保存。"],
  ["growth", "生长", "measurements", "体重（克）", "体重（克）", "7300", "体重、身长、头围请至少填写一项。"],
  ["growth", "生长", "weightG", "体重（克）", "体重（克）", "7300", "请检查标出的内容后再保存。"],
  ["growth", "生长", "heightCm", "身长（厘米）", "体重（克）", "7300", "请检查标出的内容后再保存。"],
  ["growth", "生长", "headCm", "头围（厘米）", "体重（克）", "7300", "请检查标出的内容后再保存。"],
  ["growth", "生长", "notes", "备注", "体重（克）", "7300", "请检查标出的内容后再保存。"],
  ["feeding", "喂养", "feedTime", "喂养时间", "备注", "更新喂养备注", "请检查标出的内容后再保存。"],
  ["feeding", "喂养", "feedType", "喂养类型", "备注", "更新喂养备注", "请检查标出的内容后再保存。"],
  ["feeding", "喂养", "amountMl", "量（毫升）", "备注", "更新喂养备注", "配方奶需要填写量。"],
  ["feeding", "喂养", "durationMin", "时长（分钟）", "备注", "更新喂养备注", "母乳需要填写时长。"],
  ["feeding", "喂养", "notes", "备注", "备注", "更新喂养备注", "请检查标出的内容后再保存。"],
  ["sleep", "睡眠", "sleepStart", "开始时间", "夜醒次数", "03", "请检查标出的内容后再保存。"],
  ["sleep", "睡眠", "sleepEnd", "结束时间", "夜醒次数", "03", "结束时间需要晚于开始时间。"],
  ["sleep", "睡眠", "sleepType", "睡眠类型", "夜醒次数", "03", "请检查标出的内容后再保存。"],
  ["sleep", "睡眠", "nightWakings", "夜醒次数", "夜醒次数", "03", "请检查标出的内容后再保存。"],
  ["sleep", "睡眠", "notes", "备注", "夜醒次数", "03", "请检查标出的内容后再保存。"],
  ["diaper", "大小便", "diaperTime", "记录时间", "备注", "更换后备注", "请检查标出的内容后再保存。"],
  ["diaper", "大小便", "diaperType", "类型", "备注", "更换后备注", "请检查标出的内容后再保存。"],
  ["diaper", "大小便", "notes", "备注", "备注", "更换后备注", "请检查标出的内容后再保存。"],
  ["health", "健康", "recordDate", "记录日期", "标题", "复查", "请检查标出的内容后再保存。"],
  ["health", "健康", "recordType", "健康记录类型", "标题", "复查", "请检查标出的内容后再保存。"],
  ["health", "健康", "title", "标题", "标题", "复查", "标题需要填写，且最多 200 个字符。"],
  ["health", "健康", "description", "说明", "标题", "复查", "请检查标出的内容后再保存。"],
] as const)("maps %s (%s) service field %s adjacent to its exact field/group", async (domain, label, field, targetLabel, changeLabel, changeValue, message) => {
  const update = jest.fn(async () => { throw new TrackerValidationError(domain, field, "private validation detail"); });
  const service = createServiceMock({
    list: jest.fn(async (requested) => requested === domain ? [records[domain]] : []) as ManualTrackerServicePort["list"],
    getById: jest.fn(async () => records[domain]) as ManualTrackerServicePort["getById"],
    update: update as ManualTrackerServicePort["update"],
  });
  await openEditor(domain, label, service);
  fireEvent.changeText(screen.getByLabelText(changeLabel), changeValue);
  const before = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  const alert = await screen.findByRole("alert", { name: message });
  const target = screen.getByLabelText(field === "measurements" ? "头围（厘米）" : targetLabel);
  expect(alert).toHaveTextContent(message);
  expect(alert.props.accessibilityRole).toBe("alert");
  const expectedAggregateForm = aggregateFormByField[field as keyof typeof aggregateFormByField];
  if (expectedAggregateForm !== undefined) {
    let targetGroup = target;
    let alertParent: typeof target.parent = null;
    while (targetGroup.parent !== null) {
      const parent = targetGroup.parent;
      if (parent.type === expectedAggregateForm) {
        throw new Error(`expected ${field} alert before its exact form boundary`);
      }
      const targetGroupIndex = parent.children.indexOf(targetGroup);
      const alertSibling = parent.children[targetGroupIndex + 1];
      if (
        alertSibling !== undefined
        && typeof alertSibling !== "string"
        && within(alertSibling).queryByRole("alert", { name: message }) === alert
      ) {
        alertParent = parent;
        break;
      }
      targetGroup = targetGroup.parent;
    }
    if (alertParent === null) throw new Error("expected target group beside aggregate alert");
    const targetGroupIndex = alertParent.children.indexOf(targetGroup);
    expect(targetGroupIndex).toBeGreaterThanOrEqual(0);
    const alertSibling = alertParent.children[targetGroupIndex + 1];
    if (alertSibling === undefined || typeof alertSibling === "string") throw new Error("expected exact aggregate alert sibling");
    expect(within(alertSibling).getByRole("alert", { name: message })).toBe(alert);
    expect(within(targetGroup).getByLabelText(field === "measurements" ? "头围（厘米）" : targetLabel)).toBe(target);
  } else {
    const fieldContainer = target.parent?.parent;
    if (fieldContainer === null || fieldContainer === undefined) throw new Error("expected field/group container");
    expect(within(fieldContainer).getByRole("alert")).toBe(alert);
  }
  const failed = mockTrackerReducerObserver.mock.calls.at(-1)?.[1] as TrackerScreenState;
  if (before.tag !== "edit.editing" || failed.tag !== "mutation.error") throw new Error("expected retained validation error");
  expect(failed.source.prior.draft).toBe(before.editor.draft);
  expect(failed.source.prior.initialDraft).toBe(before.editor.initialDraft);
  expect(failed.source.prior.baseline).toBe(before.editor.baseline);
  expect(failed.source.prior.prior).toBe(before.editor.prior);
  const expectedTuple = [domain, records[domain].id, expectedUpdateInputs[domain], records[domain].updatedAt];
  expect(update.mock.calls[0]).toEqual(expectedTuple);
  await act(async () => { jest.runOnlyPendingTimers(); await Promise.resolve(); });
  expect(update).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]).toEqual(expectedTuple);
  expect(screen.queryByText("private validation detail")).toBeNull();
});
