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
export const FAULT_BUNDLE_PLATFORMS = Object.freeze(["android", "ios"]);
export const FAULT_BUNDLE_FLAVORS = Object.freeze(["production", "e2e"]);
export const FAULT_BUNDLE_EXPORT_FLAGS = Object.freeze(["--no-bytecode", "--no-minify", "--clear"]);

const faultPoints = JSON.parse(await readFile(resolve(repoRoot, "src/testing/faultPoints.json"), "utf8"));
const faultPointGrammar = /^[a-z][a-z0-9_.]*$/;
assert(Array.isArray(faultPoints) && faultPoints.length === 13, "Fault point registry must contain exactly 13 points");
assert(
  faultPoints.every((point) => typeof point === "string" && point.length > 0 && faultPointGrammar.test(point)),
  "Fault point registry contains an empty or grammar-unsafe point",
);
assert.equal(new Set(faultPoints).size, faultPoints.length, "Fault point registry contains duplicate points");
const protocolMarker = "formobile-test:";
const modeMarker = "crash_once";
export const FAULT_BUNDLE_MARKERS = Object.freeze([
  FAULT_CONTROLLER_SENTINEL,
  protocolMarker,
  modeMarker,
  ...faultPoints,
]);
assert(FAULT_BUNDLE_MARKERS.every((marker) => marker.length > 0), "Fault bundle markers must be nonempty");
assert.equal(new Set(FAULT_BUNDLE_MARKERS).size, FAULT_BUNDLE_MARKERS.length, "Fault bundle markers must be unique");
assert.deepEqual(FAULT_BUNDLE_MARKERS.slice(3), faultPoints, "Fault bundle point markers must preserve the exact registry");

function expectedCounts(flavor) {
  // Tripwire for the current source topology: sentinel/protocol/mode/each registry point = 1/2/3/1.
  return Object.freeze(Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [
    marker,
    flavor === "production"
      ? 0
      : marker === FAULT_CONTROLLER_SENTINEL
        ? 1
        : marker === protocolMarker
          ? 2
          : marker === modeMarker
            ? 3
            : 1,
  ])));
}

export const FAULT_BUNDLE_EXPECTED_MARKER_COUNTS = Object.freeze({
  production: expectedCounts("production"),
  e2e: expectedCounts("e2e"),
});

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

function markerCounts(bytes) {
  return Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [
    marker,
    occurrences(bytes, Buffer.from(marker)),
  ]));
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function assertMarkerCounts(value, label) {
  assert(hasExactKeys(value, FAULT_BUNDLE_MARKERS), `${label} contains unknown or missing marker fields`);
  for (const marker of FAULT_BUNDLE_MARKERS) {
    assert(Number.isSafeInteger(value[marker]) && value[marker] >= 0, `${label} contains an invalid marker count`);
  }
}

function assertCanonicalBundlePath(path, platform, flavor) {
  const label = `${platform} ${flavor}`;
  const prefix = `.artifacts/fault-bundles/${platform}/${flavor}/`;
  assert.equal(typeof path, "string", `${label} bundle path is absent`);
  assert(path.startsWith(prefix), `${label} bundle path is outside its canonical export directory`);
  assert(!path.split(/[\\/]/).includes(".."), `${label} bundle path contains traversal`);
  assert(
    new RegExp(`^\\.artifacts/fault-bundles/${platform}/${flavor}/_expo/static/js/${platform}/index-[0-9a-f]{32}\\.js$`).test(path),
    `${label} bundle path is not a canonical lowercase-hashed index JavaScript bundle`,
  );
}

async function canonicalBundlePath(root, platform, flavor) {
  const label = `${platform} ${flavor}`;
  const staticDirectory = `.artifacts/fault-bundles/${platform}/${flavor}/_expo/static/js`;
  const staticEntries = await readdir(resolve(root, staticDirectory), { withFileTypes: true });
  assert(
    staticEntries.length === 1 && staticEntries[0].isDirectory() && staticEntries[0].name === platform,
    `${label} export must retain only its canonical platform bundle directory`,
  );
  const directory = `${staticDirectory}/${platform}`;
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  assert.equal(entries.length, 1, `${label} export must retain exactly one canonical JavaScript bundle`);
  const [entry] = entries;
  assert(entry.isFile() && /^index-[0-9a-f]{32}\.js$/.test(entry.name), `${label} bundle must be one canonical regular index JavaScript file`);
  return `${directory}/${entry.name}`;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dependencyBindings(factory) {
  const bindings = [];
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*_dependencyMap\[(\d+)\]\s*\)\s*;/g;
  for (const match of factory.matchAll(pattern)) {
    bindings.push({ name: match[1], dependencyIndex: Number(match[2]) });
  }
  return bindings;
}

