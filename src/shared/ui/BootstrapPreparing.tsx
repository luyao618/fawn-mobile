import { StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "../theme/tokens";

export function BootstrapPreparing() {
  return (
    <View accessible accessibilityLabel="正在准备本机数据" accessibilityLiveRegion="polite" style={styles.canvas}>
      <Text accessibilityRole="header" allowFontScaling style={styles.title}>正在准备本机数据</Text>
      <Text allowFontScaling style={styles.body}>完成后即可继续使用。</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { backgroundColor: colors.canvas, flex: 1, justifyContent: "center", padding: spacing.xl },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: "700" },
  body: { color: colors.textSecondary, fontSize: 16, marginTop: spacing.sm },
});
