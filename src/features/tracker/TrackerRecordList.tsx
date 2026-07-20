import { useState, type Ref } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { TrackerDomain, TrackerRecordByDomain } from "../../domain/tracker/types";
import { colors, radius, spacing } from "../../shared/theme/tokens";
import { isUsableIanaZone } from "./trackerLocalTime";
import { formatTrackerRecordSummary } from "./trackerPresentation";
import { TRACKER_DOMAIN_LABELS } from "./TrackerDomainSwitcher";
import { PrimaryAction } from "./TrackerFormPrimitives";

export function TrackerRecordList<D extends TrackerDomain>({
  busy = false,
  createRef,
  disabled = false,
  domain,
  headingRef,
  onCreate,
  onSelectRecord,
  records,
  rowRefForId,
  timeZone,
}: Readonly<{
  busy?: boolean;
  createRef?: Ref<View>;
  disabled?: boolean;
  domain: D;
  headingRef?: Ref<Text>;
  onCreate: () => void;
  onSelectRecord: (id: string) => void;
  records: readonly TrackerRecordByDomain[D][];
  rowRefForId?: (id: string) => Ref<View> | undefined;
  timeZone: string;
}>) {
  const domainLabel = TRACKER_DOMAIN_LABELS[domain];
  const unavailable = disabled || busy;
  const [focusedRecordId, setFocusedRecordId] = useState<string | null>(null);
  const requiresDeviceZone = domain === "feeding" || domain === "sleep" || domain === "diaper";
  const zoneBlocked = requiresDeviceZone && !isUsableIanaZone(timeZone);
  const presented = (zoneBlocked ? [] : records).map((record) => Object.freeze({
    record,
    summary: formatTrackerRecordSummary(domain, record, timeZone),
  }));
  let failureReason: "invalid_value" | "invalid_zone" | null = zoneBlocked ? "invalid_zone" : null;
  for (const { summary } of presented) {
    if (summary.status === "invalid") {
      failureReason = summary.reason;
      break;
    }
  }
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" allowFontScaling ref={headingRef} style={styles.heading}>
        {domainLabel}记录
      </Text>
      {failureReason ? (
        <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" allowFontScaling style={styles.error}>
          {failureReason === "invalid_zone"
            ? "无法确认本机时区，暂不能显示或编辑这类记录。"
            : `暂时无法显示${domainLabel}记录。本机数据没有更改。`}
        </Text>
      ) : (
        <PrimaryAction
          actionRef={createRef}
          busy={busy}
          disabled={disabled}
          label={`新增${domainLabel}记录`}
          onPress={onCreate}
        />
      )}

      {!failureReason && records.length === 0 ? (
        <View style={styles.empty}>
          <Text accessibilityRole="header" allowFontScaling style={styles.emptyHeading}>
            还没有{domainLabel}记录
          </Text>
          <Text allowFontScaling style={styles.description}>
            新增后会保存在本机，并显示在这里。
          </Text>
        </View>
      ) : !failureReason ? (
        <>
          <View style={styles.rows}>
            {presented.map(({ record, summary }) => {
              if (summary.status !== "formatted") return null;
              return (
                <Pressable
                  accessibilityLabel={`${domainLabel}记录，${summary.accessibilityLabel}`}
                  accessibilityRole="button"
                  accessibilityState={{ busy, disabled: unavailable }}
                  disabled={unavailable}
                  key={record.id}
                  onBlur={() => setFocusedRecordId((current) => current === record.id ? null : current)}
                  onFocus={() => setFocusedRecordId(record.id)}
                  onPress={() => onSelectRecord(record.id)}
                  ref={rowRefForId?.(record.id)}
                  style={({ pressed }) => [
                    styles.row,
                    focusedRecordId === record.id ? styles.focused : null,
                    pressed && !unavailable ? styles.pressed : null,
                    unavailable ? styles.disabled : null,
                  ]}
                >
                  <Text allowFontScaling style={styles.primary}>{summary.primary}</Text>
                  <Text allowFontScaling style={styles.secondary}>{summary.secondary}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text allowFontScaling style={styles.boundCopy}>
            显示最近最多 100 条{domainLabel}记录。
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  boundCopy: { color: colors.textSecondary, fontSize: 14 },
  container: { gap: spacing.md },
  description: { color: colors.textSecondary, fontSize: 16 },
  disabled: { opacity: 0.65 },
  empty: { gap: spacing.xs, paddingVertical: spacing.sm },
  emptyHeading: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 14 },
  focused: { borderColor: colors.focus },
  heading: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
  pressed: { backgroundColor: colors.surfaceSubtle, borderColor: colors.focus },
  primary: { color: colors.textPrimary, fontSize: 16, fontWeight: "600" },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: 1,
    gap: spacing.xs,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rows: { gap: spacing.sm },
  secondary: { color: colors.textSecondary, fontSize: 14 },
});
