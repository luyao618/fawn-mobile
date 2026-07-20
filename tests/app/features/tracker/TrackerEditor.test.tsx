import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet, Text, TextInput, View } from "react-native";

import type {
  DiaperTrackerDraft,
  FeedingTrackerDraft,
  GrowthTrackerDraft,
  HealthTrackerDraft,
  SleepTrackerDraft,
} from "../../../../src/features/tracker/trackerEditorModel";
import {
  TrackerEditor,
  type TrackerEditorProps,
  type TrackerFormErrors,
  type TrackerGroupRefs,
  type TrackerInputRefs,
  type TrackerInputSubmitMap,
} from "../../../../src/features/tracker/TrackerEditor";
import { colors } from "../../../../src/shared/theme/tokens";

const growthDraft: GrowthTrackerDraft = Object.freeze({
  domain: "growth",
  timeZone: "Asia/Shanghai",
  dateText: "2026-07-20",
  weightG: "7200",
  heightCm: "68.5",
  headCm: "43.2",
  notes: "生长备注",
});

const feedingDraft: FeedingTrackerDraft = Object.freeze({
  domain: "feeding",
  timeZone: "Asia/Shanghai",
  dateText: "2026-07-20",
  timeText: "08:10",
  feedType: "formula",
  amountMl: "120",
  durationMin: "15",
  notes: "保留",
});

const sleepDraft: SleepTrackerDraft = Object.freeze({
  domain: "sleep",
  timeZone: "Asia/Shanghai",
  dateText: "2026-07-20",
  timeText: "13:00",
  endDateText: "2026-07-20",
  endTimeText: "14:00",
  sleepType: "night",
  nightWakings: "3",
  notes: "睡眠备注",
});

const healthDraft: HealthTrackerDraft = Object.freeze({
  domain: "health",
  timeZone: "Asia/Shanghai",
  dateText: "2026-07-20",
  recordType: "illness",
  title: "轻微咳嗽",
  description: "居家观察",
});

const diaperDraft: DiaperTrackerDraft = Object.freeze({
  domain: "diaper",
  timeZone: "Asia/Shanghai",
  dateText: "2026-07-20",
  timeText: "09:30",
  diaperType: "mixed",
  notes: "大小便备注",
});

// @ts-expect-error create mode must not accept edit-only deletion props
const invalidCreateProps: TrackerEditorProps = {
  domain: "growth",
  draft: growthDraft,
  mode: "create",
  onBack: () => undefined,
  onChange: () => undefined,
  onDelete: () => undefined,
  onSave: () => undefined,
};
void invalidCreateProps;

function fieldLabels(view: ReturnType<typeof render>) {
  return view.UNSAFE_getAllByType(TextInput).map((input) => input.props.accessibilityLabel);
}

function expectControlledInputValues(
  view: ReturnType<typeof render>,
  expected: readonly (readonly [label: string, value: string])[],
) {
  expect(view.UNSAFE_getAllByType(TextInput).map((input) => [
    input.props.accessibilityLabel,
    input.props.value,
  ])).toEqual(expected);
}

