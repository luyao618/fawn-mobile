import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const spikePackage = JSON.parse(await readFile(new URL("../spikes/model-transport/package.json", import.meta.url), "utf8"));
const inventory = JSON.parse(await readFile(new URL("../licenses.slice0.json", import.meta.url), "utf8"));
const artifactLock = JSON.parse(await readFile(new URL("../dependencies.slice0.lock.json", import.meta.url), "utf8"));

const declarations = { ...rootPackage.devDependencies, ...spikePackage.dependencies, ...spikePackage.devDependencies };
const inventoried = new Map(
  [...inventory.direct_dependencies, ...inventory.development_dependencies].map((item) => [item.name, item]),
);
const locked = new Map(artifactLock.packages.map((item) => [item.name, item]));
for (const [name, version] of Object.entries(declarations)) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must be exact-pinned`);
  const entry = inventoried.get(name);
  assert(entry, `${name} is absent from licenses.slice0.json`);
  assert.equal(entry.version, version, `${name} inventory version drifted`);
  assert(entry.license, `${name} has no recorded license`);
  assert.match(entry.maintenance_status ?? "", /^(active|maintenance|deprecated)$/, `${name} has no valid maintenance status`);
  assert.equal(typeof entry.platform_support, "string", `${name} has no platform support metadata`);
  assert(entry.platform_support.trim(), `${name} has empty platform support metadata`);
  assert.equal(typeof entry.removal_path, "string", `${name} has no removal path metadata`);
  assert(entry.removal_path.trim(), `${name} has empty removal path metadata`);
  const lockedEntry = locked.get(name);
  assert(lockedEntry, `${name} is absent from dependencies.slice0.lock.json`);
  assert.equal(lockedEntry.version, version, `${name} artifact lock version drifted`);
  assert.match(lockedEntry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name} has no SHA-512 registry integrity`);
}
assert.equal(inventoried.size, Object.keys(declarations).length, "License inventory contains undeclared packages");
assert.equal(locked.size, Object.keys(declarations).length, "Artifact lock contains undeclared packages");

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const spikeLock = JSON.parse(await readFile(new URL("../spikes/model-transport/package-lock.json", import.meta.url), "utf8"));
for (const [label, currentLock] of [["root", lock], ["spike", spikeLock]]) {
  assert.equal(currentLock.lockfileVersion, 3, `${label} npm lockfile version must be 3`);
  const expectedDeclarations = label === "root" ? declarations : { ...spikePackage.dependencies, ...spikePackage.devDependencies };
  for (const [name, expected] of Object.entries(expectedDeclarations)) {
    const installed = currentLock.packages[`node_modules/${name}`];
    assert(installed && !installed.link, `${name} is missing or linked in ${label} package-lock.json`);
    assert.equal(installed.version, expected, `${name} ${label} lockfile version drifted`);
    assert.equal(installed.integrity, locked.get(name)?.integrity, `${name} ${label} lockfile integrity drifted`);
  }
}
console.log(JSON.stringify({
  licenses: "pass",
  direct_packages: Object.keys(declarations).length,
  exact_pins: true,
  registry_integrities: true,
  lifecycle_metadata: ["maintenance_status", "platform_support", "removal_path"],
  npm_locks_verified: ["root", "spike"],
}));
