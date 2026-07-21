import { View } from "react-native";

import { InlineNotice } from "../../../shared/ui/InlineNotice";
import type { HealthTrackerDraft } from "../trackerEditorModel";
import {
  LabeledMultilineInput,
  LabeledRadioGroup,
  LabeledTextInput,
  type TrackerFormErrors,
  type TrackerGroupRefs,
  type TrackerInputRefs,
  type TrackerInputSubmitMap,
  trackerFormLayoutStyles,
} from "../TrackerFormPrimitives";

const HEALTH_OPTIONS = Object.freeze([
  Object.freeze({ label: "疫苗接种", value: "vaccination" as const }),
  Object.freeze({ label: "身体不适", value: "illness" as const }),
  Object.freeze({ label: "常规检查", value: "checkup" as const }),
]);

export type HealthTrackerFormProps = Readonly<{
  busy?: boolean;
  disabled?: boolean;
  draft: HealthTrackerDraft;
  errors?: TrackerFormErrors;
  groupRefs?: TrackerGroupRefs;
  inputRefs?: TrackerInputRefs;
  inputSubmit?: TrackerInputSubmitMap;
  onChange: (draft: HealthTrackerDraft) => void;
}>;

export function HealthTrackerForm({
  busy = false,
  disabled = false,
  draft,
  errors = {},
  groupRefs,
  inputRefs,
  inputSubmit,
  onChange,
}: HealthTrackerFormProps) {
  const update = <K extends keyof HealthTrackerDraft>(field: K, value: HealthTrackerDraft[K]) => {
    onChange(Object.freeze({ ...draft, [field]: value }));
  };
  return (
    <View style={trackerFormLayoutStyles.form}>
      <LabeledTextInput
        {...inputSubmit?.recordDate}
        busy={busy}
        disabled={disabled}
        error={errors.recordDate}
        inputRef={inputRefs?.recordDate}
        label="记录日期"
        onChangeText={(value) => update("dateText", value)}
        placeholder="例如 2026-07-20"
        value={draft.dateText}
      />
      <LabeledRadioGroup
        busy={busy}
        disabled={disabled}
        error={errors.recordType}
        groupRef={groupRefs?.recordType}
        label="健康记录类型"
        onSelect={(value) => update("recordType", value)}
        options={HEALTH_OPTIONS}
        selected={draft.recordType}
      />
      <LabeledMultilineInput
        {...inputSubmit?.title}
        busy={busy}
        disabled={disabled}
        error={errors.title}
        inputRef={inputRefs?.title}
        label="标题"
        onChangeText={(value) => update("title", value)}
        submitBehavior="submit"
        value={draft.title}
      />
      <LabeledMultilineInput
        {...inputSubmit?.description}
        busy={busy}
        disabled={disabled}
        error={errors.description}
        inputRef={inputRefs?.description}
        label="说明"
        onChangeText={(value) => update("description", value)}
        value={draft.description}
      />
      <InlineNotice>健康记录用于整理照护信息，不提供诊断。</InlineNotice>
    </View>
  );
}
