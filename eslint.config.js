import { builtinModules } from "node:module";

import expoConfig from "eslint-config-expo/flat.js";

const typescriptParser = expoConfig.find((config) => config.languageOptions?.parser?.meta?.name === "typescript-eslint/parser").languageOptions.parser;
const prefixOnlyNodeBuiltins = ["node:sea", "node:sqlite", "node:test", "node:test/reporters"];
const nodeBuiltins = [...new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...prefixOnlyNodeBuiltins,
])];
const spikeAlias = "@fawn-mobile/slice0-device-proof";
const faultControllerAlias = "@for-mobile/fault-controller";
const basePaths = [
  ...nodeBuiltins.map((name) => ({ name, message: "Node built-ins are not available in mobile production code." })),
  { name: spikeAlias, message: "The workspace spike package is not available in mobile production code." },
];
const testingAliasPath = {
  name: faultControllerAlias,
  message: "Only a composition root may import the flavor-selected fault controller.",
};
const sourceExtensions = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";

function categoryPatterns(...segments) {
  return segments.flatMap((segment) => [
    segment,
    `./${segment}`,
    `../${segment}`,
    `**/${segment}`,
    `${segment}/**`,
    `./${segment}/**`,
    `../${segment}/**`,
    `**/${segment}/**`,
  ]);
}

const basePatterns = [
  { group: categoryPatterns("spikes"), message: "Production code must not import spike proofs." },
  { group: [`${spikeAlias}/**`], message: "Workspace spike alias subpaths are not available in mobile production code." },
];
const platformPackagePaths = ["expo", "react-native", "react"].map((name) => ({
  name,
  message: "Platform and React package families are forbidden in this layer.",
}));
const platformPackagePatterns = [{
  group: [
    "expo-*", "expo-*/**", "expo/**", "@expo/**",
    "react-native-*", "react-native-*/**", "react-native/**",
    "@react-native/**", "@react-native-*/**",
    "react-*", "react-*/**", "react/**",
    "@react-navigation/**",
  ],
  message: "Platform, React, and React Navigation package families are forbidden in this layer.",
}];
const expoNativePatterns = [{
  group: ["expo", "expo-*", "expo-*/**", "expo/**", "@expo/**"],
  message: "React components cannot bypass infrastructure through Expo native packages.",
}];
const nonStaticImportSyntax = [
  "error",
  {
    selector: "Identifier[name='require']",
    message: "Production code must not reference require; use statically analyzable imports.",
  },
  {
    selector: "MemberExpression[computed=true][property.value='require']",
    message: "Production code must not access require through a computed property.",
  },
  {
    selector: "TSImportEqualsDeclaration",
    message: "Production code must use ECMAScript imports instead of TypeScript require imports.",
  },
  {
    selector: "ImportExpression",
    message: "Production code must not use dynamic import().",
  },
  {
    selector: "TSImportType",
    message: "Production code must not load layer types through import() syntax.",
  },
];

function restrictedImports(paths = [], patterns = []) {
  return ["error", { paths: [...basePaths, ...paths], patterns: [...basePatterns, ...patterns] }];
}

function categoryRestriction(message, ...segments) {
  return { group: categoryPatterns(...segments), message };
}

export default [
  ...expoConfig,
  {
    ignores: [
      "android/**",
      "ios/**",
      ".artifacts/**",
      "node_modules/**",
      "spikes/**",
      "knowledge/generated/**",
    ],
  },
  {
    files: ["**/*.{mts,cts}"],
    languageOptions: { parser: typescriptParser },
  },
  {
    files: [`App.${sourceExtensions}`, `index.${sourceExtensions}`, `src/**/*.${sourceExtensions}`],
    rules: {
      "import/no-unresolved": ["error", { ignore: ["^@for-mobile/fault-controller$"] }],
      "no-restricted-imports": restrictedImports(),
      "no-restricted-syntax": nonStaticImportSyntax,
      "no-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["metro.config.cjs"],
    languageOptions: { globals: { __dirname: "readonly" } },
  },
  {
    files: [`src/shared/**/*.${sourceExtensions}`],
    rules: {
      "no-restricted-imports": restrictedImports(
        [testingAliasPath],
        [
          categoryRestriction(
            "Shared code cannot depend on runtime layers.",
            "application", "domain", "features", "infrastructure", "navigation", "testing",
          ),
          ...expoNativePatterns,
        ],
      ),
    },
  },
  {
    files: [`src/features/**/*.${sourceExtensions}`],
    rules: {
      "no-restricted-imports": restrictedImports(
        [testingAliasPath],
        [
          categoryRestriction("Features cannot import infrastructure, navigation, or testing.", "infrastructure", "navigation", "testing"),
          ...expoNativePatterns,
        ],
      ),
    },
  },
  {
    files: [`src/navigation/**/*.${sourceExtensions}`],
    rules: {
      "no-restricted-imports": restrictedImports(
        [testingAliasPath],
        [
          categoryRestriction("Navigation cannot import infrastructure or testing.", "infrastructure", "testing"),
          ...expoNativePatterns,
        ],
      ),
    },
  },
  {
    files: [`src/application/**/*.${sourceExtensions}`],
    rules: {
      "no-restricted-imports": restrictedImports(
        [...platformPackagePaths, testingAliasPath],
        [
          ...platformPackagePatterns,
          categoryRestriction(
            "Application can depend only on domain and shared production layers.",
            "features", "infrastructure", "navigation", "testing",
          ),
        ],
      ),
    },
  },
  {
    files: [`src/domain/**/*.${sourceExtensions}`],
    rules: {
      "no-restricted-imports": restrictedImports(
        [...platformPackagePaths, testingAliasPath],
        [
          ...platformPackagePatterns,
          categoryRestriction(
            "Domain cannot depend on outward runtime or testing layers.",
            "application", "infrastructure", "features", "navigation", "shared", "testing",
          ),
        ],
      ),
    },
  },
  {
    files: [`src/infrastructure/**/*.${sourceExtensions}`],
    rules: {
      "no-restricted-imports": restrictedImports(
        [testingAliasPath],
        [categoryRestriction("Infrastructure cannot depend on presentation or testing layers.", "features", "navigation", "testing")],
      ),
    },
  },
];
