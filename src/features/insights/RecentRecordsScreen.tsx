import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { RecentRecordItem } from "../../application/insights/recentRecordsService";
import { colors, radius, spacing } from "../../shared/theme/tokens";
import { AppFrame } from "../../shared/ui/AppFrame";
import { EmptyState } from "../../shared/ui/EmptyState";
import { InlineNotice } from "../../shared/ui/InlineNotice";
import { useRecentRecordsService } from "./RecentRecordsServiceContext";

type LoadState = "loading" | "ready" | "error";

export function RecentRecordsScreen() {
  const service = useRecentRecordsService();
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<readonly RecentRecordItem[]>([]);
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setState("loading");
    try {
      const result = await service.list(50);
      if (generation !== requestGeneration.current) return;
      setItems(result);
      setState("ready");
    } catch {
      if (generation !== requestGeneration.current) return;
      setState("error");
    }
  }, [service]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]));

  return (
    <AppFrame localOnly title="成长">
      <View style={styles.heading}>
        <Text accessibilityRole="header" allowFontScaling style={styles.title}>最近动态</Text>
        <Text allowFontScaling style={styles.description}>五类照护记录按发生时间汇总，最新记录排在前面。</Text>
      </View>

      {state === "loading" ? (
        <Text accessibilityLiveRegion="polite" allowFontScaling style={styles.stateText}>正在读取最近记录…</Text>
      ) : null}

      {state === "error" ? (
        <View style={styles.errorState}>
          <InlineNotice>暂时无法读取最近记录。本机数据没有更改。</InlineNotice>
          <Pressable
            accessibilityRole="button"
            onPress={() => { void load(); }}
            style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
          >
            <Text allowFontScaling style={styles.secondaryButtonText}>重新读取最近记录</Text>
          </Pressable>
        </View>
      ) : null}

      {state === "ready" && items.length === 0 ? (
        <EmptyState description="在“记录”中新增内容后，会按时间显示在这里。" title="还没有照护记录" />
      ) : null}

      {state === "ready" && items.length > 0 ? (
        <View accessibilityLabel="最近动态列表" style={styles.list}>
          {items.map((item) => (
            <View accessible accessibilityLabel={item.accessibilityLabel} key={`${item.domain}:${item.id}`} style={styles.row}>
              <View style={styles.rowHeader}>
                <Text allowFontScaling style={styles.domain}>{item.domainLabel}</Text>
                <Text allowFontScaling style={styles.time}>{item.primary}</Text>
              </View>
              <Text allowFontScaling style={styles.summary}>{item.secondary || "已记录"}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </AppFrame>
  );
}

const styles = StyleSheet.create({
  description: { color: colors.textSecondary, fontSize: 16 },
  domain: { color: colors.brandStrong, fontSize: 14, fontWeight: "700" },
  errorState: { gap: spacing.md },
  heading: { gap: spacing.xs, marginBottom: spacing.lg },
  list: { gap: spacing.sm },
  pressed: { backgroundColor: colors.surfaceSubtle },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.small,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  rowHeader: { alignItems: "flex-start", flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, justifyContent: "space-between" },
  secondaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: colors.brand,
    borderRadius: radius.small,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: { color: colors.brandStrong, fontSize: 16, fontWeight: "600" },
  stateText: { color: colors.textSecondary, fontSize: 14 },
  summary: { color: colors.textPrimary, fontSize: 16 },
  time: { color: colors.textSecondary, flexShrink: 1, fontSize: 14 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
});
