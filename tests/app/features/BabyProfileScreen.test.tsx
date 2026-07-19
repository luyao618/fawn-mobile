import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppState, type AppStateStatus, StyleSheet, Text } from "react-native";

import type {
  BabyProfileServicePort,
  BabyProfileSnapshot,
  OptionalBabyProfileSnapshot,
} from "../../../src/application/profile/babyProfileService";
import { BabyProfileValidationError } from "../../../src/domain/baby/profile";
import {
  BabyProfileServiceProvider,
} from "../../../src/features/profile/BabyProfileServiceContext";
import { BabyProfileScreen } from "../../../src/features/profile/BabyProfileScreen";

type FocusEffect = () => void | (() => void);
type FocusRegistration = {
  effect: FocusEffect;
  cleanup: (() => void) | undefined;
};
type FocusHarness = {
  focused: boolean;
  registrations: Set<FocusRegistration>;
};

jest.mock("@react-navigation/native", () => {
  const actual = jest.requireActual("@react-navigation/native");
  const React = jest.requireActual("react");
  const harness: FocusHarness = {
    focused: true,
    registrations: new Set<FocusRegistration>(),
  };
  (globalThis as typeof globalThis & { __babyProfileFocusHarness: FocusHarness }).__babyProfileFocusHarness = harness;
  return {
    ...actual,
    useFocusEffect: (effect: FocusEffect) => React.useEffect(() => {
      const registration: FocusRegistration = { cleanup: undefined, effect };
      harness.registrations.add(registration);
      if (harness.focused) {
        const cleanup = effect();
        registration.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
      return () => {
        registration.cleanup?.();
        registration.cleanup = undefined;
        harness.registrations.delete(registration);
      };
    }, [effect]),
  };
});

type AppStateListener = (state: AppStateStatus) => void;

let appStateListeners = new Set<AppStateListener>();
const defaultAppState = AppState.currentState;

function focusHarness(): FocusHarness {
  return (globalThis as typeof globalThis & { __babyProfileFocusHarness: FocusHarness }).__babyProfileFocusHarness;
}

function setProfileFocused(focused: boolean) {
  const harness = focusHarness();
  if (harness.focused === focused) return;
  harness.focused = focused;
  for (const registration of [...harness.registrations]) {
    if (focused) {
      const cleanup = registration.effect();
      registration.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    } else {
      registration.cleanup?.();
      registration.cleanup = undefined;
    }
  }
}

beforeEach(() => {
  const harness = focusHarness();
  for (const registration of harness.registrations) registration.cleanup?.();
  harness.registrations.clear();
  harness.focused = true;
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

const emptySnapshot: OptionalBabyProfileSnapshot = Object.freeze({
  profile: null,
  exactAge: Object.freeze({
    status: "unknown",
    reason: "birth_date_missing",
    localDate: "2026-07-18",
    timeZone: "Asia/Shanghai",
  }),
});

const savedSnapshot: BabyProfileSnapshot = Object.freeze({
  profile: Object.freeze({
    name: "测试宝宝",
    sex: "female",
    birthDate: "2024-02-29",
    birthWeightG: 3_200,
    birthHeightCm: 50.5,
    birthHeadCm: 34.2,
    isPremature: true,
    gestationalWeeks: 36,
    createdAt: "2026-07-18T01:00:00.000Z",
    updatedAt: "2026-07-18T01:00:00.000Z",
  }),
  exactAge: Object.freeze({
    status: "known",
    localDate: "2026-07-18",
    timeZone: "Asia/Shanghai",
    ageDays: 870,
    completedMonths: 28,
    remainingDays: 19,
  }),
});

const termSnapshot: BabyProfileSnapshot = Object.freeze({
  profile: Object.freeze({
    name: "小满",
    sex: null,
    birthDate: null,
    birthWeightG: null,
    birthHeightCm: null,
    birthHeadCm: null,
    isPremature: false,
    gestationalWeeks: null,
    createdAt: "2026-07-18T01:00:00.000Z",
    updatedAt: "2026-07-18T01:00:00.000Z",
  }),
  exactAge: Object.freeze({
    status: "unknown",
    reason: "birth_date_missing",
    localDate: "2026-07-18",
    timeZone: "Asia/Shanghai",
  }),
});

function service(overrides: Partial<BabyProfileServicePort> = {}): BabyProfileServicePort {
  return {
    load: jest.fn(async () => emptySnapshot),
    save: jest.fn(async () => savedSnapshot),
    ...overrides,
  };
}

function profileTree(profileService: BabyProfileServicePort) {
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}>
      <BabyProfileServiceProvider service={profileService}>
        <BabyProfileScreen />
      </BabyProfileServiceProvider>
    </SafeAreaProvider>
  );
}

function renderProfile(profileService: BabyProfileServicePort) {
  return render(profileTree(profileService));
}

test("我的 exposes every partial profile field with scalable, accessible controls", async () => {
  const view = renderProfile(service());
  await waitFor(() => expect(screen.getByRole("header", { name: "宝宝资料" })).toBeTruthy());

  for (const label of ["宝宝姓名", "出生日期", "出生体重（克）", "出生身长（厘米）", "出生头围（厘米）", "出生孕周（周）"]) {
    expect(screen.getByLabelText(label)).toBeTruthy();
  }
  for (const label of ["性别暂不填", "性别男孩", "性别女孩", "足月", "早产"]) {
    const control = screen.getByRole("radio", { name: label });
    expect(StyleSheet.flatten(control.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
  }
  expect(screen.getByRole("radio", { name: "足月" }).props.accessibilityState.checked).toBe(false);
  expect(screen.getByRole("radio", { name: "早产" }).props.accessibilityState.checked).toBe(false);
  expect(screen.getByRole("button", { name: "保存宝宝资料" })).toBeTruthy();
  expect(screen.getByText("出生日期待填")).toBeTruthy();
  expect(screen.getByText("资料只保存在本机；其他项目可以暂不填写，出生状态需选择足月或早产。")).toBeTruthy();
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
});

test("我的 requires an explicit prematurity choice before the first save", async () => {
  const save = jest.fn(async () => termSnapshot);
  renderProfile(service({ save }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存宝宝资料" })).toBeTruthy());

  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));

  const fieldError = screen.getByText("请选择足月或早产。");
  expect(fieldError.props.accessibilityRole).toBe("alert");
  expect(fieldError.props.accessibilityLiveRegion).toBe("assertive");
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});

test("我的 derives stable ASCII radio IDs from the current React selection state", async () => {
  renderProfile(service());
  await waitFor(() => expect(screen.getByLabelText("宝宝姓名")).toBeTruthy());

  expect(screen.getByTestId("baby-profile-sex-unspecified-selected")).toBeTruthy();
  expect(screen.getByTestId("baby-profile-sex-male-unselected")).toBeTruthy();
  expect(screen.getByTestId("baby-profile-sex-female-unselected")).toBeTruthy();
  expect(screen.getByTestId("baby-profile-prematurity-term-unselected")).toBeTruthy();
  expect(screen.getByTestId("baby-profile-prematurity-preterm-unselected")).toBeTruthy();

  fireEvent.press(screen.getByRole("radio", { name: "性别女孩" }));
  fireEvent.press(screen.getByRole("radio", { name: "足月" }));

  expect(screen.queryByTestId("baby-profile-sex-unspecified-selected")).toBeNull();
  expect(screen.getByTestId("baby-profile-sex-unspecified-unselected")).toBeTruthy();
  expect(screen.getByTestId("baby-profile-sex-female-selected")).toBeTruthy();
  expect(screen.queryByTestId("baby-profile-prematurity-term-unselected")).toBeNull();
  expect(screen.getByTestId("baby-profile-prematurity-term-selected")).toBeTruthy();
});

test("我的 permits a partial first save after choosing 足月", async () => {
  const save = jest.fn(async () => termSnapshot);
  renderProfile(service({ save }));
  await waitFor(() => expect(screen.getByLabelText("宝宝姓名")).toBeTruthy());

  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "小满");
  fireEvent.press(screen.getByRole("radio", { name: "足月" }));
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));

  expect(save).toHaveBeenCalledWith({
    name: "小满",
    sex: null,
    birthDate: null,
    birthWeightG: null,
    birthHeightCm: null,
    birthHeadCm: null,
    isPremature: false,
    gestationalWeeks: null,
  }, null);
  expect(await screen.findByText("宝宝资料已保存")).toBeTruthy();
  expect(screen.getByRole("radio", { name: "足月" }).props.accessibilityState.checked).toBe(true);
});

