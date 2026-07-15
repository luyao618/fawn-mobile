import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing } from "../theme/tokens";

export function BootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.canvas}>
      <View style={styles.content}>
        <View accessible accessibilityLiveRegion="assertive" accessibilityRole="alert">
          <Text accessibilityRole="header" allowFontScaling style={styles.title}>页面暂时无法显示</Text>
          <Text allowFontScaling style={styles.body}>可以在本机重试。此操作不会上传错误信息。</Text>
        </View>
        <Pressable accessibilityLabel="重试显示页面" accessibilityRole="button" hitSlop={4} onPress={onRetry} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
          <Text allowFontScaling style={styles.buttonText}>重试</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { alignItems: "center", backgroundColor: colors.canvas, flex: 1, justifyContent: "center", padding: spacing.xl },
  content: { gap: spacing.md, maxWidth: 480, width: "100%" },
  title: { color: colors.danger, fontSize: 24, fontWeight: "700" },
  body: { color: colors.textSecondary, fontSize: 16 },
  button: { alignItems: "center", alignSelf: "flex-start", backgroundColor: colors.brand, borderRadius: radius.control, justifyContent: "center", minHeight: 48, minWidth: 88, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  buttonPressed: { backgroundColor: colors.brandStrong },
  buttonText: { color: colors.surface, fontSize: 16, fontWeight: "600" },
});