function expectScalableTree(view: ReturnType<typeof render>) {
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
  for (const input of view.UNSAFE_getAllByType(TextInput)) {
    expect(input.props.allowFontScaling).not.toBe(false);
    expect(input.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(input.props.style)?.lineHeight).toBeUndefined();
    expect(StyleSheet.flatten(input.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
  }
  for (const control of [...screen.queryAllByRole("button"), ...screen.queryAllByRole("radio")]) {
    expect(StyleSheet.flatten(control.props.style)?.position).not.toBe("absolute");
  }
}

function expectAccessibleOrder(view: ReturnType<typeof render>, labels: readonly string[]) {
  const rendered = JSON.stringify(view.toJSON());
  let previous = -1;
  for (const label of labels) {
    const position = rendered.indexOf(`\"accessibilityLabel\":\"${label}\"`);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
}

function expectTreeOrder(view: ReturnType<typeof render>, values: readonly string[]) {
  const rendered = JSON.stringify(view.toJSON());
  let previous = -1;
  for (const value of values) {
    const position = rendered.indexOf(value, previous + 1);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
}

const PERSISTED_ONLY_DRAFT_KEYS = new Set([
  "baseline",
  "baselines",
  "createdAt",
  "diaperTime",
  "feedTime",
  "headPercentile",
  "heightPercentile",
  "id",
  "measurementDate",
  "recordDate",
  "sleepEnd",
  "sleepStart",
  "sourceMessageId",
  "updatedAt",
  "weightPercentile",
]);

function expectExactDraftChange(onChange: jest.Mock, expected: TrackerEditorProps["draft"]) {
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenNthCalledWith(1, expected);
  const [payload] = onChange.mock.calls[0] as [Record<string, unknown>];
  expect(Object.keys(payload).filter((key) => PERSISTED_ONLY_DRAFT_KEYS.has(key))).toEqual([]);
}

test("renders growth create fields in exact order without percentile controls", () => {
  const onBack = jest.fn();
  const onChange = jest.fn();
  const onSave = jest.fn();
  const errors: TrackerFormErrors = {
    form: "请检查标出的内容后再保存。",
    measurements: "体重、身长、头围请至少填写一项。",
  };
  const view = render(
    <TrackerEditor
      domain="growth"
      draft={growthDraft}
      errors={errors}
      mode="create"
      onBack={onBack}
      onChange={onChange}
      onSave={onSave}
    />,
  );

  expect(screen.getByRole("header", { name: "新增生长记录" })).toBeTruthy();
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
    "返回生长列表",
    "保存生长记录",
  ]);
  expect(fieldLabels(view)).toEqual(["测量日期", "体重（克）", "身长（厘米）", "头围（厘米）", "备注"]);
  expectControlledInputValues(view, [
    ["测量日期", "2026-07-20"],
    ["体重（克）", "7200"],
    ["身长（厘米）", "68.5"],
    ["头围（厘米）", "43.2"],
    ["备注", "生长备注"],
  ]);
  expectAccessibleOrder(view, ["测量日期", "体重（克）", "身长（厘米）", "头围（厘米）", "备注"]);
  expect(screen.getByLabelText("测量日期").props.placeholder).toBe("例如 2026-07-20");
  expect(screen.getByLabelText("备注").props.multiline).toBe(true);
  expect(screen.getByText("体重、身长、头围请至少填写一项。").props).toMatchObject({
    accessibilityLiveRegion: "assertive",
    accessibilityRole: "alert",
  });
  expect(screen.getByText("请检查标出的内容后再保存。").props).toMatchObject({
    accessibilityLiveRegion: "assertive",
    accessibilityRole: "alert",
  });
  expect(screen.queryByText(/百分位/)).toBeNull();
  expectScalableTree(view);
});

test("forwards every typed input and first-option ref with stable rerender and submit wiring", () => {
  const inputRefObjects = {
    amountMl: createRef<TextInput>(),
    description: createRef<TextInput>(),
    diaperTime: createRef<TextInput>(),
    diaperTimeDate: createRef<TextInput>(),
    durationMin: createRef<TextInput>(),
    feedTime: createRef<TextInput>(),
    feedTimeDate: createRef<TextInput>(),
    headCm: createRef<TextInput>(),
    heightCm: createRef<TextInput>(),
    measurementDate: createRef<TextInput>(),
    nightWakings: createRef<TextInput>(),
    notes: createRef<TextInput>(),
    recordDate: createRef<TextInput>(),
    sleepEnd: createRef<TextInput>(),
    sleepEndDate: createRef<TextInput>(),
    sleepStart: createRef<TextInput>(),
    sleepStartDate: createRef<TextInput>(),
    title: createRef<TextInput>(),
    weightG: createRef<TextInput>(),
  } satisfies TrackerInputRefs;
  const inputRefs: TrackerInputRefs = inputRefObjects;
  const groupRefObjects = {
    diaperType: createRef<View>(),
    feedType: createRef<View>(),
    recordType: createRef<View>(),
    sleepType: createRef<View>(),
  } satisfies TrackerGroupRefs;
  const groupRefs: TrackerGroupRefs = groupRefObjects;
  const onStartDateSubmit = jest.fn();
  const onNotesSubmit = jest.fn();
  const inputSubmit: TrackerInputSubmitMap = {
    sleepStartDate: { onSubmitEditing: onStartDateSubmit, returnKeyType: "next" },
    notes: { onSubmitEditing: onNotesSubmit, returnKeyType: "done" },
  };
  const cases = [
    {
      domain: "growth" as const,
      draft: growthDraft,
      groupKey: null,
      inputKeys: ["measurementDate", "weightG", "heightCm", "headCm", "notes"] as const,
    },
    {
      domain: "feeding" as const,
      draft: feedingDraft,
      groupKey: "feedType" as const,
      inputKeys: ["feedTimeDate", "feedTime", "amountMl", "durationMin", "notes"] as const,
    },
    {
      domain: "sleep" as const,
      draft: sleepDraft,
      groupKey: "sleepType" as const,
      inputKeys: ["sleepStartDate", "sleepStart", "sleepEndDate", "sleepEnd", "nightWakings", "notes"] as const,
    },
    {
      domain: "diaper" as const,
      draft: diaperDraft,
      groupKey: "diaperType" as const,
      inputKeys: ["diaperTimeDate", "diaperTime", "notes"] as const,
    },
    {
      domain: "health" as const,
      draft: healthDraft,
      groupKey: "recordType" as const,
      inputKeys: ["recordDate", "title", "description"] as const,
    },
  ];

  for (const formCase of cases) {
    const headingRef = createRef<Text>();
    const backRef = createRef<View>();
    const saveRef = createRef<View>();
    const deleteRef = createRef<View>();
    const props = {
      backRef,
      deleteRef,
      domain: formCase.domain,
      draft: formCase.draft,
      groupRefs,
      headingRef,
      inputRefs,
      inputSubmit,
      mode: "edit",
      onBack: jest.fn(),
      onChange: jest.fn(),
      onDelete: jest.fn(),
      onSave: jest.fn(),
      saveRef,
    } as TrackerEditorProps;
    const view = render(<TrackerEditor {...props} />);
    const mountedInputRefs = formCase.inputKeys.map((key) => inputRefObjects[key]);
    const mountedGroupRef = formCase.groupKey === null ? undefined : groupRefObjects[formCase.groupKey];

    expect(headingRef.current).not.toBeNull();
    expect(backRef.current).not.toBeNull();
    expect(saveRef.current).not.toBeNull();
    expect(deleteRef.current).not.toBeNull();
    expect(mountedInputRefs.every((ref) => ref.current !== null)).toBe(true);
    if (mountedGroupRef) expect(mountedGroupRef.current).not.toBeNull();
    for (const group of view.UNSAFE_queryAllByProps({ accessibilityRole: "radiogroup" })) {
      expect(group.props.accessible).not.toBe(true);
    }

    if (formCase.domain === "sleep") {
      const startDate = screen.getByLabelText("开始日期");
      expect(startDate.props.returnKeyType).toBe("next");
      fireEvent(startDate, "submitEditing");
      expect(onStartDateSubmit).toHaveBeenCalledTimes(1);
      const notes = screen.getByLabelText("备注");
      expect(notes.props.returnKeyType).toBe("done");
      fireEvent(notes, "submitEditing");
      expect(onNotesSubmit).toHaveBeenCalledTimes(1);
    }

    const before = {
      actions: [backRef.current, saveRef.current, deleteRef.current],
      group: mountedGroupRef?.current,
      heading: headingRef.current,
      inputs: mountedInputRefs.map((ref) => ref.current),
    };
    view.rerender(<TrackerEditor {...props} />);
    expect(headingRef.current).toBe(before.heading);
    expect(backRef.current).toBe(before.actions[0]);
    expect(saveRef.current).toBe(before.actions[1]);
    expect(deleteRef.current).toBe(before.actions[2]);
    mountedInputRefs.forEach((ref, index) => expect(ref.current).toBe(before.inputs[index]));
    if (mountedGroupRef) expect(mountedGroupRef.current).toBe(before.group);
    view.unmount();
  }
});

test("invokes every create/edit action and all five forms' controlled field callbacks", () => {
  const onBack = jest.fn();
  const onSave = jest.fn();
  const createView = render(
    <TrackerEditor
      domain="growth"
      draft={growthDraft}
      mode="create"
      onBack={onBack}
      onChange={jest.fn()}
      onSave={onSave}
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "返回生长列表" }));
  fireEvent.press(screen.getByRole("button", { name: "保存生长记录" }));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledTimes(1);
  createView.unmount();

  const onDelete = jest.fn();
  const editBack = jest.fn();
  const editSave = jest.fn();
  const editView = render(
    <TrackerEditor
      domain="health"
      draft={healthDraft}
      mode="edit"
      onBack={editBack}
      onChange={jest.fn()}
      onDelete={onDelete}
      onSave={editSave}
    />,
  );
  for (const action of screen.getAllByRole("button")) fireEvent.press(action);
  expect(editBack).toHaveBeenCalledTimes(1);
  expect(editSave).toHaveBeenCalledTimes(1);
  expect(onDelete).toHaveBeenCalledTimes(1);
  editView.unmount();

  const cases = [
    {
      domain: "growth" as const,
      draft: growthDraft,
      inputs: [["测量日期", "2026-07-21", "dateText"], ["体重（克）", "7300", "weightG"], ["身长（厘米）", "69", "heightCm"], ["头围（厘米）", "44", "headCm"], ["备注", "生长备注", "notes"]] as const,
    },
    {
      domain: "feeding" as const,
      draft: feedingDraft,
      inputs: [["喂养日期", "2026-07-21", "dateText"], ["喂养时间", "09:11", "timeText"], ["量（毫升）", "130", "amountMl"], ["时长（分钟）", "20", "durationMin"], ["备注", "喂养备注", "notes"]] as const,
      radio: ["喂养类型辅食", "feedType", "solid"] as const,
    },
    {
      domain: "sleep" as const,
      draft: sleepDraft,
      inputs: [["开始日期", "2026-07-21", "dateText"], ["开始时间", "14:00", "timeText"], ["结束日期", "2026-07-21", "endDateText"], ["结束时间", "15:00", "endTimeText"], ["夜醒次数", "4", "nightWakings"], ["备注", "睡眠备注", "notes"]] as const,
      radio: ["睡眠类型小睡", "sleepType", "nap"] as const,
    },
    {
      domain: "diaper" as const,
      draft: diaperDraft,
      inputs: [["记录日期", "2026-07-21", "dateText"], ["记录时间", "10:30", "timeText"], ["备注", "大小便备注", "notes"]] as const,
      radio: ["类型小便", "diaperType", "pee"] as const,
    },
    {
      domain: "health" as const,
      draft: healthDraft,
      inputs: [["记录日期", "2026-07-21", "dateText"], ["标题", "复查", "title"], ["说明", "健康说明", "description"]] as const,
      radio: ["健康记录类型常规检查", "recordType", "checkup"] as const,
    },
  ];

  for (const formCase of cases) {
    const onChange = jest.fn();
    const view = render(
      <TrackerEditor
        domain={formCase.domain}
        draft={formCase.draft as never}
        mode="create"
        onBack={jest.fn()}
        onChange={onChange as never}
        onSave={jest.fn()}
      />,
    );
    for (const [label, value, field] of formCase.inputs) {
      onChange.mockClear();
      fireEvent.changeText(screen.getByLabelText(label), value);
      expectExactDraftChange(onChange, { ...formCase.draft, [field]: value });
    }
    if ("radio" in formCase && formCase.radio) {
      const [label, field, value] = formCase.radio;
      onChange.mockClear();
      fireEvent.press(screen.getByRole("radio", { name: label }));
      expectExactDraftChange(onChange, {
        ...formCase.draft,
        [field]: value,
        ...(formCase.domain === "sleep" && value === "nap" ? { nightWakings: "0" } : null),
      });
    }
    view.unmount();
  }
});

