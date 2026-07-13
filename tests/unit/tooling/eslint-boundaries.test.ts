import assert from "node:assert/strict";
import { ESLint } from "eslint";
import test from "node:test";

const eslint = new ESLint({ overrideConfigFile: "eslint.config.js" });
const sourceExtensions = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"] as const;

const sourceProbes = [
  "App.tsx",
  "index.ts",
  "src/shared/nested/probe.ts",
  "src/features/nested/probe.ts",
  "src/navigation/nested/probe.ts",
  "src/application/nested/probe.ts",
  "src/domain/nested/probe.ts",
  "src/infrastructure/nested/probe.ts",
  "src/testing/nested/probe.ts",
] as const;

async function ruleMessages(filePath: string, source: string, ruleId: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter((message) => message.ruleId === ruleId);
}

async function restrictedImport(filePath: string, specifier: string) {
  return ruleMessages(
    filePath,
    `import value from ${JSON.stringify(specifier)};\nvoid value;`,
    "no-restricted-imports",
  );
}

async function assertRestrictedImport(filePath: string, specifier: string) {
  assert((await restrictedImport(filePath, specifier)).length >= 1, `${filePath} allowed ${specifier}`);
}

async function assertAllowedImport(filePath: string, specifier: string) {
  assert.equal((await restrictedImport(filePath, specifier)).length, 0, `${filePath} rejected ${specifier}`);
}

function categorySpecifiers(segment: string) {
  return [
    `../${segment}`,
    `../../${segment}/deep/module`,
    `@/${segment}`,
    `@/${segment}/deep/module`,
    `src/${segment}/deep/module`,
  ];
}

test("every production source category rejects Node built-ins and spike roots, descendants, and aliases", async () => {
  const specifiers = [
    "node:sea",
    "node:sqlite",
    "node:test",
    "node:test/reporters",
    "./spikes",
    "../../spikes/probe",
    "@/spikes",
    "@/spikes/deep/probe",
    "@fawn-mobile/slice0-device-proof",
    "@fawn-mobile/slice0-device-proof/deep/module",
  ];
  for (const filePath of sourceProbes) {
    for (const specifier of specifiers) await assertRestrictedImport(filePath, specifier);
  }
});

test("every production source category rejects non-static module loading", async () => {
  const probes = [
    { label: "require()", source: 'const value = require("./local");\nvoid value;' },
    { label: "require identifier alias", source: 'const load = require;\nvoid load("./local");' },
    { label: "sequence require", source: 'void (0, require)("./local");' },
    { label: "Reflect require", source: 'void Reflect.apply(require, undefined, ["./local"]);' },
    { label: "require.resolve()", source: 'void require.resolve("./local");' },
    { label: "require.resolveWeak()", source: 'void require.resolveWeak("./local");' },
    { label: "require.call()", source: 'void require.call(undefined, "./local");' },
    { label: "module.require()", source: 'void module.require("./local");' },
    { label: "module computed require", source: 'void module["require"]("./local");' },
    { label: "global.require()", source: 'void global.require("./local");' },
    { label: "global computed require", source: 'void global["require"]("./local");' },
    { label: "globalThis.require()", source: 'void globalThis.require("./local");' },
    { label: "aliased module require", source: 'const load = module.require;\nvoid load("./local");' },
    { label: "Reflect module require", source: 'void Reflect.apply(module["require"], module, ["./local"]);' },
    { label: "TypeScript require import", source: 'import value = require("./local");\nvoid value;' },
    { label: "dynamic import()", source: 'void import("./local");' },
  ];
  for (const filePath of sourceProbes) {
    for (const probe of probes) {
      const messages = await ruleMessages(filePath, probe.source, "no-restricted-syntax");
      assert(messages.length >= 1, `${filePath} allowed ${probe.label}`);
    }
  }
});

test("TypeScript import types cannot bypass static layer boundaries", async () => {
  for (const extension of ["ts", "tsx", "mts", "cts"] as const) {
    const filePath = `src/domain/nested/probe.${extension}`;
    const messages = await ruleMessages(
      filePath,
      'type Runtime = import("../../infrastructure/runtime").Runtime;\nvoid (0 as unknown as Runtime);',
      "no-restricted-syntax",
    );
    assert(messages.length >= 1, `${filePath} allowed TSImportType`);
  }
});

test("eval and Function-constructor loading remain rejected", async () => {
  for (const filePath of sourceProbes) {
    assert((await ruleMessages(filePath, 'eval("require(\\\"./local\\\")");', "no-eval")).length >= 1, `${filePath} allowed eval()`);
    assert(
      (await ruleMessages(filePath, 'void new Function("return require(\\\"./local\\\")")();', "no-new-func")).length >= 1,
      `${filePath} allowed new Function()`,
    );
  }
});

