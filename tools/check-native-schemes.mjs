import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AndroidConfig } = require("expo/config-plugins");
const TEST_SCHEME = "formobile-test";

export const NATIVE_SCHEME_PLACEMENTS = Object.freeze({
  android: "manifest.application[].activity[].intent-filter[].data[].$.android:scheme",
  ios: "CFBundleURLTypes[].CFBundleURLSchemes[]",
});

export const NATIVE_EVIDENCE_PATHS = Object.freeze({
  android: Object.freeze({
    production: ".artifacts/native/android/production/AndroidManifest.xml",
    e2e: ".artifacts/native/android/e2e/AndroidManifest.xml",
  }),
  ios: Object.freeze({
    production: ".artifacts/native/ios/production/Info.plist",
    e2e: ".artifacts/native/ios/e2e/Info.plist",
  }),
});

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function collectSchemeAttributes(value, path = [], matches = []) {
  if (Array.isArray(value)) value.forEach((entry, index) => collectSchemeAttributes(entry, [...path, index], matches));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "android:scheme" && entry === TEST_SCHEME) matches.push([...path, key]);
      collectSchemeAttributes(entry, [...path, key], matches);
    }
  }
  return matches;
}

function countExactStrings(value) {
  if (value === TEST_SCHEME) return 1;
  if (Array.isArray(value)) return value.reduce((count, entry) => count + countExactStrings(entry), 0);
  if (value && typeof value === "object") return Object.values(value).reduce((count, entry) => count + countExactStrings(entry), 0);
  return 0;
}

export function validateAndroidManifest(manifest, flavor) {
  const expected = flavor === "e2e" ? 1 : 0;
  const allMatches = collectSchemeAttributes(manifest);
  assert.equal(allMatches.length, expected, `android ${flavor} must contain ${expected} structural ${TEST_SCHEME} scheme nodes`);
  let intendedCount = 0;
  for (const application of manifest.manifest?.application ?? []) {
    for (const activity of application.activity ?? []) {
      for (const filter of activity["intent-filter"] ?? []) {
        const schemes = (filter.data ?? []).filter((data) => data.$?.["android:scheme"] === TEST_SCHEME);
        if (schemes.length === 0) continue;
        const actions = new Set((filter.action ?? []).map((action) => action.$?.["android:name"]));
        const categories = new Set((filter.category ?? []).map((category) => category.$?.["android:name"]));
        assert(actions.has("android.intent.action.VIEW"), "test scheme must be in a VIEW intent-filter");
        assert(categories.has("android.intent.category.DEFAULT"), "test scheme intent-filter must be DEFAULT");
        assert(categories.has("android.intent.category.BROWSABLE"), "test scheme intent-filter must be BROWSABLE");
        intendedCount += schemes.length;
      }
    }
  }
  assert.equal(intendedCount, expected, `android ${flavor} test scheme has wrong placement`);
  return { scheme: TEST_SCHEME, count: intendedCount, placement: NATIVE_SCHEME_PLACEMENTS.android };
}

export function validateIosPlist(infoPlist, flavor) {
  const expected = flavor === "e2e" ? 1 : 0;
  assert(infoPlist && typeof infoPlist === "object" && !Array.isArray(infoPlist), "Info.plist must be a dictionary");
  const urlTypes = infoPlist.CFBundleURLTypes ?? [];
  assert(Array.isArray(urlTypes), "CFBundleURLTypes must be an array");
  const schemes = [];
  for (const urlType of urlTypes) {
    assert(urlType && typeof urlType === "object" && !Array.isArray(urlType), "CFBundleURLTypes entries must be dictionaries");
    const values = urlType.CFBundleURLSchemes ?? [];
    assert(Array.isArray(values), "CFBundleURLSchemes must be an array");
    schemes.push(...values.filter((value) => value === TEST_SCHEME));
  }
  assert.equal(countExactStrings(infoPlist), expected, `ios ${flavor} must contain ${expected} structural ${TEST_SCHEME} scheme values`);
  assert.equal(schemes.length, expected, `ios ${flavor} must contain ${expected} structural ${TEST_SCHEME} scheme nodes`);
  return { scheme: TEST_SCHEME, count: schemes.length, placement: NATIVE_SCHEME_PLACEMENTS.ios };
}

export function parseIosPlistWithPlutil(inputPath, run = spawnSync, hostPlatform = process.platform) {
  assert.equal(hostPlatform, "darwin", "iOS plist inspection requires macOS plutil");
  const result = run("plutil", ["-convert", "json", "-o", "-", "--", inputPath], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `plutil failed to start: ${result.error?.message ?? "unknown error"}`);
  assert.equal(result.status, 0, `plutil failed to parse ${inputPath}: ${result.stderr ?? ""}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`plutil returned malformed JSON for ${inputPath}`, { cause: error });
  }
}

export async function inspectNativeScheme(platform, flavor, input) {
  assert(["android", "ios"].includes(platform), "platform must be android or ios");
  assert(["production", "e2e"].includes(flavor), "flavor must be production or e2e");
  const inputPath = resolve(input);
  const bytes = await readFile(inputPath);
  const structure = platform === "android"
    ? validateAndroidManifest(await AndroidConfig.Manifest.readAndroidManifestAsync(inputPath), flavor)
    : validateIosPlist(parseIosPlistWithPlutil(inputPath), flavor);
  return { inputPath, nativeInputSha256: createHash("sha256").update(bytes).digest("hex"), structure };
}

async function main() {
  const platform = option("--platform");
  const flavor = option("--flavor");
  const input = option("--input");
  assert(platform && flavor && input, "--platform, --flavor, and --input are required");
  const inspected = await inspectNativeScheme(platform, flavor, input);
  const output = option("--output");
  if (output) {
    const expectedSha = option("--expected-sha");
    const checkedOutSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    assert(expectedSha, "--expected-sha is required when writing a report");
    assert.equal(checkedOutSha, expectedSha, "Scheme report checkout does not match expected SHA");
    const report = {
      schemaVersion: 1,
      reportType: "native-scheme",
      platform,
      flavor,
      checkedOutSha,
      expectedSha,
      nativeInput: { path: input, sha256: inspected.nativeInputSha256 },
      ...inspected.structure,
    };
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify({ native_scheme: "pass", platform, flavor, input, formobile_test_schemes: inspected.structure.count, output: output ?? null }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
