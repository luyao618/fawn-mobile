import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type {
  BabyProfileSnapshot,
  OptionalBabyProfileSnapshot,
} from "../../application/profile/babyProfileService";
import { formatExactAge } from "../../domain/baby/age";
import {
  BabyProfileValidationError,
  type BabyProfile,
  type BabyProfileField,
  type BabyProfileInput,
  type BabySex,
} from "../../domain/baby/profile";
import { colors, radius, spacing } from "../../shared/theme/tokens";
import { AppFrame } from "../../shared/ui/AppFrame";
import { InlineNotice } from "../../shared/ui/InlineNotice";
import { useBabyProfileService } from "./BabyProfileServiceContext";
import { useActiveLocalDayRefresh } from "./useActiveLocalDayRefresh";

type Draft = Readonly<{
  name: string;
  sex: BabySex | null;
  birthDate: string;
  birthWeightG: string;
  birthHeightCm: string;
  birthHeadCm: string;
  isPremature: boolean | null;
  gestationalWeeks: string;
}>;

const emptyDraft: Draft = Object.freeze({
  name: "",
  sex: null,
  birthDate: "",
  birthWeightG: "",
  birthHeightCm: "",
  birthHeadCm: "",
  isPremature: null,
  gestationalWeeks: "",
});

const validationMessages: Readonly<Record<BabyProfileField, string>> = Object.freeze({
  name: "宝宝姓名最多 200 个字符。",
  sex: "请选择男孩、女孩或暂不填。",
  birthDate: "请输入有效的 YYYY-MM-DD，且不能晚于今天。",
  birthWeightG: "出生体重需为 100–10000 克的整数。",
  birthHeightCm: "出生身长需在 10–100 厘米之间。",
  birthHeadCm: "出生头围需在 10–80 厘米之间。",
  isPremature: "请选择足月或早产。",
  gestationalWeeks: "出生孕周需为 20–45 周的整数。",
  createdAt: "宝宝资料时间无效，请重新读取。",
  updatedAt: "宝宝资料已更新，请重新读取后再保存。",
});

function draftFromProfile(profile: BabyProfile | null): Draft {
  if (!profile) return emptyDraft;
  return Object.freeze({
    name: profile.name ?? "",
    sex: profile.sex,
    birthDate: profile.birthDate ?? "",
    birthWeightG: profile.birthWeightG === null ? "" : String(profile.birthWeightG),
    birthHeightCm: profile.birthHeightCm === null ? "" : String(profile.birthHeightCm),
    birthHeadCm: profile.birthHeadCm === null ? "" : String(profile.birthHeadCm),
    isPremature: profile.isPremature,
    gestationalWeeks: profile.gestationalWeeks === null ? "" : String(profile.gestationalWeeks),
  });
}

function nullableNumber(value: string): number | null {
  if (value.trim().length === 0) return null;
  return Number(value);
}

function inputFromDraft(draft: Draft, isPremature: boolean): BabyProfileInput {
  return Object.freeze({
    name: draft.name,
    sex: draft.sex,
    birthDate: draft.birthDate.trim().length === 0 ? null : draft.birthDate,
    birthWeightG: nullableNumber(draft.birthWeightG),
    birthHeightCm: nullableNumber(draft.birthHeightCm),
    birthHeadCm: nullableNumber(draft.birthHeadCm),
    isPremature,
    gestationalWeeks: nullableNumber(draft.gestationalWeeks),
  });
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" allowFontScaling style={styles.error}>{message}</Text>;
}

function LabeledInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  error,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric" | "decimal-pad";
  error?: string;
}) {
  return (
    <View style={styles.field}>
      <Text allowFontScaling style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        allowFontScaling
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, error ? styles.inputError : null]}
        value={value}
      />
      <FieldError message={error} />
    </View>
  );
}

