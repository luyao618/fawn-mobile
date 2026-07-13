import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { APPROVED_SLICE0_SPDX, validateSlice0LicenseArtifacts } from "../../../tools/check-licenses.mjs";

async function fixtures() {
  return Promise.all([
    readFile("licenses.slice0.json", "utf8").then(JSON.parse),
    readFile("dependencies.slice0.lock.json", "utf8").then(JSON.parse),
    readFile("spikes/model-transport/package.json", "utf8").then(JSON.parse),
    readFile("spikes/model-transport/package-lock.json", "utf8").then(JSON.parse),
  ]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("Slice 0 ownership reconciles the actual spike manifest and lock without reading mutable root policy", async () => {
  const [inventory, artifact, manifest, packageLock] = await fixtures();
  assert.deepEqual(validateSlice0LicenseArtifacts(inventory, artifact, manifest, packageLock), {
    directPackages: 8,
    runtimePackages: 4,
    developmentPackages: 4,
  });
  const mutableRoot = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(mutableRoot.devDependencies.typescript, "6.0.3");
  assert.equal(manifest.devDependencies.typescript, "5.9.3");
  assert.equal(artifact.packages.find((item: { name: string }) => item.name === "typescript").version, "5.9.3");
});

test("Slice 0 artifact disagreement fails closed", async () => {
  const [inventory, baseArtifact, manifest, packageLock] = await fixtures();
  const artifact = clone(baseArtifact);
  artifact.packages = artifact.packages.filter((item: { name: string }) => item.name !== "tsx");
  assert.throws(() => validateSlice0LicenseArtifacts(inventory, artifact, manifest, packageLock), /ownership/);
});

test("hostile extra spike dependency fails closed even when the frozen artifacts remain unchanged", async () => {
  const [inventory, artifact, baseManifest, basePackageLock] = await fixtures();
  const manifest = clone(baseManifest);
  const packageLock = clone(basePackageLock);
  manifest.dependencies["left-pad"] = "1.3.0";
  packageLock.packages[""].dependencies["left-pad"] = "1.3.0";
  packageLock.packages["node_modules/left-pad"] = {
    version: "1.3.0",
    integrity: "sha512-XI5MPzVNApjAyhQzN1u3BiFvUgClWZbI5J2LkQ17Nf7K6qP3zQpN1VzKQX0Y3OQn5XWq6XQ3G5D7L9A1B2C3Dg==",
  };
  assert.throws(() => validateSlice0LicenseArtifacts(inventory, artifact, manifest, packageLock), /runtime manifest/);
});

test("spike lock root and package integrity drift fail closed", async () => {
  const [inventory, artifact, manifest, basePackageLock] = await fixtures();
  const rootDrift = clone(basePackageLock);
  rootDrift.packages[""].dependencies.expo = "57.0.3";
  assert.throws(() => validateSlice0LicenseArtifacts(inventory, artifact, manifest, rootDrift), /lock root runtime/);

  const integrityDrift = clone(basePackageLock);
  integrityDrift.packages["node_modules/eventsource-parser"].integrity = "sha512-forged";
  assert.throws(() => validateSlice0LicenseArtifacts(inventory, artifact, manifest, integrityDrift), /integrity drifted/);
});

test("all eight approved Slice 0 SPDX identities reject hostile GPL relabeling independently", async () => {
  const [baseInventory, artifact, manifest, packageLock] = await fixtures();
  assert.equal(Object.keys(APPROVED_SLICE0_SPDX).length, 8);
  for (const name of Object.keys(APPROVED_SLICE0_SPDX)) {
    const inventory = clone(baseInventory);
    const entry = [...inventory.direct_dependencies, ...inventory.development_dependencies]
      .find((item: { name: string }) => item.name === name);
    assert.ok(entry, name);
    entry.license = "GPL-3.0-only";
    assert.throws(
      () => validateSlice0LicenseArtifacts(inventory, artifact, manifest, packageLock),
      new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} SPDX identity drifted`),
      name,
    );
  }
});
