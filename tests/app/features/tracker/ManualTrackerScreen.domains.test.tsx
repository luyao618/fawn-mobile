import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ScrollView } from "react-native";

import type { ManualTrackerServicePort } from "../../../../src/application/tracker/manualTrackerService";
import type {
  TrackerCreateInputByDomain,
  TrackerDomain,
  TrackerRecordByDomain,
} from "../../../../src/domain/tracker/types";
import { TrackerValidationError } from "../../../../src/domain/tracker/validation";
import { ManualTrackerScreen } from "../../../../src/features/tracker/ManualTrackerScreen";
import { ManualTrackerServiceProvider } from "../../../../src/features/tracker/ManualTrackerServiceContext";
import { AppFrame } from "../../../../src/shared/ui/AppFrame";
import * as trackerAccessibility from "../../../../src/features/tracker/trackerAccessibility";
import * as trackerLocalTime from "../../../../src/features/tracker/trackerLocalTime";
import {
  trackerScreenReducer,
  type CreateEditorSnapshot,
  type ListFact,
  type OperationOwner,
  type TrackerScreenAction,
  type TrackerScreenState,
} from "../../../../src/features/tracker/trackerScreenState";

const mismatchedCreateDraft = Object.freeze({
  domain: "feeding" as const,
  timeZone: "Asia/Shanghai",
  dateText: "2026-07-20",
  timeText: "08:10",
  feedType: "formula" as const,
  amountMl: "120",
  durationMin: "",
  notes: "",
});

const invalidMismatchedCreateAction: TrackerScreenAction = {
  type: "CREATE_REQUESTED",
  // @ts-expect-error create actions must correlate editor domain, draft, initial draft, and prior rows
  editor: Object.freeze({
    mode: "create",
    domain: "growth",
    draft: mismatchedCreateDraft,
    initialDraft: mismatchedCreateDraft,
    baseline: null,
    capturedZone: "Asia/Shanghai",
    errors: Object.freeze({}),
    prior: Object.freeze({ domain: "growth", rows: Object.freeze([]), presentationZone: "Asia/Shanghai" }),
  }),
};
void invalidMismatchedCreateAction;

let mockFocusCallback: (() => void | (() => void)) | null = null;
let mockFocusCleanup: (() => void) | null = null;

jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  const React = jest.requireActual("react");
  return {
    ...actual,
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(() => {
      mockFocusCallback = effect;
      const cleanup = effect();
      mockFocusCleanup = typeof cleanup === "function" ? cleanup : null;
      return () => {
        mockFocusCleanup?.();
        mockFocusCleanup = null;
        mockFocusCallback = null;
      };
    }, [effect]),
  };
});

const zone = "Asia/Shanghai";
const READ_FAILURE_COPY = "暂时无法读取这条记录。本机数据没有更改。";
const baseMetadata = Object.freeze({
  sourceMessageId: null,
  createdAt: "2026-07-20T00:01:00.000Z",
  updatedAt: "2026-07-20T00:02:00.000Z",
});

const records = Object.freeze({
  growth: Object.freeze({
    ...baseMetadata,
    id: "growth-private-id",
    measurementDate: "2026-07-20",
    weightG: 7200,
    heightCm: 68.5,
    headCm: null,
    weightPercentile: 0,
    heightPercentile: 42.5,
    headPercentile: null,
    notes: null,
  }),
  feeding: Object.freeze({
    ...baseMetadata,
    id: "feeding-private-id",
    feedTime: "2026-07-20T00:10:00.000Z",
    feedType: "formula",
    amountMl: 0,
    durationMin: null,
    notes: null,
  }),
  sleep: Object.freeze({
    ...baseMetadata,
    id: "sleep-private-id",
    sleepStart: "2026-07-20T05:00:00.000Z",
    sleepEnd: null,
    sleepType: "nap",
    nightWakings: 0,
    notes: null,
  }),
  diaper: Object.freeze({
    ...baseMetadata,
    id: "diaper-private-id",
    diaperTime: "2026-07-20T01:30:00.000Z",
    diaperType: "mixed",
    notes: null,
  }),
  health: Object.freeze({
    ...baseMetadata,
    id: "health-private-id",
    recordDate: "2026-07-20",
    recordType: "checkup",
    title: "常规检查",
    description: null,
  }),
}) satisfies { readonly [D in TrackerDomain]: TrackerRecordByDomain[D] };

