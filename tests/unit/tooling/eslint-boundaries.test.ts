import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { readFile } from "node:fs/promises";
import test from "node:test";

const eslint = new ESLint({ overrideConfigFile: "eslint.config.js" });
const sourceExtensions = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"] as const;
const trackerSourceGlob = `src/features/tracker/**/*.{${sourceExtensions.join(",")}}`;
const trackerConflictSyntax = [
  {
    selector: "Literal[value='RepositoryConflictError']",
    message: "Tracker features must not mention an infrastructure error class name.",
  },
  {
    selector: "TemplateElement[value.raw='RepositoryConflictError']",
    message: "Tracker features must not mention an infrastructure error class name in a template.",
  },
  {
    selector: ":matches(TSPropertySignature[key.name='code'], TSPropertySignature[computed=true][key.value='code'])",
    message: "Tracker features must not declare structural conflict-code shapes.",
  },
  {
    selector: "TSLiteralType > Literal[value='code']",
    message: "Tracker features must not declare structural conflict-code keys.",
  },
  {
    selector: ":matches(TSAsExpression, TSTypeAssertion) > TSTypeReference[typeName.name=/^(Record|ManualTrackerConflictError)$/]",
    message: "Tracker features must not assert unknown errors to structural or nominal conflict types.",
  },
  {
    selector: ":matches(MemberExpression[property.name='code'], MemberExpression[computed=true][property.value='code'])[object.type=/^(TSAsExpression|TSTypeAssertion)$/]",
    message: "Tracker features must not cast unknown errors to guess conflict codes.",
  },
  {
    selector: "BinaryExpression[operator='in'][left.value='code']",
    message: "Tracker features must not structurally probe unknown errors for conflict codes.",
  },
  {
    selector: "MemberExpression[computed=true][property.value='code']",
    message: "Tracker features must not inspect conflict codes through computed properties.",
  },
  {
    selector: "CallExpression[callee.object.name='Object'][callee.property.name='hasOwn'][arguments.1.value='code']",
    message: "Tracker features must not use Object.hasOwn to guess conflict-code shapes.",
  },
  {
    selector: "CallExpression[callee.property.name='hasOwnProperty'][arguments.0.value='code']",
    message: "Tracker features must not use hasOwnProperty to guess conflict-code shapes.",
  },
  {
    selector: "CallExpression[callee.property.name='call'][callee.object.property.name='hasOwnProperty'][arguments.1.value='code']",
    message: "Tracker features must not call hasOwnProperty to guess conflict-code shapes.",
  },
  {
    selector: "CallExpression[callee.object.name='Reflect'][callee.property.name='has'][arguments.1.value='code']",
    message: "Tracker features must not use Reflect.has to guess conflict-code shapes.",
  },
] as const;
const trackerConflictEslint = new ESLint({
  errorOnUnmatchedPattern: false,
  overrideConfigFile: "eslint.config.js",
  overrideConfig: [{
    files: [trackerSourceGlob],
    rules: { "no-restricted-syntax": ["error", ...trackerConflictSyntax] },
  }],
});

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

