import type { Component, RefObject } from "react";
import { AccessibilityInfo, findNodeHandle } from "react-native";

export type TrackerFocusRef<T extends Component> = RefObject<T | null>;

export function focusRefIfAvailable<T extends Component>(
  ref: TrackerFocusRef<T> | null | undefined,
): void {
  if (ref?.current == null) return;
  const nativeTag = findNodeHandle(ref.current);
  if (typeof nativeTag === "number" && Number.isFinite(nativeTag)) {
    AccessibilityInfo.setAccessibilityFocus(nativeTag);
  }
}
