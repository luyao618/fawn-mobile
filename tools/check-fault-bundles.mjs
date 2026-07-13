import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const FAULT_CONTROLLER_SENTINEL = "FOR_MOBILE_E2E_FAULT_CONTROLLER_REAL_V1";
export const FAULT_BUNDLE_PROOF_PATH = ".artifacts/fault-bundles/proof.json";
export const FAULT_BUNDLE_PLATFORMS = Object.freeze(["android", "ios"]);
export const FAULT_BUNDLE_FLAVORS = Object.freeze(["production", "e2e"]);
export const FAULT_BUNDLE_EXPORT_FLAGS = Object.freeze(["--no-bytecode", "--no-minify", "--clear"]);

const faultPoints = JSON.parse(await readFile(resolve(repoRoot, "src/testing/faultPoints.json"), "utf8"));
assert(Array.isArray(faultPoints) && faultPoints.every((point) => typeof point === "string"), "Fault point registry is invalid");
const protocolMarker = "formobile-test:";
const modeMarker = "crash_once";
export const FAULT_BUNDLE_MARKERS = Object.freeze([
  FAULT_CONTROLLER_SENTINEL,
  protocolMarker,
  modeMarker,
  ...faultPoints,
]);

function expectedCounts(flavor) {
  return Object.freeze(Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [
    marker,
    flavor === "production"
      ? 0
      : marker === FAULT_CONTROLLER_SENTINEL
        ? 1
        : marker === protocolMarker
          ? 2
          : marker === modeMarker
            ? 3
            : 1,
  ])));
}

export const FAULT_BUNDLE_EXPECTED_MARKER_COUNTS = Object.freeze({
  production: expectedCounts("production"),
  e2e: expectedCounts("e2e"),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function occurrences(bytes, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = bytes.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function markerCounts(bytes) {
  return Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [
    marker,
    occurrences(bytes, Buffer.from(marker)),
  ]));
}

function copyMarkerCounts(counts) {
  return Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [marker, counts[marker]]));
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function assertMarkerCounts(value, label) {
  assert(hasExactKeys(value, FAULT_BUNDLE_MARKERS), `${label} contains unknown or missing marker fields`);
  for (const marker of FAULT_BUNDLE_MARKERS) {
    assert(Number.isSafeInteger(value[marker]) && value[marker] >= 0, `${label} contains an invalid marker count`);
  }
}

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files.sort();
}

function assertCanonicalBundlePath(path, platform, flavor) {
  const label = `${platform} ${flavor}`;
  const prefix = `.artifacts/fault-bundles/${platform}/${flavor}/`;
  assert(path.startsWith(prefix), `${label} bundle path is outside its canonical export directory`);
  assert(!path.split(/[\\/]/).includes(".."), `${label} bundle path contains traversal`);
}

/**
 * @param {any} proof
 * @param {{ root?: string, expectedSha?: string }} [options]
 * @returns {Promise<{
 *   markers: string[],
 *   expectedMarkerCounts: Record<"production" | "e2e", Record<string, number>>,
 *   bundles: Record<"android" | "ios", Record<"production" | "e2e", {
 *     path: string,
 *     bytes: number,
 *     sha256: string,
 *     observedMarkerCounts: Record<string, number>
 *   }>>
 * }>}
 */