const hostileDomainCases = ([
  ["growth", "生长", records.growth, records.feeding],
  ["feeding", "喂养", records.feeding, records.sleep],
  ["sleep", "睡眠", records.sleep, records.diaper],
  ["diaper", "大小便", records.diaper, records.health],
  ["health", "健康", records.health, records.growth],
] as const).flatMap(([domain, label, activeRecord, hostileRecord]) => ([
  { activeRecord, domain, hostileRecord, kind: "list" as const, label },
  { activeRecord, domain, hostileRecord, kind: "get" as const, label },
]));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function textContent(children: unknown): string {
  if (Array.isArray(children)) return children.map(textContent).join("");
  return typeof children === "string" || typeof children === "number" ? String(children) : "";
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

function blurTracker() {
  act(() => {
    const cleanup = mockFocusCleanup;
    mockFocusCleanup = null;
    cleanup?.();
  });
}

function refocusTracker() {
  act(() => {
    const cleanup = mockFocusCallback?.();
    mockFocusCleanup = typeof cleanup === "function" ? cleanup : null;
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-07-20T00:10:00.000Z"));
  jest.spyOn(trackerLocalTime, "captureDeviceTimeZone").mockReturnValue({ status: "available", zone });
});

afterEach(() => {
  mockFocusCallback = null;
  mockFocusCleanup = null;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("defaults to growth, preserves the selected domain while mounted, and reads exactly 100 records", async () => {
  const service = createServiceMock();
  const view = renderTracker(service);
  await screen.findByRole("header", { name: "生长记录" });

  expect(screen.getAllByRole("tab").map((tab) => tab.props.accessibilityLabel)).toEqual([
    "生长", "喂养", "睡眠", "大小便", "健康",
  ]);
  expect(service.list).toHaveBeenNthCalledWith(1, "growth", 100);

  fireEvent.press(screen.getByRole("tab", { name: "大小便" }));
  await screen.findByRole("header", { name: "大小便记录" });
  expect(service.list).toHaveBeenNthCalledWith(2, "diaper", 100);
  const appFrameScrolls = view.UNSAFE_getAllByType(ScrollView).filter((scroll) => scroll.props.horizontal !== true);
  expect(appFrameScrolls).toHaveLength(1);
  expect(appFrameScrolls[0]!.props).toMatchObject({
    keyboardDismissMode: "on-drag",
    keyboardShouldPersistTaps: "handled",
  });
  expect(view.UNSAFE_getByType(AppFrame).props).toMatchObject({
    keyboardDismissMode: "on-drag",
    localOnly: true,
    title: "记录",
  });

  view.rerender(
    <SafeAreaProvider initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 20, left: 0, right: 0, bottom: 0 },
    }}>
      <ManualTrackerServiceProvider service={service}>
        <ManualTrackerScreen />
      </ManualTrackerServiceProvider>
    </SafeAreaProvider>,
  );
  expect(screen.getByRole("tab", { name: "大小便" }).props.accessibilityState.selected).toBe(true);
});

test("initial and domain loading reserve heading/action geometry", async () => {
  const growth = deferred<readonly TrackerRecordByDomain["growth"][]>();
  const feeding = deferred<readonly TrackerRecordByDomain["feeding"][]>();
  const service = createServiceMock({
    list: jest.fn((domain) => domain === "growth" ? growth.promise : feeding.promise) as ManualTrackerServicePort["list"],
  });
  renderTracker(service);

  expect(screen.getByText("正在读取生长记录…").props.accessibilityLiveRegion).toBe("polite");
  expect(screen.getByRole("header", { name: "生长记录" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "新增生长记录" }).props.accessibilityState.disabled).toBe(true);
  await act(async () => growth.resolve([]));

  fireEvent.press(screen.getByRole("tab", { name: "喂养" }));
  expect(screen.getByText("正在读取喂养记录…").props.accessibilityLiveRegion).toBe("polite");
  expect(screen.queryByText("还没有生长记录")).toBeNull();
  expect(screen.getByRole("button", { name: "新增喂养记录" }).props.accessibilityState.disabled).toBe(true);
  await act(async () => feeding.resolve([]));
});

test("switching domains starts only the selected-domain read and ignores the older result", async () => {
  const older = deferred<readonly TrackerRecordByDomain["growth"][]>();
  const selected = deferred<readonly TrackerRecordByDomain["feeding"][]>();
  const list = jest.fn((domain: TrackerDomain) => domain === "growth" ? older.promise : selected.promise);
  const service = createServiceMock({ list: list as ManualTrackerServicePort["list"] });
  renderTracker(service);

  fireEvent.press(screen.getByRole("tab", { name: "喂养" }));
  expect(list.mock.calls).toEqual([["growth", 100], ["feeding", 100]]);
  await act(async () => selected.resolve([records.feeding]));
  expect(screen.getByText("配方奶 · 量 0 毫升")).toBeTruthy();

  await act(async () => older.resolve([records.growth]));
  expect(screen.getByRole("header", { name: "喂养记录" })).toBeTruthy();
  expect(screen.queryByText(/体重 7200/)).toBeNull();
});

test("blur invalidates an ordinary list owner before its completion can commit", async () => {
  const older = deferred<readonly TrackerRecordByDomain["growth"][]>();
  const current = deferred<readonly TrackerRecordByDomain["growth"][]>();
  const list = jest.fn()
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(current.promise);
  const service = createServiceMock({ list: list as ManualTrackerServicePort["list"] });
  renderTracker(service);

  blurTracker();
  await act(async () => older.resolve([records.growth]));
  expect(screen.queryByRole("button", { name: /生长记录，/ })).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);

  refocusTracker();
  expect(list.mock.calls).toEqual([["growth", 100], ["growth", 100]]);
  await act(async () => current.resolve([]));
  expect(screen.getByText("还没有生长记录")).toBeTruthy();
  expect(screen.queryByText(/体重 7200/)).toBeNull();
});

