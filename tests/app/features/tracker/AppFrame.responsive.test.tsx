import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react-native";
import { Dimensions, ScrollView, StyleSheet, Text, TextInput, type ViewStyle, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { InlineTrackerConfirmation } from "../../../../src/features/tracker/InlineTrackerConfirmation";
import { TrackerDomainSwitcher } from "../../../../src/features/tracker/TrackerDomainSwitcher";
import { TrackerEditor } from "../../../../src/features/tracker/TrackerEditor";
import { TrackerRecordList } from "../../../../src/features/tracker/TrackerRecordList";
import { AppFrame } from "../../../../src/shared/ui/AppFrame";

const originalWindow = Dimensions.get("window");
const originalScreen = Dimensions.get("screen");
const settableDimensions = Dimensions as typeof Dimensions & {
  set: (dimensions: Readonly<{
    screen: Readonly<{ fontScale: number; height: number; scale: number; width: number }>;
    window: Readonly<{ fontScale: number; height: number; scale: number; width: number }>;
  }>) => void;
};

function setDimensions(width: number, height: number, fontScale = 1) {
  const metrics = Object.freeze({ fontScale, height, scale: 2, width });
  settableDimensions.set({ screen: metrics, window: metrics });
}

const growthRecord = Object.freeze({
  id: "growth-responsive-id",
  measurementDate: "2026-07-20",
  weightG: 7200,
  heightCm: 68.5,
  headCm: null,
  weightPercentile: null,
  heightPercentile: null,
  headPercentile: null,
  notes: "组件可达性夹具",
  sourceMessageId: null,
  createdAt: "2026-07-20T00:01:00.000Z",
  updatedAt: "2026-07-20T00:02:00.000Z",
});

const healthCreateDecision = Object.freeze({
  kind: "healthCreate" as const,
  domain: "health" as const,
  prior: Object.freeze({ fixture: "health-editor" }),
  initiatingControlRef: { current: null },
  presentationTimeZone: "Asia/Shanghai",
  serviceSummary: Object.freeze({
    action: "create" as const,
    domain: "health" as const,
    input: Object.freeze({
      recordDate: "2026-07-20",
      recordType: "checkup" as const,
      title: "常规检查",
      description: null,
      sourceMessageId: null,
    }),
  }),
});

const discardDecision = Object.freeze({
  kind: "discard" as const,
  domain: "growth" as const,
  prior: Object.freeze({ fixture: "growth-editor" }),
  destination: Object.freeze({ fixture: "growth-list" }),
  initiatingControlRef: { current: null },
});

function TrackerResponsiveFixture() {
  return (
    <View style={{ gap: 16 }}>
      <TrackerDomainSwitcher onSelectDomain={jest.fn()} selectedDomain="growth" />
      <TrackerRecordList
        domain="growth"
        onCreate={jest.fn()}
        onSelectRecord={jest.fn()}
        records={[growthRecord]}
        timeZone="Asia/Shanghai"
      />
      <TrackerEditor
        domain="growth"
        draft={{
          domain: "growth",
          timeZone: "Asia/Shanghai",
          dateText: "2026-07-20",
          weightG: "7200",
          heightCm: "68.5",
          headCm: "",
          notes: "可换行备注",
        }}
        mode="edit"
        onBack={jest.fn()}
        onChange={jest.fn()}
        onDelete={jest.fn()}
        onSave={jest.fn()}
      />
      <InlineTrackerConfirmation
        acceptActionRef={{ current: null }}
        busy={false}
        cancelActionRef={{ current: null }}
        decision={healthCreateDecision}
        headingRef={{ current: null }}
        onAccept={jest.fn()}
        onCancel={jest.fn()}
      />
      <InlineTrackerConfirmation
        acceptActionRef={{ current: null }}
        busy={false}
        cancelActionRef={{ current: null }}
        decision={discardDecision}
        headingRef={{ current: null }}
        onAccept={jest.fn()}
        onCancel={jest.fn()}
      />
    </View>
  );
}

function renderFrame(children: ReactNode = <TrackerResponsiveFixture />) {
  return render(
    <SafeAreaProvider initialMetrics={{
      frame: {
        x: 0,
        y: 0,
        width: Dimensions.get("window").width,
        height: Dimensions.get("window").height,
      },
      insets: { top: 20, left: 0, right: 0, bottom: 0 },
    }}>
      <AppFrame keyboardDismissMode="on-drag" localOnly title="记录">{children}</AppFrame>
    </SafeAreaProvider>,
  );
}

function appFrameContentStyle(view: ReturnType<typeof render>) {
  const scroll = view.UNSAFE_getAllByType(ScrollView).find((candidate) => candidate.props.horizontal !== true);
  if (!scroll) throw new Error("expected the AppFrame vertical scroll container");
  return StyleSheet.flatten(scroll.props.contentContainerStyle);
}

function expectMinimumTarget(node: { props: { accessibilityLabel?: string; style?: unknown } }) {
  const style = StyleSheet.flatten(node.props.style as ViewStyle);
  if (typeof style?.minHeight !== "number" || typeof style?.minWidth !== "number") {
    throw new Error(`missing minimum target style for ${node.props.accessibilityLabel ?? "unlabelled target"}`);
  }
  expect(style?.minHeight).toBeGreaterThanOrEqual(44);
  expect(style?.minWidth).toBeGreaterThanOrEqual(44);
}

afterEach(() => {
  settableDimensions.set({ screen: originalScreen, window: originalWindow });
});

test.each([
  { width: 320, height: 568, padding: 16 },
  { width: 360, height: 800, padding: 16 },
  { width: 390, height: 844, padding: 16 },
  { width: 430, height: 932, padding: 16 },
  { width: 431, height: 932, padding: 24 },
  { width: 768, height: 1024, padding: 32 },
])("renders tracker components at $width x $height with static single-column style contracts", ({ width, height, padding }) => {
  setDimensions(width, height);
  const view = renderFrame();
  const contentStyle = appFrameContentStyle(view);
  const scrolls = view.UNSAFE_getAllByType(ScrollView);
  const horizontalDomainScroll = scrolls.find((scroll) => scroll.props.horizontal === true);

  expect(Dimensions.get("window")).toMatchObject({ width, height });
  expect(contentStyle).toMatchObject({
    alignSelf: "center",
    flexGrow: 1,
    maxWidth: 640,
    paddingHorizontal: padding,
    width: "100%",
  });
  expect(contentStyle?.flexDirection).toBeUndefined();
  expect(horizontalDomainScroll).toBeTruthy();
  expect(horizontalDomainScroll?.props.showsHorizontalScrollIndicator).toBe(false);
  expect(screen.getByRole("header", { name: "生长记录" })).toBeTruthy();
  expect(screen.getByRole("header", { name: "编辑生长记录" })).toBeTruthy();
  expect(screen.getByRole("header", { name: "确认新增健康记录" })).toBeTruthy();
  expect(screen.getByRole("header", { name: "放弃未保存的更改？" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "放弃更改" })).toBeTruthy();

  const editorActions = StyleSheet.flatten(view.getByTestId("tracker-editor-actions").props.style);
  const confirmationActions = StyleSheet.flatten(screen.getByRole("button", { name: "确认保存" }).parent?.props.style);
  const discardActions = StyleSheet.flatten(screen.getByRole("button", { name: "放弃更改" }).parent?.props.style);
  expect(editorActions).toMatchObject({ flexWrap: "wrap" });
  expect(editorActions?.flexDirection).toBeUndefined();
  expect(confirmationActions?.flexDirection).toBeUndefined();
  expect(discardActions?.flexDirection).toBeUndefined();

  const actionTargets = screen.getAllByRole("button").filter((target) => target.props.editable === undefined);
  for (const target of [...actionTargets, ...screen.getAllByRole("tab")]) {
    expectMinimumTarget(target);
  }
  for (const input of view.UNSAFE_getAllByType(TextInput)) {
    expect(StyleSheet.flatten(input.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
    expect(input.props.allowFontScaling).not.toBe(false);
  }
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
});

test("updates responsive padding on one mounted AppFrame across 430, 431, and 768 widths", () => {
  setDimensions(430, 932);
  const view = renderFrame();
  expect(appFrameContentStyle(view)?.paddingHorizontal).toBe(16);

  act(() => setDimensions(431, 932));
  expect(appFrameContentStyle(view)?.paddingHorizontal).toBe(24);

  act(() => setDimensions(768, 1024));
  expect(appFrameContentStyle(view)?.paddingHorizontal).toBe(32);
});

test("keeps tracker component scaling props and wrapped actions when fontScale reports 2", () => {
  setDimensions(320, 568, 2);
  const view = renderFrame();

  expect(Dimensions.get("window")).toMatchObject({ width: 320, height: 568, fontScale: 2 });
  expect(appFrameContentStyle(view)).toMatchObject({ maxWidth: 640, paddingHorizontal: 16, width: "100%" });
  expect(StyleSheet.flatten(view.getByTestId("tracker-editor-actions").props.style)).toMatchObject({ flexWrap: "wrap" });
  expect(StyleSheet.flatten(screen.getByRole("button", { name: "确认保存" }).parent?.props.style)?.flexDirection).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByRole("button", { name: "放弃更改" }).parent?.props.style)?.flexDirection).toBeUndefined();
  for (const text of view.UNSAFE_getAllByType(Text)) expect(text.props.allowFontScaling).not.toBe(false);
  for (const input of view.UNSAFE_getAllByType(TextInput)) expect(input.props.allowFontScaling).not.toBe(false);
});
