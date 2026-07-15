import type { PropsWithChildren } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, spacing } from "../theme/tokens";
import { TopBar } from "./TopBar";

export function AppFrame({ children, title, localOnly = false }: PropsWithChildren<{ title: string; localOnly?: boolean }>) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const horizontal = width >= 768 ? spacing.xxl : width >= 431 ? spacing.xl : spacing.md;
  return (
    <View style={[styles.canvas, { paddingTop: insets.top }]}>
      <View style={[styles.headerWidth, { paddingHorizontal: horizontal }]}><TopBar title={title} localOnly={localOnly} /></View>
      <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: horizontal }]} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { backgroundColor: colors.canvas, flex: 1 },
  headerWidth: { alignSelf: "center", maxWidth: 640, width: "100%" },
  content: { alignSelf: "center", flexGrow: 1, maxWidth: 640, paddingBottom: spacing.xxl, paddingTop: spacing.lg, width: "100%" },
});