function RadioGroup<T extends string | boolean | null>({
  label,
  options,
  selected,
  onSelect,
  error,
}: {
  label: string;
  options: readonly Readonly<{ value: T; label: string; accessibilityLabel: string }>[];
  selected: T;
  onSelect: (value: T) => void;
  error?: string;
}) {
  return (
    <View style={styles.field}>
      <Text allowFontScaling style={styles.label}>{label}</Text>
      <View accessibilityRole="radiogroup" style={styles.radioGroup}>
        {options.map((option) => {
          const checked = option.value === selected;
          return (
            <Pressable
              accessibilityLabel={option.accessibilityLabel}
              accessibilityRole="radio"
              accessibilityState={{ checked }}
              key={option.accessibilityLabel}
              onPress={() => onSelect(option.value)}
              style={({ pressed }) => [
                styles.radio,
                checked ? styles.radioSelected : null,
                error ? styles.radioError : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text allowFontScaling style={[styles.radioText, checked ? styles.radioTextSelected : null]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <FieldError message={error} />
    </View>
  );
}

type ProfileLoadMode = "replaceDraft" | "refreshCommitted";

export function BabyProfileScreen() {
  const service = useBabyProfileService();
  const [snapshot, setSnapshot] = useState<OptionalBabyProfileSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const loadGeneration = useRef(0);
  const replaceLoadInFlight = useRef(false);
  const hasCommittedSnapshot = useRef(false);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<BabyProfileField, string>>>({});

  const load = useCallback((mode: ProfileLoadMode) => {
    if (mode === "refreshCommitted" && replaceLoadInFlight.current) return;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    const replaceDraft = mode === "replaceDraft" || !hasCommittedSnapshot.current;
    if (mode === "replaceDraft") {
      replaceLoadInFlight.current = true;
      setLoadState("loading");
    }
    void service.load().then((loaded) => {
      if (loadGeneration.current !== generation) return;
      if (mode === "replaceDraft") replaceLoadInFlight.current = false;
      setSnapshot(loaded);
      if (replaceDraft) {
        setDraft(draftFromProfile(loaded.profile));
        setErrors({});
        setSaveMessage(null);
      }
      hasCommittedSnapshot.current = true;
      setLoadState("ready");
    }).catch(() => {
      if (loadGeneration.current !== generation) return;
      if (mode === "replaceDraft") replaceLoadInFlight.current = false;
      if (mode === "replaceDraft" || !hasCommittedSnapshot.current) {
        setLoadState("error");
      }
    });
  }, [service]);

  useFocusEffect(useCallback(() => {
    load("replaceDraft");
    return () => {
      loadGeneration.current += 1;
      replaceLoadInFlight.current = false;
    };
  }, [load]));

  const refreshCommitted = useCallback(() => load("refreshCommitted"), [load]);
  useActiveLocalDayRefresh(refreshCommitted);

  const updateDraft = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft((current) => Object.freeze({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveMessage(null);
  };

  const save = useCallback(() => {
    if (savingRef.current) return;
    if (draft.isPremature === null) {
      setErrors({ isPremature: validationMessages.isPremature });
      setSaveMessage("请检查标出的资料后再保存。");
      return;
    }
    const isPremature = draft.isPremature;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setSaveMessage(null);
    loadGeneration.current += 1;
    void service.save(inputFromDraft(draft, isPremature), snapshot?.profile?.updatedAt ?? null).then((saved: BabyProfileSnapshot) => {
      loadGeneration.current += 1;
      setSnapshot(saved);
      setDraft(draftFromProfile(saved.profile));
      hasCommittedSnapshot.current = true;
      setSaveMessage("宝宝资料已保存");
    }).catch((error: unknown) => {
      if (error instanceof BabyProfileValidationError) {
        setErrors({ [error.field]: validationMessages[error.field] });
        setSaveMessage("请检查标出的资料后再保存。");
      } else if (error instanceof Error && error.name === "RepositoryConflictError") {
        setSaveMessage("宝宝资料已在其他位置更新，请重新读取后再保存。");
      } else {
        setSaveMessage("保存失败，本机资料没有更改。");
      }
    }).finally(() => {
      savingRef.current = false;
      setSaving(false);
    });
  }, [draft, service, snapshot?.profile?.updatedAt]);

  const age = snapshot ? formatExactAge(snapshot.exactAge) : null;
  return (
    <AppFrame localOnly title="我的">
      <View style={styles.headingGroup}>
        <Text accessibilityRole="header" allowFontScaling style={styles.sectionTitle}>宝宝资料</Text>
        <Text allowFontScaling style={styles.description}>资料只保存在本机；其他项目可以暂不填写，出生状态需选择足月或早产。</Text>
      </View>

      {loadState === "loading" ? (
        <Text accessibilityLiveRegion="polite" allowFontScaling style={styles.stateText}>正在读取宝宝资料…</Text>
      ) : null}
      {loadState === "error" ? (
        <View style={styles.errorSurface}>
          <InlineNotice>暂时无法读取宝宝资料。本机数据没有更改。</InlineNotice>
          <Pressable
            accessibilityRole="button"
            onPress={() => load("replaceDraft")}
            style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
          >
            <Text allowFontScaling style={styles.secondaryButtonText}>重新读取宝宝资料</Text>
          </Pressable>
        </View>
      ) : null}

      {loadState === "ready" ? (
        <>
          <View style={styles.summary}>
            <Text allowFontScaling style={styles.summaryName}>{snapshot?.profile?.name ?? "宝宝档案"}</Text>
            <Text allowFontScaling style={styles.summaryAge}>{age ?? "出生日期待填"}</Text>
          </View>

          <View style={styles.form}>
            <LabeledInput
              error={errors.name}
              label="宝宝姓名"
              onChangeText={(value) => updateDraft("name", value)}
              placeholder="可暂不填"
              value={draft.name}
            />
            <LabeledInput
              error={errors.birthDate}
              label="出生日期"
              onChangeText={(value) => updateDraft("birthDate", value)}
              placeholder="例如 2024-02-29"
              value={draft.birthDate}
            />
            <RadioGroup
              label="性别"
              onSelect={(value) => updateDraft("sex", value)}
              options={[
                { value: null, label: "暂不填", accessibilityLabel: "性别暂不填" },
                { value: "male", label: "男孩", accessibilityLabel: "性别男孩" },
                { value: "female", label: "女孩", accessibilityLabel: "性别女孩" },
              ]}
              selected={draft.sex}
            />
            <View style={styles.measurements}>
              <LabeledInput
                error={errors.birthWeightG}
                keyboardType="numeric"
                label="出生体重（克）"
                onChangeText={(value) => updateDraft("birthWeightG", value)}
                placeholder="100–10000"
                value={draft.birthWeightG}
              />
              <LabeledInput
                error={errors.birthHeightCm}
                keyboardType="decimal-pad"
                label="出生身长（厘米）"
                onChangeText={(value) => updateDraft("birthHeightCm", value)}
                placeholder="10–100"
                value={draft.birthHeightCm}
              />
              <LabeledInput
                error={errors.birthHeadCm}
                keyboardType="decimal-pad"
                label="出生头围（厘米）"
                onChangeText={(value) => updateDraft("birthHeadCm", value)}
                placeholder="10–80"
                value={draft.birthHeadCm}
              />
            </View>
            <RadioGroup
              error={errors.isPremature}
              label="出生状态"
              onSelect={(value) => updateDraft("isPremature", value)}
              options={[
                { value: false, label: "足月", accessibilityLabel: "足月" },
                { value: true, label: "早产", accessibilityLabel: "早产" },
              ]}
              selected={draft.isPremature}
            />
            <LabeledInput
              error={errors.gestationalWeeks}
              keyboardType="numeric"
              label="出生孕周（周）"
              onChangeText={(value) => updateDraft("gestationalWeeks", value)}
              placeholder="20–45，可暂不填"
              value={draft.gestationalWeeks}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saving }}
              disabled={saving}
              onPress={save}
              style={({ pressed }) => [styles.saveButton, pressed && !saving ? styles.saveButtonPressed : null, saving ? styles.disabled : null]}
            >
              <Text allowFontScaling style={styles.saveButtonText}>保存宝宝资料</Text>
            </Pressable>
            {saving ? <Text accessibilityLiveRegion="polite" allowFontScaling style={styles.stateText}>正在保存…</Text> : null}
            {saveMessage ? <Text accessibilityLiveRegion="polite" allowFontScaling style={styles.saveMessage}>{saveMessage}</Text> : null}
          </View>
        </>
      ) : null}
    </AppFrame>
  );
}

const styles = StyleSheet.create({
  description: { color: colors.textSecondary, fontSize: 16 },
  disabled: { opacity: 0.65 },
  error: { color: colors.danger, fontSize: 14 },
  errorSurface: { gap: spacing.md },
  field: { flex: 1, gap: spacing.xs, minWidth: 180 },
  form: { gap: spacing.lg, paddingBottom: spacing.xl },
  headingGroup: { gap: spacing.xs, marginBottom: spacing.lg },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  inputError: { borderColor: colors.danger },
  label: { color: colors.textPrimary, fontSize: 14, fontWeight: "600" },
  measurements: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  pressed: { backgroundColor: colors.surfaceSubtle },
  radio: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 88,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  radioGroup: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  radioError: { borderColor: colors.danger },
  radioSelected: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
  radioText: { color: colors.textPrimary, fontSize: 16 },
  radioTextSelected: { color: colors.brandStrong, fontWeight: "600" },
  saveButton: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.control,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  saveButtonPressed: { backgroundColor: colors.brandStrong },
  saveButtonText: { color: colors.surface, fontSize: 16, fontWeight: "600" },
  saveMessage: { color: colors.textPrimary, fontSize: 14 },
  secondaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: colors.brand,
    borderRadius: radius.control,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: { color: colors.brandStrong, fontSize: 16, fontWeight: "600" },
  sectionTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
  stateText: { color: colors.textSecondary, fontSize: 14 },
  summary: {
    backgroundColor: colors.surfaceSubtle,
    borderColor: colors.border,
    borderRadius: radius.surface,
    borderWidth: 1,
    gap: spacing.xs,
    marginBottom: spacing.xl,
    padding: spacing.md,
  },
  summaryAge: { color: colors.textSecondary, fontSize: 16 },
  summaryName: { color: colors.textPrimary, fontSize: 18, fontWeight: "600" },
});
