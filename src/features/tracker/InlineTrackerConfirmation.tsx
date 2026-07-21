import type { ReactElement } from "react";
import { StyleSheet, Text, View } from "react-native";

import type {
  TrackerCreateSummary,
  TrackerDeleteSummary,
  TrackerUpdateSummary,
} from "../../application/tracker/manualTrackerService";
import type { TrackerDomain, TrackerRecordByDomain } from "../../domain/tracker/types";
import {
  normalizePersistedTrackerRecord,
  normalizeTrackerCreateInput,
  normalizeTrackerUpdateInput,
} from "../../domain/tracker/validation";
import { colors, spacing } from "../../shared/theme/tokens";
import { InlineNotice } from "../../shared/ui/InlineNotice";
import type { TrackerFocusRef } from "./trackerAccessibility";
import {
  formatTrackerConfirmationFields,
  formatTrackerRecordSummary,
  formatTrackerUpdateDiffs,
  type TrackerConfirmationField,
  type TrackerUpdateDiff,
} from "./trackerPresentation";
import { TRACKER_DOMAIN_LABELS } from "./TrackerDomainSwitcher";
import { DestructiveAction, PrimaryAction, SecondaryAction } from "./TrackerFormPrimitives";

type DecisionBase<TKind extends string, D extends TrackerDomain, TPrior> = Readonly<{
  kind: TKind;
  domain: D;
  prior: TPrior;
  initiatingControlRef: TrackerFocusRef<View>;
}>;

export type TrackerHealthCreateDecision<TPrior> = DecisionBase<"healthCreate", "health", TPrior> & Readonly<{
  serviceSummary: TrackerCreateSummary<"health">;
  presentationTimeZone: string;
}>;

export type TrackerUpdateDecision<D extends TrackerDomain, TPrior> = DecisionBase<"update", D, TPrior> & Readonly<{
  serviceSummary: TrackerUpdateSummary<D>;
  baseline: TrackerRecordByDomain[D];
  presentationTimeZone: string;
}>;

export type TrackerDeleteDecision<D extends TrackerDomain, TPrior> = DecisionBase<"delete", D, TPrior> & Readonly<{
  serviceSummary: TrackerDeleteSummary<D>;
  baseline: TrackerRecordByDomain[D];
  presentationTimeZone: string;
}>;

export type TrackerDiscardDecision<
  D extends TrackerDomain,
  TPrior,
  TDestination,
> = DecisionBase<"discard", D, TPrior> & Readonly<{
  destination: TDestination;
}>;

export type AnyTrackerUpdateDecision<TPrior = unknown> = {
  [D in TrackerDomain]: TrackerUpdateDecision<D, TPrior>;
}[TrackerDomain];

export type AnyTrackerDeleteDecision<TPrior = unknown> = {
  [D in TrackerDomain]: TrackerDeleteDecision<D, TPrior>;
}[TrackerDomain];

export type AnyTrackerDiscardDecision<TPrior = unknown, TDestination = unknown> = {
  [D in TrackerDomain]: TrackerDiscardDecision<D, TPrior, TDestination>;
}[TrackerDomain];

export type AnyTrackerDecision =
  | TrackerHealthCreateDecision<unknown>
  | AnyTrackerUpdateDecision
  | AnyTrackerDeleteDecision
  | AnyTrackerDiscardDecision;

export type TrackerDecisionFeedback =
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "status"; message: string }>;

export type InlineTrackerConfirmationProps<TDecision extends AnyTrackerDecision> = Readonly<{
  decision: TDecision;
  busy: boolean;
  feedback?: TrackerDecisionFeedback;
  headingRef: TrackerFocusRef<Text>;
  cancelActionRef: TrackerFocusRef<View>;
  acceptActionRef: TrackerFocusRef<View>;
  onCancel: (decision: TDecision) => void;
  onAccept: (decision: TDecision) => void;
}>;

export function createTrackerDecisionSnapshot<TDecision extends AnyTrackerDecision>(
  decision: TDecision,
): Readonly<TDecision> {
  // Task 6 constructs already-immutable prior/destination/service facts; freeze only the envelope to preserve identities.
  return Object.freeze(decision);
}

