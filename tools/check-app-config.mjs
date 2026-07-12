import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEV_CLIENT_PLUGIN = ["expo-dev-client", { toolsButton: false, skipOnboarding: true, showMenuAtLaunch: false }];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function command(commandName, args) {
  const result = spawnSync(commandName, args, { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function resolvedConfig(flavor) {
  const result = spawnSync("npx", ["--no-install", "expo", "config", "--type", "public", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: flavor },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `Expo config failed for ${flavor}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const APPROVED_PUBLIC_CONFIG = {
  name: "For Mobile",
  slug: "for-mobile",
  version: "0.1.0",
  userInterfaceStyle: "light",
  android: {
    package: "com.luyao618.formobile",
    softwareKeyboardLayoutMode: "resize",
  },
  ios: {
    bundleIdentifier: "com.luyao618.formobile",
    supportsTablet: true,
  },
  plugins: ["@react-native-vector-icons/lucide", DEV_CLIENT_PLUGIN],
  sdkVersion: "57.0.0",
  platforms: ["ios", "android"],
};

export function validateResolvedConfigs(production, e2e) {
  assert.deepEqual(
    production,
    APPROVED_PUBLIC_CONFIG,
    "Production resolved public config must exactly match the approved shape",
  );
  assert.deepEqual(
    e2e,
    { ...APPROVED_PUBLIC_CONFIG, scheme: "formobile-test", extra: { e2eFaults: true } },
    "E2E resolved public config must exactly match the approved shape",
  );
}

async function writeReports(outputDir, platform, expectedSha, configs) {
  assert(["android", "ios"].includes(platform), "--platform must be android or ios when writing reports");
  const checkedOutSha = command("git", ["rev-parse", "HEAD"]);
  assert(expectedSha, "--expected-sha is required when writing reports");
  assert.equal(checkedOutSha, expectedSha, "Config report checkout does not match expected SHA");
  await mkdir(resolve(repoRoot, outputDir), { recursive: true });
  for (const [flavor, config] of Object.entries(configs)) {
    const configSha256 = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const report = { schemaVersion: 1, reportType: "resolved-app-config", platform, flavor, checkedOutSha, expectedSha, configSha256, config };
    await writeFile(resolve(repoRoot, outputDir, `${platform}-${flavor}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
}

export async function checkAppConfig() {
  const production = resolvedConfig("production");
  const e2e = resolvedConfig("e2e");
  validateResolvedConfigs(production, e2e);
  const invalid = spawnSync("npx", ["--no-install", "expo", "config", "--type", "public", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: "unexpected" },
  });
  assert.notEqual(invalid.status, 0, "Unknown build flavors must fail config generation");
  const outputDir = option("--output-dir", null);
  if (outputDir) await writeReports(outputDir, option("--platform", null), option("--expected-sha", null), { production, e2e });
  console.log(JSON.stringify({ config: "pass", production_scheme: null, e2e_scheme: "formobile-test", identity: "com.luyao618.formobile" }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkAppConfig();
