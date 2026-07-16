import { readFile, writeFile } from "node:fs/promises";

const EXPECTED_PACKAGE_NAME = "@fawn-mobile/slice0-device-proof";
const EXPECTED_EXPO_VERSION = "57.0.4";
const EXPECTED_INSTALL_EXCLUSIONS = ["typescript"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(`Refusing to prepare isolated Expo Doctor manifest: ${message}`);
}

export function prepareExpoDoctorManifest(manifest) {
  if (!isRecord(manifest)) fail("package.json must contain an object");
  if (manifest.name !== EXPECTED_PACKAGE_NAME) fail(`package name must be ${EXPECTED_PACKAGE_NAME}`);
  if (!isRecord(manifest.dependencies) || manifest.dependencies.expo !== EXPECTED_EXPO_VERSION) {
    fail(`dependencies.expo must be exactly ${EXPECTED_EXPO_VERSION}`);
  }
  if (!isRecord(manifest.expo) || !isRecord(manifest.expo.install)) {
    fail("expo.install must contain an object");
  }

  const exclusions = manifest.expo.install.exclude;
  if (!Array.isArray(exclusions)
    || exclusions.length !== EXPECTED_INSTALL_EXCLUSIONS.length
    || exclusions.some((value, index) => value !== EXPECTED_INSTALL_EXCLUSIONS[index])) {
    fail('expo.install.exclude must be exactly ["typescript"]');
  }

  return {
    ...manifest,
    expo: {
      ...manifest.expo,
      install: {
        ...manifest.expo.install,
        exclude: [...exclusions, "expo"],
      },
    },
  };
}

export async function rewriteExpoDoctorManifest(manifestPath) {
  const original = await readFile(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(original);
  } catch {
    fail("package.json must be valid JSON");
  }
  const prepared = prepareExpoDoctorManifest(manifest);
  await writeFile(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
  return prepared;
}