async function trackerConflictMessages(source: string) {
  const [result] = await trackerConflictEslint.lintText(source, { filePath: "src/features/tracker/probe.ts" });
  return result.messages.filter((message) => message.ruleId === "no-restricted-syntax");
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

test("all Metro-resolved App and index variants reject bounded runtime loader surfaces", async () => {
  const rootVariants = ["App", "App.android", "App.ios", "App.native", "index", "index.android", "index.ios", "index.native"];
  const probes = [
    ["direct __r", "void __r(1);"],
    ["direct __d", "void __d;"],
    ["direct __c", "const clear = __c; void clear;"],
    ["nativeRequire alias", "const load = nativeRequire; void load(1);"],
    ["global member", "const load = global.__r; void load(1);"],
    ["globalThis computed", 'const load = globalThis["__r"]; void load(1);'],
    ["computed nativeRequire", 'void global["nativeRequire"](1);'],
    ["Reflect.get", 'const load = Reflect.get(globalThis, "__d"); void load(1);'],
    ["Reflect.apply", "void Reflect.apply(nativeRequire, globalThis, [1]);"],
  ] as const;
  for (const rootVariant of rootVariants) {
    for (const extension of sourceExtensions) {
      const filePath = `${rootVariant}.${extension}`;
      for (const [label, source] of probes) {
        const messages = await ruleMessages(filePath, source, "no-restricted-syntax");
        assert(messages.length >= 1, `${filePath} allowed ${label}`);
      }
    }
  }
});

test("bounded loader policy ignores inert comments and strings", async () => {
  const messages = await ruleMessages(
    "App.native.tsx",
    'const documentation = "globalThis[\\"__r\\"]";\n/* nativeRequire(1) */\nvoid documentation;',
    "no-restricted-syntax",
  );
  assert.equal(messages.length, 0);
});

test("npm lint enumerates every Metro-resolved App and index platform variant", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(packageJson.scripts.lint, /App\{,\.android,\.ios,\.native}/);
  assert.match(packageJson.scripts.lint, /index\{,\.android,\.ios,\.native}/);
  for (const extension of sourceExtensions) assert(packageJson.scripts.lint.includes(extension));
  assert(packageJson.scripts.lint.includes("eslint.config.js"));
  assert(packageJson.scripts.lint.includes("tests/unit/tooling"));
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

test("application and features cannot import repository conflict details", async () => {
  for (const filePath of ["src/application/nested/probe.ts", "src/features/nested/probe.ts"]) {
    for (const specifier of [
      "../../infrastructure/db/repositories/conflicts",
      "@/infrastructure/db/repositories/conflicts",
      "src/infrastructure/db/repositories/conflicts",
    ]) {
      await assertRestrictedImport(filePath, specifier);
    }
  }
});

test("tracker features classify conflicts only through the application guard", async () => {
  const rejected = [
    'if (error instanceof Error && error.name === "RepositoryConflictError") {}',
    'if (error["name"] === "RepositoryConflictError") {}',
    'if ("RepositoryConflictError" === error.name) {}',
    'if ("RepositoryConflictError" === error["name"]) {}',
    'if ((error as { code?: string }).code === "stale_write") {}',
    'if (typeof error === "object" && error !== null && "code" in error && error.code === "not_found") {}',
    'const candidate = error as { code?: string }; candidate.code === "stale_write";',
    'const { code } = error as { code?: string }; code === "stale_write";',
    'const { name } = error as Error; name === "RepositoryConflictError";',
    'const className = `RepositoryConflictError`; error.name === className;',
    'type ConflictLike = { code?: string }; const candidate = error as ConflictLike; candidate.code === "stale_write";',
    'const candidate = error as Record<string, unknown>; candidate["code"] === "stale_write";',
    'const candidate = error as Record<"code", string>; candidate.code === "stale_write";',
    'Object.hasOwn(error as object, "code");',
    'error.hasOwnProperty("code");',
    'Object.prototype.hasOwnProperty.call(error, "code");',
    'Reflect.has(error as object, "code");',
    'const candidate = error as ManualTrackerConflictError; candidate.code === "stale_write";',
  ];
  for (const source of rejected) {
    assert((await trackerConflictMessages(source)).length >= 1, `tracker feature policy allowed ${source}`);
  }

  const approved = `function handle(value: unknown) {
    if (isManualTrackerConflictError(value)) {
      void (value.code === "stale_write" || value.code === "not_found");
    }
  }`;
  assert.equal((await trackerConflictMessages(approved)).length, 0);

  const sourceResults = await trackerConflictEslint.lintFiles([trackerSourceGlob]);
  const violations = sourceResults.flatMap((result) => result.messages
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => `${result.filePath}:${message.line}:${message.column} ${message.message}`));
  assert.deepEqual(violations, []);
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
