import { act, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppState, type AppStateStatus, StyleSheet, Text } from "react-native";

import type {
  BabyProfileServicePort,
  OptionalBabyProfileSnapshot,
} from "../../../src/application/profile/babyProfileService";
import { BabyProfileServiceProvider } from "../../../src/features/profile/BabyProfileServiceContext";
import { StewardScreen } from "../../../src/features/shell/ShellScreens";

jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  const React = jest.requireActual("react");
  return {
    ...actual,
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  };
});

type AppStateListener = (state: AppStateStatus) => void;

let appStateListeners = new Set<AppStateListener>();
const defaultAppState = AppState.currentState;

beforeEach(() => {
  appStateListeners = new Set<AppStateListener>();
  AppState.currentState = "active";
  jest.spyOn(AppState, "addEventListener").mockImplementation((type, listener) => {
    if (type === "change") appStateListeners.add(listener as AppStateListener);
    return {
      remove: () => { appStateListeners.delete(listener as AppStateListener); },
    };
  });
});

afterEach(() => {
  AppState.currentState = defaultAppState;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function emitAppState(state: AppStateStatus) {
  for (const listener of appStateListeners) listener(state);
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

function profileService(load: BabyProfileServicePort["load"]): BabyProfileServicePort {
  return { load, async save() { throw new Error("not used"); } };
}

function renderSteward(service: BabyProfileServicePort) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}>
      <BabyProfileServiceProvider service={service}>
        <StewardScreen />
      </BabyProfileServiceProvider>
    </SafeAreaProvider>,
  );
}

