import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { ScrollView, StyleSheet, Text, type View } from "react-native";

import {
  TrackerDomainSwitcher,
  type TrackerDomainTabRefs,
} from "../../../../src/features/tracker/TrackerDomainSwitcher";
import { colors } from "../../../../src/shared/theme/tokens";

test("renders exact horizontal tabs, forwards typed per-domain refs, and selects every domain", () => {
  const onSelectDomain = jest.fn();
  const growthRef = createRef<View>();
  const feedingRef = createRef<View>();
  const sleepRef = createRef<View>();
  const diaperRef = createRef<View>();
  const healthRef = createRef<View>();
  const refs: TrackerDomainTabRefs = {
    growth: growthRef,
    feeding: feedingRef,
    sleep: sleepRef,
    diaper: diaperRef,
    health: healthRef,
  };
  const view = render(
    <TrackerDomainSwitcher
      onSelectDomain={onSelectDomain}
      selectedDomain="growth"
      tabRefs={refs}
    />,
  );

  expect(view.UNSAFE_getByType(ScrollView).props).toMatchObject({ horizontal: true });
  expect(view.UNSAFE_getByProps({ accessibilityLabel: "记录类型", accessibilityRole: "tablist" })).toBeTruthy();
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual(["生长", "喂养", "睡眠", "大小便", "健康"]);
  expect(tabs.map((tab) => tab.props.accessibilityState.selected)).toEqual([true, false, false, false, false]);
  expect([growthRef, feedingRef, sleepRef, diaperRef, healthRef].every((ref) => ref.current !== null)).toBe(true);
  const mountedRefs = [growthRef, feedingRef, sleepRef, diaperRef, healthRef].map((ref) => ref.current);
  view.rerender(
    <TrackerDomainSwitcher
      onSelectDomain={onSelectDomain}
      selectedDomain="growth"
      tabRefs={refs}
    />,
  );
  [growthRef, feedingRef, sleepRef, diaperRef, healthRef].forEach((ref, index) => {
    expect(ref.current).toBe(mountedRefs[index]);
  });

  for (const tab of screen.getAllByRole("tab")) {
    const style = StyleSheet.flatten(tab.props.style);
    expect(style?.minHeight).toBeGreaterThanOrEqual(44);
    expect(style?.minWidth).toBeGreaterThanOrEqual(44);
    expect(style?.borderRadius).toBe(12);
    expect(style?.flex).toBeUndefined();
    expect(style?.width).toBeUndefined();
    expect(tab.props.numberOfLines).toBeUndefined();
    fireEvent.press(tab);
  }
  expect(onSelectDomain.mock.calls.map(([domain]) => domain)).toEqual([
    "growth",
    "feeding",
    "sleep",
    "diaper",
    "health",
  ]);
  const selectedStyle = StyleSheet.flatten(screen.getByRole("tab", { name: "生长" }).props.style);
  expect(selectedStyle?.backgroundColor).toBe(colors.brandSoft);
  expect(selectedStyle?.borderColor).toBe(colors.brand);
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
});

test("shows focus without layout shift and restores the base style on blur", () => {
  render(<TrackerDomainSwitcher onSelectDomain={jest.fn()} selectedDomain="growth" />);
  const feeding = screen.getByRole("tab", { name: "喂养" });
  const before = StyleSheet.flatten(feeding.props.style);

  fireEvent(feeding, "focus");
  const focused = StyleSheet.flatten(screen.getByRole("tab", { name: "喂养" }).props.style);
  expect(focused?.borderColor).toBe(colors.focus);
  expect(focused?.borderWidth).toBe(before?.borderWidth);

  fireEvent(screen.getByRole("tab", { name: "喂养" }), "blur");
  expect(StyleSheet.flatten(screen.getByRole("tab", { name: "喂养" }).props.style)?.borderColor).toBe(before?.borderColor);
});

test.each([
  { busy: true, disabled: false, label: "busy" },
  { busy: false, disabled: true, label: "disabled" },
])("$label state independently suppresses native tab presses", ({ busy, disabled }) => {
  const onSelectDomain = jest.fn();
  render(
    <TrackerDomainSwitcher
      busy={busy}
      disabled={disabled}
      onSelectDomain={onSelectDomain}
      selectedDomain="diaper"
    />,
  );

  const tab = screen.getByRole("tab", { name: "大小便" });
  expect(tab.props.accessibilityState).toEqual({
    busy,
    disabled: busy || disabled,
    selected: true,
  });
  fireEvent.press(tab);
  expect(onSelectDomain).not.toHaveBeenCalled();
  expect(screen.getAllByRole("tab")).toHaveLength(5);
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});
