import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ModelConfigValidationError } from "../../../domain/model/config";
import { colors, radius, spacing } from "../../../shared/theme/tokens";
import { InlineNotice } from "../../../shared/ui/InlineNotice";
import { useOptionalModelSettingsService } from "./ModelSettingsServiceContext";

type LoadState = "loading" | "ready" | "error";

function SettingInput({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  disabled,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  disabled: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text allowFontScaling style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        allowFontScaling
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        secureTextEntry={secureTextEntry}
        style={[styles.input, disabled ? styles.disabled : null]}
        value={value}
      />
    </View>
  );
}

export function ModelSettingsPanel() {
  const service = useOptionalModelSettingsService();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const savedToken = useRef<string | undefined>(undefined);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!service) return;
    setLoadState("loading");
    try {
      const settings = await service.load();
      if (!mounted.current) return;
      setBaseUrl(settings?.config.baseUrl ?? "");
      setModelId(settings?.config.modelId ?? "");
      setApiKey("");
      savedToken.current = settings?.secrets.bearerToken;
      setConfigured(settings !== null);
      setConfirmClear(false);
      setLoadState("ready");
    } catch {
      if (mounted.current) setLoadState("error");
    }
  }, [service]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  if (!service) return null;

  const save = () => {
    if (busy) return;
    const token = apiKey || savedToken.current;
    if (!token) {
      setMessage("请输入 API Key。");
      return;
    }
    setBusy(true);
    setMessage(null);
    void service.save({
      displayName: "默认模型",
      baseUrl,
      modelId,
      authMode: "bearer",
    }, { bearerToken: token }, new Date().toISOString()).then((settings) => {
      if (!mounted.current) return;
      savedToken.current = settings.secrets.bearerToken;
      setBaseUrl(settings.config.baseUrl);
      setModelId(settings.config.modelId);
      setApiKey("");
      setConfigured(true);
      setConfirmClear(false);
      setMessage("模型设置已保存在本机");
    }).catch((error: unknown) => {
      if (!mounted.current) return;
      setMessage(error instanceof ModelConfigValidationError ? "请检查 Base URL 和模型 ID。" : "保存失败，本机设置没有更改。");
    }).finally(() => {
      if (mounted.current) setBusy(false);
    });
  };

  const clear = () => {
    if (busy) return;
    if (!confirmClear) {
      setConfirmClear(true);
      setMessage("再次点击以确认清除模型设置。");
      return;
    }
    setBusy(true);
    setMessage(null);
    void service.clear(new Date().toISOString()).then(() => {
      if (!mounted.current) return;
      savedToken.current = undefined;
      setBaseUrl("");
      setModelId("");
      setApiKey("");
      setConfigured(false);
      setConfirmClear(false);
      setMessage("模型设置已清除");
    }).catch(() => {
      if (mounted.current) setMessage("清除失败，请稍后重试。");
    }).finally(() => {
      if (mounted.current) setBusy(false);
    });
  };

  const disabled = busy || loadState !== "ready";
  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" allowFontScaling style={styles.title}>模型连接</Text>
        <Text allowFontScaling style={styles.description}>用于管家问答。API Key 只保存在本机安全存储中。</Text>
      </View>

      {loadState === "loading" ? <Text accessibilityLiveRegion="polite" allowFontScaling style={styles.stateText}>正在读取模型设置…</Text> : null}
      {loadState === "error" ? (
        <View style={styles.errorState}>
          <InlineNotice>暂时无法读取模型设置。已保存的密钥不会显示。</InlineNotice>
          <Pressable accessibilityRole="button" onPress={() => { void load(); }} style={styles.secondaryButton}>
            <Text allowFontScaling style={styles.secondaryButtonText}>重新读取模型设置</Text>
          </Pressable>
        </View>
      ) : null}

      {loadState === "ready" ? (
        <View style={styles.form}>
          <SettingInput disabled={disabled} label="Base URL" onChangeText={(value) => { setBaseUrl(value); setMessage(null); }} placeholder="https://api.example.com/v1" value={baseUrl} />
          <SettingInput disabled={disabled} label="模型 ID" onChangeText={(value) => { setModelId(value); setMessage(null); }} placeholder="模型名称" value={modelId} />
          <SettingInput
            disabled={disabled}
            label="API Key"
            onChangeText={(value) => { setApiKey(value); setMessage(null); }}
            placeholder={configured ? "留空以保留已保存密钥" : "输入 API Key"}
            secureTextEntry
            value={apiKey}
          />
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={save}
              style={({ pressed }) => [styles.primaryButton, pressed && !disabled ? styles.primaryPressed : null, disabled ? styles.disabled : null]}
            >
              <Text allowFontScaling style={styles.primaryButtonText}>{busy ? "正在保存…" : "保存模型设置"}</Text>
            </Pressable>
            {configured ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={clear}
                style={({ pressed }) => [styles.clearButton, confirmClear ? styles.clearConfirm : null, pressed && !disabled ? styles.pressed : null, disabled ? styles.disabled : null]}
              >
                <Text allowFontScaling style={styles.clearButtonText}>{confirmClear ? "确认清除" : "清除设置"}</Text>
              </Pressable>
            ) : null}
          </View>
          {message ? <Text accessibilityLiveRegion="polite" allowFontScaling style={styles.message}>{message}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { alignItems: "stretch", flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  clearButton: { alignItems: "center", borderColor: colors.border, borderRadius: radius.small, borderWidth: 1, justifyContent: "center", minHeight: 48, paddingHorizontal: spacing.md },
  clearButtonText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
  clearConfirm: { borderColor: colors.danger },
  description: { color: colors.textSecondary, fontSize: 16 },
  disabled: { opacity: 0.65 },
  errorState: { gap: spacing.md },
  field: { gap: spacing.xs },
  form: { gap: spacing.md },
  heading: { gap: spacing.xs },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.small, borderWidth: 1, color: colors.textPrimary, fontSize: 16, minHeight: 48, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  label: { color: colors.textPrimary, fontSize: 14, fontWeight: "600" },
  message: { color: colors.textPrimary, fontSize: 14 },
  pressed: { backgroundColor: colors.surfaceSubtle },
  primaryButton: { alignItems: "center", backgroundColor: colors.brand, borderRadius: radius.small, justifyContent: "center", minHeight: 48, paddingHorizontal: spacing.lg },
  primaryButtonText: { color: colors.surface, fontSize: 16, fontWeight: "600" },
  primaryPressed: { backgroundColor: colors.brandStrong },
  secondaryButton: { alignItems: "center", alignSelf: "flex-start", borderColor: colors.brand, borderRadius: radius.small, borderWidth: 1, justifyContent: "center", minHeight: 44, paddingHorizontal: spacing.md },
  secondaryButtonText: { color: colors.brandStrong, fontSize: 16, fontWeight: "600" },
  section: { borderBottomColor: colors.border, borderBottomWidth: 1, gap: spacing.lg, marginBottom: spacing.xl, paddingBottom: spacing.xl },
  stateText: { color: colors.textSecondary, fontSize: 14 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
});
