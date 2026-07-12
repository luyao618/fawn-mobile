import assert from "node:assert/strict";
import { ESLint } from "eslint";
import test from "node:test";

const eslint = new ESLint({ overrideConfigFile: "eslint.config.js" });

async function restricted(filePath: string, specifier: string) {
  const [result] = await eslint.lintText(`import value from ${JSON.stringify(specifier)};\nvoid value;`, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
}

async function assertRestricted(filePath: string, specifier: string) {
  assert((await restricted(filePath, specifier)).length >= 1, `${filePath} allowed ${specifier}`);
}

const layers = ["App.tsx", "src/shared/probe.ts", "src/features/probe.ts", "src/navigation/probe.ts", "src/application/probe.ts", "src/domain/probe.ts"];
const prefixOnly = ["node:sea", "node:sqlite", "node:test", "node:test/reporters"];

test("every production category rejects Node 22's exact prefix-only built-ins", async () => {
  for (const filePath of layers) for (const specifier of prefixOnly) await assertRestricted(filePath, specifier);
});

test("every production category rejects spike roots, descendants, aliases, and package aliases", async () => {
  const specifiers = [
    "./spikes", "../spikes", "../spikes/probe", "@/spikes", "@/spikes/probe",
    "@fawn-mobile/slice0-device-proof", "@fawn-mobile/slice0-device-proof/index.ts", "@fawn-mobile/slice0-device-proof/deep/module",
  ];
  for (const filePath of layers) for (const specifier of specifiers) await assertRestricted(filePath, specifier);
});

test("application and domain reject all Expo, React Native, React, and React Navigation package families", async () => {
  const packages = [
    "expo", "expo-sqlite", "expo/config-plugins", "@expo/config-plugins", "@expo/plist",
    "react-native", "react-native-safe-area-context", "react-native/Libraries/Linking/Linking",
    "react", "react-test-renderer", "react/jsx-runtime",
    "@react-navigation/native",
  ];
  for (const filePath of ["src/application/probe.ts", "src/domain/probe.ts"]) {
    for (const specifier of packages) await assertRestricted(filePath, specifier);
  }
});

test("features and navigation reject infrastructure category roots, descendants, aliases, and native Expo bypasses", async () => {
  const categoryBypasses = ["../infrastructure", "../infrastructure/db", "@/infrastructure", "@/infrastructure/db"];
  const packageBypasses = ["expo-sqlite", "expo-file-system/next", "@expo/config-plugins", "@expo/plist"];
  for (const filePath of ["src/features/probe.ts", "src/navigation/probe.ts"]) {
    for (const specifier of [...categoryBypasses, ...packageBypasses]) await assertRestricted(filePath, specifier);
  }
});

test("application rejects feature and infrastructure category roots, descendants, and aliases", async () => {
  for (const segment of ["features", "infrastructure"]) {
    for (const specifier of [`../${segment}`, `../${segment}/probe`, `@/${segment}`, `@/${segment}/probe`]) {
      await assertRestricted("src/application/probe.ts", specifier);
    }
  }
});

test("domain rejects every outward category root, descendant, and alias-prefixed barrel", async () => {
  for (const segment of ["application", "infrastructure", "features", "navigation", "shared", "testing"]) {
    for (const specifier of [`../${segment}`, `../${segment}/probe`, `@/${segment}`, `@/${segment}/probe`]) {
      await assertRestricted("src/domain/probe.ts", specifier);
    }
  }
});

test("valid current layer directions remain available after flat-config composition", async () => {
  assert.equal((await restricted("src/features/probe.ts", "react-native")).length, 0);
  assert.equal((await restricted("src/navigation/probe.ts", "@react-navigation/native")).length, 0);
  assert.equal((await restricted("src/application/probe.ts", "../shared/types")).length, 0);
  assert.equal((await restricted("src/domain/probe.ts", "./value")).length, 0);
});
