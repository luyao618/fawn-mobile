import { builtinModules } from "node:module";

import expoConfig from "eslint-config-expo/flat.js";

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
    selector: "CallExpression[callee.name='require']",
    message: "Production code must use statically analyzable imports instead of require().",
  },
  {
    selector: "TSImportEqualsDeclaration",
    message: "Production code must use ECMAScript imports instead of TypeScript require imports.",
  },
  {
    selector: "ImportExpression",
    message: "Production code must not use dynamic import().",
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
    files: ["App.tsx", "index.ts", "src/**/*.{ts,tsx}"],
    rules: {
      "import/no-unresolved": ["error", { ignore: ["^@for-mobile/fault-controller$"] }],
      "no-restricted-imports": restrictedImports(),
      "no-restricted-syntax": nonStaticImportSyntax,
    },
  },
  {
    files: ["metro.config.cjs"],
    languageOptions: { globals: { __dirname: "readonly" } },
  },
  {
    files: ["src/shared/**/*.{ts,tsx}"],
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
    files: ["src/features/**/*.{ts,tsx}"],
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
    files: ["src/navigation/**/*.{ts,tsx}"],
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
    files: ["src/application/**/*.{ts,tsx}"],
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
    files: ["src/domain/**/*.{ts,tsx}"],
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
    files: ["src/infrastructure/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImports(
        [testingAliasPath],
        [categoryRestriction("Infrastructure cannot depend on presentation or testing layers.", "features", "navigation", "testing")],
      ),
    },
  },
];
