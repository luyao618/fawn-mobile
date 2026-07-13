import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const FAULT_CONTROLLER_SENTINEL = "FOR_MOBILE_E2E_FAULT_CONTROLLER_REAL_V1";
export const FAULT_BUNDLE_PROOF_PATH = ".artifacts/fault-bundles/proof.json";
export const FAULT_BUNDLE_EXPORT_FLAGS = ["--platform", "android", "--no-bytecode", "--no-minify", "--clear"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function occurrences(bytes, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = bytes.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files.sort();
}

function assertCanonicalBundlePath(path, flavor) {
  const prefix = `.artifacts/fault-bundles/${flavor}/`;
  assert(path.startsWith(prefix), `${flavor} bundle path is outside its canonical export directory`);
  assert(!path.split(/[\\/]/).includes(".."), `${flavor} bundle path contains traversal`);
}

/**
 * @param {any} proof
 * @param {{ root?: string, expectedSha?: string }} [options]
 * @returns {Promise<Record<"production" | "e2e", { path: string, bytes: number, sha256: string, sentinelOccurrences: number }>>}
 */
export async function validateFaultBundleProof(proof, options = {}) {
  const { root = repoRoot, expectedSha } = options;
  assert.equal(proof?.schemaVersion, 1, "Fault bundle proof schema is invalid");
  assert.equal(proof?.checkedOutSha, expectedSha, "Fault bundle proof SHA disagrees with the exact checkout");
  assert.deepEqual(proof?.exportFlags, FAULT_BUNDLE_EXPORT_FLAGS, "Fault bundle proof must use text bundles without minification");
  assert.equal(proof?.sentinel, FAULT_CONTROLLER_SENTINEL, "Fault bundle proof sentinel is invalid");
  const summary = {};
  for (const flavor of ["production", "e2e"]) {
    const entry = proof?.bundles?.[flavor];
    assert(entry && typeof entry === "object", `${flavor} fault bundle evidence is absent`);
    assertCanonicalBundlePath(entry.path, flavor);
    const absolute = resolve(root, entry.path);
    assert.equal(relative(resolve(root), absolute).split(sep)[0], ".artifacts", `${flavor} bundle resolves outside retained artifacts`);
    const stat = await lstat(absolute);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${flavor} bundle must be a retained regular file`);
    const bytes = await readFile(absolute);
    assert(bytes.length > 0, `${flavor} bundle is empty`);
    assert.equal(entry.bytes, bytes.length, `${flavor} bundle byte count disagrees`);
    assert.equal(entry.sha256, sha256(bytes), `${flavor} bundle hash disagrees`);
    const count = occurrences(bytes, Buffer.from(FAULT_CONTROLLER_SENTINEL));
    assert.equal(entry.sentinelOccurrences, count, `${flavor} sentinel count disagrees`);
    if (flavor === "production") assert.equal(count, 0, "Production bundle contains the real E2E fault controller sentinel");
    else assert(count > 0, "E2E bundle does not contain the real fault controller sentinel");
    summary[flavor] = { path: entry.path, bytes: bytes.length, sha256: entry.sha256, sentinelOccurrences: count };
  }
  return summary;
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export async function buildFaultBundleProof(root = repoRoot) {
  const proofPath = resolve(root, FAULT_BUNDLE_PROOF_PATH);
  await rm(dirname(proofPath), { recursive: true, force: true });
  await mkdir(dirname(proofPath), { recursive: true });
  const proof = {
    schemaVersion: 1,
    checkedOutSha: gitHead(),
    exportFlags: FAULT_BUNDLE_EXPORT_FLAGS,
    sentinel: FAULT_CONTROLLER_SENTINEL,
    bundles: {},
  };
  for (const flavor of ["production", "e2e"]) {
    const output = resolve(root, `.artifacts/fault-bundles/${flavor}`);
    const args = ["--no-install", "expo", "export", "--output-dir", output, ...FAULT_BUNDLE_EXPORT_FLAGS];
    const result = spawnSync("npx", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: flavor },
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${flavor} text export failed:\n${result.stdout}\n${result.stderr}`);
    const files = await javascriptFiles(output);
    assert.equal(files.length, 1, `${flavor} export must contain exactly one JavaScript bundle`);
    const path = relative(root, files[0]).split(sep).join("/");
    const bytes = await readFile(files[0]);
    proof.bundles[flavor] = {
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      sentinelOccurrences: occurrences(bytes, Buffer.from(FAULT_CONTROLLER_SENTINEL)),
    };
  }
  await validateFaultBundleProof(proof, { root, expectedSha: proof.checkedOutSha });
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ faultBundles: "pass", proof: FAULT_BUNDLE_PROOF_PATH, checkedOutSha: proof.checkedOutSha }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildFaultBundleProof();