test("管家 reports truthful local readiness without inventing a missing age", async () => {
  renderSteward(profileService(async () => ({
    profile: null,
    exactAge: { status: "unknown", reason: "birth_date_missing", localDate: "2026-07-18", timeZone: "Asia/Shanghai" },
  })));
  await waitFor(() => expect(screen.getByText("宝宝年龄")).toBeTruthy());
  expect(screen.getByText("仅本机")).toBeTruthy();
  expect(screen.getByText("宝宝资料")).toBeTruthy();
  expect(screen.getAllByText("未设置")).toHaveLength(2);
  expect(screen.getByText("出生日期待填")).toBeTruthy();
  expect(screen.getByText("宝宝资料只从本机读取；当前页面不会发送宝宝数据。")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

test("管家 shows the exact repository-backed age while model readiness remains unset", async () => {
  renderSteward(profileService(async () => ({
    profile: {
      name: "测试宝宝", sex: "female", birthDate: "2024-02-29", birthWeightG: null,
      birthHeightCm: null, birthHeadCm: null, isPremature: false, gestationalWeeks: null,
      createdAt: "2025-02-28T20:00:00.000Z", updatedAt: "2025-02-28T20:00:00.000Z",
    },
    exactAge: {
      status: "known", localDate: "2025-02-28", timeZone: "America/Los_Angeles",
      ageDays: 365, completedMonths: 12, remainingDays: 0,
    },
  })));
  expect(await screen.findByText("12个月0天")).toBeTruthy();
  expect(screen.getByText("已保存")).toBeTruthy();
  expect(screen.getByText("模型连接")).toBeTruthy();
  expect(screen.getByText("未设置")).toBeTruthy();
});

test("管家 fails closed instead of presenting corrupt profile data as missing", async () => {
  renderSteward(profileService(async () => { throw new Error("corrupt row"); }));
  expect(await screen.findByText("读取失败")).toBeTruthy();
  expect(screen.getByText("暂不可用")).toBeTruthy();
  expect(screen.queryByText("corrupt row")).toBeNull();
});

test("管家 resamples the active clock without polling and cleans up its single timer and listener", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const profile = {
    name: "测试宝宝", sex: "female" as const, birthDate: "2024-02-29", birthWeightG: null,
    birthHeightCm: null, birthHeadCm: null, isPremature: false, gestationalWeeks: null,
    createdAt: "2025-02-28T20:00:00.000Z", updatedAt: "2025-02-28T20:00:00.000Z",
  };
  const load = jest.fn()
    .mockResolvedValueOnce({
      profile,
      exactAge: {
        status: "known", localDate: "2026-07-18", timeZone: "Asia/Shanghai",
        ageDays: 870, completedMonths: 28, remainingDays: 19,
      },
    })
    .mockResolvedValueOnce({
      profile,
      exactAge: {
        status: "known", localDate: "2026-07-19", timeZone: "Asia/Shanghai",
        ageDays: 871, completedMonths: 28, remainingDays: 20,
      },
    });
  const view = renderSteward(profileService(load));

  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("28个月19天")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  const focusedTimerCount = jest.getTimerCount();
  expect(focusedTimerCount).toBeGreaterThanOrEqual(1);
  expect(appStateListeners.size).toBe(1);
  expect(AppState.addEventListener).toHaveBeenCalledTimes(1);

  await act(async () => {
    jest.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
  });
  expect(load).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(focusedTimerCount);

  await act(async () => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
  });
  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(focusedTimerCount);

  view.unmount();
  expect(jest.getTimerCount()).toBe(focusedTimerCount - 1);
  expect(appStateListeners.size).toBe(0);
  jest.clearAllTimers();
});

test("管家 preserves a calendar refresh raised during an older focus load", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const profile = {
    name: "测试宝宝", sex: "female" as const, birthDate: "2024-02-29", birthWeightG: null,
    birthHeightCm: null, birthHeadCm: null, isPremature: false, gestationalWeeks: null,
    createdAt: "2025-02-28T20:00:00.000Z", updatedAt: "2025-02-28T20:00:00.000Z",
  };
  const older = deferred<OptionalBabyProfileSnapshot>();
  const postEvent = deferred<OptionalBabyProfileSnapshot>();
  const load = jest.fn()
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(postEvent.promise);
  const view = renderSteward(profileService(load));
  expect(load).toHaveBeenCalledTimes(1);

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => { await Promise.resolve(); });
  expect(load).toHaveBeenCalledTimes(2);

  await act(async () => {
    postEvent.resolve({
      profile,
      exactAge: {
        status: "known", localDate: "2026-07-19", timeZone: "Asia/Shanghai",
        ageDays: 871, completedMonths: 28, remainingDays: 20,
      },
    });
    await Promise.resolve();
  });
  expect(screen.queryByText("28个月20天")).toBeNull();

  await act(async () => {
    older.resolve({
      profile: null,
      exactAge: {
        status: "unknown", reason: "birth_date_missing", localDate: "2026-07-18", timeZone: "Asia/Shanghai",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(screen.getByText("已保存")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
  view.unmount();
});

test("管家 keeps age unavailable when an older focus load resolves after a failed calendar refresh", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const profile = {
    name: "测试宝宝", sex: "female" as const, birthDate: "2024-02-29", birthWeightG: null,
    birthHeightCm: null, birthHeadCm: null, isPremature: false, gestationalWeeks: null,
    createdAt: "2025-02-28T20:00:00.000Z", updatedAt: "2025-02-28T20:00:00.000Z",
  };
  const older = deferred<OptionalBabyProfileSnapshot>();
  const load = jest.fn()
    .mockReturnValueOnce(older.promise)
    .mockRejectedValueOnce(new Error("private refresh detail"))
    .mockResolvedValueOnce({
      profile,
      exactAge: {
        status: "known", localDate: "2026-07-19", timeZone: "Asia/Shanghai",
        ageDays: 871, completedMonths: 28, remainingDays: 20,
      },
    });
  const view = renderSteward(profileService(load));

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(load).toHaveBeenCalledTimes(2);

  await act(async () => {
    older.resolve({
      profile,
      exactAge: {
        status: "known", localDate: "2026-07-18", timeZone: "Asia/Shanghai",
        ageDays: 870, completedMonths: 28, remainingDays: 19,
      },
    });
    await Promise.resolve();
  });
  expect(screen.getByText("暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();
  expect(screen.queryByText("private refresh detail")).toBeNull();

  await act(async () => {
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(3);
  view.unmount();
  jest.clearAllTimers();
});

test("管家 marks age unavailable after refresh failure and retries on the bounded clock check", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const profile = {
    name: "测试宝宝", sex: "female" as const, birthDate: "2024-02-29", birthWeightG: null,
    birthHeightCm: null, birthHeadCm: null, isPremature: false, gestationalWeeks: null,
    createdAt: "2025-02-28T20:00:00.000Z", updatedAt: "2025-02-28T20:00:00.000Z",
  };
  const load = jest.fn()
    .mockResolvedValueOnce({
      profile,
      exactAge: {
        status: "known", localDate: "2026-07-18", timeZone: "Asia/Shanghai",
        ageDays: 870, completedMonths: 28, remainingDays: 19,
      },
    })
    .mockRejectedValueOnce(new Error("private refresh detail"))
    .mockResolvedValueOnce({
      profile,
      exactAge: {
        status: "known", localDate: "2026-07-19", timeZone: "Asia/Shanghai",
        ageDays: 871, completedMonths: 28, remainingDays: 20,
      },
    });
  const view = renderSteward(profileService(load));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("28个月19天")).toBeTruthy();

  await act(async () => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText("暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();
  expect(screen.queryByText("private refresh detail")).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);

  await act(async () => {
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(3);
  const focusedTimerCount = jest.getTimerCount();
  expect(focusedTimerCount).toBeGreaterThanOrEqual(1);

  view.unmount();
  expect(jest.getTimerCount()).toBe(focusedTimerCount - 1);
  expect(appStateListeners.size).toBe(0);
  jest.clearAllTimers();
});

test("shell text keeps native scaling and omits clipping-prone fixed line heights", async () => {
  const view = renderSteward(profileService(async () => ({
    profile: null,
    exactAge: { status: "unknown", reason: "birth_date_missing", localDate: "2026-07-18", timeZone: "Asia/Shanghai" },
  })));
  await waitFor(() => expect(screen.getByText("宝宝年龄")).toBeTruthy());
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
});
