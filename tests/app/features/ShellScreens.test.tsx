import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet, Text } from "react-native";

import { StewardScreen } from "../../../src/features/shell/ShellScreens";

test("管家 reports only truthful local unavailable state with no dead controls", () => {
  render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } }}><StewardScreen /></SafeAreaProvider>);
  expect(screen.getByText("仅本机")).toBeTruthy();
  expect(screen.getByText("宝宝资料")).toBeTruthy();
  expect(screen.getAllByText("未设置")).toHaveLength(2);
  expect(screen.getByText("当前页面不会读取、保存或发送宝宝数据。")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});

test("shell text keeps native scaling and omits clipping-prone fixed line heights", () => {
  const view = render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 320, height: 568 }, insets: { top: 20, left: 0, right: 0, bottom: 24 } }}><StewardScreen /></SafeAreaProvider>);
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
});
