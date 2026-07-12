import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const registryIntegrity = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

export function validateSlice0LicenseArtifacts(inventory, artifactLock) {
  assert.equal(inventory.schema_version, 1, "Slice 0 license schema must remain version 1");
  assert.equal(artifactLock.schema_version, 1, "Slice 0 dependency schema must remain version 1");
  const inventoriedItems = [...inventory.direct_dependencies, ...inventory.development_dependencies];
  const inventoried = new Map(inventoriedItems.map((item) => [item.name, item]));
  const locked = new Map(artifactLock.packages.map((item) => [item.name, item]));
  assert.equal(inventoried.size, inventoriedItems.length, "Slice 0 license inventory contains duplicate packages");
  assert.equal(locked.size, artifactLock.packages.length, "Slice 0 artifact lock contains duplicate packages");
  assert.deepEqual([...inventoried.keys()].sort(), [...locked.keys()].sort(), "Frozen Slice 0 inventories disagree on package ownership");
  for (const [name, entry] of inventoried) {
    assert.match(entry.version, exactVersion, `${name} must be exact-pinned`);
    assert(entry.license, `${name} has no recorded license`);
    assert.match(entry.maintenance_status ?? "", /^(active|maintenance|deprecated)$/, `${name} has no valid maintenance status`);
    assert.equal(typeof entry.platform_support, "string", `${name} has no platform support metadata`);
    assert(entry.platform_support.trim(), `${name} has empty platform support metadata`);
    assert.equal(typeof entry.removal_path, "string", `${name} has no removal path metadata`);
    assert(entry.removal_path.trim(), `${name} has empty removal path metadata`);
    const lockedEntry = locked.get(name);
    assert.equal(lockedEntry.version, entry.version, `${name} frozen artifact versions disagree`);
    assert.match(lockedEntry.integrity, registryIntegrity, `${name} has no SHA-512 registry integrity`);
  }
  assert.deepEqual(inventory.audit_policy?.fail_levels, ["high", "critical"], "Slice 0 audit policy must fail high and critical findings");
  return { directPackages: inventoried.size };
}

export async function checkSlice0Licenses(root = repoRoot) {
  const [inventory, artifactLock] = await Promise.all([
    readFile(resolve(root, "licenses.slice0.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "dependencies.slice0.lock.json"), "utf8").then(JSON.parse),
  ]);
  const result = validateSlice0LicenseArtifacts(inventory, artifactLock);
  console.log(JSON.stringify({
    licenses: "pass",
    scope: "frozen-slice0-artifacts",
    direct_packages: result.directPackages,
    exact_pins: true,
    registry_integrities: true,
    lifecycle_metadata: ["maintenance_status", "platform_support", "removal_path"],
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkSlice0Licenses();
}