test("我的 hydrates every persisted field including the prematurity boolean", async () => {
  renderProfile(service({ load: jest.fn(async () => savedSnapshot) }));

  expect(await screen.findByDisplayValue("测试宝宝")).toBeTruthy();
  expect(screen.getByDisplayValue("2024-02-29")).toBeTruthy();
  expect(screen.getByDisplayValue("3200")).toBeTruthy();
  expect(screen.getByDisplayValue("50.5")).toBeTruthy();
  expect(screen.getByDisplayValue("34.2")).toBeTruthy();
  expect(screen.getByDisplayValue("36")).toBeTruthy();
  expect(screen.getByRole("radio", { name: "性别女孩" }).props.accessibilityState.checked).toBe(true);
  expect(screen.getByRole("radio", { name: "早产" }).props.accessibilityState.checked).toBe(true);
  expect(screen.getByRole("radio", { name: "足月" }).props.accessibilityState.checked).toBe(false);
  expect(screen.getByTestId("baby-profile-sex-female-selected")).toBeTruthy();
  expect(screen.getByTestId("baby-profile-prematurity-preterm-selected")).toBeTruthy();
  expect(screen.getByTestId("baby-profile-prematurity-term-unselected")).toBeTruthy();
});

test("我的 saves canonical field values only after the service commits", async () => {
  let resolveSave!: (snapshot: BabyProfileSnapshot) => void;
  const pendingSave = new Promise<BabyProfileSnapshot>((resolve) => { resolveSave = resolve; });
  const save = jest.fn(() => pendingSave);
  renderProfile(service({ save }));
  await waitFor(() => expect(screen.getByLabelText("宝宝姓名")).toBeTruthy());

  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), " 测试宝宝 ");
  fireEvent.changeText(screen.getByLabelText("出生日期"), "2024-02-29");
  fireEvent.changeText(screen.getByLabelText("出生体重（克）"), "3200");
  fireEvent.changeText(screen.getByLabelText("出生身长（厘米）"), "50.5");
  fireEvent.changeText(screen.getByLabelText("出生头围（厘米）"), "34.2");
  fireEvent.changeText(screen.getByLabelText("出生孕周（周）"), "36");
  fireEvent.press(screen.getByRole("radio", { name: "性别女孩" }));
  fireEvent.press(screen.getByRole("radio", { name: "早产" }));
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));

  expect(save).toHaveBeenCalledWith({
    name: " 测试宝宝 ",
    sex: "female",
    birthDate: "2024-02-29",
    birthWeightG: 3_200,
    birthHeightCm: 50.5,
    birthHeadCm: 34.2,
    isPremature: true,
    gestationalWeeks: 36,
  }, null);
  expect(screen.getByText("正在保存…")).toBeTruthy();
  expect(screen.queryByText("宝宝资料已保存")).toBeNull();
  for (const label of ["宝宝姓名", "出生日期", "出生体重（克）", "出生身长（厘米）", "出生头围（厘米）", "出生孕周（周）"]) {
    const input = screen.getByLabelText(label);
    expect(input.props.editable).toBe(false);
    expect(input.props.accessibilityState.disabled).toBe(true);
  }
  for (const label of ["性别暂不填", "性别男孩", "性别女孩", "足月", "早产"]) {
    const control = screen.getByRole("radio", { name: label });
    expect(control.props.accessibilityState.disabled).toBe(true);
  }
  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "保存中输入");
  fireEvent.press(screen.getByRole("radio", { name: "性别男孩" }));
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe(" 测试宝宝 ");
  expect(screen.getByRole("radio", { name: "性别女孩" }).props.accessibilityState.checked).toBe(true);

  await act(async () => resolveSave(savedSnapshot));
  expect(screen.getByText("宝宝资料已保存")).toBeTruthy();
  expect(screen.getByText("28个月19天")).toBeTruthy();
});

