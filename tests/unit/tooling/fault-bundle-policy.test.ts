import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
const listenerModuleId = 101;
const parserModuleId = 202;
const registryModuleId = 303;
const appModuleId = 404;
const entryModuleId = 505;
const runtimeModuleId = 900;
const rootRuntimeModuleId = 901;
const alternateRuntimeModuleId = 902;
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
  return tokens.length === 0 ? "productionNoOp;" : `void ${JSON.stringify(tokens)};`;
}

function metroModule(moduleId: number, dependencies: (number | null)[], body: string) {
  return `__d(function (global, require, _importDefault, _importAll, module, exports, _dependencyMap) {\n${body}\n},${moduleId},${JSON.stringify(dependencies)});`;
}

const listenerBody = [
  "exports.installFaultController = installFaultController;",
  'var _reactNative = require(_dependencyMap[0]);',
  'var _faultContract = require(_dependencyMap[1]);',
  `var E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL = "${FAULT_CONTROLLER_SENTINEL}";`,
  "async function installFaultController(onFault, signal) {",
  "  if (signal?.aborted) return () => {};",
  "  var handleUrl = ({ url }) => {",
  "    if (signal?.aborted) return;",
  "    var request = (0, _faultContract.parseFaultUrl)(url);",
  "    if (request) onFault(request);",
  "  };",
  '  var subscription = _reactNative.Linking.addEventListener("url", handleUrl);',
  "  var dispose = () => {",
  '    signal?.removeEventListener("abort", dispose);',
  "    subscription.remove();",
  "  };",
  '  signal?.addEventListener("abort", dispose, { once: true });',
  "  try {",
  "    var url = await _reactNative.Linking.getInitialURL();",
  "    if (url) handleUrl({ url });",
  "    return dispose;",
  "  } catch (error) {",
  "    dispose();",
  "    throw error;",
  "  }",
  "}",
].join("\n");

const parserBody = [
  "exports.canonicalFaultUrl = canonicalFaultUrl;",
  "exports.parseFaultUrl = parseFaultUrl;",
  "function _interopDefault(value) { return value && value.__esModule ? value : { default: value }; }",
  'var _faultPointsJson = require(_dependencyMap[0]);',
  "var faultPoints = _interopDefault(_faultPointsJson);",
  "var FAULT_POINTS = Object.freeze([...faultPoints.default]);",
  "var allowed = new Set(FAULT_POINTS);",
  "function canonicalFaultUrl(point) {",
  "  if (!allowed.has(point)) throw new Error(`Unknown fault point: ${point}`);",
  "  return `formobile-test://fault?point=${point}&mode=crash_once`;",
  "}",
  "function parseFaultUrl(value) {",
  String.raw`  var match = /^formobile-test:\/\/fault\?point=([a-z][a-z0-9_.]*)&mode=crash_once$/.exec(value);`,
  "  if (!match || !allowed.has(match[1])) return null;",
  '  var request = { point: match[1], mode: "crash_once" };',
  "  return canonicalFaultUrl(request.point) === value ? request : null;",
  "}",
].join("\n");

const appBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "var _forMobileFaultController = require(_dependencyMap[0]);",
  "function FaultControllerHost({ installFaults }) { return installFaults(() => {}, undefined); }",
  "function AppComposition({ installFaults = _forMobileFaultController.installFaultController }) {",
  "  return FaultControllerHost({ installFaults: installFaults });",
  "}",
  "function App() { return AppComposition({}); }",
  "exports.AppComposition = AppComposition;",
  "exports.default = App;",
].join("\n");

const productionControllerBody = [
  "exports.installFaultController = installFaultController;",
  "var noOp = () => {};",
  "async function installFaultController() { return noOp; }",
].join("\n");

function rootedBundle(controllerId: number, modules: string[]) {
  return [
    metroModule(entryModuleId, [rootRuntimeModuleId, appModuleId], [
      "function _interopDefault(value) { return value && value.__esModule ? value : { default: value }; }",
      "var _expo = require(_dependencyMap[0]);",
      "var _App = require(_dependencyMap[1]);",
      "var App = _interopDefault(_App);",
      "_expo.registerRootComponent(App.default);",
    ].join("\n")),
    metroModule(appModuleId, [controllerId], appBody),
    ...modules,
    metroModule(rootRuntimeModuleId, [], [
      "exports.registerRootComponent = function registerRootComponent(App) {",
      "  global.__registeredDefaultApp = App;",
      "  global.__appExecution = Promise.resolve(App());",
      "};",
    ].join("\n")),
    `__r(${entryModuleId});`,
  ].join("\n");
}

