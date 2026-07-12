import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { AppErrorBoundary } from "../../../src/shared/errors/AppErrorBoundary";

function hasAlertAncestor(node: any): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.props?.accessibilityRole === "alert") return true;
    parent = parent.parent;
  }
  return false;
}

test("render failures keep alert semantics on the message and retry as a separate accessible control", () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  const fetchSpy = jest.spyOn(global, "fetch");
  let shouldThrow = true;
  function Child() {
    if (shouldThrow) throw new Error("synthetic render failure");
    return <Text>恢复完成</Text>;
  }
  render(<AppErrorBoundary><Child /></AppErrorBoundary>);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("synthetic render failure")).toBeNull();
  const retry = screen.getByRole("button", { name: "重试显示页面" });
  expect(hasAlertAncestor(retry)).toBe(false);
  shouldThrow = false;
  fireEvent.press(retry);
  expect(screen.getByText("恢复完成")).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  consoleError.mockRestore();
});
