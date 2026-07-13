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
const protocolMarker = "formobile-test:";
const modeMarker = "crash_once";
const platforms = FAULT_BUNDLE_PLATFORMS as readonly ("android" | "ios")[];
const faultPoints = JSON.parse(await readFile("src/testing/faultPoints.json", "utf8")) as string[];
const markers = [FAULT_CONTROLLER_SENTINEL, protocolMarker, modeMarker, ...faultPoints];
const expectedMarkerCounts = {
  production: Object.fromEntries(markers.map((marker) => [marker, 0])),
  e2e: Object.fromEntries(markers.map((marker) => [
    marker,
    marker === FAULT_CONTROLLER_SENTINEL ? 1 : marker === protocolMarker ? 2 : marker === modeMarker ? 3 : 1,
  ])),
};

type MarkerCounts = Record<string, number>;
type BundleEntry = {
  path: string;
  bytes: number;
  sha256: string;
  observedMarkerCounts: MarkerCounts;
  metadata: { path: string; bytes: number; sha256: string };
};
type Proof = {
  schemaVersion: number;
  checkedOutSha: string;
  platforms: readonly string[];
  exportFlags: readonly string[];
  markers: string[];
  expectedMarkerCounts: { production: MarkerCounts; e2e: MarkerCounts };
  bundles: Record<"android" | "ios", Record<"production" | "e2e", BundleEntry>>;
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

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function markerCounts(bytes: Buffer): MarkerCounts {
  return Object.fromEntries(markers.map((marker) => {
    let count = 0;
    let offset = 0;
    const needle = Buffer.from(marker);
    while ((offset = bytes.indexOf(needle, offset)) >= 0) {
      count += 1;
      offset += needle.length;
    }
    return [marker, count];
  }));
}

function sourceFor(flavor: "production" | "e2e", override?: { marker: string; count: number }) {
  const counts = { ...expectedMarkerCounts[flavor] };
  if (override) counts[override.marker] = override.count;
  const tokens = markers.flatMap((marker) => Array.from({ length: counts[marker] }, () => marker));
  return tokens.length === 0 ? "production-no-op" : tokens.join("|");
}

async function fixture(production = sourceFor("production"), e2e = sourceFor("e2e")) {
  const root = await mkdtemp(join(tmpdir(), "g018-fault-bundles-"));
  const entries = {} as Proof["bundles"];
  for (const platform of platforms) {
    entries[platform] = {} as Record<"production" | "e2e", BundleEntry>;
    for (const [flavor, source] of [["production", production], ["e2e", e2e]] as const) {
      const path = `.artifacts/fault-bundles/${platform}/${flavor}/_expo/static/js/${platform}/index.js`;
      const bundlePath = `_expo/static/js/${platform}/index.js`;
      const bytes = Buffer.from(`${platform}:${source}`);
      const metadataPath = `.artifacts/fault-bundles/${platform}/${flavor}/metadata.json`;
      const metadataBytes = Buffer.from(JSON.stringify({
        version: 0,
        bundler: "metro",
        fileMetadata: { [platform]: { bundle: bundlePath, assets: [] } },
      }));
      await mkdir(dirname(join(root, path)), { recursive: true });
      await Promise.all([writeFile(join(root, path), bytes), writeFile(join(root, metadataPath), metadataBytes)]);
      entries[platform][flavor] = {
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        observedMarkerCounts: markerCounts(bytes),
        metadata: { path: metadataPath, bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
      };
    }
  }
  const proof: Proof = {
    schemaVersion: 3,
    checkedOutSha: sha,
    platforms: FAULT_BUNDLE_PLATFORMS,
    exportFlags: FAULT_BUNDLE_EXPORT_FLAGS,
    markers: [...markers],
    expectedMarkerCounts: {
      production: { ...expectedMarkerCounts.production },
      e2e: { ...expectedMarkerCounts.e2e },
    },
    bundles: entries,
  };
  return { root, proof };
}

async function replaceBundle(
  root: string,
  proof: Proof,
  platform: "android" | "ios",
  flavor: "production" | "e2e",
  source: string,
) {
  const entry = proof.bundles[platform][flavor];
  const bytes = Buffer.from(`${platform}:${source}`);
  await writeFile(join(root, entry.path), bytes);
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  entry.observedMarkerCounts = markerCounts(bytes);
}

async function withFixture(
  run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  production?: string,
  e2e?: string,
) {
  const value = await fixture(production, e2e);
  try {
    await run(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
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

test("schema-v3 marker projection uses only the exact runtime strings and ordered fault registry", async () => {
  await withFixture(async ({ root, proof }) => {
    const result = await validateFaultBundleProof(proof, { root, expectedSha: sha });
    assert.deepEqual(result.markers, [FAULT_CONTROLLER_SENTINEL, "formobile-test:", "crash_once", ...faultPoints]);
    assert.deepEqual(result.expectedMarkerCounts, expectedMarkerCounts);
    for (const platform of platforms) {
      assert.deepEqual(result.bundles[platform].production.observedMarkerCounts, expectedMarkerCounts.production);
      assert.deepEqual(result.bundles[platform].e2e.observedMarkerCounts, expectedMarkerCounts.e2e);
    }
  });
});

test("semantic proof independently rejects every marker missing or duplicated in E2E and leaking into production", async (t) => {
  for (const marker of markers) {
    const expected = expectedMarkerCounts.e2e[marker];
    for (const [scenario, production, e2e] of [
      ["missing from E2E", sourceFor("production"), sourceFor("e2e", { marker, count: expected - 1 })],
      ["duplicated in E2E", sourceFor("production"), sourceFor("e2e", { marker, count: expected + 1 })],
      ["leaking into production", sourceFor("production", { marker, count: 1 }), sourceFor("e2e")],
    ] as const) {
      await t.test(`${JSON.stringify(marker)} ${scenario}`, async () => {
        await withFixture(async ({ root, proof }) => {
          await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /marker count is invalid/);
        }, production, e2e);
      });
    }
  }
});

test("semantic counts are enforced independently in every platform-flavor bundle", async () => {
  for (const platform of platforms) {
    for (const flavor of ["production", "e2e"] as const) {
      await withFixture(async ({ root, proof }) => {
        const count = flavor === "production" ? 1 : 0;
        await replaceBundle(root, proof, platform, flavor, sourceFor(flavor, { marker: FAULT_CONTROLLER_SENTINEL, count }));
        await assert.rejects(
          validateFaultBundleProof(proof, { root, expectedSha: sha }),
          new RegExp(`${platform} ${flavor} marker count is invalid`),
        );
      });
    }
  }
});

test("proof recomputes every observed count from retained bundle bytes", async () => {
  for (const marker of markers) {
    await withFixture(async ({ root, proof }) => {
      proof.bundles.android.e2e.observedMarkerCounts[marker] += 1;
      await assert.rejects(
        validateFaultBundleProof(proof, { root, expectedSha: sha }),
        new RegExp(`android e2e observed marker count disagrees`),
      );
    });
  }
});

test("proof rejects schema, SHA, platform, export-flag, marker-order, and expected-count drift", async () => {
  const mutations: { mutate: (proof: Proof) => void; message: RegExp }[] = [
    { mutate: (proof) => { proof.schemaVersion = 2; }, message: /schema is invalid/ },
    { mutate: (proof) => { proof.checkedOutSha = "c".repeat(40); }, message: /SHA disagrees/ },
    { mutate: (proof) => { proof.platforms = ["ios", "android"]; }, message: /platforms are invalid/ },
    { mutate: (proof) => { proof.exportFlags = ["--no-bytecode", "--clear"]; }, message: /without minification/ },
    { mutate: (proof) => { proof.markers = [...proof.markers].reverse(); }, message: /markers are invalid/ },
    { mutate: (proof) => { proof.expectedMarkerCounts.e2e[modeMarker] = 2; }, message: /expected marker counts are invalid/ },
  ];
  for (const { mutate, message } of mutations) {
    await withFixture(async ({ root, proof }) => {
      mutate(proof);
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), message);
    });
  }
});

test("proof rejects unknown or missing schema-v3 keys at every owned level", async () => {
  const mutations = [
    (proof: any) => { proof.extra = true; },
    (proof: any) => { delete proof.markers; },
    (proof: any) => { proof.expectedMarkerCounts.preview = {}; },
    (proof: any) => { delete proof.expectedMarkerCounts.production[FAULT_CONTROLLER_SENTINEL]; },
    (proof: any) => { proof.bundles.web = {}; },
    (proof: any) => { proof.bundles.android.preview = {}; },
    (proof: any) => { delete proof.bundles.android.production; },
    (proof: any) => { proof.bundles.android.production.extra = true; },
    (proof: any) => { delete proof.bundles.android.production.observedMarkerCounts; },
    (proof: any) => { proof.bundles.android.production.observedMarkerCounts.extra = 0; },
    (proof: any) => { delete proof.bundles.android.production.metadata.sha256; },
  ];
  for (const mutate of mutations) {
    await withFixture(async ({ root, proof }) => {
      mutate(proof);
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /unknown or missing/);
    });
  }
});

test("proof binds byte counts and hashes to every retained canonical bundle", async () => {
  for (const platform of platforms) {
    for (const flavor of ["production", "e2e"] as const) {
      await withFixture(async ({ root, proof }) => {
        proof.bundles[platform][flavor].bytes += 1;
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bundle byte count disagrees/);
      });
      await withFixture(async ({ root, proof }) => {
        proof.bundles[platform][flavor].sha256 = "0".repeat(64);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bundle hash disagrees/);
      });
    }
  }
});

