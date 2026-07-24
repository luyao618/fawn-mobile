import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const registryIntegrity = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const npmRegistry = "https://registry.npmjs.org";

export const APPROVED_EXPO_INSTALL_EXCLUSIONS = Object.freeze([
  "expo",
  "expo-dev-client",
  "jest-expo",
]);

export const APPROVED_APP_DEPENDENCIES = Object.freeze({
  runtime: Object.freeze({
    "@react-native-vector-icons/lucide": "13.1.2",
    "@react-navigation/bottom-tabs": "7.18.8",
    "@react-navigation/native": "7.3.8",
    expo: "57.0.4",
    "expo-dev-client": "57.0.5",
    "expo-secure-store": "57.0.1",
    "expo-sqlite": "57.0.1",
    react: "19.2.3",
    "react-native": "0.86.0",
    "react-native-safe-area-context": "5.7.0",
    "react-native-screens": "4.26.0",
  }),
  development: Object.freeze({
    "@testing-library/react-native": "13.3.3",
    "@types/jest": "29.5.14",
    "@types/node": "24.3.0",
    "@types/react": "19.2.14",
    eslint: "9.39.5",
    "eslint-config-expo": "57.0.0",
    "expo-doctor": "1.20.0",
    jest: "29.7.0",
    "jest-expo": "57.0.1",
    "react-test-renderer": "19.2.3",
    tsx: "4.20.5",
    typescript: "6.0.3",
  }),
});

export const APPROVED_NATIVE_TRANSITIVE_GRAPH = Object.freeze({
  "expo-modules-core": Object.freeze({
    version: "57.0.3",
    resolved: "https://registry.npmjs.org/expo-modules-core/-/expo-modules-core-57.0.3.tgz",
    integrity: "sha512-fuD3DjPQvdaldtCJm2erV2/trPMrDJvEwPdz0RuxAQnduiNwZ3yxBoi81ZEKC5GBSJauMo53YXSwogsFagjwFQ==",
    license: "MIT",
    requiredBy: Object.freeze({ name: "expo", range: "~57.0.3" }),
  }),
  "expo-modules-jsi": Object.freeze({
    version: "57.0.1",
    resolved: "https://registry.npmjs.org/expo-modules-jsi/-/expo-modules-jsi-57.0.1.tgz",
    integrity: "sha512-dECN3pOFv+KrQcGrOhJKEBc1/ob7SBjTTYGRB1bc84zmQ65La0FSrAPxpvnEQf8g9giLB5y9RLqwGxHspjXigQ==",
    license: "MIT",
    requiredBy: Object.freeze({ name: "expo-modules-core", range: "~57.0.1" }),
  }),
});

export const APPROVED_APP_LICENSES = Object.freeze({
  "@react-native-vector-icons/lucide": "MIT",
  "@react-navigation/bottom-tabs": "MIT",
  "@react-navigation/native": "MIT",
  expo: "MIT",
  "expo-dev-client": "MIT",
  "expo-secure-store": "MIT",
  "expo-sqlite": "MIT",
  react: "MIT",
  "react-native": "MIT",
  "react-native-safe-area-context": "MIT",
  "react-native-screens": "MIT",
  "@testing-library/react-native": "MIT",
  "@types/jest": "MIT",
  "@types/node": "MIT",
  "@types/react": "MIT",
  eslint: "MIT",
  "eslint-config-expo": "MIT",
  "expo-doctor": "MIT",
  jest: "MIT",
  "jest-expo": "MIT",
  "react-test-renderer": "MIT",
  tsx: "MIT",
  typescript: "Apache-2.0",
});

function declarations(packageJson) {
  return [
    ...Object.entries(packageJson.dependencies ?? {}).map(([name, version]) => ({ name, version, kind: "runtime" })),
    ...Object.entries(packageJson.devDependencies ?? {}).map(([name, version]) => ({ name, version, kind: "development" })),
  ];
}

function approvedDeclarations() {
  return Object.entries(APPROVED_APP_DEPENDENCIES).flatMap(([kind, packages]) =>
    Object.entries(packages).map(([name, version]) => ({ name, version, kind })),
  );
}

function canonicalNpmTarballUrl(name, version) {
  const tarballName = name.slice(name.lastIndexOf("/") + 1);
  return `${npmRegistry}/${name}/-/${tarballName}-${version}.tgz`;
}