function e2eBundleSource() {
  const registryBody = `module.exports = ${JSON.stringify(faultPoints, null, 2)};`;
  return rootedBundle(listenerModuleId, [
    metroModule(listenerModuleId, [900, parserModuleId], listenerBody),
    metroModule(parserModuleId, [registryModuleId], parserBody),
    metroModule(registryModuleId, [], registryBody),
    metroModule(runtimeModuleId, [], [
      "exports.Linking = {",
      "  addEventListener: function addEventListener(type, handler) {",
      "    if (type !== 'url' || typeof handler !== 'function') throw new Error('invalid listener');",
      "    global.__listenerSetupReached = true;",
      "    return { remove: function remove() {} };",
      "  },",
      "  getInitialURL: async function getInitialURL() { return null; },",
      "};",
    ].join("\n")),
  ]);
}

function productionBundleSource() {
  return rootedBundle(listenerModuleId, [metroModule(listenerModuleId, [], productionControllerBody)]);
}

function sourceWithMarkerCount(flavor: "production" | "e2e", marker: string, count: number) {
  let source = flavor === "production" ? productionBundleSource() : e2eBundleSource();
  const expected = expectedMarkerCounts[flavor][marker];
  for (let index = count; index < expected; index += 1) source = replaceOnce(source, marker, `removed-marker-${index}`);
  for (let index = expected; index < count; index += 1) source += `\n/* ${marker} */`;
  return source;
}

function replaceOnce(source: string, before: string, after: string) {
  assert(source.includes(before), `fixture mutation target is absent: ${before}`);
  return source.replace(before, after);
}

