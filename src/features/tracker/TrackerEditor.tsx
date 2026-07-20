import type { Ref } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { TrackerDomain } from "../../domain/tracker/types";
import { colors, spacing } from "../../shared/theme/tokens";
import { DiaperTrackerForm } from "./forms/DiaperTrackerForm";
import { FeedingTrackerForm } from "./forms/FeedingTrackerForm";
import { GrowthTrackerForm } from "./forms/GrowthTrackerForm";
import { HealthTrackerForm } from "./forms/HealthTrackerForm";
import { SleepTrackerForm } from "./forms/SleepTrackerForm";
import type {
  DiaperTrackerDraft,
  FeedingTrackerDraft,
  GrowthTrackerDraft,
  HealthTrackerDraft,
  SleepTrackerDraft,
  TrackerEditorDraftByDomain,
} from "./trackerEditorModel";
import { TRACKER_DOMAIN_LABELS } from "./TrackerDomainSwitcher";
import {
  DestructiveAction,
  FieldError,
  PrimaryAction,
  SecondaryAction,
  type TrackerFormErrors,
  type TrackerGroupRefs,
  type TrackerInputRefs,
  type TrackerInputSubmitMap,
} from "./TrackerFormPrimitives";

export type {
  TrackerFormErrors,
  TrackerGroupRefs,
  TrackerInputRefs,
  TrackerInputSubmitMap,
} from "./TrackerFormPrimitives";

type CommonEditorProps<D extends TrackerDomain> = Readonly<{
  backRef?: Ref<View>;
  busy?: boolean;
  disabled?: boolean;
  domain: D;
  draft: TrackerEditorDraftByDomain[D];
  errors?: TrackerFormErrors;
  groupRefs?: TrackerGroupRefs;
  headingRef?: Ref<Text>;
  inputRefs?: TrackerInputRefs;
  inputSubmit?: TrackerInputSubmitMap;
  onBack: () => void;
  onChange: (draft: TrackerEditorDraftByDomain[D]) => void;
  onSave: () => void;
  saveRef?: Ref<View>;
}>;

type CreateEditorProps<D extends TrackerDomain> = CommonEditorProps<D> & Readonly<{
  deleteRef?: never;
  mode: "create";
  onDelete?: never;
}>;

type EditEditorProps<D extends TrackerDomain> = CommonEditorProps<D> & Readonly<{
  deleteRef?: Ref<View>;
  mode: "edit";
  onDelete: () => void;
}>;

export type TrackerEditorProps = {
  readonly [D in TrackerDomain]: CreateEditorProps<D> | EditEditorProps<D>;
}[TrackerDomain];

type EditorFormProps = Readonly<{
  busy?: boolean;
  disabled?: boolean;
  domain: TrackerDomain;
  draft: TrackerEditorProps["draft"];
  errors?: TrackerFormErrors;
  groupRefs?: TrackerGroupRefs;
  inputRefs?: TrackerInputRefs;
  inputSubmit?: TrackerInputSubmitMap;
  onChange: TrackerEditorProps["onChange"];
}>;

function EditorForm({
  busy,
  disabled,
  domain,
  draft,
  errors,
  groupRefs,
  inputRefs,
  inputSubmit,
  onChange,
}: EditorFormProps) {
  const shared = {
    busy,
    disabled,
    errors,
    groupRefs,
    inputRefs,
    inputSubmit,
  };
  switch (domain) {
    case "growth":
      return (
        <GrowthTrackerForm
          {...shared}
          draft={draft as GrowthTrackerDraft}
          onChange={onChange as (draft: GrowthTrackerDraft) => void}
        />
      );
    case "feeding":
      return (
        <FeedingTrackerForm
          {...shared}
          draft={draft as FeedingTrackerDraft}
          onChange={onChange as (draft: FeedingTrackerDraft) => void}
        />
      );
    case "sleep":
      return (
        <SleepTrackerForm
          {...shared}
          draft={draft as SleepTrackerDraft}
          onChange={onChange as (draft: SleepTrackerDraft) => void}
        />
      );
    case "diaper":
      return (
        <DiaperTrackerForm
          {...shared}
          draft={draft as DiaperTrackerDraft}
          onChange={onChange as (draft: DiaperTrackerDraft) => void}
        />
      );
    case "health":
      return (
        <HealthTrackerForm
          {...shared}
          draft={draft as HealthTrackerDraft}
          onChange={onChange as (draft: HealthTrackerDraft) => void}
        />
      );
  }
}

export function TrackerEditor({
  backRef,
  busy,
  deleteRef,
  disabled,
  domain,
  draft,
  errors,
  groupRefs,
  headingRef,
  inputRefs,
  inputSubmit,
  mode,
  onBack,
  onChange,
  onDelete,
  onSave,
  saveRef,
}: TrackerEditorProps) {
  const domainLabel = TRACKER_DOMAIN_LABELS[domain];
  const heading = mode === "create" ? `新增${domainLabel}记录` : `编辑${domainLabel}记录`;
  return (
    <View style={styles.editor}>
      <Text accessibilityRole="header" allowFontScaling ref={headingRef} style={styles.heading}>
        {heading}
      </Text>
      <SecondaryAction
        actionRef={backRef}
        busy={busy}
        disabled={disabled}
        label={`返回${domainLabel}列表`}
        onPress={onBack}
      />

      <EditorForm
        busy={busy}
        disabled={disabled}
        domain={domain}
        draft={draft}
        errors={errors}
        groupRefs={groupRefs}
        inputRefs={inputRefs}
        inputSubmit={inputSubmit}
        onChange={onChange}
      />

      <FieldError message={errors?.form} />
      <View style={styles.actions} testID="tracker-editor-actions">
        <PrimaryAction
          actionRef={saveRef}
          busy={busy}
          disabled={disabled}
          label={mode === "create" ? `保存${domainLabel}记录` : "保存修改"}
          onPress={onSave}
        />
        {mode === "edit" ? (
          <DestructiveAction
            actionRef={deleteRef}
            busy={busy}
            disabled={disabled}
            label="删除这条记录"
            onPress={onDelete}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexWrap: "wrap", gap: spacing.sm },
  editor: { gap: spacing.lg, paddingBottom: spacing.xl },
  heading: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
});
