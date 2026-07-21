import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const requestGeneration = useRef(0);
  const appliedGeneration = useRef(0);
  const ageRefreshFailureGeneration = useRef(0);
  const focusSession = useRef(0);
  const replaceLoadInFlight = useRef<Promise<void> | null>(null);
  const hasCommittedSnapshot = useRef(false);
  const mountedRef = useRef(true);
  const [ageRefreshFailed, setAgeRefreshFailed] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback((): Promise<void> => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const session = focusSession.current;
    setLoadState("loading");
    let operation!: Promise<void>;
    operation = service.load().then((loaded) => {
      if (!mountedRef.current || focusSession.current !== session || generation < appliedGeneration.current) return;
      appliedGeneration.current = generation;
      setSnapshot(loaded);
      hasCommittedSnapshot.current = true;
      const newerAgeRefreshFailed = generation < ageRefreshFailureGeneration.current;
      if (!newerAgeRefreshFailed) ageRefreshFailureGeneration.current = 0;
      setAgeRefreshFailed(newerAgeRefreshFailed);
      setLoadState("ready");
    }).catch(() => {
      if (!mountedRef.current || focusSession.current !== session || generation < appliedGeneration.current) return;
      setSnapshot(null);
      hasCommittedSnapshot.current = false;
      setLoadState("error");
    }).finally(() => {
      if (replaceLoadInFlight.current === operation) replaceLoadInFlight.current = null;
    });
    replaceLoadInFlight.current = operation;
    return operation;
  }, [service]);

  useFocusEffect(useCallback(() => {
    focusSession.current += 1;
    void load();
    return () => {
      focusSession.current += 1;
      replaceLoadInFlight.current = null;
    };
  }, [load]));

  const refreshCommitted = useCallback(async (): Promise<void> => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const session = focusSession.current;
    const replaceOperation = replaceLoadInFlight.current;
    let loaded: OptionalBabyProfileSnapshot;
    try {
      loaded = await service.load();
    } catch (error) {
      if (mountedRef.current && focusSession.current === session && generation >= appliedGeneration.current) {
        ageRefreshFailureGeneration.current = generation;
        if (hasCommittedSnapshot.current) setAgeRefreshFailed(true);
      }
      throw error;
    }
    if (replaceOperation) await replaceOperation;
    if (!mountedRef.current || focusSession.current !== session) return;
    if (!hasCommittedSnapshot.current) {
      ageRefreshFailureGeneration.current = generation;
      throw new Error("A committed profile snapshot is required for an age refresh.");
    }
    if (generation < appliedGeneration.current) return;
    appliedGeneration.current = generation;
    setSnapshot(loaded);
    ageRefreshFailureGeneration.current = 0;
    setAgeRefreshFailed(false);
    setLoadState("ready");
  }, [service]);
  useActiveLocalDayRefresh(refreshCommitted);

  const profileStatus = loadState === "error" ? "读取失败" : loadState === "loading" ? "读取中" : snapshot?.profile ? "已保存" : "未设置";
  const ageStatus = loadState === "error"
    ? "暂不可用"
    : loadState === "loading"
      ? "读取中"
      : ageRefreshFailed
        ? "暂不可用"
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

export const GrowthScreen = () => <DestinationScreen description="有真实的本地记录后，成长信息才会显示在这里。" heading="还没有可展示的成长数据" title="成长" />;
export const AlbumScreen = () => <DestinationScreen description="照片导入功能尚未启用，当前不会请求相册权限。" heading="还没有照片" title="相册" />;

const styles = StyleSheet.create({
  readiness: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.surface, borderWidth: 1, marginVertical: spacing.sm },
  row: { alignItems: "flex-start", flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, justifyContent: "space-between", minHeight: 52, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rowLabel: { color: colors.textPrimary, flexShrink: 1, fontSize: 16 },
  rowStatus: { color: colors.textSecondary, flexShrink: 1, fontSize: 14 },
});
