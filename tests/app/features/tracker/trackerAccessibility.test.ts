import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { AccessibilityInfo, findNodeHandle, View } from "react-native";

import { focusRefIfAvailable } from "../../../../src/features/tracker/trackerAccessibility";

jest.mock("react-native/Libraries/ReactNative/RendererProxy", () => ({
  findNodeHandle: jest.fn(),
}));

const mockedFindNodeHandle = findNodeHandle as jest.MockedFunction<typeof findNodeHandle>;
const setAccessibilityFocus = jest.spyOn(AccessibilityInfo, "setAccessibilityFocus").mockImplementation(() => undefined);

test.each([
  ["missing ref", undefined, undefined],
  ["null ref", null, undefined],
  ["unmounted ref", createRef<View>(), undefined],
] as const)("does nothing for %s", (_name, ref, _unused) => {
  focusRefIfAvailable(ref);

  expect(mockedFindNodeHandle).not.toHaveBeenCalled();
  expect(setAccessibilityFocus).not.toHaveBeenCalled();
});

test.each([
  ["null tag", null],
  ["string tag", "17"],
  ["NaN tag", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
] as const)("looks up once but does not focus a current ref with a %s", (_name, nativeTag) => {
  const ref = { current: {} as View };
  mockedFindNodeHandle.mockReturnValueOnce(nativeTag as never);

  focusRefIfAvailable(ref);

  expect(mockedFindNodeHandle).toHaveBeenCalledTimes(1);
  expect(mockedFindNodeHandle).toHaveBeenCalledWith(ref.current);
  expect(setAccessibilityFocus).not.toHaveBeenCalled();
});

test.each([0, 42, -7])("focuses finite numeric native tag %s exactly once", (nativeTag) => {
  const ref = { current: {} as View };
  mockedFindNodeHandle.mockReturnValueOnce(nativeTag);

  focusRefIfAvailable(ref);

  expect(mockedFindNodeHandle).toHaveBeenCalledTimes(1);
  expect(setAccessibilityFocus).toHaveBeenCalledTimes(1);
  expect(setAccessibilityFocus).toHaveBeenCalledWith(nativeTag);
});

test.each([
  { name: "no-call path", nativeTag: null },
  { name: "focus call path", nativeTag: 42 },
])("performs no timer, retry, or deferred work on the $name", ({ nativeTag }) => {
  const ref = { current: {} as View };
  const timeout = jest.spyOn(global, "setTimeout");
  const interval = jest.spyOn(global, "setInterval");
  const microtask = jest.spyOn(global, "queueMicrotask");
  const immediate = jest.spyOn(global, "setImmediate");
  const animationFrame = typeof global.requestAnimationFrame === "function"
    ? jest.spyOn(global, "requestAnimationFrame")
    : null;
  mockedFindNodeHandle.mockReturnValueOnce(nativeTag);

  focusRefIfAvailable(ref);

  expect(mockedFindNodeHandle).toHaveBeenCalledTimes(1);
  expect(timeout).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();
  expect(microtask).not.toHaveBeenCalled();
  expect(immediate).not.toHaveBeenCalled();
  if (animationFrame) expect(animationFrame).not.toHaveBeenCalled();
});

test("keeps the focus helper statically synchronous and single-shot", () => {
  const source = readFileSync(
    join(process.cwd(), "src/features/tracker/trackerAccessibility.ts"),
    "utf8",
  );
  expect(source).not.toMatch(/\b(?:Promise|async|await|setImmediate|requestAnimationFrame|setTimeout|setInterval|queueMicrotask)\b/);
  expect(source.match(/findNodeHandle\s*\(/g)).toHaveLength(1);
  expect(source.match(/setAccessibilityFocus\s*\(/g)).toHaveLength(1);
});
