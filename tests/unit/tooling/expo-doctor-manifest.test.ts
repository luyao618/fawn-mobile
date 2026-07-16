import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { computeG017SourceFingerprint } from "../../../spikes/model-transport/deviceEvidenceValidator.mjs";
import {
  prepareExpoDoctorManifest,
  rewriteExpoDoctorManifest,
} from "../../../tools/expo-doctor-manifest.mjs";

const sourceManifestPath = resolve("spikes/model-transport/package.json");

async function sourceManifest() {
  return JSON.parse(await readFile(sourceManifestPath, "utf8"));
}

test("isolated Expo Doctor manifest excludes Expo without mutating its input", async () => {
  const manifest = await sourceManifest();
  const original = structuredClone(manifest);

  const prepared = prepareExpoDoctorManifest(manifest);

  assert.deepEqual(manifest, original);
  assert.notEqual(prepared, manifest);
  assert.deepEqual(prepared.expo.install.exclude, ["typescript", "expo"]);
  assert.deepEqual(manifest.expo.install.exclude, ["typescript"]);
});

test("isolated Expo Doctor manifest fails closed for malformed or unexpected source manifests", async () => {
  const valid = await sourceManifest();
  const unexpected = [
    null,
    [],
    {},
    { ...valid, name: "@fawn-mobile/unexpected" },
    { ...valid, dependencies: { ...valid.dependencies, expo: "57.0.6" } },
    { ...valid, dependencies: null },
    { ...valid, expo: null },
    { ...valid, expo: { install: null } },
    { ...valid, expo: { install: { exclude: "typescript" } } },
    { ...valid, expo: { install: { exclude: [] } } },
    { ...valid, expo: { install: { exclude: ["typescript", "expo"] } } },
    { ...valid, expo: { install: { exclude: ["unexpected"] } } },
  ];

  for (const manifest of unexpected) {
    assert.throws(
      () => prepareExpoDoctorManifest(manifest),
      /Refusing to prepare isolated Expo Doctor manifest/,
    );
  }
});

test("temporary rewrite preserves source manifest bytes and the official G017 fingerprint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "g017-doctor-manifest-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const temporaryManifestPath = join(directory, "package.json");
  const sourceBytesBefore = await readFile(sourceManifestPath);
  const fingerprintBefore = await computeG017SourceFingerprint();
  await writeFile(temporaryManifestPath, sourceBytesBefore);

  await rewriteExpoDoctorManifest(temporaryManifestPath);

  const rewritten = JSON.parse(await readFile(temporaryManifestPath, "utf8"));
  assert.deepEqual(rewritten.expo.install.exclude, ["typescript", "expo"]);
  assert.deepEqual(await readFile(sourceManifestPath), sourceBytesBefore);
  assert.equal(await computeG017SourceFingerprint(), fingerprintBefore);
});

test("temporary rewrite rejects invalid JSON without overwriting it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "g017-doctor-invalid-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "package.json");
  const invalid = "{ invalid json\n";
  await writeFile(manifestPath, invalid);

  await assert.rejects(
    rewriteExpoDoctorManifest(manifestPath),
    /package\.json must be valid JSON/,
  );
  assert.equal(await readFile(manifestPath, "utf8"), invalid);
});