test("我的 defers a boundary refresh until save settles without publishing the saved stale age", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const pendingSave = deferred<BabyProfileSnapshot>();
  const pendingRefresh = deferred<OptionalBabyProfileSnapshot>();
  const savedBeforeRefresh: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "边界保存草稿",
      updatedAt: "2026-07-19T02:00:00.000Z",
    }),
    exactAge: savedSnapshot.exactAge,
  });
  const refreshedSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: savedBeforeRefresh.profile,
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 871,
      completedMonths: 28,
      remainingDays: 20,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockReturnValueOnce(pendingRefresh.promise);
  const save = jest.fn(() => pendingSave.promise);
  const view = renderProfile(service({ load, save }));
  expect(await screen.findByText("28个月19天")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "边界保存草稿");
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => { await Promise.resolve(); });

  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();

  await act(async () => {
    pendingSave.resolve(savedBeforeRefresh);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("边界保存草稿");
  expect(screen.getByText("宝宝资料已保存")).toBeTruthy();

  await act(async () => {
    pendingRefresh.resolve(refreshedSnapshot);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("边界保存草稿");
  expect(screen.getByText("宝宝资料已保存")).toBeTruthy();
  view.unmount();
});

test("我的 preserves a save rejected while blurred and refocuses with only an age refresh", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const pendingSave = deferred<BabyProfileSnapshot>();
  const pendingRefresh = deferred<OptionalBabyProfileSnapshot>();
  const pendingRetry = deferred<BabyProfileSnapshot>();
  const refreshedSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "不应替换草稿",
      updatedAt: "2026-07-19T03:00:00.000Z",
    }),
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 871,
      completedMonths: 28,
      remainingDays: 20,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockReturnValueOnce(pendingRefresh.promise);
  const save = jest.fn()
    .mockReturnValueOnce(pendingSave.promise)
    .mockReturnValueOnce(pendingRetry.promise);
  const profileService = service({ load, save });
  const view = renderProfile(profileService);
  expect(await screen.findByText("28个月19天")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "提交中的草稿");
  fireEvent.changeText(screen.getByLabelText("出生日期"), "2024-02-30");
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));

  act(() => setProfileFocused(false));
  expect(appStateListeners.size).toBe(0);
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("提交中的草稿");
  expect(screen.getByText("正在保存…")).toBeTruthy();

  await act(async () => {
    pendingSave.reject(new BabyProfileValidationError("birthDate", "private validation detail"));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("提交中的草稿");
  expect(screen.getByLabelText("出生日期").props.value).toBe("2024-02-30");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
  });
  expect(screen.getByText("28个月19天")).toBeTruthy();

  act(() => setProfileFocused(true));
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("28个月19天")).toBeNull();
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("提交中的草稿");
  expect(screen.getByLabelText("出生日期").props.value).toBe("2024-02-30");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();
  expect(screen.queryByText("private validation detail")).toBeNull();

  await act(async () => {
    pendingRefresh.resolve(refreshedSnapshot);
    await pendingRefresh.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(screen.getByText("测试宝宝")).toBeTruthy();
  expect(screen.queryByText("不应替换草稿")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("提交中的草稿");
  expect(screen.getByLabelText("出生日期").props.value).toBe("2024-02-30");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();
  expect(screen.queryByText("private validation detail")).toBeNull();
  expect(appStateListeners.size).toBe(1);

  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
  expect(save).toHaveBeenLastCalledWith({
    name: "提交中的草稿",
    sex: "female",
    birthDate: "2024-02-30",
    birthWeightG: 3_200,
    birthHeightCm: 50.5,
    birthHeadCm: 34.2,
    isPremature: true,
    gestationalWeeks: 36,
  }, "2026-07-18T01:00:00.000Z");
  view.unmount();
});

test("我的 hides age when a blurred calendar boundary refocuses during save and refreshes after settlement", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const pendingSave = deferred<BabyProfileSnapshot>();
  const pendingRefresh = deferred<OptionalBabyProfileSnapshot>();
  const savedBeforeRefresh: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "跨日保存草稿",
      updatedAt: "2026-07-19T03:00:00.000Z",
    }),
    exactAge: savedSnapshot.exactAge,
  });
  const refreshedSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedBeforeRefresh.profile,
      name: "不应替换保存结果",
    }),
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 871,
      completedMonths: 28,
      remainingDays: 20,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockReturnValueOnce(pendingRefresh.promise);
  const save = jest.fn(() => pendingSave.promise);
  const view = renderProfile(service({ load, save }));
  expect(await screen.findByText("28个月19天")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "跨日保存草稿");
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));

  act(() => setProfileFocused(false));
  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    setProfileFocused(true);
  });

  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();

  await act(async () => {
    pendingSave.resolve(savedBeforeRefresh);
    await pendingSave.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("跨日保存草稿");
  expect(screen.getByText("宝宝资料已保存")).toBeTruthy();

  await act(async () => {
    pendingRefresh.resolve(refreshedSnapshot);
    await pendingRefresh.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(screen.getByText("跨日保存草稿")).toBeTruthy();
  expect(screen.queryByText("不应替换保存结果")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("跨日保存草稿");
  view.unmount();
});

test("我的 reruns a refresh that started before a save so the older completion cannot end stale", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const olderRefresh = deferred<OptionalBabyProfileSnapshot>();
  const pendingSave = deferred<BabyProfileSnapshot>();
  const freshRerun = deferred<OptionalBabyProfileSnapshot>();
  const savedDuringRefresh: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "逆序保存草稿",
      updatedAt: "2026-07-19T04:00:00.000Z",
    }),
    exactAge: savedSnapshot.exactAge,
  });
  const olderSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "较旧刷新资料",
    }),
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 870,
      completedMonths: 28,
      remainingDays: 18,
    }),
  });
  const freshSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedDuringRefresh.profile,
      name: "不应替换保存草稿",
    }),
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 871,
      completedMonths: 28,
      remainingDays: 20,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockReturnValueOnce(olderRefresh.promise)
    .mockReturnValueOnce(freshRerun.promise);
  const save = jest.fn(() => pendingSave.promise);
  const view = renderProfile(service({ load, save }));
  expect(await screen.findByText("28个月19天")).toBeTruthy();

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => { await Promise.resolve(); });
  expect(load).toHaveBeenCalledTimes(2);

  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "逆序保存草稿");
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();

  await act(async () => {
    pendingSave.resolve(savedDuringRefresh);
    await pendingSave.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();

  await act(async () => {
    olderRefresh.resolve(olderSnapshot);
    await olderRefresh.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(3);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月18天")).toBeNull();

  await act(async () => {
    freshRerun.resolve(freshSnapshot);
    await freshRerun.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(3);
  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(screen.getByText("逆序保存草稿")).toBeTruthy();
  expect(screen.queryByText("不应替换保存草稿")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("逆序保存草稿");
  view.unmount();
});

test("我的 keeps age unavailable after a failed save until the inverse refresh rerun completes", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const olderRefresh = deferred<OptionalBabyProfileSnapshot>();
  const pendingSave = deferred<BabyProfileSnapshot>();
  const freshRerun = deferred<OptionalBabyProfileSnapshot>();
  const pendingRetry = deferred<BabyProfileSnapshot>();
  const olderSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "不应采用较旧刷新资料",
      updatedAt: "2026-07-19T05:00:00.000Z",
    }),
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 870,
      completedMonths: 28,
      remainingDays: 18,
    }),
  });
  const freshSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "不应采用重跑刷新资料",
      updatedAt: "2026-07-19T06:00:00.000Z",
    }),
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 871,
      completedMonths: 28,
      remainingDays: 20,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockReturnValueOnce(olderRefresh.promise)
    .mockReturnValueOnce(freshRerun.promise);
  const save = jest.fn()
    .mockReturnValueOnce(pendingSave.promise)
    .mockReturnValueOnce(pendingRetry.promise);
  const view = renderProfile(service({ load, save }));
  expect(await screen.findByText("28个月19天")).toBeTruthy();

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => { await Promise.resolve(); });
  expect(load).toHaveBeenCalledTimes(2);

  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "失败后保留的草稿");
  fireEvent.changeText(screen.getByLabelText("出生日期"), "2024-02-30");
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();

  await act(async () => {
    pendingSave.reject(new BabyProfileValidationError("birthDate", "private validation detail"));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("失败后保留的草稿");
  expect(screen.getByLabelText("出生日期").props.value).toBe("2024-02-30");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();
  expect(screen.queryByText("private validation detail")).toBeNull();

  await act(async () => {
    olderRefresh.resolve(olderSnapshot);
    await olderRefresh.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(3);
  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月18天")).toBeNull();
  expect(screen.queryByText("不应采用较旧刷新资料")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("失败后保留的草稿");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();

  await act(async () => {
    freshRerun.resolve(freshSnapshot);
    await freshRerun.promise;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(load).toHaveBeenCalledTimes(3);
  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(screen.getByText("测试宝宝")).toBeTruthy();
  expect(screen.queryByText("不应采用重跑刷新资料")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("失败后保留的草稿");
  expect(screen.getByLabelText("出生日期").props.value).toBe("2024-02-30");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();

  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({
    name: "失败后保留的草稿",
    sex: "female",
    birthDate: "2024-02-30",
    birthWeightG: 3_200,
    birthHeightCm: 50.5,
    birthHeadCm: 34.2,
    isPremature: true,
    gestationalWeeks: 36,
  }, "2026-07-18T01:00:00.000Z");
  view.unmount();
});

test("我的 lets an in-flight save finish without updating state after unmount", async () => {
  const pending = deferred<BabyProfileSnapshot>();
  let operationFinished = false;
  const saveOperation = pending.promise.then((result) => {
    operationFinished = true;
    return result;
  });
  const save = jest.fn(() => saveOperation);
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const view = renderProfile(service({ save }));
  await waitFor(() => expect(screen.getByLabelText("宝宝姓名")).toBeTruthy());
  fireEvent.press(screen.getByRole("radio", { name: "足月" }));
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
  expect(save).toHaveBeenCalledTimes(1);

  view.unmount();
  expect(appStateListeners.size).toBe(0);
  await act(async () => {
    pending.resolve(savedSnapshot);
    await saveOperation;
  });

  expect(operationFinished).toBe(true);
  expect(consoleError).not.toHaveBeenCalled();
});

test("我的 reports field-specific validation errors without claiming a save", async () => {
  const save = jest.fn(async () => {
    throw new BabyProfileValidationError("birthDate", "private validation detail");
  });
  renderProfile(service({ save }));
  await waitFor(() => expect(screen.getByLabelText("出生日期")).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText("出生日期"), "2024-02-30");
  fireEvent.press(screen.getByRole("radio", { name: "足月" }));
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));

  expect(await screen.findByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.queryByText("宝宝资料已保存")).toBeNull();
  expect(screen.queryByText("private validation detail")).toBeNull();
});

test("我的 fails closed on load errors and provides a local retry", async () => {
  const load = jest.fn()
    .mockRejectedValueOnce(new Error("private database detail"))
    .mockResolvedValueOnce(emptySnapshot);
  renderProfile(service({ load }));
  expect(await screen.findByText("暂时无法读取宝宝资料。本机数据没有更改。")).toBeTruthy();
  expect(screen.queryByText("private database detail")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "重新读取宝宝资料" }));
  await waitFor(() => expect(screen.getByLabelText("宝宝姓名")).toBeTruthy());
  expect(load).toHaveBeenCalledTimes(2);
});

test("我的 refreshes committed age on resume without replacing an unsaved name", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const refreshedSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: savedSnapshot.profile,
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 871,
      completedMonths: 28,
      remainingDays: 20,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockResolvedValueOnce(refreshedSnapshot);
  const save = jest.fn(async () => {
    throw new BabyProfileValidationError("birthDate", "private validation detail");
  });
  const view = renderProfile(service({ load, save }));
  expect(await screen.findByText("28个月19天")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "未保存姓名");
  fireEvent.changeText(screen.getByLabelText("出生日期"), "2024-02-30");
  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
  expect(await screen.findByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });

  await waitFor(() => expect(screen.getByText("28个月20天")).toBeTruthy());
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("未保存姓名");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();
  view.unmount();
  expect(appStateListeners.size).toBe(0);
});