function executeSyntheticBundle(source: string) {
  const harness = String.raw`
    const factories = new Map();
    const cache = new Map();
    global.__d = (factory, id, dependencies) => factories.set(id, { factory, dependencies });
    global.__r = (id) => {
      if (cache.has(id)) return cache.get(id).exports;
      const definition = factories.get(id);
      if (!definition) throw new Error("undefined synthetic Metro module " + id);
      const module = { exports: {} };
      cache.set(id, module);
      definition.factory(global, global.__r, undefined, undefined, module, module.exports, definition.dependencies);
      return module.exports;
    };
    ${source}
    Promise.resolve(global.__appExecution).then(() => {
      if (typeof global.__registeredDefaultApp !== "function") throw new Error("default App was not registered");
      if (!global.__listenerSetupReached) throw new Error("listener setup path was not reached");
      process.stdout.write("listener-setup-reached");
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  return spawnSync("node", ["-e", harness], { encoding: "utf8" });
}

async function fixture(production = productionBundleSource(), e2e = e2eBundleSource()) {
  const root = await mkdtemp(join(tmpdir(), "g018-fault-bundles-"));
  const entries = {} as Proof["bundles"];
  for (const platform of platforms) {
    entries[platform] = {} as Record<"production" | "e2e", BundleEntry>;
    for (const [flavor, source] of [["production", production], ["e2e", e2e]] as const) {
      const bundlePath = `_expo/static/js/${platform}/index-${flavor === "production" ? "a" : "b"}.js`;
      const canonicalBundlePath = bundlePath.replace(/index-([ab])\.js$/, (_match, digit) => `index-${digit.repeat(32)}.js`);
      const path = `.artifacts/fault-bundles/${platform}/${flavor}/${canonicalBundlePath}`;
      const bytes = Buffer.from(source);
      const metadataPath = `.artifacts/fault-bundles/${platform}/${flavor}/metadata.json`;
      const metadataBytes = Buffer.from(JSON.stringify({
        version: 0,
        bundler: "metro",
        fileMetadata: { [platform]: { bundle: canonicalBundlePath, assets: [] } },
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
  const bytes = Buffer.from(source);
  await writeFile(join(root, entry.path), bytes);
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  entry.observedMarkerCounts = markerCounts(bytes);
}

async function rewriteMetadataBundle(root: string, entry: BundleEntry, platform: "android" | "ios", bundle: string) {
  const metadataPath = join(root, entry.metadata.path);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.fileMetadata[platform].bundle = bundle;
  const bytes = Buffer.from(JSON.stringify(metadata));
  await writeFile(metadataPath, bytes);
  entry.metadata.bytes = bytes.length;
  entry.metadata.sha256 = sha256(bytes);
}

async function relocateBundle(
  root: string,
  proof: Proof,
  platform: "android" | "ios",
  flavor: "production" | "e2e",
  bundlePath: string,
) {
  const entry = proof.bundles[platform][flavor];
  const oldPath = join(root, entry.path);
  const bytes = await readFile(oldPath);
  const newRelativePath = `.artifacts/fault-bundles/${platform}/${flavor}/${bundlePath}`;
  const newPath = join(root, newRelativePath);
  await mkdir(dirname(newPath), { recursive: true });
  await writeFile(newPath, bytes);
  await rm(oldPath);
  entry.path = newRelativePath;
  await rewriteMetadataBundle(root, entry, platform, bundlePath);
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

test("fault registry and marker projection stay exact, unique, nonempty, ordered, and grammar-safe", () => {
  assert.equal(faultPoints.length, 13);
  assert.equal(new Set(faultPoints).size, 13);
  assert(faultPoints.every((point) => point.length > 0 && /^[a-z][a-z0-9_.]*$/.test(point)));
  assert.deepEqual(markers, [FAULT_CONTROLLER_SENTINEL, "formobile-test:", "crash_once", ...faultPoints]);
  assert.equal(new Set(markers).size, markers.length);
  assert(markers.every((marker) => marker.length > 0));
});

test("schema-v4 collector leaves retain the established sentinelOccurrences shape", async () => {
  await withFixture(async ({ root, proof }) => {
    const result = await validateFaultBundleProof(proof, { root, expectedSha: sha });
    assert.deepEqual(Object.keys(result), ["android", "ios"]);
    assert.equal((result as any).bundles, undefined);
    for (const platform of platforms) {
      assert.deepEqual(Object.keys(result[platform].production), ["path", "bytes", "sha256", "sentinelOccurrences"]);
      assert.deepEqual(Object.keys(result[platform].e2e), ["path", "bytes", "sha256", "sentinelOccurrences"]);
      assert.equal(result[platform].production.sentinelOccurrences, 0);
      assert.equal(result[platform].e2e.sentinelOccurrences, 1);
    }
  });
});

test("synthetic Metro evidence executes the registered default App through listener setup", () => {
  const result = executeSyntheticBundle(e2eBundleSource());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "listener-setup-reached");
});

test("reachability ignores dependencies confined to dead branches or after unconditional termination", async (t) => {
  const mutations = [
    ["dead nested branch", "_expo.registerRootComponent(App.default);", "_expo.registerRootComponent(App.default);\nif (false) require(_dependencyMap[2]);"],
    ["after early termination", "_expo.registerRootComponent(App.default);", "_expo.registerRootComponent(App.default);\nreturn;\nrequire(_dependencyMap[2]);"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const source = replaceOnce(e2eBundleSource(), before, after)
        .replace(`},${entryModuleId},[${rootRuntimeModuleId},${appModuleId}]);`, `},${entryModuleId},[${rootRuntimeModuleId},${appModuleId},9999]);`);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", source);
        await validateFaultBundleProof(proof, { root, expectedSha: sha });
      });
    });
  }
});

test("unused optional null dependency slots remain outside the proven graph", async () => {
  const source = e2eBundleSource().replace(
    `},${entryModuleId},[${rootRuntimeModuleId},${appModuleId}]);`,
    `},${entryModuleId},[${rootRuntimeModuleId},${appModuleId},null]);`,
  );
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "ios", "e2e", source);
    await validateFaultBundleProof(proof, { root, expectedSha: sha });
  });
});

test("bundle proof requires executing Metro roots and a defined reachable App dependency graph", async (t) => {
  const mutations = [
    ["no roots", (source: string) => source.replaceAll(`__r(${entryModuleId});`, "")],
    ["undefined root", (source: string) => source.replace(`__r(${entryModuleId});`, "__r(9999);")],
    [
      "undefined App edge",
      (source: string) => source.replace(
        `},${entryModuleId},[${rootRuntimeModuleId},${appModuleId}]);`,
        `},${entryModuleId},[${rootRuntimeModuleId},9999]);`,
      ),
    ],
    [
      "null App edge",
      (source: string) => source.replace(
        `},${entryModuleId},[${rootRuntimeModuleId},${appModuleId}]);`,
        `},${entryModuleId},[${rootRuntimeModuleId},null]);`,
      ),
    ],
    [
      "App ignores controller",
      (source: string) => source.replace(
        "installFaults = _forMobileFaultController.installFaultController",
        "installFaults = async function () { return () => {}; }",
      ),
    ],
  ] as const;
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", mutate(e2eBundleSource()));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /root|reachable|App|dependency/i);
      });
    });
  }
});

test("listener evidence must execute in the final export and deliver parsed requests", async (t) => {
  const decoys = [
    ["block comment", `/*\n${listenerBody}\n*/`],
    ["string literal", `var decoy = ${JSON.stringify(listenerBody)};`],
  ] as const;
  for (const [name, decoy] of decoys) {
    await t.test(name, async () => {
      const source = replaceOnce(e2eBundleSource(), listenerBody, decoy);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", source);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /listener|export|installFaultController/i);
      });
    });
  }
  await t.test("drops onFault(request)", async () => {
    const source = replaceOnce(e2eBundleSource(), "if (request) onFault(request);", "if (request) void request;");
    await withFixture(async ({ root, proof }) => {
      await replaceBundle(root, proof, "ios", "e2e", source);
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /onFault|listener/i);
    });
  });
  for (const [name, before, after] of [
    [
      "unconditional return before listener installation",
      "  var handleUrl = ({ url }) => {",
      "  return () => {};\n  var handleUrl = ({ url }) => {",
    ],
    [
      "disconnected parser result",
      "    var request = (0, _faultContract.parseFaultUrl)(url);\n    if (request) onFault(request);",
      "    var parsed = (0, _faultContract.parseFaultUrl)(url);\n    var request = { point: url };\n    if (request) onFault(request);",
    ],
    [
      "parser result reassignment",
      "    var request = (0, _faultContract.parseFaultUrl)(url);\n    if (request) onFault(request);",
      "    var request = (0, _faultContract.parseFaultUrl)(url);\n    request = { point: url };\n    if (request) onFault(request);",
    ],
  ] as const) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /listener|parse|return|control|binding/i);
      });
    });
  }
});

test("selected module exports reject every unrecognized mutation path", async (t) => {
  const mutations = [
    ["App Object.assign", appBody, `${appBody}\nObject.assign(exports, { default: function Other() {} });`],
    ["App direct assignment", appBody, `${appBody}\nexports.default = function Other() {};`],
    ["controller Reflect.set", listenerBody, `${listenerBody}\nReflect.set(exports, "installFaultController", function () {});`],
    ["controller alias write", listenerBody, `${listenerBody}\nvar exportAlias = exports;\nexportAlias.installFaultController = function () {};`],
    ["parser defineProperties", parserBody, `${parserBody}\nObject.defineProperties(exports, { parseFaultUrl: { value: function () {} } });`],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /export|mutation|App|listener|parser/i);
      });
    });
  }
});

test("default App and root registration are bound to AppComposition", async (t) => {
  const mutations = [
    ["default App no-op", "function App() { return AppComposition({}); }", "function App() { return null; }"],
    ["root registers another value", "_expo.registerRootComponent(App.default);", "_expo.registerRootComponent(function Other() {});"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /App|default|root|register/i);
      });
    });
  }
});

test("Linking listener and initial URL calls share one defined imported runtime namespace", async (t) => {
  const extraRuntime = metroModule(alternateRuntimeModuleId, [], "exports.Linking = exports.Linking;");
  const mutations = [
    [
      "null runtime dependency",
      (source: string) => source.replace(`[${runtimeModuleId},${parserModuleId}]`, `[null,${parserModuleId}]`),
    ],
    [
      "undefined runtime dependency",
      (source: string) => source.replace(`[${runtimeModuleId},${parserModuleId}]`, `[9999,${parserModuleId}]`),
    ],
    [
      "mismatched receiver",
      (source: string) => replaceOnce(
        source.replace(listenerBody, `var _otherRuntime = require(_dependencyMap[2]);\n${listenerBody}`)
          .replace(`[${runtimeModuleId},${parserModuleId}]`, `[${runtimeModuleId},${parserModuleId},${alternateRuntimeModuleId}]`)
          .replace(metroModule(rootRuntimeModuleId, [], [
            "exports.registerRootComponent = function registerRootComponent(App) {",
            "  global.__registeredDefaultApp = App;",
            "  global.__appExecution = Promise.resolve(App());",
            "};",
          ].join("\n")), `${extraRuntime}\n${metroModule(rootRuntimeModuleId, [], [
            "exports.registerRootComponent = function registerRootComponent(App) {",
            "  global.__registeredDefaultApp = App;",
            "  global.__appExecution = Promise.resolve(App());",
            "};",
          ].join("\n"))}`),
        "await _reactNative.Linking.getInitialURL()",
        "await _otherRuntime.Linking.getInitialURL()",
      ),
    ],
  ] as const;
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", mutate(e2eBundleSource()));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /runtime|Linking|dependency|listener|undefined|null/i);
      });
    });
  }
});

test("parser and registry evidence must be the final live exports", async (t) => {
  const mutations = [
    ["parser early return", (source: string) => replaceOnce(source, "function parseFaultUrl(value) {", "function parseFaultUrl(value) {\n  return null;")],
    ["parser export overwrite", (source: string) => replaceOnce(source, parserBody, `${parserBody}\nexports.parseFaultUrl = function () { return null; };`)],
    [
      "parser defineProperty overwrite",
      (source: string) => replaceOnce(source, parserBody, `${parserBody}\nObject.defineProperty(exports, "parseFaultUrl", { value: function () { return null; } });`),
    ],
    ["parser binding overwrite", (source: string) => replaceOnce(source, parserBody, `${parserBody}\nparseFaultUrl = function () { return null; };`)],
    [
      "registry overwrite",
      (source: string) => replaceOnce(
        source,
        `module.exports = ${JSON.stringify(faultPoints, null, 2)};`,
        `module.exports = ${JSON.stringify(faultPoints, null, 2)};\nmodule.exports = [];`,
      ),
    ],
  ] as const;
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", mutate(e2eBundleSource()));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /parser|registry|export|return/i);
      });
    });
  }
});

test("listener, parser, and registry must be distinct reachable modules", async () => {
  const combinedParser = parserBody.replace("require(_dependencyMap[0])", "require(_dependencyMap[2])");
  const registryBody = `module.exports = ${JSON.stringify(faultPoints, null, 2)};`;
  const collapsed = rootedBundle(listenerModuleId, [
    metroModule(listenerModuleId, [runtimeModuleId, listenerModuleId, registryModuleId], `${listenerBody}\n${combinedParser}`),
    metroModule(registryModuleId, [], registryBody),
    metroModule(runtimeModuleId, [], "exports.Linking = {};"),
  ]);
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "android", "e2e", collapsed);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /distinct|listener|parser/i);
  });
});

test("production App reaches the exact exported no-op controller", async () => {
  const hostile = replaceOnce(
    productionBundleSource(),
    "async function installFaultController() { return noOp; }",
    "async function installFaultController() { return function hostile() { throw new Error('live'); }; }",
  );
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "ios", "production", hostile);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /production|no-op|controller/i);
  });
});

test("marker-only token bags cannot impersonate Metro listener-parser-registry evidence", async () => {
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "android", "e2e", sourceFor("e2e"));
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /Metro|listener|module/i);
  });
});

test("every executable __d call must be a top-level Metro wrapper", async () => {
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "android", "e2e", `${e2eBundleSource()}\nfunction hostile() { __d(function () {}, 999, []); }`);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /Metro|wrapper|__d/i);
  });
});

test("production rejects marker-free listener behavior", async () => {
  const markerFreeListener = listenerBody.replace(
    `var E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL = "${FAULT_CONTROLLER_SENTINEL}";\n`,
    "",
  );
  const productionWithListener = rootedBundle(listenerModuleId, [
    metroModule(listenerModuleId, [runtimeModuleId, parserModuleId], markerFreeListener),
    metroModule(parserModuleId, [], "exports.parseFaultUrl = function () { return null; };"),
    metroModule(runtimeModuleId, [], "exports.Linking = {};"),
  ]);
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "ios", "production", productionWithListener);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /production.*(?:listener|controller|no-op)|listener.*production/i);
  });
});

test("E2E listener proof rejects hostile URL, initial-link, abort, disposal, and parser-call mutations", async (t) => {
  const mutations = [
    ["URL event", '.addEventListener("url", handleUrl)', '.addEventListener("change", handleUrl)'],
    ["URL callback", '.addEventListener("url", handleUrl)', '.addEventListener("url", otherHandle)'],
    ["initial URL", ".getInitialURL()", ".getInitialUri()"],
    ["initial dispatch", "if (url) handleUrl({ url });", "if (url) onFault({ url });"],
    ["abort guard", "if (signal?.aborted) return () => {};", "if (false) return () => {};"],
    ["abort registration", '.addEventListener("abort", dispose', '.addEventListener("cancel", dispose'],
    ["abort removal", '.removeEventListener("abort", dispose)', '.removeEventListener("cancel", dispose)'],
    ["subscription disposal", "subscription.remove()", "void subscription"],
    ["parser call argument", "_faultContract.parseFaultUrl)(url)", '_faultContract.parseFaultUrl)("ignored")'],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /listener|structure/i);
      });
    });
  }
});

test("E2E sentinel must reside in the unique listener module", async () => {
  const sentinelDeclaration = `var E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL = "${FAULT_CONTROLLER_SENTINEL}";`;
  const relocated = `${replaceOnce(e2eBundleSource(), sentinelDeclaration, "var decoySentinel = true;")}\n/* ${FAULT_CONTROLLER_SENTINEL} */`;
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "android", "e2e", relocated);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /sentinel.*listener|listener.*sentinel/i);
  });
});

test("E2E parser proof rejects hostile serializer, grammar, allowlist, and canonical-equality mutations", async (t) => {
  const mutations = [
    [
      "serializer",
      "return `formobile-test://fault?point=${point}&mode=crash_once`;",
      "return String.raw`formobile-test://fault?point=${point}&mode=crash_once`;",
    ],
    ["regex grammar", "[a-z0-9_.]*", "[a-z0-9._]*"],
    ["allowlist construction", "new Set(FAULT_POINTS)", "new WeakSet(FAULT_POINTS)"],
    ["parser allowlist", "!allowed.has(match[1])", "!FAULT_POINTS.includes(match[1])"],
    ["canonical equality", "=== value ? request : null", "== value ? request : null"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /parser|structure/i);
      });
    });
  }
});