test("proof rejects missing platform evidence and cross-platform canonical paths", async () => {
  await withFixture(async ({ root, proof }) => {
    delete (proof.bundles as any).ios;
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /unknown or missing platform fields/);
  });
  await withFixture(async ({ root, proof }) => {
    proof.bundles.ios.e2e.path = proof.bundles.android.e2e.path;
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /ios e2e bundle path is outside/);
  });
});

test("proof binds retained metadata to its claimed platform and canonical bundle", async () => {
  for (const mutation of ["relabeled-platform", "extra-key", "wrong-bundle"] as const) {
    await withFixture(async ({ root, proof }) => {
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
      entry.metadata.sha256 = sha256(bytes);
      await assert.rejects(
        validateFaultBundleProof(proof, { root, expectedSha: sha }),
        /metadata contains unknown or missing platform fields|metadata platform entry contains unknown or missing fields|metadata bundle does not match/,
      );
    });
  }
});

test("proof rejects hostile retained metadata bytes, hashes, version, and bundler", async () => {
  for (const [mutation, message] of [
    ["bytes", /metadata byte count disagrees/],
    ["hash", /metadata hash disagrees/],
    ["version", /metadata version must remain 0/],
    ["bundler", /metadata bundler must remain metro/],
  ] as const) {
    await withFixture(async ({ root, proof }) => {
      const entry = proof.bundles.android.e2e;
      if (mutation === "bytes") entry.metadata.bytes += 1;
      else if (mutation === "hash") entry.metadata.sha256 = "0".repeat(64);
      else {
        const metadataPath = join(root, entry.metadata.path);
        const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        if (mutation === "version") metadata.version = 1;
        else metadata.bundler = "webpack";
        const bytes = Buffer.from(JSON.stringify(metadata));
        await writeFile(metadataPath, bytes);
        entry.metadata.bytes = bytes.length;
        entry.metadata.sha256 = sha256(bytes);
      }
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), message);
    });
  }
});
