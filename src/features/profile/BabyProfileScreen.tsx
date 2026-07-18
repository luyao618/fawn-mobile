import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
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
  disabled = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric" | "decimal-pad";
  error?: string;
  disabled?: boolean;
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
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, error ? styles.inputError : null, disabled ? styles.disabled : null]}
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
  disabled = false,
}: {
  label: string;
  options: readonly Readonly<{ value: T; label: string; accessibilityLabel: string }>[];
  selected: T;
  onSelect: (value: T) => void;
  error?: string;
  disabled?: boolean;
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
              accessibilityState={{ checked, disabled }}
              disabled={disabled}
              key={option.accessibilityLabel}
              onPress={() => onSelect(option.value)}
              style={({ pressed }) => [
                styles.radio,
                checked ? styles.radioSelected : null,
                error ? styles.radioError : null,
                pressed && !disabled ? styles.pressed : null,
                disabled ? styles.disabled : null,
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

export function BabyProfileScreen() {
  const service = useBabyProfileService();
  const [snapshot, setSnapshot] = useState<OptionalBabyProfileSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const requestGeneration = useRef(0);
  const appliedGeneration = useRef(0);
  const replacementBarrierGeneration = useRef(0);
  const ageRefreshFailureGeneration = useRef(0);
  const focusSession = useRef(0);
  const replaceLoadInFlight = useRef<Promise<void> | null>(null);
  const hasCommittedSnapshot = useRef(false);
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const refreshDeferredBySave = useRef(false);
  const [saving, setSaving] = useState(false);
  const [ageRefreshFailed, setAgeRefreshFailed] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<BabyProfileField, string>>>({});

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
      if (
        !mountedRef.current
        || focusSession.current !== session
        || generation < appliedGeneration.current
        || generation < replacementBarrierGeneration.current
      ) return;
      appliedGeneration.current = generation;
      setSnapshot(loaded);
      setDraft(draftFromProfile(loaded.profile));
      setErrors({});
      setSaveMessage(null);
      hasCommittedSnapshot.current = true;
      const newerAgeRefreshFailed = generation < ageRefreshFailureGeneration.current;
      if (!newerAgeRefreshFailed) ageRefreshFailureGeneration.current = 0;
      setAgeRefreshFailed(newerAgeRefreshFailed);
      setLoadState("ready");
    }).catch(() => {
      if (
        !mountedRef.current
        || focusSession.current !== session
        || generation < appliedGeneration.current
        || generation < replacementBarrierGeneration.current
      ) return;
      setLoadState("error");
    }).finally(() => {
      if (replaceLoadInFlight.current === operation) replaceLoadInFlight.current = null;
    });
    replaceLoadInFlight.current = operation;
    return operation;
  }, [service]);

  const deferRefreshUntilSaveSettles = useCallback((): never => {
    refreshDeferredBySave.current = true;
    ageRefreshFailureGeneration.current = Math.max(
      ageRefreshFailureGeneration.current,
      requestGeneration.current + 1,
    );
    if (mountedRef.current && hasCommittedSnapshot.current) setAgeRefreshFailed(true);
    throw new Error("Age refresh deferred until profile save settles.");
  }, []);

  const refreshCommitted = useCallback(async (): Promise<void> => {
    if (savingRef.current) deferRefreshUntilSaveSettles();
    refreshDeferredBySave.current = false;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const session = focusSession.current;
    const replaceOperation = replaceLoadInFlight.current;
    let loaded: OptionalBabyProfileSnapshot;
    try {
      loaded = await service.load();
    } catch (error) {
      if (savingRef.current) deferRefreshUntilSaveSettles();
      if (mountedRef.current && focusSession.current === session && generation >= appliedGeneration.current) {
        ageRefreshFailureGeneration.current = generation;
        if (hasCommittedSnapshot.current) setAgeRefreshFailed(true);
      }
      throw error;
    }
    if (savingRef.current) deferRefreshUntilSaveSettles();
    if (replaceOperation) await replaceOperation;
    if (!mountedRef.current || focusSession.current !== session) return;
    if (!hasCommittedSnapshot.current) {
      ageRefreshFailureGeneration.current = generation;
      throw new Error("A committed profile snapshot is required for an age refresh.");
    }
    if (generation < appliedGeneration.current) return;
    appliedGeneration.current = generation;
    setSnapshot((current) => current === null ? current : Object.freeze({
      profile: current.profile,
      exactAge: loaded.exactAge,
    }));
    ageRefreshFailureGeneration.current = 0;
    setAgeRefreshFailed(false);
    setLoadState("ready");
  }, [deferRefreshUntilSaveSettles, service]);
  const requestAgeRefresh = useActiveLocalDayRefresh(refreshCommitted);

  useFocusEffect(useCallback(() => {
    focusSession.current += 1;
    if (savingRef.current) {
      refreshDeferredBySave.current = true;
    } else {
      void load();
    }
    return () => {
      focusSession.current += 1;
      replaceLoadInFlight.current = null;
    };
  }, [load]));

  const updateDraft = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    if (savingRef.current) return;
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
    requestGeneration.current += 1;
    replacementBarrierGeneration.current = requestGeneration.current;
    void service.save(inputFromDraft(draft, isPremature), snapshot?.profile?.updatedAt ?? null).then((saved: BabyProfileSnapshot) => {
      if (!mountedRef.current) return;
      const refreshPending = refreshDeferredBySave.current;
      requestGeneration.current += 1;
      appliedGeneration.current = requestGeneration.current;
      setSnapshot(saved);
      setDraft(draftFromProfile(saved.profile));
      hasCommittedSnapshot.current = true;
      if (!refreshPending) {
        ageRefreshFailureGeneration.current = 0;
        setAgeRefreshFailed(false);
      }
      setLoadState("ready");
      setSaveMessage("宝宝资料已保存");
    }).catch((error: unknown) => {
      if (!mountedRef.current) return;
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
      if (!mountedRef.current) return;
      setSaving(false);
      if (refreshDeferredBySave.current) requestAgeRefresh();
    });
  }, [draft, requestAgeRefresh, service, snapshot?.profile?.updatedAt]);

  const age = !ageRefreshFailed && snapshot ? formatExactAge(snapshot.exactAge) : null;
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
            onPress={() => { void load(); }}
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
            <Text allowFontScaling style={styles.summaryAge}>{ageRefreshFailed ? "年龄暂不可用" : age ?? "出生日期待填"}</Text>
          </View>

          <View style={styles.form}>
            <LabeledInput
              disabled={saving}
              error={errors.name}
              label="宝宝姓名"
              onChangeText={(value) => updateDraft("name", value)}
              placeholder="可暂不填"
              value={draft.name}
            />
            <LabeledInput
              disabled={saving}
              error={errors.birthDate}
              label="出生日期"
              onChangeText={(value) => updateDraft("birthDate", value)}
              placeholder="例如 2024-02-29"
              value={draft.birthDate}
            />
            <RadioGroup
              disabled={saving}
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
                disabled={saving}
                error={errors.birthWeightG}
                keyboardType="numeric"
                label="出生体重（克）"
                onChangeText={(value) => updateDraft("birthWeightG", value)}
                placeholder="100–10000"
                value={draft.birthWeightG}
              />
              <LabeledInput
                disabled={saving}
                error={errors.birthHeightCm}
                keyboardType="decimal-pad"
                label="出生身长（厘米）"
                onChangeText={(value) => updateDraft("birthHeightCm", value)}
                placeholder="10–100"
                value={draft.birthHeightCm}
              />
              <LabeledInput
                disabled={saving}
                error={errors.birthHeadCm}
                keyboardType="decimal-pad"
                label="出生头围（厘米）"
                onChangeText={(value) => updateDraft("birthHeadCm", value)}
                placeholder="10–80"
                value={draft.birthHeadCm}
              />
            </View>
            <RadioGroup
              disabled={saving}
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
              disabled={saving}
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
