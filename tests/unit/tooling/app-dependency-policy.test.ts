import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APPROVED_APP_DEPENDENCIES,
  APPROVED_APP_LICENSES,
  APPROVED_EXPO_INSTALL_EXCLUSIONS,
  APPROVED_NATIVE_TRANSITIVE_GRAPH,
  validateAppDependencyPolicy,
} from "../../../tools/check-app-dependencies.mjs";

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
  assert.deepEqual(validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), { runtime: 11, development: 12 });
  assert.deepEqual(packageJson.dependencies, APPROVED_APP_DEPENDENCIES.runtime);
  assert.deepEqual(packageJson.devDependencies, APPROVED_APP_DEPENDENCIES.development);
  assert.equal(Object.keys(APPROVED_APP_LICENSES).length, 23);
  assert.equal(APPROVED_APP_LICENSES.expo, "MIT");
  assert.equal(APPROVED_APP_LICENSES["expo-sqlite"], "MIT");
  assert.equal(APPROVED_APP_DEPENDENCIES.runtime["expo-secure-store"], "57.0.1");
  assert.equal(APPROVED_APP_LICENSES["expo-secure-store"], "MIT");
  assert.equal(APPROVED_APP_LICENSES.typescript, "Apache-2.0");
});

test("Expo install exclusions reject omission, extras, reordering, and drift while keeping native modules checked", async () => {
  const [basePackageJson, packageLock, artifact, inventory] = await fixtures();
  assert.deepEqual(APPROVED_EXPO_INSTALL_EXCLUSIONS, ["expo", "expo-dev-client", "jest-expo"]);
  assert.deepEqual(basePackageJson.expo.install.exclude, APPROVED_EXPO_INSTALL_EXCLUSIONS);
  assert.equal(APPROVED_EXPO_INSTALL_EXCLUSIONS.includes("expo-secure-store"), false);
  assert.equal(APPROVED_EXPO_INSTALL_EXCLUSIONS.includes("expo-sqlite"), false);

  const mutations = [
    (manifest: any) => { delete manifest.expo.install.exclude; },
    (manifest: any) => { manifest.expo.install.exclude = ["expo", "expo-dev-client"]; },
    (manifest: any) => { manifest.expo.install.exclude = ["expo", "expo-dev-client", "jest-expo", "expo-secure-store"]; },
    (manifest: any) => { manifest.expo.install.exclude = ["expo", "expo-dev-client", "jest-expo", "expo-sqlite"]; },
    (manifest: any) => { manifest.expo.install.exclude = ["jest-expo", "expo-dev-client", "expo"]; },
    (manifest: any) => { manifest.expo.install.exclude = ["expo", "expo-dev-client", "jest-expo@57.0.1"]; },
  ];
  for (const mutate of mutations) {
    const packageJson = clone(basePackageJson);
    mutate(packageJson);
    assert.throws(() => validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), /Expo install exclusions must exactly match/);
  }
});

test("app dependency policy rejects every approved Expo package version drift", async () => {
  const [basePackageJson, packageLock, artifact, inventory] = await fixtures();
  for (const [kind, name] of [
    ["dependencies", "expo"],
    ["dependencies", "expo-dev-client"],
    ["dependencies", "expo-secure-store"],
    ["dependencies", "expo-sqlite"],
    ["devDependencies", "jest-expo"],
  ] as const) {
    const packageJson = clone(basePackageJson);
    packageJson[kind][name] = "0.0.0";
    assert.throws(() => validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), /exactly match the approved/);
  }
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

test("app dependency policy fail-closes the approved native transitive graph", async () => {
  const [packageJson, basePackageLock, artifact, inventory] = await fixtures();
  assert.deepEqual(APPROVED_NATIVE_TRANSITIVE_GRAPH, {
    "expo-modules-core": {
      version: "57.0.3",
      resolved: "https://registry.npmjs.org/expo-modules-core/-/expo-modules-core-57.0.3.tgz",
      integrity: "sha512-fuD3DjPQvdaldtCJm2erV2/trPMrDJvEwPdz0RuxAQnduiNwZ3yxBoi81ZEKC5GBSJauMo53YXSwogsFagjwFQ==",
      license: "MIT",
      requiredBy: { name: "expo", range: "~57.0.3" },
    },
    "expo-modules-jsi": {
      version: "57.0.1",
      resolved: "https://registry.npmjs.org/expo-modules-jsi/-/expo-modules-jsi-57.0.1.tgz",
      integrity: "sha512-dECN3pOFv+KrQcGrOhJKEBc1/ob7SBjTTYGRB1bc84zmQ65La0FSrAPxpvnEQf8g9giLB5y9RLqwGxHspjXigQ==",
      license: "MIT",
      requiredBy: { name: "expo-modules-core", range: "~57.0.1" },
    },
  });

  const mutations: { mutate: (lock: any) => void; error: RegExp }[] = [
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-core"].version = "57.0.5"; },
      error: /expo-modules-core native transitive version drifted/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-jsi"].version = "57.0.3"; },
      error: /expo-modules-jsi native transitive version drifted/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-core"].integrity = "sha512-forged"; },
      error: /expo-modules-core native transitive integrity drifted/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-jsi"].integrity = "sha512-forged"; },
      error: /expo-modules-jsi native transitive integrity drifted/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo"].dependencies["expo-modules-core"] = "~57.0.5"; },
      error: /expo dependency on expo-modules-core must exactly match ~57.0.3/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-core"].dependencies["expo-modules-jsi"] = "~57.0.3"; },
      error: /expo-modules-core dependency on expo-modules-jsi must exactly match ~57.0.1/,
    },
    {
      mutate: (lock) => { delete lock.packages["node_modules/expo-modules-core"]; },
      error: /expo-modules-core is missing or linked/,
    },
    {
      mutate: (lock) => { delete lock.packages["node_modules/expo-modules-jsi"]; },
      error: /expo-modules-jsi is missing or linked/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-core"].link = true; },
      error: /expo-modules-core is missing or linked/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-jsi"].license = "GPL-3.0-only"; },
      error: /expo-modules-jsi native transitive license drifted/,
    },
    {
      mutate: (lock) => { lock.packages["node_modules/expo-modules-core"].resolved = "https://example.test/expo-modules-core.tgz"; },
      error: /expo-modules-core native transitive registry resolution drifted/,
    },
  ];

  for (const { mutate, error } of mutations) {
    const packageLock = clone(basePackageLock);
    mutate(packageLock);
    assert.throws(() => validateAppDependencyPolicy(packageJson, packageLock, artifact, inventory), error);
  }
});
