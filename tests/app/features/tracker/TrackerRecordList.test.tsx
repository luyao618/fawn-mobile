import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, Text, View } from "react-native";

import type { TrackerRecordByDomain } from "../../../../src/domain/tracker/types";
import { TrackerRecordList } from "../../../../src/features/tracker/TrackerRecordList";
import { colors } from "../../../../src/shared/theme/tokens";

const firstGrowth: TrackerRecordByDomain["growth"] = Object.freeze({
  id: "private-first-id-x9",
  measurementDate: "2026-07-20",
  weightG: 7_200,
  heightCm: 68.5,
  headCm: 43.2,
  weightPercentile: 91.234,
  heightPercentile: 82.345,
  headPercentile: 73.456,
  notes: "不应在列表预览的完整备注",
  sourceMessageId: "private-source-message-x9",
  createdAt: "2026-07-20T01:02:03.004Z",
  updatedAt: "2026-07-20T05:06:07.008Z",
});

const secondGrowth: TrackerRecordByDomain["growth"] = Object.freeze({
  ...firstGrowth,
  id: "private-second-id-y8",
  measurementDate: "2026-07-19",
  weightG: 7_100,
  notes: null,
});

const feeding: TrackerRecordByDomain["feeding"] = Object.freeze({
  id: "private-feed-id-z7",
  feedTime: "2026-07-20T00:10:00.000Z",
  feedType: "formula",
  amountMl: 120,
  durationMin: null,
  notes: null,
  sourceMessageId: null,
  createdAt: "2026-07-20T00:11:00.000Z",
  updatedAt: "2026-07-20T00:12:00.000Z",
});

const sleep: TrackerRecordByDomain["sleep"] = Object.freeze({
  id: "private-sleep-id-a6",
  sleepStart: "2026-07-20T13:00:00.000Z",
  sleepEnd: "2026-07-20T14:00:00.000Z",
  sleepType: "night",
  nightWakings: 3,
  notes: null,
  sourceMessageId: null,
  createdAt: "2026-07-20T14:01:00.000Z",
  updatedAt: "2026-07-20T14:02:00.000Z",
});

const diaper: TrackerRecordByDomain["diaper"] = Object.freeze({
  id: "private-diaper-id-b5",
  diaperTime: "2026-07-20T01:30:00.000Z",
  diaperType: "mixed",
  notes: null,
  sourceMessageId: null,
  createdAt: "2026-07-20T01:31:00.000Z",
  updatedAt: "2026-07-20T01:32:00.000Z",
});

const health: TrackerRecordByDomain["health"] = Object.freeze({
  id: "private-health-id-c4",
  recordDate: "2026-07-20",
  recordType: "illness",
  title: "轻微咳嗽",
  description: "居家观察",
  sourceMessageId: null,
  createdAt: "2026-07-20T02:01:00.000Z",
  updatedAt: "2026-07-20T02:02:00.000Z",
});

function textContent(children: unknown): string {
  if (Array.isArray(children)) return children.map(textContent).join("");
  return typeof children === "string" || typeof children === "number" ? String(children) : "";
}

function renderedTextOrder(view: ReturnType<typeof render>): string[] {
  return view.UNSAFE_getAllByType(Text).map((text) => textContent(text.props.children));
}

