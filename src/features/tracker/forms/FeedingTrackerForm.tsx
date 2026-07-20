import { View } from "react-native";

import type { FeedingTrackerDraft } from "../trackerEditorModel";
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

const FEEDING_OPTIONS = Object.freeze([
  Object.freeze({ label: "母乳", value: "breast" as const }),
  Object.freeze({ label: "配方奶", value: "formula" as const }),
  Object.freeze({ label: "辅食", value: "solid" as const }),
]);

export type FeedingTrackerFormProps = Readonly<{
  busy?: boolean;
  disabled?: boolean;
  draft: FeedingTrackerDraft;
  errors?: TrackerFormErrors;
  groupRefs?: TrackerGroupRefs;
  inputRefs?: TrackerInputRefs;
  inputSubmit?: TrackerInputSubmitMap;
  onChange: (draft: FeedingTrackerDraft) => void;
}>;

export function FeedingTrackerForm({
  busy = false,
  disabled = false,
  draft,
  errors = {},
  groupRefs,
  inputRefs,
  inputSubmit,
  onChange,
}: FeedingTrackerFormProps) {
  const update = <K extends keyof FeedingTrackerDraft>(field: K, value: FeedingTrackerDraft[K]) => {
    onChange(Object.freeze({ ...draft, [field]: value }));
  };
  return (
    <View style={trackerFormLayoutStyles.form}>
      <View style={trackerFormLayoutStyles.fieldPair}>
        <LabeledTextInput
          {...inputSubmit?.feedTimeDate}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.feedTimeDate}
          label="喂养日期"
          onChangeText={(value) => update("dateText", value)}
          placeholder="例如 2026-07-20"
          value={draft.dateText}
        />
        <LabeledTextInput
          {...inputSubmit?.feedTime}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.feedTime}
          label="喂养时间"
          onChangeText={(value) => update("timeText", value)}
          placeholder="例如 08:10"
          value={draft.timeText}
        />
      </View>
      <FieldError message={errors.feedTime} />
      <LabeledRadioGroup
        busy={busy}
        disabled={disabled}
        error={errors.feedType}
        groupRef={groupRefs?.feedType}
        label="喂养类型"
        onSelect={(value) => update("feedType", value)}
        options={FEEDING_OPTIONS}
        selected={draft.feedType}
      />
      <LabeledTextInput
        {...inputSubmit?.amountMl}
        busy={busy}
        disabled={disabled}
        error={errors.amountMl}
        inputRef={inputRefs?.amountMl}
        keyboardType="numeric"
        label="量（毫升）"
        onChangeText={(value) => update("amountMl", value)}
        value={draft.amountMl}
      />
      {draft.feedType === "formula" && !errors.amountMl ? <TrackerFieldHint>配方奶需要填写量。</TrackerFieldHint> : null}
      <LabeledTextInput
        {...inputSubmit?.durationMin}
        busy={busy}
        disabled={disabled}
        error={errors.durationMin}
        inputRef={inputRefs?.durationMin}
        keyboardType="numeric"
        label="时长（分钟）"
        onChangeText={(value) => update("durationMin", value)}
        value={draft.durationMin}
      />
      {draft.feedType === "breast" && !errors.durationMin ? <TrackerFieldHint>母乳需要填写时长。</TrackerFieldHint> : null}
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
