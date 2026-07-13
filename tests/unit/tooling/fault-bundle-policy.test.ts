import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  FAULT_BUNDLE_EXPORT_FLAGS,
  FAULT_BUNDLE_PLATFORMS,
  FAULT_CONTROLLER_SENTINEL,
  validateFaultBundleProof,
} from "../../../tools/check-fault-bundles.mjs";

const sha = "b".repeat(40);
const platforms = FAULT_BUNDLE_PLATFORMS as readonly ("android" | "ios")[];

type BundleEntry = {
  path: string;
  bytes: number;
  sha256: string;
  sentinelOccurrences: number;
  metadata: { path: string; bytes: number; sha256: string };
};

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

test("Metro rejects inherited-property and unknown build flavors instead of resolving them", () => {
  for (const flavor of ["constructor", "toString", "__proto__", "preview"]) {
    const result = resolverTarget(flavor);
    assert.notEqual(result.status, 0, flavor);
    assert.match(result.stderr, new RegExp(`Unsupported EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: ${flavor}`));
  }
});

async function fixture(production: string, e2e: string) {
  const root = await mkdtemp(join(tmpdir(), "g018-fault-bundles-"));
  const entries = {} as Record<"android" | "ios", Record<"production" | "e2e", BundleEntry>>;
  for (const platform of platforms) {
    entries[platform] = {} as Record<"production" | "e2e", BundleEntry>;
    for (const [flavor, source] of [["production", production], ["e2e", e2e]] as const) {
      const path = `.artifacts/fault-bundles/${platform}/${flavor}/_expo/static/js/${platform}/index.js`;
      const bundlePath = `_expo/static/js/${platform}/index.js`;
      const bytes = Buffer.from(`${platform}:${source}`);
      const metadataPath = `.artifacts/fault-bundles/${platform}/${flavor}/metadata.json`;
      const metadataBytes = Buffer.from(JSON.stringify({ version: 0, bundler: "metro", fileMetadata: { [platform]: { bundle: bundlePath, assets: [] } } }));
      await mkdir(dirname(join(root, path)), { recursive: true });
      await Promise.all([writeFile(join(root, path), bytes), writeFile(join(root, metadataPath), metadataBytes)]);
      entries[platform][flavor] = {
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sentinelOccurrences: source.split(FAULT_CONTROLLER_SENTINEL).length - 1,
        metadata: {
          path: metadataPath,
          bytes: metadataBytes.length,
          sha256: createHash("sha256").update(metadataBytes).digest("hex"),
        },
      };
    }
  }
  return {
    root,
    proof: { schemaVersion: 2, checkedOutSha: sha, platforms: FAULT_BUNDLE_PLATFORMS, exportFlags: FAULT_BUNDLE_EXPORT_FLAGS, sentinel: FAULT_CONTROLLER_SENTINEL, bundles: entries },
  };
}

test("text-bundle proof requires the sentinel absent from production and present in E2E on both platforms", async () => {
  const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
  try {
    const result = await validateFaultBundleProof(proof, { root, expectedSha: sha });
    for (const platform of platforms) {
      assert.equal(result[platform].production.sentinelOccurrences, 0);
      assert.equal(result[platform].e2e.sentinelOccurrences, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("text-bundle proof rejects hostile evidence independently for all four platform-flavor bundles", async () => {
  for (const platform of platforms) {
    for (const [flavor, source, expected] of [
      ["production", FAULT_CONTROLLER_SENTINEL, /production bundle contains/],
      ["e2e", "e2e-without-controller", /E2E bundle does not contain/],
    ] as const) {
      const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
      try {
        const entry = proof.bundles[platform][flavor];
        const bytes = Buffer.from(`${platform}:${source}`);
        await writeFile(join(root, entry.path), bytes);
        entry.bytes = bytes.length;
        entry.sha256 = createHash("sha256").update(bytes).digest("hex");
        entry.sentinelOccurrences = source.split(FAULT_CONTROLLER_SENTINEL).length - 1;
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }

  const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
  try {
    await writeFile(join(root, proof.bundles.ios.e2e.path), "forged");
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /byte count disagrees|hash disagrees/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("text-bundle proof rejects missing platform evidence and cross-platform canonical paths", async () => {
  const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
  try {
    delete (proof.bundles as any).ios;
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /unknown or missing platform fields/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const hostile = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
  try {
    hostile.proof.bundles.ios.e2e.path = hostile.proof.bundles.android.e2e.path;
    await assert.rejects(validateFaultBundleProof(hostile.proof, { root: hostile.root, expectedSha: sha }), /ios e2e bundle path is outside/);
  } finally {
    await rm(hostile.root, { recursive: true, force: true });
  }
});

test("text-bundle proof rejects unknown or missing schema-v2 keys at every owned level", async () => {
  const mutations = [
    (proof: any) => { proof.extra = true; },
    (proof: any) => { delete proof.sentinel; },
    (proof: any) => { proof.bundles.web = {}; },
    (proof: any) => { proof.bundles.android.preview = {}; },
    (proof: any) => { delete proof.bundles.android.production; },
    (proof: any) => { proof.bundles.android.production.extra = true; },
    (proof: any) => { delete proof.bundles.android.production.path; },
    (proof: any) => { delete proof.bundles.android.production.metadata.sha256; },
  ];
  for (const mutate of mutations) {
    const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
    try {
      mutate(proof);
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /unknown or missing/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("text-bundle proof binds retained metadata to its claimed platform and canonical bundle", async () => {
  for (const mutation of ["relabeled-platform", "extra-key", "wrong-bundle"] as const) {
    const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
    try {
      const entry = proof.bundles.android.e2e;
      const metadataPath = join(root, entry.metadata.path);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      if (mutation === "relabeled-platform") {
        metadata.fileMetadata.ios = metadata.fileMetadata.android;
        delete metadata.fileMetadata.android;
      } else if (mutation === "extra-key") {
        metadata.fileMetadata.android.extra = true;
      } else {
        metadata.fileMetadata.android.bundle = "_expo/static/js/android/other.js";
      }
      const bytes = Buffer.from(JSON.stringify(metadata));
      await writeFile(metadataPath, bytes);
      entry.metadata.bytes = bytes.length;
      entry.metadata.sha256 = createHash("sha256").update(bytes).digest("hex");
      await assert.rejects(
        validateFaultBundleProof(proof, { root, expectedSha: sha }),
        /metadata contains unknown or missing platform fields|metadata platform entry contains unknown or missing fields|metadata bundle does not match/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("text-bundle proof rejects hostile retained Expo metadata version and bundler values", async () => {
  for (const [field, value, message] of [
    ["version", 1, /metadata version must remain 0/],
    ["bundler", "webpack", /metadata bundler must remain metro/],
  ] as const) {
    const { root, proof } = await fixture("production-no-op", `e2e:${FAULT_CONTROLLER_SENTINEL}`);
    try {
      const entry = proof.bundles.android.e2e;
      const metadataPath = join(root, entry.metadata.path);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata[field] = value;
      const bytes = Buffer.from(JSON.stringify(metadata));
      await writeFile(metadataPath, bytes);
      entry.metadata.bytes = bytes.length;
      entry.metadata.sha256 = createHash("sha256").update(bytes).digest("hex");
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