test("shows focus styling on input, radio, and action without changing border width", () => {
  render(
    <TrackerEditor
      domain="health"
      draft={healthDraft}
      mode="edit"
      onBack={jest.fn()}
      onChange={jest.fn()}
      onDelete={jest.fn()}
      onSave={jest.fn()}
    />,
  );
  const controls = [
    screen.getByLabelText("标题"),
    screen.getByRole("radio", { name: "健康记录类型常规检查" }),
    screen.getByRole("button", { name: "保存修改" }),
  ];
  for (const control of controls) {
    const before = StyleSheet.flatten(control.props.style);
    expect(before?.borderWidth).toBeGreaterThan(0);
    fireEvent(control, "focus");
    const focused = StyleSheet.flatten(control.props.style);
    expect(focused?.borderColor).toBe(colors.focus);
    expect(focused?.borderWidth).toBe(before?.borderWidth);
    expect(focused?.borderWidth).toBeGreaterThan(0);
    fireEvent(control, "blur");
    expect(StyleSheet.flatten(control.props.style)?.borderColor).toBe(before?.borderColor);
  }
});

test.each([
  { busy: true, disabled: false },
  { busy: false, disabled: true },
])("busy=$busy disabled=$disabled independently suppresses input, radio, and action callbacks", ({ busy, disabled }) => {
  const onBack = jest.fn();
  const onChange = jest.fn();
  const onDelete = jest.fn();
  const onSave = jest.fn();
  const view = render(
    <TrackerEditor
      busy={busy}
      disabled={disabled}
      domain="health"
      draft={healthDraft}
      mode="edit"
      onBack={onBack}
      onChange={onChange}
      onDelete={onDelete}
      onSave={onSave}
    />,
  );
  for (const input of view.UNSAFE_getAllByType(TextInput)) {
    expect(input.props.editable).toBe(false);
    expect(input.props.accessibilityState).toEqual({ busy, disabled: true });
    fireEvent.changeText(input, "不应写入");
  }
  for (const radio of screen.getAllByRole("radio")) {
    expect(radio.props.accessibilityState).toEqual({
      busy,
      checked: radio.props.accessibilityLabel === "健康记录类型身体不适",
      disabled: true,
    });
    fireEvent.press(radio);
  }
  for (const action of screen.getAllByRole("button")) {
    expect(action.props.accessibilityState).toEqual({ busy, disabled: true });
    fireEvent.press(action);
  }
  expect(onChange).not.toHaveBeenCalled();
  expect(onBack).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();
});