test("a stale list rejection after blur cannot replace the newer focused read", async () => {
  const older = deferred<readonly TrackerRecordByDomain["growth"][]>();
  const current = deferred<readonly TrackerRecordByDomain["growth"][]>();
  const list = jest.fn()
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(current.promise);
  const service = createServiceMock({ list: list as ManualTrackerServicePort["list"] });
  renderTracker(service);

  blurTracker();
  await act(async () => older.reject(new Error("private stale list rejection")));
  expect(screen.queryByText("暂时无法读取生长记录。本机数据没有更改。")).toBeNull();

  refocusTracker();
  expect(list.mock.calls).toEqual([["growth", 100], ["growth", 100]]);
  await act(async () => current.resolve([]));
  expect(screen.getByText("还没有生长记录")).toBeTruthy();
  expect(screen.queryByText(/private stale list rejection/)).toBeNull();
});

test("list read failure with no committed rows offers only read retry", async () => {
  const list = jest.fn()
    .mockRejectedValueOnce(new Error("private storage detail"))
    .mockResolvedValueOnce([]);
  const service = createServiceMock({ list });
  renderTracker(service);

  expect(await screen.findByText("暂时无法读取生长记录。本机数据没有更改。")).toBeTruthy();
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
    "重新读取记录",
  ]);
  fireEvent.press(screen.getByRole("button", { name: "重新读取记录" }));
  await screen.findByText("还没有生长记录");
  expect(list.mock.calls).toEqual([["growth", 100], ["growth", 100]]);
  expect(service.getById).not.toHaveBeenCalled();
  expect(service.create).not.toHaveBeenCalled();
});