test("base and layer restrictions apply to every JavaScript and TypeScript source extension", async () => {
  for (const extension of sourceExtensions) {
    await assertRestrictedImport(`src/domain/nested/probe.${extension}`, "../../shared/value");
    await assertRestrictedImport(`src/features/nested/probe.${extension}`, "../../navigation/RootNavigator");
    const requireMessages = await ruleMessages(
      `src/testing/nested/probe.${extension}`,
      'const load = require;\nvoid load("node:test");',
      "no-restricted-syntax",
    );
    assert(requireMessages.length >= 1, `.${extension} source escaped non-static import policy`);
  }
});

test("application and domain reject all Expo, React Native, React, and React Navigation package families", async () => {
  const packages = [
    "expo",
    "expo-sqlite",
    "expo/config-plugins",
    "@expo/config-plugins",
    "@expo/plist",
    "react-native",
    "react-native-safe-area-context",
    "react-native/Libraries/Linking/Linking",
    "react",
    "react-test-renderer",
    "react/jsx-runtime",
    "@react-navigation/native",
  ];
  for (const filePath of ["src/application/nested/probe.ts", "src/domain/nested/probe.ts"]) {
    for (const specifier of packages) await assertRestrictedImport(filePath, specifier);
  }
});

test("the complete source-side layer matrix rejects roots, nested paths, and alias paths", async () => {
  const forbiddenByLayer = {
    shared: ["application", "domain", "features", "infrastructure", "navigation", "testing"],
    features: ["infrastructure", "navigation", "testing"],
    navigation: ["infrastructure", "testing"],
    application: ["features", "infrastructure", "navigation", "testing"],
    domain: ["application", "features", "infrastructure", "navigation", "shared", "testing"],
    infrastructure: ["features", "navigation", "testing"],
  } as const;

  for (const [layer, forbiddenTargets] of Object.entries(forbiddenByLayer)) {
    const filePath = `src/${layer}/nested/probe.ts`;
    for (const target of forbiddenTargets) {
      for (const specifier of categorySpecifiers(target)) await assertRestrictedImport(filePath, specifier);
    }
  }
});

test("features cannot import navigation while navigation can compose features", async () => {
  for (const specifier of categorySpecifiers("navigation")) {
    await assertRestrictedImport("src/features/nested/probe.ts", specifier);
  }
  for (const specifier of ["../features", "../../features/deep/screen", "@/features/deep/screen"]) {
    await assertAllowedImport("src/navigation/nested/probe.ts", specifier);
  }
});

test("all production layers reject testing leakage while composition roots retain static composition access", async () => {
  const productionLayers = ["shared", "features", "navigation", "application", "domain", "infrastructure"];
  for (const layer of productionLayers) {
    const filePath = `src/${layer}/nested/probe.ts`;
    for (const specifier of categorySpecifiers("testing")) {
      await assertRestrictedImport(filePath, specifier);
    }
    await assertRestrictedImport(filePath, "@for-mobile/fault-controller");
  }
  await assertAllowedImport("App.tsx", "@for-mobile/fault-controller");
  await assertAllowedImport("App.tsx", "./src/testing/faultContract");
  await assertAllowedImport("App.tsx", "./src/infrastructure/db/openDatabase");
  await assertAllowedImport("index.ts", "./src/testing/FaultController.production");
});

test("valid inward directions and required platform adapters remain available", async () => {
  const allowedByLayer: Record<string, string[]> = {
    "src/shared/nested/probe.ts": ["../../shared/theme/tokens", "react", "react-native"],
    "src/features/nested/probe.ts": ["../../shared/ui/AppFrame", "../../application/useCase", "../../domain/model", "react-native"],
    "src/navigation/nested/probe.ts": ["../../features/screen", "../../application/useCase", "../../domain/model", "../../shared/theme/tokens", "@react-navigation/native"],
    "src/application/nested/probe.ts": ["../../domain/model", "../../shared/value"],
    "src/domain/nested/probe.ts": ["./value"],
    "src/infrastructure/nested/probe.ts": ["../../application/port", "../../domain/model", "../../shared/value", "expo-sqlite", "react-native"],
    "src/testing/nested/probe.ts": ["../faultContract", "react-native"],
    "App.tsx": ["./src/navigation/RootNavigator", "./src/testing/faultContract", "react-native-safe-area-context"],
    "index.ts": ["./App", "expo"],
  };
  for (const [filePath, specifiers] of Object.entries(allowedByLayer)) {
    for (const specifier of specifiers) await assertAllowedImport(filePath, specifier);
  }
});
