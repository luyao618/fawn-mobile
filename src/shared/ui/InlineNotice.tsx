import { StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing } from "../theme/tokens";

export function InlineNotice({ children }: { children: string }) {
  return (
    <View accessibilityRole="summary" style={styles.notice}>
      <Text allowFontScaling style={styles.text}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { backgroundColor: colors.butter, borderColor: colors.border, borderRadius: radius.small, borderWidth: 1, padding: spacing.md },
  text: { color: colors.textPrimary, fontSize: 14 },
});
