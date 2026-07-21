import { createContext, useContext, useState, type ReactNode, type Ref } from "react";
import {
  Pressable,
  type KeyboardTypeOptions,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";

import { colors, radius, spacing } from "../../shared/theme/tokens";

export type TrackerFormErrors = Readonly<Partial<Record<string, string>>>;
export type TrackerInputField =
  | "measurementDate"
  | "weightG"
  | "heightCm"
  | "headCm"
  | "notes"
  | "feedTimeDate"
  | "feedTime"
  | "amountMl"
  | "durationMin"
  | "sleepStartDate"
  | "sleepStart"
  | "sleepEndDate"
  | "sleepEnd"
  | "nightWakings"
  | "diaperTimeDate"
  | "diaperTime"
  | "recordDate"
  | "title"
  | "description";
export type TrackerRadioField = "feedType" | "sleepType" | "diaperType" | "recordType";
export type TrackerInputRefs = Readonly<Partial<Record<TrackerInputField, Ref<TextInput>>>>;
export type TrackerGroupRefs = Readonly<Partial<Record<TrackerRadioField, Ref<View>>>>;
export type TrackerInputSubmitConfig = Readonly<{
  onSubmitEditing?: TextInputProps["onSubmitEditing"];
  returnKeyType?: TextInputProps["returnKeyType"];
}>;
export type TrackerInputSubmitMap = Readonly<Partial<Record<TrackerInputField, TrackerInputSubmitConfig>>>;

export type TrackerErrorAnnouncement = Readonly<{ id: number; message: string }>;
const TrackerErrorAnnouncementContext = createContext<TrackerErrorAnnouncement | null | undefined>(undefined);

export function TrackerErrorAnnouncementScope({
  announcement,
  children,
}: Readonly<{
  announcement: TrackerErrorAnnouncement | null;
  children: ReactNode;
}>) {
  return (
    <TrackerErrorAnnouncementContext.Provider value={announcement}>
      {children}
    </TrackerErrorAnnouncementContext.Provider>
  );
}

type InputProps = Readonly<{
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  inputRef?: Ref<TextInput>;
  keyboardType?: KeyboardTypeOptions;
  label: string;
  onChangeText: (value: string) => void;
  onSubmitEditing?: TextInputProps["onSubmitEditing"];
  placeholder?: string;
  returnKeyType?: TextInputProps["returnKeyType"];
  submitBehavior?: TextInputProps["submitBehavior"];
  value: string;
}>;

export function FieldError({ message }: { message?: string }) {
  const announcement = useContext(TrackerErrorAnnouncementContext);
  if (!message) return null;
  const announce = announcement === undefined || announcement?.message === message;
  return (
    <Text
      accessibilityLiveRegion={announce ? "assertive" : undefined}
      accessibilityRole={announce ? "alert" : undefined}
      allowFontScaling
      key={announcement && announce ? announcement.id : undefined}
      style={styles.error}
    >
      {message}
    </Text>
  );
}

export function TrackerFieldHint({ children }: { children: string }) {
  return <Text allowFontScaling style={styles.hint}>{children}</Text>;
}

function TrackerTextField({
  busy = false,
  disabled = false,
  error,
  inputRef,
  keyboardType = "default",
  label,
  multiline,
  onChangeText,
  onSubmitEditing,
  placeholder,
  returnKeyType,
  submitBehavior,
  value,
}: InputProps & Readonly<{ multiline: boolean }>) {
  const unavailable = disabled || busy;
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text allowFontScaling style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityState={{ busy, disabled: unavailable }}
        allowFontScaling
        autoCapitalize="none"
        autoCorrect={false}
        editable={!unavailable}
        keyboardType={keyboardType}
        multiline={multiline}
        onBlur={() => setFocused(false)}
        onChangeText={(nextValue) => {
          if (!unavailable) onChangeText(nextValue);
        }}
        onFocus={() => setFocused(true)}
        onSubmitEditing={(event) => {
          if (!unavailable) onSubmitEditing?.(event);
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        ref={inputRef}
        returnKeyType={returnKeyType}
        submitBehavior={submitBehavior}
        style={[
          styles.input,
          multiline ? styles.multilineInput : null,
          error ? styles.inputError : null,
          focused ? styles.focused : null,
          unavailable ? styles.disabled : null,
        ]}
        textAlignVertical={multiline ? "top" : "center"}
        value={value}
      />
      <FieldError message={error} />
    </View>
  );
}

export function LabeledTextInput(props: InputProps) {
  return <TrackerTextField {...props} multiline={false} />;
}

export function LabeledMultilineInput(props: Omit<InputProps, "keyboardType">) {
  return <TrackerTextField {...props} keyboardType="default" multiline />;
}

export type TrackerRadioOption<T extends string> = Readonly<{
  label: string;
  value: T;
}>;

export function LabeledRadioGroup<T extends string>({
  busy = false,
  disabled = false,
  error,
  groupRef,
  label,
  onSelect,
  options,
  selected,
}: Readonly<{
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  groupRef?: Ref<View>;
  label: string;
  onSelect: (value: T) => void;
  options: readonly TrackerRadioOption<T>[];
  selected: T | "";
}>) {
  const unavailable = disabled || busy;
  const [focusedValue, setFocusedValue] = useState<T | null>(null);
  return (
    <View style={styles.field}>
      <Text allowFontScaling style={styles.label}>{label}</Text>
      <View
        accessibilityLabel={label}
        accessibilityRole="radiogroup"
        style={styles.radioGroup}
      >
        {options.map((option, index) => {
          const checked = selected === option.value;
          return (
            <Pressable
              accessibilityLabel={`${label}${option.label}`}
              accessibilityRole="radio"
              accessibilityState={{ busy, checked, disabled: unavailable }}
              disabled={unavailable}
              key={option.value}
              onBlur={() => setFocusedValue((current) => current === option.value ? null : current)}
              onFocus={() => setFocusedValue(option.value)}
              onPress={() => onSelect(option.value)}
              ref={index === 0 ? groupRef : undefined}
              style={({ pressed }) => [
                styles.radio,
                checked ? styles.radioSelected : null,
                error ? styles.radioError : null,
                focusedValue === option.value ? styles.focused : null,
                pressed && !unavailable ? styles.pressed : null,
                unavailable ? styles.disabled : null,
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

type TrackerActionProps = Readonly<{
  actionRef?: Ref<View>;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}>;

function TrackerAction({
  actionRef,
  busy = false,
  disabled = false,
  label,
  onPress,
  tone,
}: TrackerActionProps & Readonly<{ tone: "primary" | "secondary" | "destructive" }>) {
  const unavailable = disabled || busy;
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: unavailable }}
      disabled={unavailable}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onPress={onPress}
      ref={actionRef}
      style={({ pressed }) => [
        styles.action,
        tone === "primary" ? styles.primaryAction : null,
        tone === "secondary" ? styles.secondaryAction : null,
        tone === "destructive" ? styles.destructiveAction : null,
        focused ? styles.focused : null,
        pressed && !unavailable && tone === "primary" ? styles.primaryPressed : null,
        pressed && !unavailable && tone !== "primary" ? styles.pressed : null,
        unavailable ? styles.disabled : null,
      ]}
    >
      <Text
        allowFontScaling
        style={[
          styles.actionText,
          tone === "primary" ? styles.primaryActionText : null,
          tone === "secondary" ? styles.secondaryActionText : null,
          tone === "destructive" ? styles.destructiveActionText : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function PrimaryAction(props: TrackerActionProps) {
  return <TrackerAction {...props} tone="primary" />;
}

export function SecondaryAction(props: TrackerActionProps) {
  return <TrackerAction {...props} tone="secondary" />;
}

export function DestructiveAction(props: TrackerActionProps) {
  return <TrackerAction {...props} tone="destructive" />;
}

export const trackerFormLayoutStyles = StyleSheet.create({
  fieldPair: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  form: { gap: spacing.lg },
});

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    borderRadius: radius.control,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  actionText: { fontSize: 16, fontWeight: "600", textAlign: "center" },
  destructiveAction: { borderColor: colors.danger, borderWidth: 1 },
  destructiveActionText: { color: colors.danger },
  disabled: { opacity: 0.65 },
  error: { color: colors.danger, fontSize: 14 },
  field: { flex: 1, gap: spacing.xs, minWidth: 180 },
  focused: { borderColor: colors.focus },
  hint: { color: colors.textSecondary, fontSize: 14 },
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
  multilineInput: { minHeight: 112 },
  pressed: { backgroundColor: colors.surfaceSubtle },
  primaryAction: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
    borderWidth: 1,
    minHeight: 48,
  },
  primaryActionText: { color: colors.surface },
  primaryPressed: { backgroundColor: colors.brandStrong },
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
  radioError: { borderColor: colors.danger },
  radioGroup: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  radioSelected: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
  radioText: { color: colors.textPrimary, fontSize: 16, textAlign: "center" },
  radioTextSelected: { color: colors.brandStrong, fontWeight: "600" },
  secondaryAction: { borderColor: colors.brand, borderWidth: 1 },
  secondaryActionText: { color: colors.brandStrong },
});
