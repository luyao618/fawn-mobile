import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";

import { getTabBarMetrics, RootNavigator } from "../../../src/navigation/RootNavigator";

jest.mock("@react-native-vector-icons/lucide/static", () => ({
  Lucide: () => null,
}));

function renderNavigator() {
  return render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}><RootNavigator /></SafeAreaProvider>);
}

test("renders exactly five accessible tabs with 管家 selected initially", () => {
  renderNavigator();
  expect(screen.getByRole("header", { name: "照护空间尚未设置" })).toBeTruthy();
  const labels = ["管家", "记录", "成长", "相册", "我的"];
  const tabs = screen.getAllByRole("button").filter((item) => labels.includes(item.props.accessibilityLabel));
  expect(tabs).toHaveLength(5);
  for (const tab of tabs) expect(StyleSheet.flatten(tab.props.style)).toMatchObject({ flex: 1 });
  expect(screen.getByLabelText("管家").props.accessibilityState).toMatchObject({ selected: true });
});

test.each([
  ["记录", "还没有照护记录"],
  ["成长", "还没有可展示的成长数据"],
  ["相册", "还没有照片"],
  ["我的", "本机设置尚未启用"],
])("visits %s through its accessible tab", (label, heading) => {
  renderNavigator();
  fireEvent.press(screen.getByLabelText(label));
  expect(screen.getByRole("header", { name: heading })).toBeTruthy();
});


test("tab metrics preserve default geometry and grow for 200% text above the safe-area inset", () => {
  expect(getTabBarMetrics(1, 0)).toEqual({ height: 64, itemPaddingVertical: 0 });
  expect(getTabBarMetrics(1, 34)).toEqual({ height: 83, itemPaddingVertical: 0 });
  expect(getTabBarMetrics(2, 24)).toEqual({ height: 93, itemPaddingVertical: 4 });
  expect(getTabBarMetrics(2, 34)).toEqual({ height: 103, itemPaddingVertical: 4 });
});