test("renders provided field and form error slots exactly for every domain in adjacent tree order", () => {
  const cases = [
    ["growth", "生长", growthDraft, "measurementDate", "测量日期", "体重（克）"],
    ["feeding", "喂养", feedingDraft, "amountMl", "量（毫升）", "时长（分钟）"],
    ["sleep", "睡眠", sleepDraft, "nightWakings", "夜醒次数", "备注"],
    ["diaper", "大小便", diaperDraft, "diaperType", "类型混合", "备注"],
    ["health", "健康", healthDraft, "title", "标题", "说明"],
  ] as const;

  for (const [domain, domainLabel, draft, errorKey, fieldAnchor, nextAnchor] of cases) {
    const fieldError = `${domain}-field-error`;
    const formError = `${domain}-form-error`;
    const props = {
      domain,
      draft,
      errors: { [errorKey]: fieldError, form: formError },
      mode: "create",
      onBack: jest.fn(),
      onChange: jest.fn(),
      onSave: jest.fn(),
    } as TrackerEditorProps;
    const view = render(<TrackerEditor {...props} />);

    for (const exactError of [fieldError, formError]) {
      expect(screen.getByText(exactError).props).toMatchObject({
        accessibilityLiveRegion: "assertive",
        accessibilityRole: "alert",
        children: exactError,
      });
    }
    expectTreeOrder(view, [fieldAnchor, fieldError, nextAnchor, formError, `保存${domainLabel}记录`]);
    view.unmount();
  }
});

