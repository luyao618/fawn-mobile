import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { OptionalBabyProfileSnapshot } from "../../application/profile/babyProfileService";
import { formatExactAge } from "../../domain/baby/age";
import { useBabyProfileService } from "../profile/BabyProfileServiceContext";
import { useActiveLocalDayRefresh } from "../profile/useActiveLocalDayRefresh";
import { colors, radius, spacing } from "../../shared/theme/tokens";
import { AppFrame } from "../../shared/ui/AppFrame";
import { EmptyState } from "../../shared/ui/EmptyState";
import { InlineNotice } from "../../shared/ui/InlineNotice";

function ReadinessRow({ label, status }: { label: string; status: string }) {
  return (
    <View style={styles.row}>
      <Text allowFontScaling style={styles.rowLabel}>{label}</Text>
      <Text allowFontScaling style={styles.rowStatus}>{status}</Text>
    </View>
  );
}

export function StewardScreen() {
  const service = useBabyProfileService();
  const [snapshot, setSnapshot] = useState<OptionalBabyProfileSnapshot | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const loadGeneration = useRef(0);
  const focusLoadInFlight = useRef(false);
  const load = useCallback((showLoading: boolean) => {
    if (!showLoading && focusLoadInFlight.current) return;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    if (showLoading) {
      focusLoadInFlight.current = true;
      setSnapshot(null);
      setLoadState("loading");
    }
    void service.load().then((loaded) => {
      if (loadGeneration.current !== generation) return;
      if (showLoading) focusLoadInFlight.current = false;
      setSnapshot(loaded);
      setLoadState("ready");
    }).catch(() => {
      if (loadGeneration.current !== generation) return;
      if (showLoading) focusLoadInFlight.current = false;
      if (!showLoading) return;
      setSnapshot(null);
      setLoadState("error");
    });
  }, [service]);

  useFocusEffect(useCallback(() => {
    load(true);
    return () => {
      loadGeneration.current += 1;
      focusLoadInFlight.current = false;
    };
  }, [load]));

  const refreshCommitted = useCallback(() => load(false), [load]);
  useActiveLocalDayRefresh(refreshCommitted);

  const profileStatus = loadState === "error" ? "读取失败" : loadState === "loading" ? "读取中" : snapshot?.profile ? "已保存" : "未设置";
  const ageStatus = loadState === "error"
    ? "暂不可用"
    : loadState === "loading"
      ? "读取中"
      : formatExactAge(snapshot?.exactAge ?? {
        status: "unknown",
        reason: "birth_date_missing",
        localDate: "",
        timeZone: "",
      }) ?? "出生日期待填";
  return (
    <AppFrame localOnly title="管家">
      <EmptyState
        description={snapshot?.profile ? "宝宝资料已从本机读取；模型连接尚未设置。" : "填写宝宝资料后，可在这里查看准确的本地年龄状态。"}
        title={snapshot?.profile ? "宝宝资料已保存在本机" : "照护空间尚未设置"}
      >
        <View style={styles.readiness}>
          <ReadinessRow label="宝宝资料" status={profileStatus} />
          <ReadinessRow label="宝宝年龄" status={ageStatus} />
          <ReadinessRow label="模型连接" status="未设置" />
        </View>
        <InlineNotice>宝宝资料只从本机读取；当前页面不会发送宝宝数据。</InlineNotice>
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

const styles = StyleSheet.create({
  readiness: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.surface, borderWidth: 1, marginVertical: spacing.sm },
  row: { alignItems: "flex-start", flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, justifyContent: "space-between", minHeight: 52, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rowLabel: { color: colors.textPrimary, flexShrink: 1, fontSize: 16 },
  rowStatus: { color: colors.textSecondary, flexShrink: 1, fontSize: 14 },
});