test("edit loading disables back until get settles, and failure offers retry plus return without a stale draft", async () => {
  const focus = jest.spyOn(trackerAccessibility, "focusRefIfAvailable");
  const pending = deferred<TrackerRecordByDomain["growth"]>();
  const getById = jest.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("private"));
  const service = createServiceMock({
    list: jest.fn(async () => [records.growth]) as ManualTrackerServicePort["list"],
    getById,
  });
  renderTracker(service);
  const row = await screen.findByRole("button", { name: /生长记录，/ });
  fireEvent.press(row);

  expect(screen.getByText("正在读取这条生长记录…").props.accessibilityLiveRegion).toBe("polite");
  expect(screen.getByRole("button", { name: "返回生长列表" }).props.accessibilityState.disabled).toBe(true);
  expect(screen.queryByLabelText("测量日期")).toBeNull();
  expect(getById).toHaveBeenCalledWith("growth", records.growth.id);

  await act(async () => pending.reject(new Error("read failed")));
  expect(screen.getByText("暂时无法读取这条记录。本机数据没有更改。")).toBeTruthy();
  expect(screen.queryByLabelText("测量日期")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "重新读取这条记录" }));
  await screen.findByText("暂时无法读取这条记录。本机数据没有更改。");
  expect(getById.mock.calls).toEqual([
    ["growth", records.growth.id],
    ["growth", records.growth.id],
  ]);
  expect(service.create).not.toHaveBeenCalled();
  expect(service.update).not.toHaveBeenCalled();
  expect(service.delete).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "返回生长列表" })).toBeTruthy();
  focus.mockClear();
  fireEvent.press(screen.getByRole("button", { name: "返回生长列表" }));
  await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
  const [headingTarget] = focus.mock.calls[0]!;
  const mountedHeading = headingTarget?.current as unknown as {
    props: { accessibilityRole?: string; children?: unknown };
  };
  expect(mountedHeading).not.toBeNull();
  expect(mountedHeading.props.accessibilityRole).toBe("header");
  expect(textContent(mountedHeading.props.children)).toBe("生长记录");
  expect(screen.getByRole("header", { name: "生长记录" })).toBeTruthy();
});

test.each(["success", "null", "error"] as const)(
  "rejects stale get %s after blur and a newer focus owner",
  async (outcome) => {
    const older = deferred<TrackerRecordByDomain["growth"] | null>();
    const current = deferred<TrackerRecordByDomain["growth"] | null>();
    const getById = jest.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(current.promise);
    const list = jest.fn(async () => [records.growth]);
    const service = createServiceMock({
      list: list as ManualTrackerServicePort["list"],
      getById: getById as ManualTrackerServicePort["getById"],
    });
    renderTracker(service);
    fireEvent.press(await screen.findByRole("button", { name: /生长记录，/ }));

    blurTracker();
    refocusTracker();
    expect(getById.mock.calls).toEqual([
      ["growth", records.growth.id],
      ["growth", records.growth.id],
    ]);

    await act(async () => {
      if (outcome === "success") older.resolve(records.growth);
      else if (outcome === "null") older.resolve(null);
      else older.reject(new Error("private stale get failure"));
    });
    expect(screen.getByText("正在读取这条生长记录…")).toBeTruthy();
    expect(screen.queryByLabelText("测量日期")).toBeNull();
    expect(screen.queryByText(READ_FAILURE_COPY)).toBeNull();
    expect(screen.queryByText("这条记录已不存在，列表已重新读取。")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => current.resolve(records.growth));
    expect(screen.getByRole("header", { name: "编辑生长记录" })).toBeTruthy();
  },
);

test("a missing selected record returns to the list with the exact not-found message", async () => {
  const list = jest.fn()
    .mockResolvedValueOnce([records.growth])
    .mockResolvedValueOnce([]);
  const service = createServiceMock({ list, getById: jest.fn(async () => null) });
  renderTracker(service);

  fireEvent.press(await screen.findByRole("button", { name: /生长记录，/ }));
  expect(await screen.findByText("这条记录已不存在，列表已重新读取。")).toBeTruthy();
  expect(list.mock.calls).toEqual([["growth", 100], ["growth", 100]]);
  expect(screen.getByRole("header", { name: "生长记录" })).toBeTruthy();
});