test("keeps feeding optional values when its controlled enum changes", () => {
  const onChange = jest.fn();
  const view = render(
    <TrackerEditor
      domain="feeding"
      draft={feedingDraft}
      mode="create"
      onBack={jest.fn()}
      onChange={onChange}
      onSave={jest.fn()}
    />,
  );

  expect(fieldLabels(view)).toEqual(["喂养日期", "喂养时间", "量（毫升）", "时长（分钟）", "备注"]);
  expectControlledInputValues(view, [
    ["喂养日期", "2026-07-20"],
    ["喂养时间", "08:10"],
    ["量（毫升）", "120"],
    ["时长（分钟）", "15"],
    ["备注", "保留"],
  ]);
  expectAccessibleOrder(view, ["喂养日期", "喂养时间", "喂养类型", "量（毫升）", "时长（分钟）", "备注"]);
  expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
    "喂养类型母乳",
    "喂养类型配方奶",
    "喂养类型辅食",
  ]);
  expect(view.UNSAFE_getByProps({ accessibilityLabel: "喂养类型", accessibilityRole: "radiogroup" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "喂养类型配方奶" }).props.accessibilityState.checked).toBe(true);
  for (const label of ["母乳", "配方奶", "辅食"]) expect(screen.getByText(label)).toBeTruthy();
  fireEvent.press(screen.getByRole("radio", { name: "喂养类型母乳" }));
  expectExactDraftChange(onChange, { ...feedingDraft, feedType: "breast" });
  expect(screen.getByText("配方奶需要填写量。")).toBeTruthy();
  expectScalableTree(view);
});

