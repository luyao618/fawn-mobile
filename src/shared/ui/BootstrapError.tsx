import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing } from "../theme/tokens";

export type BootstrapErrorAction = Readonly<{
  label: string;
  onPress: () => void;
  pending?: boolean;
}>;

type BootstrapErrorProps = Readonly<{
  action?: BootstrapErrorAction;
  title?: string;
  body?: string;
}>;

export function BootstrapError({
  action,
  title = "页面暂时无法显示",
  body = "可以在本机重试。此操作不会上传错误信息。",
}: BootstrapErrorProps) {
  return (
    <View style={styles.canvas}>
      <View style={styles.content}>
        <View accessible accessibilityLiveRegion="assertive" accessibilityRole="alert">
          <Text accessibilityRole="header" allowFontScaling style={styles.title}>{title}</Text>
          <Text allowFontScaling style={styles.body}>{body}</Text>
        </View>
        {action ? (
          <Pressable accessibilityLabel={action.label} accessibilityRole="button" accessibilityState={{ busy: action.pending, disabled: action.pending }} disabled={action.pending} hitSlop={4} onPress={action.onPress} style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}>
            <Text allowFontScaling style={styles.buttonText}>{action.pending ? "正在重试" : "重试"}</Text>
          </Pressable>
        ) : null}
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