test("preserves service order, forwards list/action refs, and selects rows by ID only", () => {
  const onCreate = jest.fn();
  const onSelectRecord = jest.fn();
  const headingRef = createRef<Text>();
  const createRefValue = createRef<View>();
  const firstRowRef = createRef<View>();
  const view = render(
    <TrackerRecordList
      createRef={createRefValue}
      domain="growth"
      headingRef={headingRef}
      onCreate={onCreate}
      onSelectRecord={onSelectRecord}
      records={[secondGrowth, firstGrowth]}
      rowRefForId={(id) => id === secondGrowth.id ? firstRowRef : undefined}
      timeZone="Asia/Shanghai"
    />,
  );

  expect(headingRef.current).not.toBeNull();
  expect(createRefValue.current).not.toBeNull();
  expect(firstRowRef.current).not.toBeNull();
  const mountedRefs = {
    create: createRefValue.current,
    heading: headingRef.current,
    row: firstRowRef.current,
  };
  view.rerender(
    <TrackerRecordList
      createRef={createRefValue}
      domain="growth"
      headingRef={headingRef}
      onCreate={onCreate}
      onSelectRecord={onSelectRecord}
      records={[secondGrowth, firstGrowth]}
      rowRefForId={(id) => id === secondGrowth.id ? firstRowRef : undefined}
      timeZone="Asia/Shanghai"
    />,
  );
  expect(headingRef.current).toBe(mountedRefs.heading);
  expect(createRefValue.current).toBe(mountedRefs.create);
  expect(firstRowRef.current).toBe(mountedRefs.row);
  expect(screen.getByRole("header", { name: "生长记录" })).toBeTruthy();
  const buttons = screen.getAllByRole("button");
  expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
    "新增生长记录",
    "生长记录，2026年7月19日，体重 7100 克 · 身长 68.5 厘米 · 头围 43.2 厘米",
    "生长记录，2026年7月20日，体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米 · 有备注",
  ]);
  expect(screen.getByText("显示最近最多 100 条生长记录。")).toBeTruthy();
  for (const row of buttons.slice(1)) {
    const style = StyleSheet.flatten(row.props.style);
    expect(style?.borderRadius).toBe(12);
    expect(style?.borderWidth).toBe(1);
    expect(style?.minHeight).toBeGreaterThanOrEqual(48);
    expect(row.findAllByType(View)).toHaveLength(0);
  }

  const rendered = JSON.stringify(view.toJSON());
  for (const privateValue of [
    "private-first-id-x9",
    "private-second-id-y8",
    "private-source-message-x9",
    "2026-07-20T01:02:03.004Z",
    "2026-07-20T05:06:07.008Z",
    "91.234",
    "82.345",
    "73.456",
    "不应在列表预览的完整备注",
  ]) expect(rendered).not.toContain(privateValue);

  fireEvent.press(buttons[0]!);
  fireEvent.press(buttons[1]!);
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onSelectRecord).toHaveBeenCalledWith("private-second-id-y8");
});

test.each([
  {
    copy: "无法确认本机时区，暂不能显示或编辑这类记录。",
    domain: "feeding" as const,
    records: [feeding],
    timeZone: "Private/Invalid-Zone",
  },
  {
    copy: "暂时无法显示生长记录。本机数据没有更改。",
    domain: "growth" as const,
    records: [{ ...firstGrowth, measurementDate: "private-invalid-date" }],
    timeZone: "Asia/Shanghai",
  },
])("blocks the whole $domain list for invalid presentation without leaking or enabling mutations", ({ copy, domain, records, timeZone }) => {
  const onCreate = jest.fn();
  const onSelectRecord = jest.fn();
  const view = render(
    <TrackerRecordList
      domain={domain}
      onCreate={onCreate}
      onSelectRecord={onSelectRecord}
      records={records as never}
      timeZone={timeZone}
    />,
  );

  expect(screen.getByText(copy).props).toMatchObject({ accessibilityLiveRegion: "assertive", accessibilityRole: "alert" });
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryAllByText(/体重|配方奶|120/)).toHaveLength(0);
  const rendered = JSON.stringify(view.toJSON());
  expect(rendered).not.toContain("private-feed-id-z7");
  expect(rendered).not.toContain("2026-07-20T00:10:00.000Z");
  expect(rendered).not.toContain("private-first-id-x9");
  expect(rendered).not.toContain("private-invalid-date");
  expect(onCreate).not.toHaveBeenCalled();
  expect(onSelectRecord).not.toHaveBeenCalled();
});