test("forces nap wakings to zero, disables the field, and preserves field order", () => {
  const onChange = jest.fn();
  const view = render(
    <TrackerEditor
      domain="sleep"
      draft={sleepDraft}
      errors={{ sleepEnd: "结束日期和结束时间需要一起填写。" }}
      mode="edit"
      onBack={jest.fn()}
      onChange={onChange}
      onDelete={jest.fn()}
      onSave={jest.fn()}
    />,
  );

  expect(screen.getByRole("header", { name: "编辑睡眠记录" })).toBeTruthy();
  expect(fieldLabels(view)).toEqual([
    "开始日期",
    "开始时间",
    "结束日期",
    "结束时间",
    "夜醒次数",
    "备注",
  ]);
  expectControlledInputValues(view, [
    ["开始日期", "2026-07-20"],
    ["开始时间", "13:00"],
    ["结束日期", "2026-07-20"],
    ["结束时间", "14:00"],
    ["夜醒次数", "3"],
    ["备注", "睡眠备注"],
  ]);
  expectAccessibleOrder(view, [
    "开始日期",
    "开始时间",
    "结束日期",
    "结束时间",
    "睡眠类型",
    "夜醒次数",
    "备注",
  ]);
  expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
    "睡眠类型小睡",
    "睡眠类型夜间睡眠",
  ]);
  expect(view.UNSAFE_getByProps({ accessibilityLabel: "睡眠类型", accessibilityRole: "radiogroup" })).toBeTruthy();
  for (const label of ["小睡", "夜间睡眠"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
    "返回睡眠列表",
    "保存修改",
    "删除这条记录",
  ]);

  fireEvent.press(screen.getByRole("radio", { name: "睡眠类型小睡" }));
  expectExactDraftChange(onChange, { ...sleepDraft, nightWakings: "0", sleepType: "nap" });

  view.rerender(
    <TrackerEditor
      domain="sleep"
      draft={{ ...sleepDraft, sleepType: "nap", nightWakings: "0" }}
      mode="edit"
      onBack={jest.fn()}
      onChange={onChange}
      onDelete={jest.fn()}
      onSave={jest.fn()}
    />,
  );
  expect(screen.getByLabelText("夜醒次数").props).toMatchObject({
    accessibilityState: { busy: false, disabled: true },
    editable: false,
    value: "0",
  });
  expect(screen.getByText("小睡的夜醒次数固定为 0。")).toBeTruthy();
  expectScalableTree(view);
});

test("renders diaper fields and enum copy in exact order", () => {
  const view = render(
    <TrackerEditor
      domain="diaper"
      draft={diaperDraft}
      errors={{ diaperType: "请选择大便、小便或混合。" }}
      mode="create"
      onBack={jest.fn()}
      onChange={jest.fn()}
      onSave={jest.fn()}
    />,
  );

  expectControlledInputValues(view, [
    ["记录日期", "2026-07-20"],
    ["记录时间", "09:30"],
    ["备注", "大小便备注"],
  ]);
  expectAccessibleOrder(view, ["记录日期", "记录时间", "类型", "备注"]);
  expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
    "类型大便",
    "类型小便",
    "类型混合",
  ]);
  expect(view.UNSAFE_getByProps({ accessibilityLabel: "类型", accessibilityRole: "radiogroup" })).toBeTruthy();
  expect(screen.getByText("请选择大便、小便或混合。").props.accessibilityRole).toBe("alert");
  expectScalableTree(view);
});

