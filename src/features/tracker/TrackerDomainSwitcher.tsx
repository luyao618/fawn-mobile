import { useState, type Ref } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { TrackerDomain } from "../../domain/tracker/types";
import { colors, radius, spacing } from "../../shared/theme/tokens";

export const TRACKER_DOMAIN_LABELS: Readonly<Record<TrackerDomain, string>> = Object.freeze({
  growth: "生长",
  feeding: "喂养",
  sleep: "睡眠",
  diaper: "大小便",
  health: "健康",
});

export const TRACKER_DOMAIN_ORDER: readonly TrackerDomain[] = Object.freeze([
  "growth",
  "feeding",
  "sleep",
  "diaper",
  "health",
]);

export type TrackerDomainTabRefs = Readonly<Partial<Record<TrackerDomain, Ref<View>>>>;

export function TrackerDomainSwitcher({
  busy = false,
  disabled = false,
  onSelectDomain,
  selectedDomain,
  tabRefs,
}: Readonly<{
  busy?: boolean;
  disabled?: boolean;
  onSelectDomain: (domain: TrackerDomain) => void;
  selectedDomain: TrackerDomain;
  tabRefs?: TrackerDomainTabRefs;
}>) {
  const unavailable = disabled || busy;
  const [focusedDomain, setFocusedDomain] = useState<TrackerDomain | null>(null);
  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      <View accessibilityLabel="记录类型" accessibilityRole="tablist" style={styles.tabList}>
        {TRACKER_DOMAIN_ORDER.map((domain) => {
          const selected = domain === selectedDomain;
          const label = TRACKER_DOMAIN_LABELS[domain];
          return (
            <Pressable
              accessibilityLabel={label}
              accessibilityRole="tab"
              accessibilityState={{ busy, disabled: unavailable, selected }}
              disabled={unavailable}
              key={domain}
              onBlur={() => setFocusedDomain((current) => current === domain ? null : current)}
              onFocus={() => setFocusedDomain(domain)}
              onPress={() => onSelectDomain(domain)}
              ref={tabRefs?.[domain]}
              style={({ pressed }) => [
                styles.tab,
                selected ? styles.selectedTab : null,
                focusedDomain === domain ? styles.focusedTab : null,
                pressed && !unavailable ? styles.pressedTab : null,
                unavailable ? styles.disabled : null,
              ]}
            >
              <Text allowFontScaling style={[styles.tabText, selected ? styles.selectedTabText : null]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.65 },
  focusedTab: { borderColor: colors.focus },
  pressedTab: { backgroundColor: colors.surfaceSubtle, borderColor: colors.focus },
  scrollContent: { paddingVertical: spacing.xxs },
  selectedTab: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
  selectedTabText: { color: colors.brandStrong, fontWeight: "600" },
  tab: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  tabList: { flexDirection: "row", gap: spacing.sm },
  tabText: { color: colors.textPrimary, fontSize: 12, fontWeight: "600" },
});