test("E2E proof rejects listener-parser-registry dependency rewiring and duplicate module IDs", async (t) => {
  const mutations = [
    ["listener dependency index", "require(_dependencyMap[1])", "require(_dependencyMap[0])"],
    ["listener dependency target", `[900,${parserModuleId}]`, `[${parserModuleId},900]`],
    ["parser dependency index", "var _faultPointsJson = require(_dependencyMap[0]);", "var _faultPointsJson = require(_dependencyMap[1]);"],
    ["parser dependency target", `},${parserModuleId},[${registryModuleId}]);`, `},${parserModuleId},[404]);`],
    ["duplicate module ID", `__r(${entryModuleId});`, `${metroModule(parserModuleId, [], "exports.decoy = true;")}\n__r(${entryModuleId});`],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /dependency|module|parser|registry/i);
      });
    });
  }
});

test("E2E registry proof rejects hostile order, shape, and contents", async (t) => {
  const originalRegistry = `module.exports = ${JSON.stringify(faultPoints, null, 2)};`;
  const mutations = [
    ["order", `module.exports = ${JSON.stringify([...faultPoints].reverse(), null, 2)};`],
    ["shape", `module.exports = { values: ${JSON.stringify(faultPoints, null, 2)} };`],
    ["extra value", `module.exports = ${JSON.stringify([...faultPoints, "invalid-point!"], null, 2)};`],
  ] as const;
  for (const [name, replacement] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", replaceOnce(e2eBundleSource(), originalRegistry, replacement));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /registry|fault point|structure/i);
      });
    });
  }
});