test("renders health field order, exact enums, neutral notice, and busy actions", () => {
  const view = render(
    <TrackerEditor
      busy
      disabled
      domain="health"
      draft={healthDraft}
      errors={{
        recordType: "请选择疫苗接种、身体不适或常规检查。",
        title: "标题需要填写，且最多 200 个字符。",
      }}
      mode="edit"
      onBack={jest.fn()}
      onChange={jest.fn()}
      onDelete={jest.fn()}
      onSave={jest.fn()}
    />,
  );

  expect(fieldLabels(view)).toEqual(["记录日期", "标题", "说明"]);
  expectControlledInputValues(view, [
    ["记录日期", "2026-07-20"],
    ["标题", "轻微咳嗽"],
    ["说明", "居家观察"],
  ]);
  expectAccessibleOrder(view, ["记录日期", "健康记录类型", "标题", "说明"]);
  expect(screen.getAllByRole("radio").map((radio) => radio.props.accessibilityLabel)).toEqual([
    "健康记录类型疫苗接种",
    "健康记录类型身体不适",
    "健康记录类型常规检查",
  ]);
  expect(view.UNSAFE_getByProps({ accessibilityLabel: "健康记录类型", accessibilityRole: "radiogroup" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "健康记录类型身体不适" }).props.accessibilityState.checked).toBe(true);
  for (const label of ["疫苗接种", "身体不适", "常规检查"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("健康记录用于整理照护信息，不提供诊断。")).toBeTruthy();
  expect(screen.getByText("标题需要填写，且最多 200 个字符。").props.accessibilityLiveRegion).toBe("assertive");
  for (const action of screen.getAllByRole("button")) {
    expect(action.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(StyleSheet.flatten(action.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
  }
  expect(StyleSheet.flatten(screen.getByRole("button", { name: "保存修改" }).props.style)?.minHeight).toBeGreaterThanOrEqual(48);
  for (const input of view.UNSAFE_getAllByType(TextInput)) {
    expect(input.props.accessibilityState).toEqual({ busy: true, disabled: true });
  }
  expect(screen.getByLabelText("说明").props.multiline).toBe(true);
  for (const radio of screen.getAllByRole("radio")) {
    expect(radio.props.accessibilityState).toEqual({
      busy: true,
      checked: radio.props.accessibilityLabel === "健康记录类型身体不适",
      disabled: true,
    });
    expect(StyleSheet.flatten(radio.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
  }
  const actionGroup = view.UNSAFE_getAllByType(View).find((node) => node.props.testID === "tracker-editor-actions");
  expect(StyleSheet.flatten(actionGroup?.props.style)?.flexWrap).toBe("wrap");
  expectScalableTree(view);
});

test("keeps a 200-code-point health title controlled, wrapping, scalable, and callback-complete", () => {
  const title = "健".repeat(200);
  const nextTitle = "康".repeat(200);
  const onChange = jest.fn();
  const onSubmitEditing = jest.fn();
  const titleRef = createRef<TextInput>();
  const draft = Object.freeze({ ...healthDraft, title });
  const view = render(
    <TrackerEditor
      domain="health"
      draft={draft}
      inputRefs={{ title: titleRef }}
      inputSubmit={{ title: { onSubmitEditing, returnKeyType: "next" } }}
      mode="create"
      onBack={jest.fn()}
      onChange={onChange}
      onSave={jest.fn()}
    />,
  );
  const input = screen.getByLabelText("标题");
  const style = StyleSheet.flatten(input.props.style);

  expect(Array.from(title)).toHaveLength(200);
  expect(input.props).toMatchObject({
    allowFontScaling: true,
    multiline: true,
    returnKeyType: "next",
    submitBehavior: "submit",
    textAlignVertical: "top",
    value: title,
  });
  expect(input.props.numberOfLines).toBeUndefined();
  expect(style?.height).toBeUndefined();
  expect(style?.maxHeight).toBeUndefined();
  expect(style?.lineHeight).toBeUndefined();
  expect(titleRef.current).not.toBeNull();

  fireEvent.changeText(input, nextTitle);
  expectExactDraftChange(onChange, { ...draft, title: nextTitle });
  fireEvent(input, "submitEditing");
  expect(onSubmitEditing).toHaveBeenCalledTimes(1);
  expectScalableTree(view);
});

test("keeps exact create and edit action order for every domain", () => {
  const cases = [
    ["growth", "生长", growthDraft],
    ["feeding", "喂养", feedingDraft],
    ["sleep", "睡眠", sleepDraft],
    ["diaper", "大小便", diaperDraft],
    ["health", "健康", healthDraft],
  ] as const;
  for (const [domain, label, draft] of cases) {
    const createProps = {
      domain,
      draft,
      mode: "create",
      onBack: jest.fn(),
      onChange: jest.fn(),
      onSave: jest.fn(),
    } as TrackerEditorProps;
    const createView = render(<TrackerEditor {...createProps} />);
    expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      `返回${label}列表`,
      `保存${label}记录`,
    ]);
    createView.unmount();

    const editProps = {
      domain,
      draft,
      mode: "edit",
      onBack: jest.fn(),
      onChange: jest.fn(),
      onDelete: jest.fn(),
      onSave: jest.fn(),
    } as TrackerEditorProps;
    const editView = render(<TrackerEditor {...editProps} />);
    expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual([
      `返回${label}列表`,
      "保存修改",
      "删除这条记录",
    ]);
    editView.unmount();
  }
});

test("keeps controls 320-compatible through wrapping, scalable text, and minimum targets", () => {
  const view = render(
    <TrackerEditor
      domain="sleep"
      draft={sleepDraft}
      mode="edit"
      onBack={jest.fn()}
      onChange={jest.fn()}
      onDelete={jest.fn()}
      onSave={jest.fn()}
    />,
  );
  const styles = view.UNSAFE_getAllByType(View).map((node) => StyleSheet.flatten(node.props.style));
  expect(styles.filter((style) => style?.flexDirection === "row" && style?.flexWrap === "wrap").length).toBeGreaterThanOrEqual(3);
  const fieldWidths = styles.filter((style) => style?.minWidth !== undefined).map((style) => style?.minWidth);
  expect(fieldWidths.length).toBeGreaterThan(0);
  expect(fieldWidths.every((width) => typeof width === "number" && width <= 288)).toBe(true);
  expect(StyleSheet.flatten(view.getByTestId("tracker-editor-actions").props.style)?.flexWrap).toBe("wrap");
  for (const control of [...screen.getAllByRole("button"), ...screen.getAllByRole("radio")]) {
    expect(StyleSheet.flatten(control.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
  }
  expectScalableTree(view);
});

test("persists Task 4 forbidden-style, ownership, and import boundaries", () => {
  const paths = [
    "src/features/tracker/TrackerDomainSwitcher.tsx",
    "src/features/tracker/TrackerRecordList.tsx",
    "src/features/tracker/TrackerFormPrimitives.tsx",
    "src/features/tracker/TrackerEditor.tsx",
    "src/features/tracker/forms/GrowthTrackerForm.tsx",
    "src/features/tracker/forms/FeedingTrackerForm.tsx",
    "src/features/tracker/forms/SleepTrackerForm.tsx",
    "src/features/tracker/forms/DiaperTrackerForm.tsx",
    "src/features/tracker/forms/HealthTrackerForm.tsx",
  ];
  const root = process.cwd();
  const sources = paths.map((path) => Object.freeze({
    path,
    source: readFileSync(join(root, path), "utf8"),
  }));
  const source = sources.map((entry) => entry.source).join("\n");
  expect(source).not.toMatch(/numberOfLines|ellipsizeMode|lineHeight|allowFontScaling=\{false\}|position:\s*["']absolute|transform:\s*\[|scale\s*\(/);
  expect(source).not.toMatch(/(?:^|[,{]\s*)height:\s*\d/m);
  const forbiddenImportPath = /sqlite|(?:^|\/)(?:application|infrastructure|navigation|request|testing)(?:\/|$)|(?:^|[\/:@.-])(?:http|model|network|profile|provider)(?:[\/:@.-]|$)|axios|babyProfile|DataMutationCoordinator|ExclusiveTransaction|ManualTrackerService|manualTrackerService|modelSettingsService|pending[-_]?task|react-navigation/i;
  const forbiddenRuntimeBoundary = /\b(?:BabyProfile(?:Context|Provider|Service)?|DataMutationCoordinator|ExclusiveTransaction(?:Port)?|ManualTrackerService(?:Context|Port|Provider)?|ProfileContext|ServiceContext|XMLHttpRequest|axios|fetch|useBabyProfile|useManualTrackerService)\b|pending[-_]?task/i;
  const referencedModulePaths = (contents: string) => [
    ...contents.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...contents.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...contents.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...contents.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
  expect(referencedModulePaths(`
    import coordinator from "../../application/DataMutationCoordinator";
    import "expo-sqlite";
    const context = import("./ManualTrackerServiceContext");
    const client = require("axios");
  `)).toEqual([
    "../../application/DataMutationCoordinator",
    "expo-sqlite",
    "./ManualTrackerServiceContext",
    "axios",
  ]);
  for (const forbiddenPath of [
    "@op-engineering/op-sqlite",
    "../../application/tracker/manualTrackerService",
    "../../features/profile/BabyProfileContext",
    "../../infrastructure/exclusiveTransaction",
    "../../model/provider/client",
    "../pending-task",
    "node:http",
  ]) expect(forbiddenPath).toMatch(forbiddenImportPath);
  for (const allowedPath of [
    "../../domain/tracker/types",
    "../../shared/theme/tokens",
    "./trackerEditorModel",
    "./TrackerFormPrimitives",
  ]) expect(allowedPath).not.toMatch(forbiddenImportPath);
  expect("fetch('/records'); new XMLHttpRequest(); useManualTrackerService();").toMatch(forbiddenRuntimeBoundary);
  for (const entry of sources) {
    const imports = referencedModulePaths(entry.source);
    for (const importPath of imports) {
      expect(importPath).not.toMatch(forbiddenImportPath);
      if (!importPath.startsWith(".")) continue;
      const resolvedPath = relative(root, resolve(dirname(join(root, entry.path)), importPath)).replaceAll("\\", "/");
      expect(resolvedPath).toMatch(/^src\/(?:domain|shared|features\/tracker)(?:\/|$)/);
    }
    expect(entry.source).not.toMatch(forbiddenRuntimeBoundary);
  }
  expect(source).not.toMatch(/\b(?:async|await|Promise|useEffect|useReducer)\b/);
  const primitiveSource = readFileSync(
    join(process.cwd(), "src/features/tracker/TrackerFormPrimitives.tsx"),
    "utf8",
  );
  expect(primitiveSource).toContain("ref={index === 0 ? groupRef : undefined}");
  expect(primitiveSource).toContain("focused: { borderColor: colors.focus }");
});
