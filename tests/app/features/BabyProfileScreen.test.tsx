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

function renderProfile(profileService: BabyProfileServicePort) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}>
      <BabyProfileServiceProvider service={profileService}>
        <BabyProfileScreen />
      </BabyProfileServiceProvider>
    </SafeAreaProvider>,
  );
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

  await act(async () => resolveSave(savedSnapshot));
  expect(screen.getByText("宝宝资料已保存")).toBeTruthy();
  expect(screen.getByText("28个月19天")).toBeTruthy();
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