test("E2E registry factory rejects post-assignment mutation and aliases", async (t) => {
  const originalRegistry = `module.exports = ${JSON.stringify(faultPoints, null, 2)};`;
  const mutations = [
    ["reverse", `${originalRegistry}\nmodule.exports.reverse();`],
    ["push", `${originalRegistry}\nmodule.exports.push("hostile");`],
    ["index", `${originalRegistry}\nmodule.exports[0] = "hostile";`],
    ["alias", `${originalRegistry}\nvar registryAlias = module.exports;\nregistryAlias.pop();`],
  ] as const;
  for (const [name, replacement] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", replaceOnce(e2eBundleSource(), originalRegistry, replacement));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /registry|factory|statement|mutation/i);
      });
    });
  }
});

test("semantic proof independently rejects every marker missing or duplicated in E2E and leaking into production", async (t) => {
  for (const marker of markers) {
    const expected = expectedMarkerCounts.e2e[marker];
    for (const [scenario, production, e2e] of [
      ["missing from E2E", productionBundleSource(), sourceWithMarkerCount("e2e", marker, expected - 1)],
      ["duplicated in E2E", productionBundleSource(), sourceWithMarkerCount("e2e", marker, expected + 1)],
      ["leaking into production", sourceWithMarkerCount("production", marker, 1), e2eBundleSource()],
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

test("proof requires one lowercase-hashed JavaScript bundle and rejects txt, unhashed, and uppercase names", async (t) => {
  for (const [name, bundlePath] of [
    ["txt", "_expo/static/js/android/index-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt"],
    ["unhashed", "_expo/static/js/android/index.js"],
    ["uppercase", "_expo/static/js/android/index-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.js"],
  ] as const) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await relocateBundle(root, proof, "android", "e2e", bundlePath);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /canonical|index-|JavaScript bundle/i);
      });
    });
  }
});

