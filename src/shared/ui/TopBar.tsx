import { StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "../theme/tokens";
import { StatusBadge } from "./StatusBadge";

export function TopBar({ title, localOnly = false }: { title: string; localOnly?: boolean }) {
  return (
    <View style={styles.bar}>
      <Text accessibilityRole="header" allowFontScaling style={styles.title}>{title}</Text>
      {localOnly ? <StatusBadge label="仅本机" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, justifyContent: "space-between", minHeight: 56, paddingVertical: spacing.sm },
  title: { color: colors.textPrimary, flexShrink: 1, fontSize: 24, fontWeight: "700" },
});
