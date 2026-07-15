import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GENERATED_PATHS = [
  ".artifacts", ".expo", ".expo-export", "android", "ios", "coverage", "dist", "build", "knowledge/generated",
  "spikes/model-transport/.expo", "spikes/model-transport/.expo-export", "spikes/model-transport/android", "spikes/model-transport/ios",
  "spikes/backup-crypto/.expo", "spikes/backup-crypto/.expo-export", "spikes/backup-crypto/android", "spikes/backup-crypto/ios",
  "spikes/sqlite-fts/.expo", "spikes/sqlite-fts/.expo-export", "spikes/sqlite-fts/.generated", "spikes/sqlite-fts/android", "spikes/sqlite-fts/ios",
];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIRECTORIES = new Set([".git", ".omx", "node_modules"]);

function containedPath(root, candidate) {
  const path = resolve(root, candidate);
  const fromRoot = relative(root, path);
  assert(fromRoot && !fromRoot.startsWith("..") && !isAbsolute(fromRoot), `Refusing path outside repository: ${candidate}`);
  assert(!fromRoot.split(/[\\/]/).some((part) => part === ".git" || part === ".omx"), `Refusing protected path: ${candidate}`);
  return { path, fromRoot };
}

async function findPythonCaches(root, directory = root) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") matches.push(path);
      else matches.push(...await findPythonCaches(root, path));
    } else if (entry.name.endsWith(".pyc")) matches.push(path);
  }
  return matches;
}

function readTrackedPaths(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  assert.equal(result.status, 0, `Unable to inspect tracked paths: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

function assertUntracked(target, trackedPaths, root) {
  const fromRoot = relative(root, target).replaceAll("\\", "/");
  const prefix = `${fromRoot}/`;
  assert(!trackedPaths.some((tracked) => tracked === fromRoot || tracked.startsWith(prefix)), `Refusing to delete tracked path: ${fromRoot}`);
}

export async function cleanGenerated({ root = repoRoot, generatedPaths = GENERATED_PATHS, trackedPaths = readTrackedPaths(root) } = {}) {
  const normalizedRoot = resolve(root);
  const explicit = generatedPaths.map((candidate) => containedPath(normalizedRoot, candidate).path);
  const pythonCaches = await findPythonCaches(normalizedRoot);
  const targets = [...new Set([...explicit, ...pythonCaches])];
  for (const target of targets) assertUntracked(target, trackedPaths, normalizedRoot);
  await Promise.all(targets.map((path) => rm(path, { recursive: true, force: true })));
  return { generatedPaths: explicit.length, pythonCaches: pythonCaches.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await cleanGenerated();
  console.log(JSON.stringify({ cleanup: "pass", generated_paths: result.generatedPaths, python_caches: result.pythonCaches }));
}
