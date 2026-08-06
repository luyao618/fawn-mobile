import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AlphaChatFailure } from "../../application/chat/alphaChatService";
import { colors, radius, spacing } from "../../shared/theme/tokens";
import { InlineNotice } from "../../shared/ui/InlineNotice";
import { useOptionalModelSettingsService } from "../settings/model/ModelSettingsServiceContext";
import { useOptionalChatService } from "./ChatServiceContext";

type ChatMessage = Readonly<{ id: number; role: "user" | "assistant"; content: string }>;
type Readiness = "loading" | "configured" | "missing" | "error";

export function AlphaChatPanel() {
  const modelSettings = useOptionalModelSettingsService();
  const chat = useOptionalChatService();
  const [readiness, setReadiness] = useState<Readiness>("loading");
  const [modelId, setModelId] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadReadiness = useCallback(async () => {
    if (!modelSettings || !chat) {
      setReadiness("missing");
      return;
    }
    setReadiness("loading");
    try {
      const settings = await modelSettings.load();
      if (!mounted.current) return;
      setModelId(settings?.config.modelId ?? "");
      setReadiness(settings ? "configured" : "missing");
    } catch {
      if (mounted.current) setReadiness("error");
    }
  }, [chat, modelSettings]);

  useFocusEffect(useCallback(() => {
    void loadReadiness();
  }, [loadReadiness]));

  if (!modelSettings || !chat) return null;

  const append = (role: ChatMessage["role"], content: string) => {
    nextId.current += 1;
    const message = Object.freeze({ id: nextId.current, role, content });
    setMessages((current) => Object.freeze([...current, message]));
  };

  const send = () => {
    const question = draft.trim();
    if (!question || busy) return;
    append("user", question);
    setDraft("");
    setError(null);
    setBusy(true);
    void chat.send(question).then((answer) => {
      if (!mounted.current) return;
      append("assistant", answer.content);
      setModelId(answer.modelId);
    }).catch((failure: unknown) => {
      if (!mounted.current) return;
      if (failure instanceof AlphaChatFailure && failure.code === "not_configured") {
        setReadiness("missing");
        setError("模型设置已不可用，请在“我的”中重新配置。");
      } else if (failure instanceof AlphaChatFailure && failure.code === "invalid_question") {
        setError("请输入较短的问题后重试。");
      } else {
        setError("暂时无法获得回答，请检查模型设置和网络后重试。");
      }
    }).finally(() => {
      if (mounted.current) setBusy(false);
    });
  };

  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" allowFontScaling style={styles.title}>问问管家</Text>
        <Text allowFontScaling style={styles.description}>回答会使用宝宝资料和最多 20 条最近记录。</Text>
      </View>
      <InlineNotice>内部 Alpha，仅供参考，不替代专业医疗建议。</InlineNotice>
      {readiness === "loading" ? <Text accessibilityLiveRegion="polite" allowFontScaling style={styles.stateText}>正在读取模型设置…</Text> : null}
      {readiness === "missing" ? <Text allowFontScaling style={styles.stateText}>请先在“我的”中配置模型连接。</Text> : null}
      {readiness === "error" ? (
        <View style={styles.errorState}>
          <Text accessibilityRole="alert" allowFontScaling style={styles.errorText}>模型设置暂不可用。</Text>
          <Pressable accessibilityRole="button" onPress={() => { void loadReadiness(); }} style={styles.secondaryButton}>
            <Text allowFontScaling style={styles.secondaryButtonText}>重新读取模型设置</Text>
          </Pressable>
        </View>
      ) : null}
      {readiness === "configured" ? (
        <>
          <Text allowFontScaling style={styles.modelLabel}>当前模型: {modelId}</Text>
          <View accessibilityLabel="当前聊天" style={styles.messages}>
            {messages.length === 0 ? <Text allowFontScaling style={styles.emptyText}>还没有消息。可以从宝宝年龄或最近记录开始提问。</Text> : null}
            {messages.map((message) => (
              <View key={message.id} style={[styles.message, message.role === "user" ? styles.userMessage : styles.assistantMessage]}>
                <Text allowFontScaling style={styles.messageRole}>{message.role === "user" ? "你" : "管家"}</Text>
                <Text allowFontScaling selectable style={styles.messageText}>{message.content}</Text>
              </View>
            ))}
          </View>
          <View style={styles.composer}>
            <TextInput
              accessibilityLabel="给管家的问题"
              allowFontScaling
              editable={!busy}
              maxLength={2000}
              multiline
              onChangeText={(value) => { setDraft(value); setError(null); }}
              placeholder="例如：结合最近记录，我今天需要留意什么？"
              placeholderTextColor={colors.textSecondary}
              style={[styles.input, busy ? styles.disabled : null]}
              value={draft}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || !draft.trim() }}
              disabled={busy || !draft.trim()}
              onPress={send}
              style={({ pressed }) => [styles.sendButton, pressed && !busy ? styles.sendPressed : null, busy || !draft.trim() ? styles.disabled : null]}
            >
              <Text allowFontScaling style={styles.sendText}>{busy ? "正在回答…" : "发送"}</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {error ? <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" allowFontScaling style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  assistantMessage: { alignSelf: "stretch", backgroundColor: colors.surface },
  composer: { gap: spacing.sm },
  description: { color: colors.textSecondary, fontSize: 16 },
  disabled: { opacity: 0.6 },
  emptyText: { color: colors.textSecondary, fontSize: 15 },
  errorState: { gap: spacing.sm },
  errorText: { color: colors.danger, fontSize: 14 },
  heading: { gap: spacing.xs },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.small, borderWidth: 1, color: colors.textPrimary, fontSize: 16, maxHeight: 160, minHeight: 88, padding: spacing.md, textAlignVertical: "top" },
  message: { borderColor: colors.border, borderRadius: radius.small, borderWidth: 1, gap: spacing.xs, maxWidth: "92%", padding: spacing.md },
  messageRole: { color: colors.textSecondary, fontSize: 12, fontWeight: "700" },
  messages: { gap: spacing.sm },
  messageText: { color: colors.textPrimary, fontSize: 16, lineHeight: 24 },
  modelLabel: { color: colors.sage, fontSize: 14, fontWeight: "600" },
  secondaryButton: { alignItems: "center", alignSelf: "flex-start", borderColor: colors.brand, borderRadius: radius.small, borderWidth: 1, justifyContent: "center", minHeight: 44, paddingHorizontal: spacing.md },
  secondaryButtonText: { color: colors.brandStrong, fontSize: 16, fontWeight: "600" },
  section: { borderTopColor: colors.border, borderTopWidth: 1, gap: spacing.md, marginTop: spacing.xl, paddingTop: spacing.xl },
  sendButton: { alignItems: "center", alignSelf: "flex-end", backgroundColor: colors.brand, borderRadius: radius.small, justifyContent: "center", minHeight: 48, minWidth: 96, paddingHorizontal: spacing.lg },
  sendPressed: { backgroundColor: colors.brandStrong },
  sendText: { color: colors.surface, fontSize: 16, fontWeight: "700" },
  stateText: { color: colors.textSecondary, fontSize: 14 },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
  userMessage: { alignSelf: "flex-end", backgroundColor: colors.brandSoft },
});
