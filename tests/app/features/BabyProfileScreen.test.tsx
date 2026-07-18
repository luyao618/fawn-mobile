import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet, Text } from "react-native";

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
  expect(screen.getByRole("button", { name: "保存宝宝资料" })).toBeTruthy();
  expect(screen.getByText("出生日期待填")).toBeTruthy();
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
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