export async function validateFaultBundleProof(proof, options = {}) {
  const { root = repoRoot, expectedSha } = options;
  assert(
    hasExactKeys(proof, ["schemaVersion", "checkedOutSha", "platforms", "exportFlags", "markers", "expectedMarkerCounts", "bundles"]),
    "Fault bundle proof contains unknown or missing root fields",
  );
  assert.equal(proof?.schemaVersion, 3, "Fault bundle proof schema is invalid");
  assert.equal(proof?.checkedOutSha, expectedSha, "Fault bundle proof SHA disagrees with the exact checkout");
  assert.deepEqual(proof?.platforms, FAULT_BUNDLE_PLATFORMS, "Fault bundle proof platforms are invalid");
  assert.deepEqual(proof?.exportFlags, FAULT_BUNDLE_EXPORT_FLAGS, "Fault bundle proof must use text bundles without minification");
  assert.deepEqual(proof?.markers, FAULT_BUNDLE_MARKERS, "Fault bundle proof markers are invalid");
  assert(
    hasExactKeys(proof?.expectedMarkerCounts, FAULT_BUNDLE_FLAVORS),
    "Fault bundle proof expected counts contain unknown or missing flavor fields",
  );
  for (const flavor of FAULT_BUNDLE_FLAVORS) {
    assertMarkerCounts(proof.expectedMarkerCounts[flavor], `${flavor} expected marker counts`);
    assert.deepEqual(
      proof.expectedMarkerCounts[flavor],
      FAULT_BUNDLE_EXPECTED_MARKER_COUNTS[flavor],
      "Fault bundle proof expected marker counts are invalid",
    );
  }
  assert(hasExactKeys(proof?.bundles, FAULT_BUNDLE_PLATFORMS), "Fault bundle proof contains unknown or missing platform fields");

  const bundles = {};
  for (const platform of FAULT_BUNDLE_PLATFORMS) {
    assert(hasExactKeys(proof.bundles[platform], FAULT_BUNDLE_FLAVORS), `${platform} fault bundle proof contains unknown or missing flavor fields`);
    bundles[platform] = {};
    for (const flavor of FAULT_BUNDLE_FLAVORS) {
      const label = `${platform} ${flavor}`;
      const entry = proof?.bundles?.[platform]?.[flavor];
      assert(entry && typeof entry === "object", `${label} fault bundle evidence is absent`);
      assert(
        hasExactKeys(entry, ["path", "bytes", "sha256", "observedMarkerCounts", "metadata"]),
        `${label} fault bundle entry contains unknown or missing fields`,
      );
      assertMarkerCounts(entry.observedMarkerCounts, `${label} observed marker counts`);
      assert(hasExactKeys(entry.metadata, ["path", "bytes", "sha256"]), `${label} metadata evidence contains unknown or missing fields`);
      assertCanonicalBundlePath(entry.path, platform, flavor);
      const absolute = resolve(root, entry.path);
      assert.equal(relative(resolve(root), absolute).split(sep)[0], ".artifacts", `${label} bundle resolves outside retained artifacts`);
      const stat = await lstat(absolute);
      assert(stat.isFile() && !stat.isSymbolicLink(), `${label} bundle must be a retained regular file`);
      const bytes = await readFile(absolute);
      assert(bytes.length > 0, `${label} bundle is empty`);
      assert.equal(entry.bytes, bytes.length, `${label} bundle byte count disagrees`);
      assert.equal(entry.sha256, sha256(bytes), `${label} bundle hash disagrees`);
      const observedMarkerCounts = markerCounts(bytes);
      for (const marker of FAULT_BUNDLE_MARKERS) {
        assert.equal(
          entry.observedMarkerCounts[marker],
          observedMarkerCounts[marker],
          `${label} observed marker count disagrees for ${JSON.stringify(marker)}`,
        );
        assert.equal(
          observedMarkerCounts[marker],
          FAULT_BUNDLE_EXPECTED_MARKER_COUNTS[flavor][marker],
          `${label} marker count is invalid for ${JSON.stringify(marker)}`,
        );
      }
      const exportPrefix = `.artifacts/fault-bundles/${platform}/${flavor}/`;
      assert.equal(entry.metadata.path, `${exportPrefix}metadata.json`, `${label} metadata path is not canonical`);
      const metadataAbsolute = resolve(root, entry.metadata.path);
      const metadataStat = await lstat(metadataAbsolute);
      assert(metadataStat.isFile() && !metadataStat.isSymbolicLink(), `${label} metadata must be a retained regular file`);
      const metadataBytes = await readFile(metadataAbsolute);
      assert.equal(entry.metadata.bytes, metadataBytes.length, `${label} metadata byte count disagrees`);
      assert.equal(entry.metadata.sha256, sha256(metadataBytes), `${label} metadata hash disagrees`);
      const metadata = JSON.parse(metadataBytes.toString("utf8"));
      assert(hasExactKeys(metadata, ["version", "bundler", "fileMetadata"]), `${label} Expo metadata contains unknown or missing root fields`);
      assert.equal(metadata.version, 0, `${label} Expo metadata version must remain 0`);
      assert.equal(metadata.bundler, "metro", `${label} Expo metadata bundler must remain metro`);
      assert(hasExactKeys(metadata.fileMetadata, [platform]), `${label} Expo metadata contains unknown or missing platform fields`);
      assert(hasExactKeys(metadata.fileMetadata[platform], ["bundle", "assets"]), `${label} Expo metadata platform entry contains unknown or missing fields`);
      assert(Array.isArray(metadata.fileMetadata[platform].assets), `${label} Expo metadata assets must be an array`);
      assert.equal(`${exportPrefix}${metadata.fileMetadata[platform].bundle}`, entry.path, `${label} Expo metadata bundle does not match the validated canonical bundle`);
      bundles[platform][flavor] = {
        path: entry.path,
        bytes: bytes.length,
        sha256: entry.sha256,
        observedMarkerCounts,
      };
    }
  }
  return {
    markers: [...FAULT_BUNDLE_MARKERS],
    expectedMarkerCounts: {
      production: copyMarkerCounts(FAULT_BUNDLE_EXPECTED_MARKER_COUNTS.production),
      e2e: copyMarkerCounts(FAULT_BUNDLE_EXPECTED_MARKER_COUNTS.e2e),
    },
    bundles,
  };
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export async function buildFaultBundleProof(root = repoRoot) {
  const proofPath = resolve(root, FAULT_BUNDLE_PROOF_PATH);
  await rm(dirname(proofPath), { recursive: true, force: true });
  await mkdir(dirname(proofPath), { recursive: true });
  const proof = {
    schemaVersion: 3,
    checkedOutSha: gitHead(),
    platforms: FAULT_BUNDLE_PLATFORMS,
    exportFlags: FAULT_BUNDLE_EXPORT_FLAGS,
    markers: FAULT_BUNDLE_MARKERS,
    expectedMarkerCounts: FAULT_BUNDLE_EXPECTED_MARKER_COUNTS,
    bundles: {},
  };
  for (const platform of FAULT_BUNDLE_PLATFORMS) {
    proof.bundles[platform] = {};
    for (const flavor of FAULT_BUNDLE_FLAVORS) {
      const output = resolve(root, `.artifacts/fault-bundles/${platform}/${flavor}`);
      const args = ["--no-install", "expo", "export", "--output-dir", output, "--platform", platform, ...FAULT_BUNDLE_EXPORT_FLAGS];
      const result = spawnSync("npx", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: flavor },
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${platform} ${flavor} text export failed:\n${result.stdout}\n${result.stderr}`);
      const files = await javascriptFiles(output);
      assert.equal(files.length, 1, `${platform} ${flavor} export must contain exactly one JavaScript bundle`);
      const path = relative(root, files[0]).split(sep).join("/");
      const bytes = await readFile(files[0]);
      const metadataPath = relative(root, resolve(output, "metadata.json")).split(sep).join("/");
      const metadataBytes = await readFile(resolve(output, "metadata.json"));
      proof.bundles[platform][flavor] = {
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        observedMarkerCounts: markerCounts(bytes),
        metadata: { path: metadataPath, bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
      };
    }
  }
  await validateFaultBundleProof(proof, { root, expectedSha: proof.checkedOutSha });
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ faultBundles: "pass", proof: FAULT_BUNDLE_PROOF_PATH, checkedOutSha: proof.checkedOutSha }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildFaultBundleProof();
