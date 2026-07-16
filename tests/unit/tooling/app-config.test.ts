import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateResolvedConfigs } from "../../../tools/check-app-config.mjs";

function config(flavor: string) {
  const result = spawnSync("npx", ["--no-install", "expo", "config", "--type", "public", "--json"], {
    encoding: "utf8",
    env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: flavor },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function introspectedConfig() {
  const result = spawnSync("npx", ["--no-install", "expo", "config", "--type", "introspect", "--json"], {
    encoding: "utf8",
    env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: "production" },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function validPair() {
  return [config("production"), config("e2e")] as const;
}

test("resolved configs pin identity, native plugins, and flavor isolation", () => {
  const [production, e2e] = validPair();
  assert.doesNotThrow(() => validateResolvedConfigs(production, e2e));
  assert.deepEqual(production.plugins, [
    "@react-native-vector-icons/lucide",
    ["expo-secure-store", { configureAndroidBackup: true, faceIDPermission: false }],
    ["expo-dev-client", { toolsButton: false, skipOnboarding: true, showMenuAtLaunch: false }],
  ]);
  assert.equal(JSON.stringify(production).includes("NSFaceIDUsageDescription"), false);
  const appJson = JSON.parse(readFileSync(new URL("../../../app.json", import.meta.url), "utf8"));
  assert.deepEqual(appJson.expo.ios.config, { usesNonExemptEncryption: false });
});

test("SecureStore introspection configures Android backup without requesting Face ID", () => {
  const introspected = introspectedConfig();
  const infoPlist = introspected._internal.modResults.ios.infoPlist;
  assert.equal(infoPlist.ITSAppUsesNonExemptEncryption, false);
  assert.equal(Object.hasOwn(infoPlist, "NSFaceIDUsageDescription"), false);
  const application = introspected._internal.modResults.android.manifest.manifest.application[0].$;
  assert.equal(application["android:allowBackup"], "true");
  assert.equal(application["android:fullBackupContent"], "@xml/secure_store_backup_rules");
  assert.equal(application["android:dataExtractionRules"], "@xml/secure_store_data_extraction_rules");
});

test("config policy rejects nested Android and iOS privacy permission declarations", () => {
  const mutations = [
    (config: any) => { config.android.permissions = ["android.permission.READ_CONTACTS"]; },
    (config: any) => { config.android.blockedPermissions = ["android.permission.CAMERA"]; },
    (config: any) => { config.ios.infoPlist = { NSPhotoLibraryUsageDescription: "decoy" }; },
    (config: any) => { config.ios.entitlements = { "com.apple.developer.healthkit": true }; },
    (config: any) => { config.ios.privacyManifests = { NSPrivacyAccessedAPITypes: [{}] }; },
  ];
  for (const mutate of mutations) {
    const [production, e2e] = validPair().map((value) => structuredClone(value)) as [any, any];
    mutate(production);
    assert.throws(() => validateResolvedConfigs(production, e2e), /approved shape/i);
  }
});


test("config policy rejects hostile native links, telemetry, and every undeclared nested or root field", () => {
  const mutations = [
    (value: any) => { value.android.intentFilters = [{ action: "VIEW", data: [{ scheme: "https", host: "attacker.example" }] }]; },
    (value: any) => { value.ios.associatedDomains = ["applinks:attacker.example"]; },
    (value: any) => { value.extra = { telemetryUrl: "https://attacker.example/collect" }; },
    (value: any) => { value.extra = { backendUrl: "https://attacker.example/api" }; },
    (value: any) => { value.android.adaptiveIcon = { foregroundImage: "./attacker.png" }; },
    (value: any) => { value.ios.config = { usesNonExemptEncryption: true }; },
    (value: any) => { value.ios.usesIcloudStorage = true; },
    (value: any) => { value.web = { bundler: "metro" }; },
    (value: any) => { value.experiments = { typedRoutes: true }; },
  ];
  const pair = validPair();
  for (const mutate of mutations) {
    const production = structuredClone(pair[0]);
    const e2e = structuredClone(pair[1]);
    mutate(production);
    assert.throws(() => validateResolvedConfigs(production, e2e), /exactly match|resolved public config/i);
  }
});

test("unknown build flavor fails before config generation", () => {
  const result = spawnSync("npx", ["--no-install", "expo", "config", "--type", "public", "--json"], {
    encoding: "utf8",
    env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: "preview" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR/);
});
