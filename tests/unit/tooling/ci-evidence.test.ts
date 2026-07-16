import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertCleanTrackedStatus,
  CLEAN_REPOSITORY_STATUS_ARGS,
  collectFaultBundleEvidence,
  validateNativeReports,
  validateTestResultInput,
} from "../../../tools/collect-ci-evidence.mjs";
import { NATIVE_EVIDENCE_PATHS, NATIVE_SCHEME_PLACEMENTS } from "../../../tools/check-native-schemes.mjs";

const sha = "a".repeat(40);
const opening = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity">`;
const filter = `<intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="formobile-test"/></intent-filter>`;
const closing = `</activity></application></manifest>`;
const productionBytes = opening + closing;
const e2eBytes = opening + filter + closing;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function baseConfig() {
  return {
    name: "For Mobile",
    slug: "for-mobile",
    version: "0.1.0",
    userInterfaceStyle: "light",
    android: { package: "com.luyao618.formobile", softwareKeyboardLayoutMode: "resize" },
    ios: { bundleIdentifier: "com.luyao618.formobile", supportsTablet: true },
    plugins: ["@react-native-vector-icons/lucide", ["expo-secure-store", { configureAndroidBackup: true, faceIDPermission: false }], ["expo-dev-client", { toolsButton: false, skipOnboarding: true, showMenuAtLaunch: false }]],
    sdkVersion: "57.0.0",
    platforms: ["ios", "android"],
  };
}

function configReport(flavor: "production" | "e2e") {
  const config: any = baseConfig();
  if (flavor === "e2e") {
    config.scheme = "formobile-test";
    config.extra = { e2eFaults: true };
  }
  return { schemaVersion: 1, reportType: "resolved-app-config", platform: "android", flavor, checkedOutSha: sha, expectedSha: sha, configSha256: hash(JSON.stringify(config)), config };
}

