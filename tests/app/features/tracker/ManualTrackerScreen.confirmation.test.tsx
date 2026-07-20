import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as ts from "typescript";

import type {
  ManualTrackerServicePort,
  TrackerCreateSummary,
  TrackerDeleteSummary,
  TrackerUpdateSummary,
} from "../../../../src/application/tracker/manualTrackerService";
import type {
  TrackerDomain,
  TrackerRecordByDomain,
  TrackerUpdateInputByDomain,
} from "../../../../src/domain/tracker/types";
import { ManualTrackerScreen } from "../../../../src/features/tracker/ManualTrackerScreen";
import { ManualTrackerServiceProvider } from "../../../../src/features/tracker/ManualTrackerServiceContext";
import * as trackerLocalTime from "../../../../src/features/tracker/trackerLocalTime";
import {
  trackerScreenReducer,
  type EditEditorSnapshot,
  type ListFact,
  type OperationOwner,
  type TrackerScreenAction,
  type TrackerScreenState,
} from "../../../../src/features/tracker/trackerScreenState";

const mockTrackerReducerObserver = jest.fn(
  (_action: TrackerScreenAction, _state: TrackerScreenState): void => undefined,
);

jest.mock("../../../../src/features/tracker/trackerScreenState", () => {
  const actual = jest.requireActual("../../../../src/features/tracker/trackerScreenState");
  return {
    ...actual,
    trackerScreenReducer: (state: TrackerScreenState, action: TrackerScreenAction) => {
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
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-07-20T00:10:00.000Z"));
  jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
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
  expect(create).toHaveBeenCalledWith("health", expect.any(Object));
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
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: jest.fn(async (_domain, id) => id === second.id ? second : records.health) as ManualTrackerServicePort["getById"],
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
      mutationCompletedAction, updateConfirmationRequiredAction, updateProbeStartedAction,
      type CreateEditorSnapshot, type DomainAction, type DomainState,
      type EditEditorSnapshot, type MutationCompletion, type OperationOwner,
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
    // @ts-expect-error the approved decision boundary rejects mixed-domain envelopes
    createTrackerDecisionSnapshot({ ...feedingDecision, domain: "growth", prior: growthEdit, baseline: growthEdit.baseline });
    void foreignConfirmation; void impossibleState; void impossibleAction; void wrongOwnerAction;
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