test("我的 calendar refresh preserves the draft profile token so a stale draft still conflicts", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const concurrentSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: Object.freeze({
      ...savedSnapshot.profile,
      name: "并发更新姓名",
      birthDate: "2024-03-01",
      updatedAt: "2026-07-19T01:00:00.000Z",
    }),
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 870,
      completedMonths: 28,
      remainingDays: 18,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockResolvedValueOnce(concurrentSnapshot);
  const conflict = new Error("private concurrent profile detail");
  conflict.name = "RepositoryConflictError";
  const save = jest.fn(async () => { throw conflict; });
  const view = renderProfile(service({ load, save }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByDisplayValue("测试宝宝")).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "基于旧资料的草稿");

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByText("28个月18天")).toBeTruthy();
  expect(screen.getByText("测试宝宝")).toBeTruthy();
  expect(screen.queryByText("并发更新姓名")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("基于旧资料的草稿");

  fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
  expect(save).toHaveBeenCalledWith({
    name: "基于旧资料的草稿",
    sex: "female",
    birthDate: "2024-02-29",
    birthWeightG: 3_200,
    birthHeightCm: 50.5,
    birthHeadCm: 34.2,
    isPremature: true,
    gestationalWeeks: 36,
  }, "2026-07-18T01:00:00.000Z");
  expect(await screen.findByText("宝宝资料已在其他位置更新，请重新读取后再保存。")).toBeTruthy();
  expect(screen.queryByText("private concurrent profile detail")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("基于旧资料的草稿");
  view.unmount();
});

