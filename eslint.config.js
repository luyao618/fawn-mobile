import { builtinModules } from "node:module";

import expoConfig from "eslint-config-expo/flat.js";

const prefixOnlyNodeBuiltins = ["node:sea", "node:sqlite", "node:test", "node:test/reporters"];
const nodeBuiltins = [...new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...prefixOnlyNodeBuiltins,
])];
const spikeAlias = "@fawn-mobile/slice0-device-proof";
const basePaths = [
  ...nodeBuiltins.map((name) => ({ name, message: "Node built-ins are not available in mobile production code." })),
  { name: spikeAlias, message: "The workspace spike package is not available in mobile production code." },
];

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

function restrictedImports(paths = [], patterns = []) {
  return ["error", { paths: [...basePaths, ...paths], patterns: [...basePatterns, ...patterns] }];
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
    },
  },
  {
    files: ["metro.config.cjs"],
    languageOptions: { globals: { __dirname: "readonly" } },
  },
  {
    files: ["src/features/**/*.{ts,tsx}", "src/navigation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImports([], [
        { group: categoryPatterns("infrastructure"), message: "Features and navigation cannot import infrastructure directly." },
        { group: ["expo-*", "expo-*/**", "@expo/**"], message: "Features and navigation cannot bypass infrastructure through Expo native packages." },
      ]),
    },
  },
  {
    files: ["src/application/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImports(
        platformPackagePaths,
        [...platformPackagePatterns, { group: categoryPatterns("features", "infrastructure") }],
      ),
    },
  },
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImports(
        platformPackagePaths,
        [
          ...platformPackagePatterns,
          { group: categoryPatterns("application", "infrastructure", "features", "navigation", "shared", "testing") },
        ],
      ),
    },
  },
];
