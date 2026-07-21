import { View } from "react-native";

import type { GrowthTrackerDraft } from "../trackerEditorModel";
import {
  FieldError,
  LabeledMultilineInput,
  LabeledTextInput,
  type TrackerFormErrors,
  type TrackerInputRefs,
  type TrackerInputSubmitMap,
  trackerFormLayoutStyles,
} from "../TrackerFormPrimitives";

export type GrowthTrackerFormProps = Readonly<{
  busy?: boolean;
  disabled?: boolean;
  draft: GrowthTrackerDraft;
  errors?: TrackerFormErrors;
  inputRefs?: TrackerInputRefs;
  inputSubmit?: TrackerInputSubmitMap;
  onChange: (draft: GrowthTrackerDraft) => void;
}>;

export function GrowthTrackerForm({
  busy = false,
  disabled = false,
  draft,
  errors = {},
  inputRefs,
  inputSubmit,
  onChange,
}: GrowthTrackerFormProps) {
  const update = <K extends keyof GrowthTrackerDraft>(field: K, value: GrowthTrackerDraft[K]) => {
    onChange(Object.freeze({ ...draft, [field]: value }));
  };
  return (
    <View style={trackerFormLayoutStyles.form}>
      <LabeledTextInput
        {...inputSubmit?.measurementDate}
        busy={busy}
        disabled={disabled}
        error={errors.measurementDate}
        inputRef={inputRefs?.measurementDate}
        label="测量日期"
        onChangeText={(value) => update("dateText", value)}
        placeholder="例如 2026-07-20"
        value={draft.dateText}
      />
      <LabeledTextInput
        {...inputSubmit?.weightG}
        busy={busy}
        disabled={disabled}
        error={errors.weightG}
        inputRef={inputRefs?.weightG}
        keyboardType="numeric"
        label="体重（克）"
        onChangeText={(value) => update("weightG", value)}
        value={draft.weightG}
      />
      <LabeledTextInput
        {...inputSubmit?.heightCm}
        busy={busy}
        disabled={disabled}
        error={errors.heightCm}
        inputRef={inputRefs?.heightCm}
        keyboardType="decimal-pad"
        label="身长（厘米）"
        onChangeText={(value) => update("heightCm", value)}
        value={draft.heightCm}
      />
      <LabeledTextInput
        {...inputSubmit?.headCm}
        busy={busy}
        disabled={disabled}
        error={errors.headCm}
        inputRef={inputRefs?.headCm}
        keyboardType="decimal-pad"
        label="头围（厘米）"
        onChangeText={(value) => update("headCm", value)}
        value={draft.headCm}
      />
      <FieldError message={errors.measurements} />
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
