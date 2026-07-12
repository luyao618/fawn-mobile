import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateSlice0LicenseArtifacts } from "../../../tools/check-licenses.mjs";

test("Slice 0 license ownership is derived only from its two frozen artifacts", async () => {
  const inventory = JSON.parse(await readFile("licenses.slice0.json", "utf8"));
  const artifact = JSON.parse(await readFile("dependencies.slice0.lock.json", "utf8"));
  assert.doesNotThrow(() => validateSlice0LicenseArtifacts(inventory, artifact));
  const mutableRoot = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(mutableRoot.devDependencies.typescript, "6.0.3");
  assert.equal(artifact.packages.find((item: { name: string }) => item.name === "typescript").version, "5.9.3");
});

test("Slice 0 artifact disagreement fails closed", async () => {
  const inventory = JSON.parse(await readFile("licenses.slice0.json", "utf8"));
  const artifact = JSON.parse(await readFile("dependencies.slice0.lock.json", "utf8"));
  artifact.packages = artifact.packages.filter((item: { name: string }) => item.name !== "tsx");
  assert.throws(() => validateSlice0LicenseArtifacts(inventory, artifact), /ownership/);
});
