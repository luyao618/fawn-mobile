import { StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing } from "../../shared/theme/tokens";
import { AppFrame } from "../../shared/ui/AppFrame";
import { EmptyState } from "../../shared/ui/EmptyState";
import { InlineNotice } from "../../shared/ui/InlineNotice";

function ReadinessRow({ label }: { label: string }) {
  return (
    <View style={styles.row}>
      <Text allowFontScaling style={styles.rowLabel}>{label}</Text>
      <Text allowFontScaling style={styles.rowStatus}>未设置</Text>
    </View>
  );
}

export function StewardScreen() {
  return (
    <AppFrame localOnly title="管家">
      <EmptyState description="完成宝宝资料和模型连接后，可在这里提问、记录并查看回答依据。" title="照护空间尚未设置">
        <View style={styles.readiness}>
          <ReadinessRow label="宝宝资料" />
          <ReadinessRow label="模型连接" />
        </View>
        <InlineNotice>当前页面不会读取、保存或发送宝宝数据。</InlineNotice>
      </EmptyState>
    </AppFrame>
  );
}

function DestinationScreen({ title, heading, description }: { title: string; heading: string; description: string }) {
  return <AppFrame title={title}><EmptyState description={description} title={heading} /></AppFrame>;
}

export const RecordsScreen = () => <DestinationScreen description="本地记录功能将在后续版本启用。" heading="还没有照护记录" title="记录" />;
export const GrowthScreen = () => <DestinationScreen description="有真实的本地记录后，成长信息才会显示在这里。" heading="还没有可展示的成长数据" title="成长" />;
export const AlbumScreen = () => <DestinationScreen description="照片导入功能尚未启用，当前不会请求相册权限。" heading="还没有照片" title="相册" />;
export const MeScreen = () => <DestinationScreen description="宝宝资料、模型连接、备份和隐私设置将在后续版本提供。" heading="本机设置尚未启用" title="我的" />;

const styles = StyleSheet.create({
  readiness: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.surface, borderWidth: 1, marginVertical: spacing.sm },
  row: { alignItems: "flex-start", flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, justifyContent: "space-between", minHeight: 52, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rowLabel: { color: colors.textPrimary, flexShrink: 1, fontSize: 16 },
  rowStatus: { color: colors.textSecondary, flexShrink: 1, fontSize: 14 },
});