test.each([
  ["growth", "生长", "测量日期"],
  ["feeding", "喂养", "喂养日期"],
  ["sleep", "睡眠", "开始日期"],
  ["diaper", "大小便", "记录时间"],
  ["health", "健康", "标题"],
] as const)("creates and opens exact %s editors", async (domain, label, fieldLabel) => {
  const service = createServiceMock();
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  if (domain !== "growth") {
    fireEvent.press(screen.getByRole("tab", { name: label }));
    await screen.findByText(`还没有${label}记录`);
  }
  fireEvent.press(screen.getByRole("button", { name: `新增${label}记录` }));
  expect(screen.getByRole("header", { name: `新增${label}记录` })).toBeTruthy();
  expect(screen.getByLabelText(fieldLabel)).toBeTruthy();
  expect(service.getById).not.toHaveBeenCalled();
});

test.each([
  ["growth", "生长", "测量日期", "2026-07-20"],
  ["feeding", "喂养", "喂养时间", "08:10"],
  ["sleep", "睡眠", "开始时间", "13:00"],
  ["diaper", "大小便", "记录时间", "09:30"],
  ["health", "健康", "标题", "常规检查"],
] as const)("loads the exact %s edit editor through getById", async (domain, label, fieldLabel, value) => {
  const getById = jest.fn(async () => records[domain]);
  const service = createServiceMock({
    list: jest.fn(async (requestedDomain) => requestedDomain === domain ? [records[domain]] : []) as ManualTrackerServicePort["list"],
    getById: getById as ManualTrackerServicePort["getById"],
  });
  renderTracker(service);
  if (domain !== "growth") {
    await screen.findByText("还没有生长记录");
    fireEvent.press(screen.getByRole("tab", { name: label }));
  }
  fireEvent.press(await screen.findByRole("button", { name: new RegExp(`${label}记录，`) }));
  expect(await screen.findByRole("header", { name: `编辑${label}记录` })).toBeTruthy();
  expect(screen.getByLabelText(fieldLabel).props.value).toBe(value);
  expect(getById).toHaveBeenCalledWith(domain, records[domain].id);
});

test.each([
  {
    domain: "growth" as const,
    label: "生长",
    fill: () => {
      fireEvent.changeText(screen.getByLabelText("体重（克）"), "7200");
      fireEvent.changeText(screen.getByLabelText("身长（厘米）"), "68.5");
      fireEvent.changeText(screen.getByLabelText("头围（厘米）"), "43.2");
      fireEvent.changeText(screen.getByLabelText("备注"), "完整生长备注");
    },
    input: {
      measurementDate: "2026-07-20", weightG: 7200, heightCm: 68.5, headCm: 43.2,
      weightPercentile: null, heightPercentile: null, headPercentile: null,
      notes: "完整生长备注", sourceMessageId: null,
    },
  },
  {
    domain: "feeding" as const,
    label: "喂养",
    fill: () => {
      fireEvent.press(screen.getByRole("radio", { name: "喂养类型配方奶" }));
      fireEvent.changeText(screen.getByLabelText("量（毫升）"), "0");
      fireEvent.changeText(screen.getByLabelText("时长（分钟）"), "15");
      fireEvent.changeText(screen.getByLabelText("备注"), "完整喂养备注");
    },
    input: {
      feedTime: "2026-07-20T00:10:00.000Z", feedType: "formula", amountMl: 0,
      durationMin: 15, notes: "完整喂养备注", sourceMessageId: null,
    },
  },
  {
    domain: "sleep" as const,
    label: "睡眠",
    fill: () => {
      fireEvent.changeText(screen.getByLabelText("结束日期"), "2026-07-20");
      fireEvent.changeText(screen.getByLabelText("结束时间"), "09:40");
      fireEvent.press(screen.getByRole("radio", { name: "睡眠类型夜间睡眠" }));
      fireEvent.changeText(screen.getByLabelText("夜醒次数"), "3");
      fireEvent.changeText(screen.getByLabelText("备注"), "完整睡眠备注");
    },
    input: {
      sleepStart: "2026-07-20T00:10:00.000Z", sleepEnd: "2026-07-20T01:40:00.000Z", sleepType: "night",
      nightWakings: 3, notes: "完整睡眠备注", sourceMessageId: null,
    },
  },
  {
    domain: "diaper" as const,
    label: "大小便",
    fill: () => {
      fireEvent.press(screen.getByRole("radio", { name: "类型大便" }));
      fireEvent.changeText(screen.getByLabelText("备注"), "完整大小便备注");
    },
    input: {
      diaperTime: "2026-07-20T00:10:00.000Z", diaperType: "poop",
      notes: "完整大小便备注", sourceMessageId: null,
    },
  },
] satisfies readonly {
  domain: Exclude<TrackerDomain, "health">;
  label: string;
  fill: () => void;
  input: TrackerCreateInputByDomain[Exclude<TrackerDomain, "health">];
}[])("low-risk $domain create calls once with the exact DTO and only completed is success", async ({ domain, label, fill, input }) => {
  const create = jest.fn(async (calledDomain: TrackerDomain, calledInput: TrackerCreateInputByDomain[TrackerDomain]) => ({
    status: "completed" as const,
    summary: Object.freeze({ action: "create" as const, domain: calledDomain, input: calledInput }),
    record: records[domain],
  }));
  const service = createServiceMock({ create: create as ManualTrackerServicePort["create"] });
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  if (domain !== "growth") {
    fireEvent.press(screen.getByRole("tab", { name: label }));
    await screen.findByText(`还没有${label}记录`);
  }
  fireEvent.press(screen.getByRole("button", { name: `新增${label}记录` }));
  fill();
  fireEvent.press(screen.getByRole("button", { name: `保存${label}记录` }));

  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledWith(domain, input);
  await screen.findByText(`${label}记录已保存`);
  expect(service.update).not.toHaveBeenCalled();
  expect(service.delete).not.toHaveBeenCalled();
});