const INVALID_ZONE_TEXT = "无法确认本机时区，暂不能显示或编辑这类记录。";
const INVALID_CONTENT_TEXT = "暂时无法显示确认内容。本机数据没有更改。";

type PresentationFailureReason = "invalid_zone" | "invalid_value";

type DecisionPresentation = Readonly<{
  title: string;
  identifyingPrimary?: string;
  identifyingSecondary?: string;
  fields?: readonly TrackerConfirmationField[];
  diffs?: readonly TrackerUpdateDiff[];
  notice?: string;
  body?: string;
  consequence?: string;
  cancelLabel: string;
  acceptLabel?: string;
  acceptTone?: "primary" | "destructive";
  failure?: PresentationFailureReason;
  zeroDiff?: boolean;
}>;

function hasSameOwnValues(original: object, normalized: object): boolean {
  const originalKeys = Object.keys(original);
  const normalizedKeys = Object.keys(normalized);
  return originalKeys.length === normalizedKeys.length
    && normalizedKeys.every((key) => Object.prototype.hasOwnProperty.call(original, key)
      && Object.is(original[key as keyof typeof original], normalized[key as keyof typeof normalized]));
}

function validHealthCreateSummary(summary: TrackerCreateSummary<"health">): boolean {
  if (summary.action !== "create" || summary.domain !== "health") return false;
  try {
    return hasSameOwnValues(summary.input, normalizeTrackerCreateInput("health", summary.input));
  } catch {
    return false;
  }
}

function validUpdateDecision<D extends TrackerDomain>(decision: TrackerUpdateDecision<D, unknown>): boolean {
  const { baseline, domain, serviceSummary } = decision;
  if (
    serviceSummary.action !== "update"
    || serviceSummary.domain !== domain
    || baseline.id !== serviceSummary.id
    || baseline.updatedAt !== serviceSummary.expectedUpdatedAt
  ) return false;
  try {
    return hasSameOwnValues(baseline, normalizePersistedTrackerRecord(domain, baseline))
      && hasSameOwnValues(serviceSummary.input, normalizeTrackerUpdateInput(domain, serviceSummary.input));
  } catch {
    return false;
  }
}

function validDeleteDecision<D extends TrackerDomain>(decision: TrackerDeleteDecision<D, unknown>): boolean {
  const { baseline, domain, serviceSummary } = decision;
  if (
    serviceSummary.action !== "delete"
    || serviceSummary.domain !== domain
    || baseline.id !== serviceSummary.id
    || baseline.updatedAt !== serviceSummary.expectedUpdatedAt
  ) return false;
  try {
    return hasSameOwnValues(baseline, normalizePersistedTrackerRecord(domain, baseline));
  } catch {
    return false;
  }
}

function healthCreatePresentation(
  decision: TrackerHealthCreateDecision<unknown>,
): DecisionPresentation {
  if (decision.domain !== "health" || !validHealthCreateSummary(decision.serviceSummary)) {
    return { title: "确认新增健康记录", cancelLabel: "返回修改", failure: "invalid_value" };
  }
  const result = formatTrackerConfirmationFields(
    "health",
    decision.serviceSummary.input,
    decision.presentationTimeZone,
  );
  if (result.status === "invalid") {
    return { title: "确认新增健康记录", cancelLabel: "返回修改", failure: result.reason };
  }
  return {
    title: "确认新增健康记录",
    fields: result.fields,
    notice: "健康记录用于整理照护信息，不提供诊断。",
    consequence: "确认后会保存在本机。",
    cancelLabel: "返回修改",
    acceptLabel: "确认保存",
    acceptTone: "primary",
  };
}