test("composes every domain list with exact empty and bounded copy in reading order", () => {
  const cases = [
    {
      domain: "growth" as const,
      label: "生长",
      primary: "2026年7月20日",
      record: firstGrowth,
      rowLabel: "生长记录，2026年7月20日，体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米 · 有备注",
      secondary: "体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米 · 有备注",
    },
    {
      domain: "feeding" as const,
      label: "喂养",
      primary: "2026年7月20日 08:10（本机时间）",
      record: feeding,
      rowLabel: "喂养记录，2026年7月20日 08:10（本机时间），配方奶 · 量 120 毫升",
      secondary: "配方奶 · 量 120 毫升",
    },
    {
      domain: "sleep" as const,
      label: "睡眠",
      primary: "2026年7月20日 21:00（本机时间）",
      record: sleep,
      rowLabel: "睡眠记录，2026年7月20日 21:00（本机时间），夜间睡眠 · 至 2026年7月20日 22:00（本机时间） · 夜醒 3 次",
      secondary: "夜间睡眠 · 至 2026年7月20日 22:00（本机时间） · 夜醒 3 次",
    },
    {
      domain: "diaper" as const,
      label: "大小便",
      primary: "2026年7月20日 09:30（本机时间）",
      record: diaper,
      rowLabel: "大小便记录，2026年7月20日 09:30（本机时间），混合",
      secondary: "混合",
    },
    {
      domain: "health" as const,
      label: "健康",
      primary: "2026年7月20日",
      record: health,
      rowLabel: "健康记录，2026年7月20日，身体不适 · 轻微咳嗽 · 有说明",
      secondary: "身体不适 · 轻微咳嗽 · 有说明",
    },
  ];

  for (const listCase of cases) {
    const heading = `${listCase.label}记录`;
    const create = `新增${listCase.label}记录`;
    const empty = `还没有${listCase.label}记录`;
    const description = "新增后会保存在本机，并显示在这里。";
    const bound = `显示最近最多 100 条${listCase.label}记录。`;
    const emptyView = render(
      <TrackerRecordList
        domain={listCase.domain}
        onCreate={jest.fn()}
        onSelectRecord={jest.fn()}
        records={[]}
        timeZone="Asia/Shanghai"
      />,
    );
    expect(screen.getByRole("header", { name: heading })).toBeTruthy();
    expect(screen.getByRole("button", { name: create })).toBeTruthy();
    expect(screen.getByRole("header", { name: empty })).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.queryByText(bound)).toBeNull();
    expect(renderedTextOrder(emptyView)).toEqual([
      heading,
      create,
      empty,
      description,
    ]);
    emptyView.unmount();

    const populatedView = render(
      <TrackerRecordList
        domain={listCase.domain}
        onCreate={jest.fn()}
        onSelectRecord={jest.fn()}
        records={[listCase.record] as never}
        timeZone="Asia/Shanghai"
      />,
    );
    expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      create,
      listCase.rowLabel,
    ]);
    expect(screen.getByText(bound)).toBeTruthy();
    expect(screen.queryByText(empty)).toBeNull();
    expect(renderedTextOrder(populatedView)).toEqual([
      heading,
      create,
      listCase.primary,
      listCase.secondary,
      bound,
    ]);
    const rowStyle = StyleSheet.flatten(screen.getByRole("button", { name: listCase.rowLabel }).props.style);
    expect(rowStyle?.borderRadius).toBe(12);
    expect(rowStyle?.borderWidth).toBe(1);
    populatedView.unmount();
  }
});

test("blocks an empty instant-domain list when its device zone is invalid", () => {
  render(
    <TrackerRecordList
      domain="sleep"
      onCreate={jest.fn()}
      onSelectRecord={jest.fn()}
      records={[]}
      timeZone="Private/Invalid-Zone"
    />,
  );
  expect(screen.getByText("无法确认本机时区，暂不能显示或编辑这类记录。")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryByText("还没有睡眠记录")).toBeNull();
});

test("shows row focus without layout shift and restores style on blur", () => {
  render(
    <TrackerRecordList
      domain="growth"
      onCreate={jest.fn()}
      onSelectRecord={jest.fn()}
      records={[firstGrowth]}
      timeZone="Asia/Shanghai"
    />,
  );
  const row = screen.getAllByRole("button")[1]!;
  const before = StyleSheet.flatten(row.props.style);
  fireEvent(row, "focus");
  const focused = StyleSheet.flatten(screen.getAllByRole("button")[1]!.props.style);
  expect(focused?.borderColor).toBe(colors.focus);
  expect(focused?.borderWidth).toBe(before?.borderWidth);
  fireEvent(screen.getAllByRole("button")[1]!, "blur");
  expect(StyleSheet.flatten(screen.getAllByRole("button")[1]!.props.style)?.borderColor).toBe(before?.borderColor);
});

test.each([
  { busy: true, disabled: false },
  { busy: false, disabled: true },
])("busy=$busy disabled=$disabled independently suppresses list mutations", ({ busy, disabled }) => {
  const onCreate = jest.fn();
  const onSelectRecord = jest.fn();
  render(
    <TrackerRecordList
      busy={busy}
      disabled={disabled}
      domain="growth"
      onCreate={onCreate}
      onSelectRecord={onSelectRecord}
      records={[firstGrowth]}
      timeZone="Asia/Shanghai"
    />,
  );
  for (const button of screen.getAllByRole("button")) {
    expect(button.props.accessibilityState).toEqual({ busy, disabled: true });
    fireEvent.press(button);
  }
  expect(onCreate).not.toHaveBeenCalled();
  expect(onSelectRecord).not.toHaveBeenCalled();
});

test("renders exact empty copy and scalable text", () => {
  const view = render(
    <TrackerRecordList
      domain="health"
      onCreate={jest.fn()}
      onSelectRecord={jest.fn()}
      records={[]}
      timeZone="Asia/Shanghai"
    />,
  );
  expect(screen.getByText("还没有健康记录")).toBeTruthy();
  expect(screen.getByText("新增后会保存在本机，并显示在这里。")).toBeTruthy();
  expect(screen.queryByText("显示最近最多 100 条健康记录。")).toBeNull();
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
});
