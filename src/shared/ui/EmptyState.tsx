import { StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "../theme/tokens";

export function EmptyState({ title, description, children }: React.PropsWithChildren<{ title: string; description: string }>) {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" allowFontScaling style={styles.title}>{title}</Text>
      <Text allowFontScaling style={styles.description}>{description}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
  description: { color: colors.textSecondary, fontSize: 16 },
});