function updatePresentationForDomain<D extends TrackerDomain>(
  decision: TrackerUpdateDecision<D, unknown>,
): DecisionPresentation {
  if (!validUpdateDecision(decision)) {
    return { title: "确认保存修改", cancelLabel: "返回修改", failure: "invalid_value" };
  }
  const identifying = formatTrackerRecordSummary(
    decision.domain,
    decision.baseline,
    decision.presentationTimeZone,
  );
  if (identifying.status === "invalid") {
    return { title: "确认保存修改", cancelLabel: "返回修改", failure: identifying.reason };
  }
  const changes = formatTrackerUpdateDiffs(
    decision.domain,
    decision.baseline,
    decision.serviceSummary.input,
    decision.presentationTimeZone,
  );
  if (changes.status === "invalid") {
    return { title: "确认保存修改", cancelLabel: "返回修改", failure: changes.reason };
  }
  return {
    title: "确认保存修改",
    identifyingPrimary: identifying.primary,
    diffs: changes.diffs,
    cancelLabel: "返回修改",
    acceptLabel: changes.diffs.length === 0 ? undefined : "确认保存",
    acceptTone: "primary",
    zeroDiff: changes.diffs.length === 0,
  };
}

function updatePresentation(decision: AnyTrackerUpdateDecision): DecisionPresentation {
  switch (decision.domain) {
    case "growth": return updatePresentationForDomain(decision);
    case "feeding": return updatePresentationForDomain(decision);
    case "sleep": return updatePresentationForDomain(decision);
    case "diaper": return updatePresentationForDomain(decision);
    case "health": return updatePresentationForDomain(decision);
  }
}

function deletePresentationForDomain<D extends TrackerDomain>(
  decision: TrackerDeleteDecision<D, unknown>,
): DecisionPresentation {
  const title = `确认删除这条${TRACKER_DOMAIN_LABELS[decision.domain]}记录`;
  if (!validDeleteDecision(decision)) return { title, cancelLabel: "取消", failure: "invalid_value" };
  const identifying = formatTrackerRecordSummary(
    decision.domain,
    decision.baseline,
    decision.presentationTimeZone,
  );
  if (identifying.status === "invalid") return { title, cancelLabel: "取消", failure: identifying.reason };
  return {
    title,
    identifyingPrimary: identifying.primary,
    identifyingSecondary: identifying.secondary,
    consequence: "删除后不会出现在记录列表中；当前版本没有恢复入口。",
    cancelLabel: "取消",
    acceptLabel: "确认删除",
    acceptTone: "destructive",
  };
}

function deletePresentation(decision: AnyTrackerDeleteDecision): DecisionPresentation {
  switch (decision.domain) {
    case "growth": return deletePresentationForDomain(decision);
    case "feeding": return deletePresentationForDomain(decision);
    case "sleep": return deletePresentationForDomain(decision);
    case "diaper": return deletePresentationForDomain(decision);
    case "health": return deletePresentationForDomain(decision);
  }
}

function isTrackerDomain(value: unknown): value is TrackerDomain {
  return value === "growth" || value === "feeding" || value === "sleep" || value === "diaper" || value === "health";
}

function presentDecision(decision: AnyTrackerDecision): DecisionPresentation {
  if (!isTrackerDomain(decision.domain)) {
    return { title: "确认记录操作", cancelLabel: "返回修改", failure: "invalid_value" };
  }
  switch (decision.kind) {
    case "healthCreate": return healthCreatePresentation(decision);
    case "update": return updatePresentation(decision);
    case "delete": return deletePresentation(decision);
    case "discard":
      return {
        title: "放弃未保存的更改？",
        body: "当前填写的内容还没有保存。",
        cancelLabel: "继续编辑",
        acceptLabel: "放弃更改",
        acceptTone: "destructive",
      };
    default:
      return { title: "确认记录操作", cancelLabel: "返回修改", failure: "invalid_value" };
  }
}

function Feedback({ feedback }: { feedback?: TrackerDecisionFeedback }) {
  if (!feedback) return null;
  return (
    <Text
      accessibilityLiveRegion={feedback.kind === "error" ? "assertive" : "polite"}
      accessibilityRole={feedback.kind === "error" ? "alert" : undefined}
      allowFontScaling
      style={feedback.kind === "error" ? styles.error : styles.status}
    >
      {feedback.message}
    </Text>
  );
}