test("我的 preserves the form while failed age refresh retries on the next active transition", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 6, 18, 12, 0, 0));
  const refreshedSnapshot: BabyProfileSnapshot = Object.freeze({
    profile: savedSnapshot.profile,
    exactAge: Object.freeze({
      status: "known",
      localDate: "2026-07-19",
      timeZone: "Asia/Shanghai",
      ageDays: 871,
      completedMonths: 28,
      remainingDays: 20,
    }),
  });
  const load = jest.fn()
    .mockResolvedValueOnce(savedSnapshot)
    .mockRejectedValueOnce(new Error("private refresh detail"))
    .mockResolvedValueOnce(refreshedSnapshot);
  const save = jest.fn(async () => {
    throw new BabyProfileValidationError("birthDate", "private validation detail");
  });
  const view = renderProfile(service({ load, save }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.changeText(screen.getByLabelText("宝宝姓名"), "未保存姓名");
  fireEvent.changeText(screen.getByLabelText("出生日期"), "2024-02-30");
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "保存宝宝资料" }));
    await Promise.resolve();
  });
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();

  act(() => {
    jest.setSystemTime(new Date(2026, 6, 19, 12, 0, 0));
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByText("年龄暂不可用")).toBeTruthy();
  expect(screen.queryByText("28个月19天")).toBeNull();
  expect(screen.queryByText("private refresh detail")).toBeNull();
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("未保存姓名");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();

  act(() => {
    emitAppState("background");
    emitAppState("active");
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByText("28个月20天")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(3);
  expect(screen.getByLabelText("宝宝姓名").props.value).toBe("未保存姓名");
  expect(screen.getByText("请输入有效的 YYYY-MM-DD，且不能晚于今天。")).toBeTruthy();
  expect(screen.getByText("请检查标出的资料后再保存。")).toBeTruthy();
  view.unmount();
  expect(appStateListeners.size).toBe(0);
});
