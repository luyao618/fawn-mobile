import { View } from "react-native";

import type { SleepTrackerDraft } from "../trackerEditorModel";
import {
  FieldError,
  LabeledMultilineInput,
  LabeledRadioGroup,
  LabeledTextInput,
  TrackerFieldHint,
  type TrackerFormErrors,
  type TrackerGroupRefs,
  type TrackerInputRefs,
  type TrackerInputSubmitMap,
  trackerFormLayoutStyles,
} from "../TrackerFormPrimitives";

const SLEEP_OPTIONS = Object.freeze([
  Object.freeze({ label: "小睡", value: "nap" as const }),
  Object.freeze({ label: "夜间睡眠", value: "night" as const }),
]);

export type SleepTrackerFormProps = Readonly<{
  busy?: boolean;
  disabled?: boolean;
  draft: SleepTrackerDraft;
  errors?: TrackerFormErrors;
  groupRefs?: TrackerGroupRefs;
  inputRefs?: TrackerInputRefs;
  inputSubmit?: TrackerInputSubmitMap;
  onChange: (draft: SleepTrackerDraft) => void;
}>;

export function SleepTrackerForm({
  busy = false,
  disabled = false,
  draft,
  errors = {},
  groupRefs,
  inputRefs,
  inputSubmit,
  onChange,
}: SleepTrackerFormProps) {
  const update = <K extends keyof SleepTrackerDraft>(field: K, value: SleepTrackerDraft[K]) => {
    onChange(Object.freeze({ ...draft, [field]: value }));
  };
  const selectSleepType = (sleepType: "nap" | "night") => {
    onChange(Object.freeze({
      ...draft,
      nightWakings: sleepType === "nap" ? "0" : draft.nightWakings,
      sleepType,
    }));
  };
  const nap = draft.sleepType === "nap";
  return (
    <View style={trackerFormLayoutStyles.form}>
      <View style={trackerFormLayoutStyles.fieldPair}>
        <LabeledTextInput
          {...inputSubmit?.sleepStartDate}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.sleepStartDate}
          label="开始日期"
          onChangeText={(value) => update("dateText", value)}
          placeholder="例如 2026-07-20"
          value={draft.dateText}
        />
        <LabeledTextInput
          {...inputSubmit?.sleepStart}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.sleepStart}
          label="开始时间"
          onChangeText={(value) => update("timeText", value)}
          placeholder="例如 08:10"
          value={draft.timeText}
        />
      </View>
      <FieldError message={errors.sleepStart} />
      <View style={trackerFormLayoutStyles.fieldPair}>
        <LabeledTextInput
          {...inputSubmit?.sleepEndDate}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.sleepEndDate}
          label="结束日期"
          onChangeText={(value) => update("endDateText", value)}
          placeholder="例如 2026-07-20"
          value={draft.endDateText}
        />
        <LabeledTextInput
          {...inputSubmit?.sleepEnd}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.sleepEnd}
          label="结束时间"
          onChangeText={(value) => update("endTimeText", value)}
          placeholder="例如 08:10"
          value={draft.endTimeText}
        />
      </View>
      <FieldError message={errors.sleepEnd} />
      <LabeledRadioGroup
        busy={busy}
        disabled={disabled}
        error={errors.sleepType}
        groupRef={groupRefs?.sleepType}
        label="睡眠类型"
        onSelect={selectSleepType}
        options={SLEEP_OPTIONS}
        selected={draft.sleepType}
      />
      <LabeledTextInput
        {...inputSubmit?.nightWakings}
        busy={busy}
        disabled={disabled || nap}
        error={errors.nightWakings}
        inputRef={inputRefs?.nightWakings}
        keyboardType="numeric"
        label="夜醒次数"
        onChangeText={(value) => update("nightWakings", value)}
        value={nap ? "0" : draft.nightWakings}
      />
      {nap ? <TrackerFieldHint>小睡的夜醒次数固定为 0。</TrackerFieldHint> : null}
      <LabeledMultilineInput
        {...inputSubmit?.notes}
        busy={busy}
        disabled={disabled}
        error={errors.notes}
        inputRef={inputRefs?.notes}
        label="备注"
        onChangeText={(value) => update("notes", value)}
        value={draft.notes}
      />
    </View>
  );
}
