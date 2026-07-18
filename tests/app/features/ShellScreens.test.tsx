import { render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet, Text } from "react-native";

import type { BabyProfileServicePort } from "../../../src/application/profile/babyProfileService";
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