function parseMetroModules(bytes, label) {
  const source = bytes.toString("utf8");
  const starts = [];
  for (let offset = 0; (offset = source.indexOf("__d(", offset)) >= 0; offset += 4) starts.push(offset);
  const modules = [];
  const suffixPattern = /}\s*,\s*(\d+)\s*,\s*(\[(?:\s*(?:\d+|null)\s*(?:,\s*(?:\d+|null)\s*)*)?\])\s*\)\s*;/g;

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? source.length;
    const segment = source.slice(start, end);
    const suffixes = [...segment.matchAll(suffixPattern)];
    assert.equal(suffixes.length, 1, `${label} Metro __d wrapper cannot be parsed exactly once`);
    const suffix = suffixes[0];
    const factory = segment.slice("__d(".length, suffix.index + 1);
    assert(
      /^\s*function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*{/.test(factory),
      `${label} Metro __d wrapper factory is invalid`,
    );
    const dependencies = JSON.parse(suffix[2]);
    assert(
      dependencies.every((dependency) => dependency === null || (Number.isSafeInteger(dependency) && dependency >= 0)),
      `${label} Metro dependency map is invalid`,
    );
    const moduleId = Number(suffix[1]);
    assert(Number.isSafeInteger(moduleId) && moduleId >= 0, `${label} Metro module ID is invalid`);
    modules.push({ moduleId, dependencies, factory });
  }

  assert.equal(modules.length, starts.length, `${label} parsed wrapper count disagrees with all __d( occurrences`);
  assert(modules.length > 0, `${label} bundle contains no Metro __d wrappers`);
  assert.equal(new Set(modules.map(({ moduleId }) => moduleId)).size, modules.length, `${label} Metro module IDs must be unique`);
  return modules;
}