export function validateAppDependencyPolicy(packageJson, packageLock, artifactLock, licenseInventory) {
  assert.deepEqual(
    packageJson.expo?.install?.exclude,
    APPROVED_EXPO_INSTALL_EXCLUSIONS,
    "Expo install exclusions must exactly match the approved ordered native-regression exceptions",
  );
  const declared = declarations(packageJson);
  const approved = approvedDeclarations();
  assert.deepEqual(
    declared.map(({ name, version, kind }) => ({ name, version, kind })).sort((a, b) => a.name.localeCompare(b.name)),
    approved.sort((a, b) => a.name.localeCompare(b.name)),
    "Root app dependencies must exactly match the approved names, versions, and ownership",
  );
  const declaredByName = new Map(declared.map((item) => [item.name, item]));
  const lockedItems = artifactLock.packages;
  const artifactByName = new Map(lockedItems.map((item) => [item.name, item]));
  const licenseItems = [...licenseInventory.direct_dependencies, ...licenseInventory.development_dependencies];
  const licenseByName = new Map(licenseItems.map((item) => [item.name, item]));
  assert.equal(declaredByName.size, declared.length, "A package cannot be both runtime and development owned");
  assert.equal(artifactByName.size, lockedItems.length, "App dependency lock contains duplicates");
  assert.equal(licenseByName.size, licenseItems.length, "App license inventory contains duplicates");
  const expectedNames = [...declaredByName.keys()].sort();
  assert.deepEqual(Object.keys(APPROVED_APP_LICENSES).sort(), expectedNames, "Approved app license map must cover every root declaration exactly once");
  assert.deepEqual([...artifactByName.keys()].sort(), expectedNames, "App dependency lock must cover every approved root declaration exactly once");
  assert.deepEqual([...licenseByName.keys()].sort(), expectedNames, "App license inventory must cover every approved root declaration exactly once");
  assert.equal(artifactLock.schema_version, 1, "App dependency schema must be version 1");
  assert.equal(artifactLock.registry, npmRegistry, `App dependency lock registry must exactly match ${npmRegistry}`);
  assert.equal(licenseInventory.schema_version, 1, "App license schema must be version 1");
  assert.equal(packageLock.lockfileVersion, 3, "Root npm lockfile version must be 3");
  for (const [name, approved] of Object.entries(APPROVED_NATIVE_TRANSITIVE_GRAPH)) {
    const installed = packageLock.packages[`node_modules/${name}`];
    assert(installed && !installed.link, `${name} is missing or linked in the root package lock`);
    assert.equal(installed.version, approved.version, `${name} native transitive version drifted`);
    assert.equal(installed.integrity, approved.integrity, `${name} native transitive integrity drifted`);
    assert.equal(installed.license, approved.license, `${name} native transitive license drifted`);
    assert.equal(installed.resolved, approved.resolved, `${name} native transitive registry resolution drifted`);
    const parent = packageLock.packages[`node_modules/${approved.requiredBy.name}`];
    assert(parent && !parent.link, `${approved.requiredBy.name} is missing or linked in the root package lock`);
    assert.equal(
      parent.dependencies?.[name],
      approved.requiredBy.range,
      `${approved.requiredBy.name} dependency on ${name} must exactly match ${approved.requiredBy.range}`,
    );
  }
  for (const [name, declaration] of declaredByName) {
    assert.match(declaration.version, exactVersion, `${name} must be exact-pinned`);
    const artifact = artifactByName.get(name);
    assert.equal(artifact.version, declaration.version, `${name} app artifact version drifted`);
    assert.equal(artifact.kind, declaration.kind, `${name} app artifact ownership drifted`);
    assert.match(artifact.integrity, registryIntegrity, `${name} app artifact has no SHA-512 integrity`);
    const installed = packageLock.packages[`node_modules/${name}`];
    assert(installed && !installed.link, `${name} is missing or linked in the root package lock`);
    assert.equal(installed.version, declaration.version, `${name} root lock version drifted`);
    assert.equal(installed.integrity, artifact.integrity, `${name} root lock integrity drifted`);
    assert.equal(installed.resolved, canonicalNpmTarballUrl(name, declaration.version), `${name} root lock registry resolution drifted`);
    const license = licenseByName.get(name);
    assert.equal(license.version, declaration.version, `${name} license version drifted`);
    assert.equal(license.kind, declaration.kind, `${name} license ownership drifted`);
    assert.equal(license.license, APPROVED_APP_LICENSES[name], `${name} license/SPDX value drifted`);
    assert.match(license.maintenance_status ?? "", /^(active|maintenance|deprecated)$/, `${name} has no valid maintenance status`);
    for (const field of ["purpose", "platform_support", "removal_path"]) {
      assert.equal(typeof license[field], "string", `${name} has no ${field} metadata`);
      assert(license[field].trim(), `${name} has empty ${field} metadata`);
    }
  }
  assert.equal(declaredByName.has("eventsource-parser"), false, "eventsource-parser must remain spike-only");
  assert.deepEqual(licenseInventory.audit_policy?.fail_levels, ["high", "critical"], "App audit policy must fail high and critical findings");
  return { runtime: Object.keys(APPROVED_APP_DEPENDENCIES.runtime).length, development: Object.keys(APPROVED_APP_DEPENDENCIES.development).length };
}

export async function checkAppDependencies(mode, root = repoRoot) {
  assert(["--dependencies", "--licenses"].includes(mode), "Usage: check-app-dependencies.mjs --dependencies|--licenses");
  const [packageJson, packageLock, artifactLock, licenseInventory] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "dependencies.app.lock.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "licenses.app.json"), "utf8").then(JSON.parse),
  ]);
  const result = validateAppDependencyPolicy(packageJson, packageLock, artifactLock, licenseInventory);
  console.log(JSON.stringify({
    [mode === "--dependencies" ? "dependencies" : "licenses"]: "pass",
    scope: "root-app",
    runtime_packages: result.runtime,
    development_packages: result.development,
    exact_pins: true,
    registry_integrities: true,
    spike_only_excluded: ["eventsource-parser"],
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkAppDependencies(process.argv[2]);
}
