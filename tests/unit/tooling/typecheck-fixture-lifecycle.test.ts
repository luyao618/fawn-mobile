import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { cleanupGeneratedArtifacts } from "../../../tools/run-slice0.mjs";
import { runTypecheck } from "../../../tools/run-typecheck.mjs";

const generatedDirectory = resolve("spikes/sqlite-fts/.generated");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("clean typecheck generates the canonical G015 fixture and removes it", async () => {
  await rm(generatedDirectory, { recursive: true, force: true });
  await runTypecheck();
  assert.equal(await exists(generatedDirectory), false);
});


test("Slice 0 cleanup removes only exact generated artifacts and preserves unrelated sentinels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "slice0-cleanup-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generatedPaths = [
    "spikes/model-transport/.expo/state.json",
    "spikes/model-transport/.expo-export/android/metadata.json",
    "spikes/model-transport/android/generated.txt",
    "spikes/model-transport/ios/generated.txt",
    "spikes/sqlite-fts/.generated/fixture.ts",
    "tools/__pycache__/cache.pyc",
    "tools/knowledge/__pycache__/cache.pyc",
    "tools/knowledge/tests/__pycache__/cache.pyc",
  ];
  const sentinelPaths = [
    ".expo/state.json",
    "android/unrelated.txt",
    "ios/unrelated.txt",
    "knowledge/generated/unrelated.csv",
    "unrelated/__pycache__/cache.pyc",
    "unrelated/keep.txt",
  ];
  for (const relative of [...generatedPaths, ...sentinelPaths]) {
    const path = join(root, relative);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "sentinel");
  }
  const whoOutput = join(root, "who-output.csv");
  await writeFile(whoOutput, "generated");
  await cleanupGeneratedArtifacts(root, whoOutput);
  for (const relative of generatedPaths) assert.equal(await exists(join(root, relative)), false, relative);
  assert.equal(await exists(whoOutput), false);
  for (const relative of sentinelPaths) assert.equal(await exists(join(root, relative)), true, relative);
});