test("unexpected low-risk confirmation_required is a safe retained-form failure", async () => {
  const input: TrackerCreateInputByDomain["growth"] = {
    measurementDate: "2026-07-20", weightG: 7200, heightCm: null, headCm: null,
    weightPercentile: null, heightPercentile: null, headPercentile: null, notes: null, sourceMessageId: null,
  };
  const create = jest.fn(async () => ({
    status: "confirmation_required" as const,
    summary: Object.freeze({ action: "create" as const, domain: "growth" as const, input }),
  }));
  const service = createServiceMock({ create: create as ManualTrackerServicePort["create"] });
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("button", { name: "新增生长记录" }));
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7200");
  fireEvent.press(screen.getByRole("button", { name: "保存生长记录" }));

  expect(await screen.findByText("保存失败，本机记录没有更改。")).toBeTruthy();
  expect(screen.getByLabelText("体重（克）").props.value).toBe("7200");
  expect(create).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("生长记录已保存")).toBeNull();
});

test("a pending low-risk create stays interlocked, then starts one operation-owned refresh and focuses its mounted heading", async () => {
  const createResult = deferred<Awaited<ReturnType<ManualTrackerServicePort["create"]>>>();
  const refresh = deferred<readonly TrackerRecordByDomain["growth"][]>();
  const list = jest.fn()
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(refresh.promise);
  const create = jest.fn((
    _domain: TrackerDomain,
    _input: TrackerCreateInputByDomain[TrackerDomain],
  ) => createResult.promise);
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    create: create as ManualTrackerServicePort["create"],
  });
  const focus = jest.spyOn(trackerAccessibility, "focusRefIfAvailable");
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("button", { name: "新增生长记录" }));
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7200");
  fireEvent.press(screen.getByRole("button", { name: "保存生长记录" }));

  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const save = screen.getByRole("button", { name: "保存生长记录" });
  expect(save.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  expect(screen.queryByText("生长记录已保存")).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);
  fireEvent.press(save);
  expect(create).toHaveBeenCalledTimes(1);
  focus.mockClear();

  const input = create.mock.calls[0]![1];
  await act(async () => createResult.resolve({
    status: "completed",
    summary: Object.freeze({ action: "create", domain: "growth", input }),
    record: records.growth,
  }));
  expect(list.mock.calls).toEqual([["growth", 100], ["growth", 100]]);
  expect(screen.getByText("生长记录已保存")).toBeTruthy();
  await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
  const [headingTarget] = focus.mock.calls[0]!;
  const mountedHeading = headingTarget?.current as unknown as {
    props: { accessibilityRole?: string; children?: unknown };
  };
  expect(mountedHeading).not.toBeNull();
  expect(mountedHeading.props.accessibilityRole).toBe("header");
  expect(textContent(mountedHeading.props.children)).toBe("生长记录");
  expect(screen.getByRole("header", { name: "生长记录" })).toBeTruthy();

  blurTracker();
  refocusTracker();
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => refresh.resolve([]));
  expect(screen.getByText("生长记录已保存")).toBeTruthy();
  expect(create).toHaveBeenCalledTimes(1);
});

