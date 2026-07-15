import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const moduleUrl = new URL("../../../tools/clean-generated.mjs", import.meta.url).href;

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

function subprocess(script: string, cwd: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8" });
}

test("cleanup is anchored to the repository and leaves a foreign CWD android directory untouched", async () => {
  const foreign = await mkdtemp(join(tmpdir(), "g018-foreign-cwd-"));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "g018-clean-entrypoint-"));
  try {
    await mkdir(join(foreign, "android"));
    await writeFile(join(foreign, "android", "user-file"), "keep");
    await mkdir(join(fixtureRoot, "tools"), { recursive: true });
    await mkdir(join(fixtureRoot, "android"));
    await writeFile(join(fixtureRoot, "android", "generated-file"), "remove");
    await writeFile(join(fixtureRoot, "tools", "clean-generated.mjs"), await readFile(resolve("tools/clean-generated.mjs")));
    const fakeBin = join(fixtureRoot, "fake-bin");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "git"), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, "git"), 0o755);
    const toolPath = await realpath(join(fixtureRoot, "tools", "clean-generated.mjs"));
    const result = spawnSync(process.execPath, [toolPath], {
      cwd: foreign,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(join(fixtureRoot, "android")), false);
    assert.equal(await readFile(join(foreign, "android", "user-file"), "utf8"), "keep");
  } finally {
    await rm(foreign, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("cleanup skips .omx and refuses traversal and tracked paths without deleting user files", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-clean-root-"));
  const outside = await mkdtemp(join(tmpdir(), "g018-clean-outside-"));
  try {
    await mkdir(join(root, ".omx", "cache", "__pycache__"), { recursive: true });
    await writeFile(join(root, ".omx", "cache", "__pycache__", "user.pyc"), "keep");
    await mkdir(join(root, "android"));
    await writeFile(join(root, "android", "tracked.txt"), "keep");
    await writeFile(join(outside, "user.txt"), "keep");

    const protectedResult = subprocess(`
      import { cleanGenerated } from ${JSON.stringify(moduleUrl)};
      await cleanGenerated({ root: ${JSON.stringify(root)}, generatedPaths: ["android"], trackedPaths: ["android/tracked.txt"] });
    `, root);
    assert.notEqual(protectedResult.status, 0);
    assert.match(protectedResult.stderr, /Refusing to delete tracked path/);
    assert.equal(await readFile(join(root, "android", "tracked.txt"), "utf8"), "keep");

    const traversalResult = subprocess(`
      import { cleanGenerated } from ${JSON.stringify(moduleUrl)};
      await cleanGenerated({ root: ${JSON.stringify(root)}, generatedPaths: [${JSON.stringify(`../${outside.split("/").pop()}`)}], trackedPaths: [] });
    `, root);
    assert.notEqual(traversalResult.status, 0);
    assert.match(traversalResult.stderr, /outside repository/);
    assert.equal(await readFile(join(outside, "user.txt"), "utf8"), "keep");

    const cleanResult = subprocess(`
      import { cleanGenerated } from ${JSON.stringify(moduleUrl)};
      await cleanGenerated({ root: ${JSON.stringify(root)}, generatedPaths: ["android"], trackedPaths: [] });
    `, root);
    assert.equal(cleanResult.status, 0, cleanResult.stderr);
    assert.equal(await exists(join(root, "android")), false);
    assert.equal(await readFile(join(root, ".omx", "cache", "__pycache__", "user.pyc"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
