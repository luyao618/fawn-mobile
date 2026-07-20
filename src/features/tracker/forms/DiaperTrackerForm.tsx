import { View } from "react-native";

import type { DiaperTrackerDraft } from "../trackerEditorModel";
import {
  FieldError,
  LabeledMultilineInput,
  LabeledRadioGroup,
  LabeledTextInput,
  type TrackerFormErrors,
  type TrackerGroupRefs,
  type TrackerInputRefs,
  type TrackerInputSubmitMap,
  trackerFormLayoutStyles,
} from "../TrackerFormPrimitives";

const DIAPER_OPTIONS = Object.freeze([
  Object.freeze({ label: "大便", value: "poop" as const }),
  Object.freeze({ label: "小便", value: "pee" as const }),
  Object.freeze({ label: "混合", value: "mixed" as const }),
]);

export type DiaperTrackerFormProps = Readonly<{
  busy?: boolean;
  disabled?: boolean;
  draft: DiaperTrackerDraft;
  errors?: TrackerFormErrors;
  groupRefs?: TrackerGroupRefs;
  inputRefs?: TrackerInputRefs;
  inputSubmit?: TrackerInputSubmitMap;
  onChange: (draft: DiaperTrackerDraft) => void;
}>;

export function DiaperTrackerForm({
  busy = false,
  disabled = false,
  draft,
  errors = {},
  groupRefs,
  inputRefs,
  inputSubmit,
  onChange,
}: DiaperTrackerFormProps) {
  const update = <K extends keyof DiaperTrackerDraft>(field: K, value: DiaperTrackerDraft[K]) => {
    onChange(Object.freeze({ ...draft, [field]: value }));
  };
  return (
    <View style={trackerFormLayoutStyles.form}>
      <View style={trackerFormLayoutStyles.fieldPair}>
        <LabeledTextInput
          {...inputSubmit?.diaperTimeDate}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.diaperTimeDate}
          label="记录日期"
          onChangeText={(value) => update("dateText", value)}
          placeholder="例如 2026-07-20"
          value={draft.dateText}
        />
        <LabeledTextInput
          {...inputSubmit?.diaperTime}
          busy={busy}
          disabled={disabled}
          inputRef={inputRefs?.diaperTime}
          label="记录时间"
          onChangeText={(value) => update("timeText", value)}
          placeholder="例如 08:10"
          value={draft.timeText}
        />
      </View>
      <FieldError message={errors.diaperTime} />
      <LabeledRadioGroup
        busy={busy}
        disabled={disabled}
        error={errors.diaperType}
        groupRef={groupRefs?.diaperType}
        label="类型"
        onSelect={(value) => update("diaperType", value)}
        options={DIAPER_OPTIONS}
        selected={draft.diaperType}
      />
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