test("validation focuses the first invalid field and keeps safe adjacent copy", async () => {
  const focus = jest.spyOn(trackerAccessibility, "focusRefIfAvailable");
  const service = createServiceMock();
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("button", { name: "新增生长记录" }));
  fireEvent.changeText(screen.getByLabelText("测量日期"), "bad-private-value");
  fireEvent.press(screen.getByRole("button", { name: "保存生长记录" }));

  expect(screen.getByText("测量日期需要使用 YYYY-MM-DD 格式。").props.accessibilityRole).toBe("alert");
  expect(focus).toHaveBeenCalledTimes(1);
  const [target] = focus.mock.calls[0]!;
  expect((target?.current as unknown as { props: { accessibilityLabel?: string } })?.props.accessibilityLabel).toBe("测量日期");
  expect(service.create).not.toHaveBeenCalled();
});

test.each([
  ["feeding", "喂养", "请选择母乳、配方奶或辅食。", "喂养类型母乳"],
  ["sleep", "睡眠", "请选择小睡或夜间睡眠。", "睡眠类型小睡"],
  ["diaper", "大小便", "请选择大便、小便或混合。", "类型大便"],
] as const)("validation focuses the first %s radio alias", async (domain, label, errorCopy, focusLabel) => {
  const focus = jest.spyOn(trackerAccessibility, "focusRefIfAvailable");
  const service = createServiceMock();
  renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("tab", { name: label }));
  await screen.findByText(`还没有${label}记录`);
  fireEvent.press(screen.getByRole("button", { name: `新增${label}记录` }));
  fireEvent.press(screen.getByRole("button", { name: `保存${label}记录` }));

  expect(screen.getByText(errorCopy).props.accessibilityRole).toBe("alert");
  await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
  const [target] = focus.mock.calls[0]!;
  expect((target?.current as unknown as { props: { accessibilityLabel?: string } })?.props.accessibilityLabel).toBe(focusLabel);
  expect(service.create).not.toHaveBeenCalled();
});

test.each([
  ["weightG", "请检查标出的内容后再保存。", "体重（克）"],
  ["privateRawField", "请检查标出的内容后再保存。", null],
] as const)("maps service validation field %s without exposing raw details", async (field, message, fieldLabel) => {
  const create = jest.fn(async () => {
    throw new TrackerValidationError("growth", field, "private raw validation detail");
  });
  const service = createServiceMock({ create: create as ManualTrackerServicePort["create"] });
  const view = renderTracker(service);
  await screen.findByText("还没有生长记录");
  fireEvent.press(screen.getByRole("button", { name: "新增生长记录" }));
  fireEvent.changeText(screen.getByLabelText("体重（克）"), "7200");
  fireEvent.press(screen.getByRole("button", { name: "保存生长记录" }));

  expect(await screen.findByText(message)).toBeTruthy();
  if (fieldLabel !== null) expect(screen.getByLabelText(fieldLabel).props.value).toBe("7200");
  const rendered = JSON.stringify(view.toJSON());
  expect(rendered).not.toContain("private raw validation detail");
  expect(rendered).not.toContain("privateRawField");
});