test("proof rejects every extra file in the canonical bundle directory", async (t) => {
  for (const fileName of ["notes.txt", "index-cccccccccccccccccccccccccccccccc.js"]) {
    await t.test(fileName, async () => {
      await withFixture(async ({ root, proof }) => {
        const directory = dirname(join(root, proof.bundles.ios.e2e.path));
        await writeFile(join(directory, fileName), "hostile extra");
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /exactly one|extra|canonical/i);
      });
    });
  }
  await t.test("sibling of platform directory", async () => {
    await withFixture(async ({ root, proof }) => {
      const platformDirectory = dirname(join(root, proof.bundles.android.e2e.path));
      await writeFile(join(dirname(platformDirectory), "rogue.txt"), "hostile extra");
      await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /only its canonical platform bundle directory/i);
    });
  });
});

test("proof rejects extra JavaScript anywhere in a flavor export but allows retained assets", async () => {
  await withFixture(async ({ root, proof }) => {
    const flavorRoot = join(root, ".artifacts/fault-bundles/android/e2e");
    await writeFile(join(flavorRoot, "rogue.js"), "globalThis.compromised = true;");
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /extra JavaScript|canonical bundle/i);
  });
  await withFixture(async ({ root, proof }) => {
    const asset = join(root, ".artifacts/fault-bundles/android/e2e/assets/legitimate-asset");
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(asset, "asset bytes");
    await validateFaultBundleProof(proof, { root, expectedSha: sha });
  });
});

test("proof rejects a symlink in any retained evidence ancestor", async () => {
  await withFixture(async ({ root, proof }) => {
    const platformRoot = join(root, ".artifacts/fault-bundles/android");
    const realPlatformRoot = `${platformRoot}-real`;
    await rename(platformRoot, realPlatformRoot);
    await symlink(realPlatformRoot, platformRoot, "dir");
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /symbolic link|symlink/i);
  });
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
  await withFixture(async ({ root, proof }) => {
    proof.bundles.android.e2e.path = proof.bundles.android.e2e.path.replace(
      "/android/e2e/_expo/",
      "/android/e2e/../e2e/_expo/",
    );
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /traversal|canonical/i);
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
