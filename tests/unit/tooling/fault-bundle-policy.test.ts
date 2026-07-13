import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  FAULT_BUNDLE_EXPORT_FLAGS,
  FAULT_CONTROLLER_SENTINEL,
  validateFaultBundleProof,
} from "../../../tools/check-fault-bundles.mjs";

const sha = "b".repeat(40);

type BundleEntry = { path: string; bytes: number; sha256: string; sentinelOccurrences: number };

function resolverTarget(flavor: string) {
  const program = String.raw`
    const config = require("./metro.config.cjs");
    const context = { resolveRequest(_context, moduleName, platform) { return { moduleName, platform }; } };
    process.stdout.write(JSON.stringify(config.resolver.resolveRequest(context, "@for-mobile/fault-controller", "android")));
  `;
  return spawnSync("node", ["-e", program], {
    encoding: "utf8",
    env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: flavor },
  });
}

test("Metro resolves the stable fault-controller specifier to standalone flavor modules", () => {
  const production = resolverTarget("production");
  const e2e = resolverTarget("e2e");
  assert.equal(production.status, 0, production.stderr);
  assert.equal(e2e.status, 0, e2e.stderr);
  assert.match(JSON.parse(production.stdout).moduleName, /src\/testing\/FaultController\.production\.ts$/);
  assert.match(JSON.parse(e2e.stdout).moduleName, /src\/testing\/FaultController\.e2e\.ts$/);
  assert.notEqual(JSON.parse(production.stdout).moduleName, JSON.parse(e2e.stdout).moduleName);
});

test("Metro rejects unknown build flavors instead of falling back to E2E or production", () => {
  const result = resolverTarget("preview");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: preview/);
});

async function fixture(production: string, e2e: string) {
  const root = await mkdtemp(join(tmpdir(), "g018-fault-bundles-"));
  const entries = {} as Record<"production" | "e2e", BundleEntry>;
  for (const [flavor, source] of [["production", production], ["e2e", e2e]] as const) {
    const path = `.artifacts/fault-bundles/${flavor}/_expo/static/js/android/index.js`;
    const bytes = Buffer.from(source);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    entries[flavor] = {
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sentinelOccurrences: source.split(FAULT_CONTROLLER_SENTINEL).length - 1,
    };
  }
  return {
    root,
    proof: { schemaVersion: 1, checkedOutSha: sha, exportFlags: FAULT_BUNDLE_EXPORT_FLAGS, sentinel: FAULT_CONTROLLER_SENTINEL, bundles: entries },
  };
}

test("text-bundle proof requires the sentinel absent from production and present in E2E", async () => {
  const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
  try {
    const result = await validateFaultBundleProof(proof, { root, expectedSha: sha });
    assert.equal(result.production.sentinelOccurrences, 0);
    assert.equal(result.e2e.sentinelOccurrences, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("text-bundle proof rejects production leakage, E2E omission, and retained-byte drift", async () => {
  for (const [production, e2e, expected] of [
    [FAULT_CONTROLLER_SENTINEL, FAULT_CONTROLLER_SENTINEL, /Production bundle contains/],
    ["production-no-op", "e2e-without-controller", /E2E bundle does not contain/],
  ] as const) {
    const { root, proof } = await fixture(production, e2e);
    try {
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
  try {
    await writeFile(join(root, proof.bundles.e2e.path), "forged");
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /byte count disagrees|hash disagrees/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