test.each(hostileDomainCases)('$kind fails closed when $domain receives another domain without private leakage', async ({
  activeRecord,
  domain,
  hostileRecord,
  kind,
  label,
}) => {
  const list = jest.fn(async (requestedDomain: TrackerDomain) => {
    if (requestedDomain === "growth" && domain !== "growth") return [];
    if (requestedDomain !== domain) return [];
    return kind === "list" ? [hostileRecord] : [activeRecord];
  });
  const getById = jest.fn(async () => hostileRecord);
  const service = createServiceMock({
    list: list as ManualTrackerServicePort["list"],
    getById: getById as ManualTrackerServicePort["getById"],
  });
  const view = renderTracker(service);

  if (domain !== "growth") {
    await screen.findByText("还没有生长记录");
    fireEvent.press(screen.getByRole("tab", { name: label }));
  }
  if (kind === "list") {
    expect(await screen.findByText(`暂时无法读取${label}记录。本机数据没有更改。`)).toBeTruthy();
  } else {
    fireEvent.press(await screen.findByRole("button", { name: new RegExp(`${label}记录，`) }));
    expect(await screen.findByText(READ_FAILURE_COPY)).toBeTruthy();
    expect(getById).toHaveBeenCalledWith(domain, activeRecord.id);
  }
  const rendered = JSON.stringify(view.toJSON());
  for (const [key, value] of Object.entries(hostileRecord)) {
    if (typeof value === "string" && (key === "id" || key === "sourceMessageId" || value.includes("T"))) {
      expect(rendered).not.toContain(value);
    }
  }
  expect(service.create).not.toHaveBeenCalled();
  expect(service.update).not.toHaveBeenCalled();
  expect(service.delete).not.toHaveBeenCalled();
});

test("keeps Records profile-independent and inside the tracker application boundary", async () => {
  const source = readFileSync(
    require.resolve("../../../../src/features/tracker/ManualTrackerScreen"),
    "utf8",
  );
  expect(source).not.toMatch(/BabyProfile|DataMutationCoordinator|ExclusiveTransaction|sqlite|migration|fetch\(/);

  const service = createServiceMock();
  renderTracker(service);
  expect(await screen.findByText("还没有生长记录")).toBeTruthy();
  expect(service.list).toHaveBeenCalledWith("growth", 100);
});

test("the reducer rejects mismatched mutation owner, prior identity, and domain facts", () => {
  const rows = Object.freeze([records.growth]);
  const prior: ListFact<"growth"> = Object.freeze({ domain: "growth", rows, presentationZone: zone });
  const draft = Object.freeze({
    domain: "growth" as const,
    timeZone: zone,
    dateText: "2026-07-20",
    weightG: "7200",
    heightCm: "",
    headCm: "",
    notes: "",
  });
  const editor: CreateEditorSnapshot<"growth"> = Object.freeze({
    mode: "create",
    domain: "growth",
    draft,
    initialDraft: Object.freeze({ ...draft }),
    baseline: null,
    capturedZone: zone,
    errors: Object.freeze({}),
    prior,
  });
  const editing: TrackerScreenState = Object.freeze({ tag: "create.editing", editor });
  const wrongOwner: OperationOwner<"feeding", "create"> = Object.freeze({
    mountEpoch: 1,
    operationId: 1,
    domain: "feeding",
    kind: "create",
  });
  // @ts-expect-error mutation actions must correlate owner and prior domains
  expect(trackerScreenReducer(editing, {
    type: "MUTATION_STARTED",
    owner: wrongOwner,
    prior: editor,
  })).toBe(editing);

  const owner: OperationOwner<"growth", "create"> = Object.freeze({
    mountEpoch: 1,
    operationId: 2,
    domain: "growth",
    kind: "create",
  });
  const submitting = trackerScreenReducer(editing, { type: "MUTATION_STARTED", owner, prior: editor });
  expect(submitting).not.toBe(editing);
  const duplicatedPrior: ListFact<"growth"> = Object.freeze({ ...prior });
  expect(trackerScreenReducer(submitting, {
    type: "OPERATION_REFRESH_STARTED",
    owner,
    next: Object.freeze({
      tag: "list.loading",
      source: "mutation-refresh",
      owner,
      prior: duplicatedPrior,
      success: "生长记录已保存",
    }),
  })).toBe(submitting);
});