export function InlineTrackerConfirmation<TDecision extends AnyTrackerDecision>({
  acceptActionRef,
  busy,
  cancelActionRef,
  decision,
  feedback,
  headingRef,
  onAccept,
  onCancel,
}: InlineTrackerConfirmationProps<TDecision>): ReactElement {
  const presentation = presentDecision(decision);
  const failureText = presentation.failure === "invalid_zone" ? INVALID_ZONE_TEXT : INVALID_CONTENT_TEXT;
  const cancel = () => {
    if (!busy) onCancel(decision);
  };
  const accept = () => {
    if (!busy && !presentation.failure && !presentation.zeroDiff) onAccept(decision);
  };

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" allowFontScaling ref={headingRef} style={styles.heading}>
        {presentation.title}
      </Text>

      {presentation.failure ? (
        <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" allowFontScaling style={styles.error}>
          {failureText}
        </Text>
      ) : (
        <>
          {presentation.identifyingPrimary ? (
            <Text allowFontScaling style={styles.identifyingPrimary}>{presentation.identifyingPrimary}</Text>
          ) : null}
          {presentation.identifyingSecondary ? (
            <Text allowFontScaling style={styles.identifyingSecondary}>{presentation.identifyingSecondary}</Text>
          ) : null}
          {presentation.fields?.map((item) => (
            <View key={item.label} style={styles.valueRow}>
              <Text allowFontScaling style={styles.label}>{item.label}</Text>
              <Text allowFontScaling style={styles.value}>{item.value}</Text>
            </View>
          ))}
          {presentation.diffs ? (
            presentation.zeroDiff ? (
              <Text allowFontScaling style={styles.body}>内容没有更改。</Text>
            ) : (
              <View style={styles.changeSection}>
                <Text accessibilityRole="header" allowFontScaling style={styles.sectionHeading}>修改内容</Text>
                {presentation.diffs.map((item) => (
                  <View key={item.label} style={styles.change}>
                    <Text allowFontScaling style={styles.label}>{item.label}</Text>
                    <View style={styles.changeValue}>
                      <Text allowFontScaling style={styles.changeLabel}>原内容</Text>
                      <Text allowFontScaling style={styles.value}>{item.previousValue}</Text>
                    </View>
                    <View style={styles.changeValue}>
                      <Text allowFontScaling style={styles.changeLabel}>新内容</Text>
                      <Text allowFontScaling style={styles.value}>{item.nextValue}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )
          ) : null}
          {presentation.body ? <Text allowFontScaling style={styles.body}>{presentation.body}</Text> : null}
          {presentation.notice ? <InlineNotice>{presentation.notice}</InlineNotice> : null}
          {presentation.consequence ? (
            <Text allowFontScaling style={styles.body}>{presentation.consequence}</Text>
          ) : null}
        </>
      )}

      <Feedback feedback={feedback} />

      <View style={styles.actions}>
        <SecondaryAction
          actionRef={cancelActionRef}
          busy={busy}
          label={presentation.cancelLabel}
          onPress={cancel}
        />
        {presentation.acceptLabel && !presentation.failure ? (
          presentation.acceptTone === "destructive" ? (
            <DestructiveAction
              actionRef={acceptActionRef}
              busy={busy}
              label={presentation.acceptLabel}
              onPress={accept}
            />
          ) : (
            <PrimaryAction
              actionRef={acceptActionRef}
              busy={busy}
              label={presentation.acceptLabel}
              onPress={accept}
            />
          )
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  body: { color: colors.textPrimary, fontSize: 16 },
  change: { gap: spacing.xs },
  changeLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: "600" },
  changeSection: { gap: spacing.md },
  changeValue: { gap: spacing.xs },
  container: { gap: spacing.lg },
  error: { color: colors.danger, fontSize: 14 },
  heading: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
  identifyingPrimary: { color: colors.textPrimary, fontSize: 16, fontWeight: "600" },
  identifyingSecondary: { color: colors.textSecondary, fontSize: 14 },
  label: { color: colors.textSecondary, fontSize: 14, fontWeight: "600" },
  sectionHeading: { color: colors.textPrimary, fontSize: 16, fontWeight: "600" },
  status: { color: colors.textSecondary, fontSize: 14 },
  value: { color: colors.textPrimary, fontSize: 16 },
  valueRow: { gap: spacing.xs },
});
