import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { computeG017SourceFingerprint } from "../spikes/model-transport/deviceEvidenceValidator.mjs";

const platform = process.argv[2];
if (platform !== "android" && platform !== "ios") throw new Error("Expected android or ios platform");
const packageRoot = resolve(new URL("../spikes/model-transport", import.meta.url).pathname);
const output = resolve(packageRoot, `.expo-export/${platform}`);
const fingerprint = await computeG017SourceFingerprint();
const result = spawnSync("npx", ["expo", "export", "--platform", platform, "--output-dir", output, "--clear"], {
  cwd: packageRoot,
  env: { ...process.env, EXPO_PUBLIC_G017_SOURCE_FINGERPRINT: fingerprint },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const metadataBytes = await readFile(resolve(output, "metadata.json"));
const metadata = JSON.parse(metadataBytes.toString("utf8"));
const bundlePath = metadata.fileMetadata?.[platform]?.bundle;
if (typeof bundlePath !== "string" || !bundlePath.startsWith(`_expo/static/js/${platform}/`) || !bundlePath.endsWith(".hbc")) {
  throw new Error("Expo export did not produce the expected platform Hermes bundle");
}
const bundleBytes = await readFile(resolve(output, bundlePath));
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const dependencies = {
  expo: packageJson.dependencies.expo,
  react: packageJson.dependencies.react,
  reactNative: packageJson.dependencies["react-native"],
  eventsourceParser: packageJson.dependencies["eventsource-parser"],
};
const manifest = {
  schemaVersion: 1,
  contractId: "for-mobile-g017-expo-export-v1",
  platform,
  sourceFingerprint: fingerprint,
  dependencies,
  metadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
  bundle: {
    path: bundlePath,
    bytes: bundleBytes.length,
    sha256: createHash("sha256").update(bundleBytes).digest("hex"),
    format: "hermes-bytecode",
  },
};
const temporary = resolve(output, ".g017-proof-manifest.tmp");
await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
await rename(temporary, resolve(output, "g017-proof-manifest.json"));
console.log(JSON.stringify({ g017_export: "pass", platform, fingerprint, bundle_sha256: manifest.bundle.sha256 }));