function listenerEvidence(module) {
  const factory = module.factory;
  const urlRegistration = factory.match(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?\.addEventListener\(\s*["']url["']\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*;/,
  );
  if (!urlRegistration) return null;
  const subscription = escaped(urlRegistration[1]);
  const handler = escaped(urlRegistration[2]);
  const handlerDeclaration = factory.match(
    new RegExp(`\\b(?:const|let|var)\\s+${handler}\\s*=\\s*\\(\\s*{\\s*url\\s*}\\s*\\)\\s*=>\\s*{([\\s\\S]*?)}\\s*;`),
  );
  if (!handlerDeclaration) return null;
  if (!/\b(?:const|let|var)\s+url\s*=\s*await\s+[^;]*?\.getInitialURL\(\s*\)\s*;/.test(factory)) return null;
  if (!new RegExp(`\\bif\\s*\\(\\s*url\\s*\\)\\s*${handler}\\s*\\(\\s*{\\s*url\\s*}\\s*\\)\\s*;`).test(factory)) return null;
  if ((factory.match(/signal\?\.aborted/g) ?? []).length < 2) return null;
  const abortRegistration = factory.match(/\.addEventListener\(\s*["']abort["']\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*{\s*once\s*:\s*true\s*}\s*\)/);
  if (!abortRegistration) return null;
  const disposeName = abortRegistration[1];
  const dispose = escaped(disposeName);
  const disposeDeclaration = factory.match(new RegExp(`\\b(?:const|let|var)\\s+${dispose}\\s*=\\s*\\(\\)\\s*=>\\s*{([\\s\\S]*?)}\\s*;`));
  if (!disposeDeclaration) return null;
  if (!new RegExp(`\\.removeEventListener\\(\\s*["']abort["']\\s*,\\s*${dispose}\\s*\\)`).test(disposeDeclaration[1])) return null;
  if (!new RegExp(`\\b${subscription}\\.remove\\(\\s*\\)\\s*;`).test(disposeDeclaration[1])) return null;
  if (!new RegExp(`\\breturn\\s+${dispose}\\s*;`).test(factory)) return null;
  if (!new RegExp(`\\b${dispose}\\s*\\(\\s*\\)\\s*;`).test(factory)) return null;

  const parserBindings = dependencyBindings(factory).filter(({ name }) => {
    const binding = escaped(name);
    return new RegExp(`(?:\\(\\s*0\\s*,\\s*)?${binding}\\.parseFaultUrl\\s*\\)?\\s*\\(\\s*url\\s*\\)`).test(handlerDeclaration[1]);
  });
  if (parserBindings.length !== 1) return null;
  return { module, parserDependencyIndex: parserBindings[0].dependencyIndex };
}

function parserEvidence(module) {
  const factory = module.factory;
  const serializer = "return `formobile-test://fault?point=${point}&mode=crash_once`;";
  const grammar = String.raw`/^formobile-test:\/\/fault\?point=([a-z][a-z0-9_.]*)&mode=crash_once$/`;
  const serializerStart = factory.search(/function\s+canonicalFaultUrl\s*\(\s*point\s*\)/);
  const parserStart = factory.search(/function\s+parseFaultUrl\s*\(\s*value\s*\)/);
  if (serializerStart < 0 || parserStart <= serializerStart) return null;
  const serializerSource = factory.slice(serializerStart, parserStart);
  const parserSource = factory.slice(parserStart);
  if (!serializerSource.includes(serializer) || !parserSource.includes(grammar)) return null;
  if (!/new\s+Set\(\s*FAULT_POINTS\s*\)/.test(factory)) return null;
  if (!/!allowed\.has\(\s*point\s*\)/.test(serializerSource) || !/!allowed\.has\(\s*match\[1\]\s*\)/.test(parserSource)) return null;
  if (!/canonicalFaultUrl\(\s*request\.point\s*\)\s*===\s*value\s*\?\s*request\s*:\s*null/.test(parserSource)) return null;

  const registryBindings = dependencyBindings(factory).filter(({ name }) => {
    const importedName = escaped(name);
    const interop = factory.match(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*_interopDefault\\(\\s*${importedName}\\s*\\)\\s*;`));
    if (!interop) return false;
    return new RegExp(`Object\\.freeze\\(\\s*\\[\\s*\\.\\.\\.${escaped(interop[1])}\\.default\\s*\\]\\s*\\)`).test(factory);
  });
  if (registryBindings.length !== 1) return null;
  return { module, registryDependencyIndex: registryBindings[0].dependencyIndex };
}

function registryValue(module) {
  const matches = [...module.factory.matchAll(/module\.exports\s*=\s*(\[[\s\S]*?])\s*;/g)];
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(matches[0][1]);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function moduleGraph(bytes, label, flavor) {
  const modules = parseMetroModules(bytes, label);
  const listeners = modules.map(listenerEvidence).filter(Boolean);
  const parsers = modules.map(parserEvidence).filter(Boolean);
  const registries = modules
    .map((module) => ({ module, value: registryValue(module) }))
    .filter(({ value }) => value && JSON.stringify(value) === JSON.stringify(faultPoints));

  if (flavor === "production") {
    assert.equal(listeners.length, 0, `${label} production bundle contains fault listener structure`);
    assert.equal(parsers.length, 0, `${label} production bundle contains fault parser structure`);
    assert.equal(registries.length, 0, `${label} production bundle contains fault registry structure`);
    return {
      wrapperCount: modules.length,
      listenerModuleId: null,
      parserModuleId: null,
      registryModuleId: null,
      listenerToParser: null,
      parserToRegistry: null,
    };
  }

  assert.equal(listeners.length, 1, `${label} E2E bundle must contain exactly one fault listener structure`);
  assert.equal(parsers.length, 1, `${label} E2E bundle must contain exactly one fault parser structure`);
  assert.equal(registries.length, 1, `${label} E2E bundle must contain exactly one ordered fault registry structure`);
  const listener = listeners[0];
  const parser = parsers[0];
  const registry = registries[0];
  assert.equal(
    occurrences(Buffer.from(listener.module.factory), Buffer.from(FAULT_CONTROLLER_SENTINEL)),
    1,
    `${label} sentinel must identify the listener module exactly once`,
  );
  const parserModuleId = listener.module.dependencies[listener.parserDependencyIndex];
  assert.equal(parserModuleId, parser.module.moduleId, `${label} listener dependency does not resolve to the unique parser module`);
  const registryModuleId = parser.module.dependencies[parser.registryDependencyIndex];
  assert.equal(registryModuleId, registry.module.moduleId, `${label} parser dependency does not resolve to the unique registry module`);
  assert.equal(registry.module.dependencies.length, 0, `${label} fault registry module must not have dependencies`);

  return {
    wrapperCount: modules.length,
    listenerModuleId: listener.module.moduleId,
    parserModuleId: parser.module.moduleId,
    registryModuleId: registry.module.moduleId,
    listenerToParser: { dependencyIndex: listener.parserDependencyIndex, moduleId: parserModuleId },
    parserToRegistry: { dependencyIndex: parser.registryDependencyIndex, moduleId: registryModuleId },
  };
}

/**
 * @param {any} proof
 * @param {{ root?: string, expectedSha?: string }} [options]
 * @returns {Promise<Record<"android" | "ios", Record<"production" | "e2e", {
 *     path: string,
 *     bytes: number,
 *     sha256: string,
 *     observedMarkerCounts: Record<string, number>,
 *     moduleGraph: object
 *   }>>>}
 */
export async function validateFaultBundleProof(proof, options = {}) {
  const { root = repoRoot, expectedSha } = options;
  assert(
    hasExactKeys(proof, ["schemaVersion", "checkedOutSha", "platforms", "exportFlags", "markers", "expectedMarkerCounts", "bundles"]),
    "Fault bundle proof contains unknown or missing root fields",
  );
  assert.equal(proof?.schemaVersion, 3, "Fault bundle proof schema is invalid");
  assert.equal(proof?.checkedOutSha, expectedSha, "Fault bundle proof SHA disagrees with the exact checkout");
  assert.deepEqual(proof?.platforms, FAULT_BUNDLE_PLATFORMS, "Fault bundle proof platforms are invalid");
  assert.deepEqual(proof?.exportFlags, FAULT_BUNDLE_EXPORT_FLAGS, "Fault bundle proof must use text bundles without minification");
  assert.deepEqual(proof?.markers, FAULT_BUNDLE_MARKERS, "Fault bundle proof markers are invalid");
  assert(
    hasExactKeys(proof?.expectedMarkerCounts, FAULT_BUNDLE_FLAVORS),
    "Fault bundle proof expected counts contain unknown or missing flavor fields",
  );
  for (const flavor of FAULT_BUNDLE_FLAVORS) {
    assertMarkerCounts(proof.expectedMarkerCounts[flavor], `${flavor} expected marker counts`);
    assert.deepEqual(
      proof.expectedMarkerCounts[flavor],
      FAULT_BUNDLE_EXPECTED_MARKER_COUNTS[flavor],
      "Fault bundle proof expected marker counts are invalid",
    );
  }
  assert(hasExactKeys(proof?.bundles, FAULT_BUNDLE_PLATFORMS), "Fault bundle proof contains unknown or missing platform fields");

  const bundles = {};
  for (const platform of FAULT_BUNDLE_PLATFORMS) {
    assert(hasExactKeys(proof.bundles[platform], FAULT_BUNDLE_FLAVORS), `${platform} fault bundle proof contains unknown or missing flavor fields`);
    bundles[platform] = {};
    for (const flavor of FAULT_BUNDLE_FLAVORS) {
      const label = `${platform} ${flavor}`;
      const entry = proof?.bundles?.[platform]?.[flavor];
      assert(entry && typeof entry === "object", `${label} fault bundle evidence is absent`);
      assert(
        hasExactKeys(entry, ["path", "bytes", "sha256", "observedMarkerCounts", "metadata"]),
        `${label} fault bundle entry contains unknown or missing fields`,
      );
      assertMarkerCounts(entry.observedMarkerCounts, `${label} observed marker counts`);
      assert(hasExactKeys(entry.metadata, ["path", "bytes", "sha256"]), `${label} metadata evidence contains unknown or missing fields`);
      assertCanonicalBundlePath(entry.path, platform, flavor);
      assert.equal(await canonicalBundlePath(root, platform, flavor), entry.path, `${label} proof does not identify the sole canonical bundle`);
      const absolute = resolve(root, entry.path);
      assert.equal(relative(resolve(root), absolute).split(sep)[0], ".artifacts", `${label} bundle resolves outside retained artifacts`);
      const stat = await lstat(absolute);
      assert(stat.isFile() && !stat.isSymbolicLink(), `${label} bundle must be a retained regular file`);
      const bytes = await readFile(absolute);
      assert(bytes.length > 0, `${label} bundle is empty`);
      assert.equal(entry.bytes, bytes.length, `${label} bundle byte count disagrees`);
      assert.equal(entry.sha256, sha256(bytes), `${label} bundle hash disagrees`);
      const observedMarkerCounts = markerCounts(bytes);
      for (const marker of FAULT_BUNDLE_MARKERS) {
        assert.equal(
          entry.observedMarkerCounts[marker],
          observedMarkerCounts[marker],
          `${label} observed marker count disagrees for ${JSON.stringify(marker)}`,
        );
        assert.equal(
          observedMarkerCounts[marker],
          FAULT_BUNDLE_EXPECTED_MARKER_COUNTS[flavor][marker],
          `${label} marker count is invalid for ${JSON.stringify(marker)}`,
        );
      }
      const graph = moduleGraph(bytes, label, flavor);
      const exportPrefix = `.artifacts/fault-bundles/${platform}/${flavor}/`;
      assert.equal(entry.metadata.path, `${exportPrefix}metadata.json`, `${label} metadata path is not canonical`);
      const metadataAbsolute = resolve(root, entry.metadata.path);
      const metadataStat = await lstat(metadataAbsolute);
      assert(metadataStat.isFile() && !metadataStat.isSymbolicLink(), `${label} metadata must be a retained regular file`);
      const metadataBytes = await readFile(metadataAbsolute);
      assert.equal(entry.metadata.bytes, metadataBytes.length, `${label} metadata byte count disagrees`);
      assert.equal(entry.metadata.sha256, sha256(metadataBytes), `${label} metadata hash disagrees`);
      const metadata = JSON.parse(metadataBytes.toString("utf8"));
      assert(hasExactKeys(metadata, ["version", "bundler", "fileMetadata"]), `${label} Expo metadata contains unknown or missing root fields`);
      assert.equal(metadata.version, 0, `${label} Expo metadata version must remain 0`);
      assert.equal(metadata.bundler, "metro", `${label} Expo metadata bundler must remain metro`);
      assert(hasExactKeys(metadata.fileMetadata, [platform]), `${label} Expo metadata contains unknown or missing platform fields`);
      assert(hasExactKeys(metadata.fileMetadata[platform], ["bundle", "assets"]), `${label} Expo metadata platform entry contains unknown or missing fields`);
      assert(Array.isArray(metadata.fileMetadata[platform].assets), `${label} Expo metadata assets must be an array`);
      assert.equal(`${exportPrefix}${metadata.fileMetadata[platform].bundle}`, entry.path, `${label} Expo metadata bundle does not match the validated canonical bundle`);
      bundles[platform][flavor] = {
        path: entry.path,
        bytes: bytes.length,
        sha256: entry.sha256,
        observedMarkerCounts,
        moduleGraph: graph,
      };
    }
  }
  return bundles;
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
    schemaVersion: 3,
    checkedOutSha: gitHead(),
    platforms: FAULT_BUNDLE_PLATFORMS,
    exportFlags: FAULT_BUNDLE_EXPORT_FLAGS,
    markers: FAULT_BUNDLE_MARKERS,
    expectedMarkerCounts: FAULT_BUNDLE_EXPECTED_MARKER_COUNTS,
    bundles: {},
  };
  for (const platform of FAULT_BUNDLE_PLATFORMS) {
    proof.bundles[platform] = {};
    for (const flavor of FAULT_BUNDLE_FLAVORS) {
      const output = resolve(root, `.artifacts/fault-bundles/${platform}/${flavor}`);
      const args = ["--no-install", "expo", "export", "--output-dir", output, "--platform", platform, ...FAULT_BUNDLE_EXPORT_FLAGS];
      const result = spawnSync("npx", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: flavor },
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${platform} ${flavor} text export failed:\n${result.stdout}\n${result.stderr}`);
      const path = await canonicalBundlePath(root, platform, flavor);
      const bytes = await readFile(resolve(root, path));
      const metadataPath = relative(root, resolve(output, "metadata.json")).split(sep).join("/");
      const metadataBytes = await readFile(resolve(output, "metadata.json"));
      proof.bundles[platform][flavor] = {
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        observedMarkerCounts: markerCounts(bytes),
        metadata: { path: metadataPath, bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
      };
    }
  }
  await validateFaultBundleProof(proof, { root, expectedSha: proof.checkedOutSha });
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ faultBundles: "pass", proof: FAULT_BUNDLE_PROOF_PATH, checkedOutSha: proof.checkedOutSha }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildFaultBundleProof();
