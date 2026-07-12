import { StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "../theme/tokens";

export function StatusBadge({ label }: { label: string }) {
  return (
    <View accessibilityLabel={label} style={styles.badge}>
      <Text allowFontScaling style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: "flex-start", backgroundColor: colors.brandSoft, borderRadius: 999, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  text: { color: colors.brandStrong, fontSize: 12, fontWeight: "600" },
});
