import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { APPROVED_APP_DEPENDENCIES, APPROVED_APP_LICENSES, validateAppDependencyPolicy } from "../../../tools/check-app-dependencies.mjs";

async function fixtures() {
  return Promise.all([
    readFile("package.json", "utf8").then(JSON.parse),
    readFile("package-lock.json", "utf8").then(JSON.parse),
    readFile("dependencies.app.lock.json", "utf8").then(JSON.parse),
    readFile("licenses.app.json", "utf8").then(JSON.parse),
  ]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("app dependency policy pins the independently approved names, versions, and ownership", async () => {
  const [packageJson, packageLock, artifact, inventory] = await fixtures();
  assert.deepEqual(validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), { runtime: 10, development: 12 });
  assert.deepEqual(packageJson.dependencies, APPROVED_APP_DEPENDENCIES.runtime);
  assert.deepEqual(packageJson.devDependencies, APPROVED_APP_DEPENDENCIES.development);
  assert.equal(Object.keys(APPROVED_APP_LICENSES).length, 22);
  assert.equal(APPROVED_APP_LICENSES.expo, "MIT");
  assert.equal(APPROVED_APP_LICENSES["expo-sqlite"], "MIT");
  assert.equal(APPROVED_APP_LICENSES.typescript, "Apache-2.0");
});

test("app dependency policy rejects replacement, version drift, cross-owner moves, extras, and omissions", async () => {
  const [basePackageJson, packageLock, artifact, inventory] = await fixtures();
  const mutations = [
    (manifest: any) => { delete manifest.dependencies.react; manifest.dependencies["left-pad"] = "1.3.0"; },
    (manifest: any) => { manifest.dependencies.expo = "57.0.3"; },
    (manifest: any) => { delete manifest.dependencies.react; manifest.devDependencies.react = "19.2.3"; },
    (manifest: any) => { manifest.dependencies["left-pad"] = "1.3.0"; },
    (manifest: any) => { delete manifest.devDependencies.typescript; },
  ];
  for (const mutate of mutations) {
    const packageJson = clone(basePackageJson);
    mutate(packageJson);
    assert.throws(() => validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), /exactly match the approved/);
  }
});

test("app dependency policy rejects approved inventory and integrity drift", async () => {
  const [packageJson, packageLock, artifact, inventory] = await fixtures();
  inventory.development_dependencies = inventory.development_dependencies.filter((item: { name: string }) => item.name !== "typescript");
  assert.throws(() => validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), /cover every approved/);
  artifact.packages.find((item: { name: string }) => item.name === "expo").integrity = "sha512-forged";
  assert.throws(() => validateAppDependencyPolicy(packageJson, packageLock, artifact, { ...inventory, development_dependencies: [...inventory.development_dependencies, { ...artifact.packages.find((item: { name: string }) => item.name === "typescript"), license: "Apache-2.0", maintenance_status: "active", purpose: "test", platform_support: "host", removal_path: "replace" }] }), /integrity/);
});

test("app dependency policy rejects exact approved license/SPDX mutations", async () => {
  const [packageJson, packageLock, artifact, baseInventory] = await fixtures();
  for (const [name, forged] of [["expo", "GPL-3.0-only"], ["typescript", "MIT"]] as const) {
    const inventory = clone(baseInventory);
    const entry = [...inventory.direct_dependencies, ...inventory.development_dependencies].find((item: { name: string }) => item.name === name);
    entry.license = forged;
    assert.throws(() => validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), new RegExp(`${name} license/SPDX`));
  }
});