function schemeReport(flavor: "production" | "e2e", bytes: string) {
  return {
    schemaVersion: 1,
    reportType: "native-scheme",
    platform: "android",
    flavor,
    checkedOutSha: sha,
    expectedSha: sha,
    scheme: "formobile-test",
    count: flavor === "e2e" ? 1 : 0,
    placement: NATIVE_SCHEME_PLACEMENTS.android,
    nativeInput: { path: NATIVE_EVIDENCE_PATHS.android[flavor], sha256: hash(bytes) },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "g018-evidence-"));
  for (const [flavor, bytes] of [["production", productionBytes], ["e2e", e2eBytes]] as const) {
    const path = join(root, NATIVE_EVIDENCE_PATHS.android[flavor]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return {
    root,
    value: {
      platform: "android",
      expectedSha: sha,
      root,
      configReports: { production: configReport("production"), e2e: configReport("e2e") },
      schemeReports: { production: schemeReport("production", productionBytes), e2e: schemeReport("e2e", e2eBytes) },
    },
  };
}

function rehashConfig(report: any) {
  report.configSha256 = hash(JSON.stringify(report.config));
}

test("CI evidence reparses and hashes both canonical retained native files", async () => {
  const { root, value } = await fixture();
  try {
    const result: any = await validateNativeReports(value);
    assert.equal(result.scheme.production.count, 0);
    assert.equal(result.scheme.e2e.count, 1);
    assert.equal(result.nativeFiles.production.path, NATIVE_EVIDENCE_PATHS.android.production);
    assert.equal(result.nativeFiles.production.sha256, hash(productionBytes));
    assert.equal(result.nativeFiles.e2e.sha256, hash(e2eBytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI evidence rejects forged config identity, privacy, plugins, native placement, paths, and counts", async () => {
  const mutations = [
    (value: any) => { value.configReports.production.config.android.package = "com.attacker.fake"; rehashConfig(value.configReports.production); },
    (value: any) => { value.configReports.e2e.config.ios.infoPlist = { NSCameraUsageDescription: "fake" }; rehashConfig(value.configReports.e2e); },
    (value: any) => { value.configReports.production.config.plugins = []; rehashConfig(value.configReports.production); },
    (value: any) => { value.schemeReports.production.placement = "not-structural"; },
    (value: any) => { value.schemeReports.e2e.nativeInput.path = "android/app/src/main/AndroidManifest.xml"; },
    (value: any) => { delete value.schemeReports.production.nativeInput.path; },
    (value: any) => { value.schemeReports.e2e.count = 0; },
    (value: any) => { value.schemeReports.production = null; },
  ];
  for (const mutate of mutations) {
    const { root, value } = await fixture();
    try {
      mutate(value);
      await assert.rejects(validateNativeReports(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});


test("CI evidence rejects hostile links, telemetry, and undeclared nested or root config fields", async () => {
  const mutations = [
    (config: any) => { config.android.intentFilters = [{ action: "VIEW", data: [{ scheme: "https", host: "attacker.example" }] }]; },
    (config: any) => { config.ios.associatedDomains = ["applinks:attacker.example"]; },
    (config: any) => { config.extra = { telemetryUrl: "https://attacker.example/collect" }; },
    (config: any) => { config.android.adaptiveIcon = { foregroundImage: "./attacker.png" }; },
    (config: any) => { config.ios.config = { usesNonExemptEncryption: false }; },
    (config: any) => { config.web = { bundler: "metro" }; },
    (config: any) => { config.experiments = { typedRoutes: true }; },
  ];
  for (const mutate of mutations) {
    const { root, value } = await fixture();
    try {
      mutate(value.configReports.production.config);
      rehashConfig(value.configReports.production);
      await assert.rejects(validateNativeReports(value), /exactly match|resolved public config/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("CI evidence rejects stale or forged production bytes and mismatched E2E bytes", async () => {
  for (const [flavor, replacement] of [["production", e2eBytes], ["e2e", productionBytes]] as const) {
    const { root, value } = await fixture();
    try {
      await writeFile(join(root, NATIVE_EVIDENCE_PATHS.android[flavor]), replacement);
      await assert.rejects(validateNativeReports(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("same-commit provenance rejects tracked, index, and nonignored untracked dirtiness and requires a hashed explicit passing result", () => {
  assert.deepEqual(CLEAN_REPOSITORY_STATUS_ARGS, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.doesNotThrow(() => assertCleanTrackedStatus(""));
  for (const status of [" M App.tsx", "M  App.tsx", "MM App.tsx", "?? rogue.txt"]) assert.throws(() => assertCleanTrackedStatus(status), /clean/);
  const result = validateTestResultInput("pass", ".artifacts/test-results/static.log", Buffer.from("real gate output\n"));
  assert.equal(result.status, "pass");
  assert.equal(result.file.sha256, hash("real gate output\n"));
  assert.throws(() => validateTestResultInput(undefined, "result.log", Buffer.from("output")), /test-result pass/);
  assert.throws(() => validateTestResultInput("pass", null, Buffer.from("output")), /test-result-file/);
  assert.throws(() => validateTestResultInput("pass", "result.log", Buffer.alloc(0)), /nonempty/);
});

test("schema-v4 fault bundle collector preserves established sentinel leaves exactly", () => {
  const leaf = { path: "bundle.js", bytes: 12, sha256: "f".repeat(64), sentinelOccurrences: 1 };
  const bundles = {
    android: { production: { ...leaf, sentinelOccurrences: 0 }, e2e: leaf },
    ios: { production: { ...leaf, sentinelOccurrences: 0 }, e2e: leaf },
  };
  const evidence = collectFaultBundleEvidence({ path: "proof.json", sha256: "e".repeat(64) }, bundles);
  assert.deepEqual(evidence.bundles, bundles);
  for (const platform of ["android", "ios"] as const) {
    for (const flavor of ["production", "e2e"] as const) {
      assert.deepEqual(Object.keys(evidence.bundles[platform][flavor]), ["path", "bytes", "sha256", "sentinelOccurrences"]);
      assert.equal((evidence.bundles[platform][flavor] as any).observedMarkerCounts, undefined);
      assert.equal((evidence.bundles[platform][flavor] as any).moduleGraph, undefined);
    }
  }
});
