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
  BOOTSTRAP_TRACE_SENTINEL,
  FAULT_CONTROLLER_SENTINEL,
  validateFaultBundleProof,
} from "../../../tools/check-fault-bundles.mjs";

const sha = "b".repeat(40);
const protocolMarker = "formobile-test:";
const modeMarker = "crash_once";
const platforms = FAULT_BUNDLE_PLATFORMS as readonly ("android" | "ios")[];
const faultPoints = JSON.parse(await readFile("src/testing/faultPoints.json", "utf8")) as string[];
const markers = [FAULT_CONTROLLER_SENTINEL, BOOTSTRAP_TRACE_SENTINEL, protocolMarker, modeMarker, ...faultPoints];
const listenerModuleId = 101;
const parserModuleId = 202;
const registryModuleId = 303;
const appModuleId = 404;
const entryModuleId = 505;
const runtimeModuleId = 900;
const rootRuntimeModuleId = 901;
const alternateRuntimeModuleId = 902;
const appRuntimeModuleId = 903;
const bootstrapModuleId = 904;
const navigatorModuleId = 905;
const recoveryModuleId = 906;
const alternateRecoveryModuleId = 907;
const cleanupFailureModuleId = 908;
const alternateCleanupFailureModuleId = 909;
const expectedMarkerCounts = {
  production: Object.fromEntries(markers.map((marker) => [marker, 0])),
  e2e: Object.fromEntries(markers.map((marker) => [
    marker,
    marker === FAULT_CONTROLLER_SENTINEL || marker === BOOTSTRAP_TRACE_SENTINEL ? 1 : marker === protocolMarker ? 2 : marker === modeMarker ? 3 : 1,
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
  'Object.defineProperty(exports, "__esModule", { value: true });',
  'Object.defineProperty(exports, "E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL", {',
  "  enumerable: true,",
  "  get: function () { return E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL; },",
  "});",
  "exports.installFaultController = installFaultController;",
  "exports.traceBootstrap = traceBootstrap;",
  'var _reactNative = require(_dependencyMap[0]);',
  'var _faultContract = require(_dependencyMap[1]);',
  `var E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL = "${FAULT_CONTROLLER_SENTINEL}";`,
  `var E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL = "${BOOTSTRAP_TRACE_SENTINEL}";`,
  'Object.defineProperty(exports, "E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL", { enumerable: true, get: function () { return E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL; } });',
  "var MAX_BOOTSTRAP_ATTEMPTS = 32;",
  'var traceSession = Math.random().toString(36).slice(2, 14).padEnd(12, "0");',
  "var traceAttempts = new Map();",
  'var traceFailureStages = new Set(["open-configure", "migrate", "post-migrate"]);',
  'var traceFailureCloseOutcomes = new Set(["unobserved", "succeeded", "failed"]);',
  'var traceFailureCategories = new Set(["abort", "cleanup", "sqlite-open", "sqlite", "aggregate", "uncoded"]);',
  "var traceSequence = 0;",
  "function traceBootstrap(record) {",
  "  var attempt = record.attempt;",
  "  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_BOOTSTRAP_ATTEMPTS) return;",
  "  var output;",
  '  if (record.kind === "start") {',
  "    if (traceAttempts.has(attempt)) return;",
  '    traceAttempts.set(attempt, "started");',
  '    output = Object.freeze({ schemaVersion: 1, session: traceSession, sequence: ++traceSequence, attempt: attempt, kind: "start" });',
  '  } else if (record.kind === "terminal") {',
  '    if (traceAttempts.get(attempt) !== "started" || !((record.outcome === "success" && record.stage === "ready" && record.closeOutcome === "not-attempted" && !("failureCategory" in record)) || (record.outcome === "failure" && traceFailureStages.has(record.stage) && traceFailureCloseOutcomes.has(record.closeOutcome) && traceFailureCategories.has(record.failureCategory)))) return;',
  '    traceAttempts.set(attempt, "terminal");',
  '    var terminal = { schemaVersion: 1, session: traceSession, sequence: ++traceSequence, attempt: attempt, kind: "terminal", stage: record.stage, outcome: record.outcome, closeOutcome: record.closeOutcome };',
  '    if (record.outcome === "failure") terminal.failureCategory = record.failureCategory;',
  "    output = Object.freeze(terminal);",
  "  } else {",
  "    return;",
  "  }",
  "  try { console.info(`${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(output)}`); } catch {}",
  "}",
  "var noOp = () => {};",
  "async function installFaultController(onFault, signal) {",
  "  if (signal?.aborted) return noOp;",
  "  var active = true;",
  "  var removed = false;",
  "  var handleUrl = ({ url }) => {",
  "    if (!active || signal?.aborted) return;",
  "    var request = (0, _faultContract.parseFaultUrl)(url);",
  "    if (request) onFault(request);",
  "  };",
  '  var subscription = _reactNative.Linking.addEventListener("url", handleUrl);',
  "  var dispose = () => {",
  "    if (removed) return;",
  "    active = false;",
  "    removed = true;",
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
  'Object.defineProperty(exports, "__esModule", { value: true });',
  'Object.defineProperty(exports, "FAULT_POINTS", {',
  "  enumerable: true,",
  "  get: function () { return FAULT_POINTS; },",
  "});",
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

const hostBody = [
  "function FaultControllerHost({ installFaults, children }) {",
  "  var [setupError, setSetupError] = (0, _react.useState)(null);",
  "  (0, _react.useEffect)(() => {",
  "    var active = true;",
  "    var dispose = () => {};",
  "    var abortController = new AbortController();",
  "    void installFaults((request) => { global.__deliveredFault = request; }, abortController.signal).then(installedDispose => {",
  "      if (active) dispose = installedDispose; else installedDispose();",
  "    }).catch(error => {",
  "      if (active) setSetupError(asError(error));",
  "    });",
  "    return () => {",
  "      active = false;",
  "      abortController.abort();",
  "      dispose();",
  "    };",
  "  }, [installFaults]);",
  "  if (setupError) throw setupError;",
  "  return children;",
  "}",
].join("\n");

const compositionBody = [
  "function AppComposition({ installFaults = _forMobileFaultController.installFaultController }) {",
  "  return FaultControllerHost({ installFaults: installFaults, children: _navigation.RootNavigator({ bootstrap: productionBootstrap }) });",
  "}",
].join("\n");

const appBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  'Object.defineProperty(exports, "default", {',
  "  enumerable: true,",
  "  get: function () { return App; },",
  "});",
  "exports.AppComposition = AppComposition;",
  "var _forMobileFaultController = require(_dependencyMap[0]);",
  "var _react = require(_dependencyMap[1]);",
  "var _bootstrap = require(_dependencyMap[2]);",
  "var _navigation = require(_dependencyMap[3]);",
  "var productionBootstrap = (0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap);",
  'function asError(reason) { return reason instanceof Error ? reason : new Error("synthetic setup failure", { cause: reason }); }',
  hostBody,
  compositionBody,
  "function App() { return AppComposition({}); }",
].join("\n");

const productionControllerBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.installFaultController = installFaultController;",
  "exports.traceBootstrap = undefined;",
  "var noOp = () => {};",
  "async function installFaultController() { return noOp; }",
].join("\n");

const bootstrapBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.createProductionBootstrap = createProductionBootstrap;",
  "var _recover = require(_dependencyMap[0]);",
  'var processNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;',
  "function createProductionBootstrap(traceBootstrap) {",
  "  var tracing = traceBootstrap === undefined ? undefined : (() => {",
  "    var attempt = 0;",
  "    var emit = (record) => { try { traceBootstrap(record); } catch {} };",
  "    return { startAttempt() {",
  "      attempt += 1;",
  "      var currentAttempt = attempt;",
  '      emit({ kind: "start", attempt: currentAttempt });',
  '      return (record) => emit({ kind: "terminal", attempt: currentAttempt, ...record });',
  "    } };",
  "  })();",
  "  return async function bootstrap(signal) {",
  "    var traceTerminal = tracing?.startAttempt();",
  "    var services = Object.freeze({});",
  "    var runtime = await (0, _recover.recoverAndOpen)({ ...(traceTerminal === undefined ? {} : { traceTerminal: traceTerminal }) }, signal);",
  "    return Object.freeze({ services: services, close: runtime.close });",
  "  };",
  "}",
].join("\n");

const recoveryBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.recoverAndOpen = recoverAndOpen;",
  "var _cleanupFailure = require(_dependencyMap[0]);",
  "function failureCategory(error) {",
  "  try {",
  '    if ((0, _cleanupFailure.isCleanupFailure)(error)) return "cleanup";',
  '    if (error instanceof Error && error.name === "AbortError") return "abort";',
  '    var code = typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;',
  '    if (code === "E_SQLITE_OPEN_DATABASE") return "sqlite-open";',
  '    if (code === "ERR_INTERNAL_SQLITE_ERROR") return "sqlite";',
  '    if (error instanceof AggregateError) return "aggregate";',
  '  } catch { return "uncoded"; }',
  '  return "uncoded";',
  "}",
  "function emitTerminal(sink, record) { try { sink?.(record); } catch {} }",
  "function emitFailureTerminal(sink, record, error) {",
  "  if (sink === undefined) return;",
  "  emitTerminal(sink, { ...record, failureCategory: failureCategory(error) });",
  "}",
  "function abortError() {",
  '  var error = new Error("Startup was aborted");',
  '  error.name = "AbortError";',
  "  return error;",
  "}",
  "function idempotentRuntime(database, services) {",
  "  return { services: services, close: async function close() {",
  "    try { await database.close(); } catch (closeError) {",
  '      throw (0, _cleanupFailure.cleanupFailure)([closeError], "Closing the application database failed");',
  "    }",
  "  } };",
  "}",
  "async function recoverAndOpen(dependencies, signal) {",
  "  var database;",
  '  var stage = "open-configure";',
  "  try {",
  "    database = await dependencies.database.openConfigured(signal);",
  '    stage = "migrate";',
  '    await dependencies.coordinator.runMaintenance("migration", async function () { await database.migrate(signal); });',
  '    stage = "post-migrate";',
  '    await dependencies.coordinator.runMaintenance("album", async function () { await dependencies.album.reconcile(database, signal); });',
  '    emitTerminal(dependencies.traceTerminal, { stage: "ready", outcome: "success", closeOutcome: "not-attempted" });',
  "    return idempotentRuntime(database, {});",
  "  } catch (startupError) {",
  "    if (!database) {",
  '      emitFailureTerminal(dependencies.traceTerminal, { stage: stage, outcome: "failure", closeOutcome: "unobserved" }, startupError);',
  "      throw startupError;",
  "    }",
  "    try {",
  "      await database.close();",
  "    } catch (closeError) {",
  '      var failure = (0, _cleanupFailure.cleanupFailure)([startupError, closeError], "Application startup failed and closing the database also failed");',
  '      emitFailureTerminal(dependencies.traceTerminal, { stage: stage, outcome: "failure", closeOutcome: "failed" }, failure);',
  "      throw failure;",
  "    }",
  '    emitFailureTerminal(dependencies.traceTerminal, { stage: stage, outcome: "failure", closeOutcome: "succeeded" }, startupError);',
  "    throw startupError;",
  "  }",
  "}",
].join("\n");

const cleanupFailureBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.cleanupFailure = cleanupFailure;",
  "exports.isCleanupFailure = isCleanupFailure;",
  'var CLEANUP_FAILURE_MARKER = "fawn.cleanup-failure.v1";',
  "function cleanupFailure(errors, message) {",
  "  var failure = new AggregateError(errors, message);",
  '  Object.defineProperty(failure, "cleanupFailure", { configurable: false, enumerable: false, value: CLEANUP_FAILURE_MARKER, writable: false });',
  "  return failure;",
  "}",
  "function isCleanupFailure(value) {",
  '  if (typeof value !== "object" || value === null) return false;',
  '  var descriptor = Object.getOwnPropertyDescriptor(value, "cleanupFailure");',
  "  return descriptor?.value === CLEANUP_FAILURE_MARKER && descriptor.configurable === false && descriptor.enumerable === false && descriptor.writable === false;",
  "}",
].join("\n");

const alternateCleanupFailureBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.cleanupFailure = function cleanupFailure(error) { return error; };",
  "exports.isCleanupFailure = function isCleanupFailure() { return false; };",
].join("\n");

const alternateRecoveryBody = [
  'Object.defineProperty(exports, "__esModule", { value: true });',
  "exports.recoverAndOpen = alternateRecoverAndOpen;",
  "async function alternateRecoverAndOpen() { return { services: {}, close: async function close() {} }; }",
].join("\n");

const appRuntimeBody = [
  "exports.useState = function useState(value) { return [value, function setValue(next) { global.__hostState = next; }]; };",
  "exports.useEffect = function useEffect(effect) { global.__hostCleanup = effect(); };",
  "exports.jsx = function jsx(Component, props) { return typeof Component === 'function' ? Component(props) : null; };",
  "exports.jsxs = exports.jsx;",
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
    metroModule(appModuleId, [controllerId, appRuntimeModuleId, bootstrapModuleId, navigatorModuleId], appBody),
    ...modules,
    metroModule(appRuntimeModuleId, [], appRuntimeBody),
    metroModule(bootstrapModuleId, [recoveryModuleId], bootstrapBody),
    metroModule(recoveryModuleId, [cleanupFailureModuleId], recoveryBody),
    metroModule(alternateRecoveryModuleId, [], alternateRecoveryBody),
    metroModule(cleanupFailureModuleId, [], cleanupFailureBody),
    metroModule(alternateCleanupFailureModuleId, [], alternateCleanupFailureBody),
    metroModule(navigatorModuleId, [], [
      "exports.RootNavigator = function RootNavigator({ bootstrap }) {",
      "  global.__liveBootstrap = bootstrap;",
      "  return null;",
      "};",
    ].join("\n")),
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
      "    return { remove: function remove() { global.__listenerRemoveCount = (global.__listenerRemoveCount ?? 0) + 1; } };",
      "  },",
      "  getInitialURL: async function getInitialURL() { return global.__syntheticInitialUrl ?? null; },",
      "};",
    ].join("\n")),
  ]);
}

function productionBundleSource() {
  return rootedBundle(listenerModuleId, [metroModule(listenerModuleId, [], productionControllerBody)]);
}

function jsxAppBundleSource() {
  const jsxAppBody = appBody
    .replace(
      "var _react = require(_dependencyMap[1]);",
      "var _react = require(_dependencyMap[1]);\nvar _reactJsxRuntime = require(_dependencyMap[1]);",
    )
    .replace(
      "function App() { return AppComposition({}); }",
      "function App() { return (0, _reactJsxRuntime.jsx)(AppComposition, {}); }",
    );
  return replaceOnce(e2eBundleSource(), appBody, jsxAppBody);
}

function jsxCompositionBundleSource(hostProp = "children") {
  const jsxComposition = [
    "function Shell({ children }) { return children; }",
    "function AppComposition({ installFaults = _forMobileFaultController.installFaultController }) {",
    "  return (0, _reactJsxRuntime.jsx)(Shell, {",
    `    ${hostProp}: (0, _reactJsxRuntime.jsx)(FaultControllerHost, { installFaults: installFaults, children: (0, _reactJsxRuntime.jsx)(_navigation.RootNavigator, { bootstrap: productionBootstrap }) }),`,
    "  });",
    "}",
  ].join("\n");
  const jsxAppBody = appBody
    .replace(
      "var _react = require(_dependencyMap[1]);",
      "var _react = require(_dependencyMap[1]);\nvar _reactJsxRuntime = require(_dependencyMap[1]);",
    )
    .replace(compositionBody, jsxComposition);
  return replaceOnce(e2eBundleSource(), appBody, jsxAppBody);
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

function executeSyntheticBundle(source: string, initialUrl: string | null = null) {
  const harness = String.raw`
    const factories = new Map();
    const cache = new Map();
    const NativeAbortController = AbortController;
    global.AbortController = class SyntheticAbortController extends NativeAbortController {
      constructor() {
        super();
        global.__hostAbortSignal = this.signal;
      }
    };
    global.__syntheticInitialUrl = ${JSON.stringify(initialUrl)};
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
    Promise.resolve(global.__appExecution).then(() => new Promise((resolve) => setImmediate(resolve))).then(() => {
      if (typeof global.__registeredDefaultApp !== "function") throw new Error("default App was not registered");
      if (!global.__listenerSetupReached) throw new Error("listener setup path was not reached");
      if (!(global.__hostAbortSignal instanceof AbortSignal)) throw new Error("host did not install with a real AbortSignal");
      if (global.__hostAbortSignal.aborted) throw new Error("host AbortSignal was not active during installation");
      if (typeof global.__hostCleanup !== "function") throw new Error("host cleanup was not installed");
      if (global.__syntheticInitialUrl !== null) {
        const expected = { point: ${JSON.stringify(faultPoints[0])}, mode: "crash_once" };
        if (JSON.stringify(global.__deliveredFault) !== JSON.stringify(expected)) throw new Error("active initial URL was not delivered exactly");
      }
      global.__hostCleanup();
      if (!global.__hostAbortSignal.aborted) throw new Error("host cleanup did not abort its signal");
      if (global.__listenerRemoveCount !== 1) throw new Error("host cleanup did not dispose the listener exactly once");
      process.stdout.write(global.__syntheticInitialUrl === null ? "listener-setup-reached" : "active-url-delivered");
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
  assert.deepEqual(markers, [FAULT_CONTROLLER_SENTINEL, BOOTSTRAP_TRACE_SENTINEL, "formobile-test:", "crash_once", ...faultPoints]);
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

test("synthetic Metro evidence delivers one active canonical initial URL", () => {
  const result = executeSyntheticBundle(e2eBundleSource(), `formobile-test://fault?point=${faultPoints[0]}&mode=crash_once`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "active-url-delivered");
});

test("bundle proof accepts the immutable imported JSX-runtime App call emitted by Babel", async () => {
  await withFixture(async ({ root, proof }) => {
    await validateFaultBundleProof(proof, { root, expectedSha: sha });
  }, undefined, jsxAppBundleSource());
});

test("bundle proof follows FaultControllerHost through rendered JSX children", async () => {
  await withFixture(async ({ root, proof }) => {
    await validateFaultBundleProof(proof, { root, expectedSha: sha });
  }, undefined, jsxCompositionBundleSource());
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

test("listener parser delivery, abort flow, disposal, and Linking receiver reject dead or mutable paths", async (t) => {
  const directDelivery = "    if (request) onFault(request);";
  const mutations = [
    [
      "delivery nested under false",
      directDelivery,
      "    if (request) { if (false) onFault(request); }",
    ],
    [
      "delivery nested under contradictory guard",
      directDelivery,
      "    if (request) { if (!request) onFault(request); }",
    ],
    [
      "parser request destructuring write",
      "    var request = (0, _faultContract.parseFaultUrl)(url);\n    if (request) onFault(request);",
      [
        "    var request = (0, _faultContract.parseFaultUrl)(url);",
        "    ({ value: request } = { value: { point: url, mode: null } });",
        "    if (request) onFault(request);",
      ].join("\n"),
    ],
    [
      "handler abort guard hidden in false expression",
      "    if (!active || signal?.aborted) return;",
      "    if (false && signal?.aborted) return;",
    ],
    [
      "initial abort guard hidden in false expression",
      "  if (signal?.aborted) return noOp;",
      "  if (false && signal?.aborted) return noOp;",
    ],
    [
      "side-effecting pre-install declaration",
      "  if (signal?.aborted) return noOp;\n  var active = true;",
      "  if (signal?.aborted) return noOp;\n  var hostile = onFault(null);\n  var active = true;",
    ],
    [
      "runtime Linking object mutation",
      "var _reactNative = require(_dependencyMap[0]);",
      [
        "var _reactNative = require(_dependencyMap[0]);",
        "_reactNative.Linking = { addEventListener: function hostileAdd() {}, getInitialURL: async function hostileGet() {} };",
      ].join("\n"),
    ],
    [
      "abort registration hidden in dead branch",
      '  signal?.addEventListener("abort", dispose, { once: true });',
      '  if (false) signal?.addEventListener("abort", dispose, { once: true });',
    ],
    [
      "error disposal hidden in dead branch",
      "    dispose();\n    throw error;",
      "    if (false) dispose();\n    throw error;",
    ],
    [
      "initial dispatch hidden in dead branch",
      "    if (url) handleUrl({ url });",
      "    if (url) { if (false) handleUrl({ url }); }",
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /listener|parser|delivery|abort|control|Linking|runtime/i);
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

test("selected export objects reject rebinding and wrapped escape paths", async (t) => {
  const mutations = [
    ["direct exports rebind", appBody, `exports = {};\n${appBody}`],
    ["destructuring exports rebind", appBody, `({ value: exports } = { value: {} });\n${appBody}`],
    [
      "assignment alias from exports",
      appBody,
      `${appBody}\nvar exportAlias;\nexportAlias = exports;\nexportAlias.default = function Other() {};`,
    ],
    [
      "assignment alias from module.exports",
      appBody,
      `${appBody}\nvar exportAlias;\nexportAlias = module.exports;\nexportAlias.default = function Other() {};`,
    ],
    [
      "object-wrapped exports escape",
      appBody,
      `${appBody}\nvar exportHolder = { value: exports };\nexportHolder.value.default = function Other() {};`,
    ],
    [
      "array-wrapped module.exports escape",
      listenerBody,
      `${listenerBody}\nvar exportSlots = [module.exports];\nexportSlots[0].installFaultController = function Other() {};`,
    ],
    [
      "conditional exports alias",
      listenerBody,
      `${listenerBody}\nvar exportAlias = true ? exports : null;\nexportAlias.installFaultController = function Other() {};`,
    ],
    [
      "logical exports alias",
      parserBody,
      `${parserBody}\nvar exportAlias = exports && exports;\nexportAlias.parseFaultUrl = function Other() {};`,
    ],
    [
      "function-returned exports escape",
      appBody,
      `${appBody}\nfunction liveExports() { return exports; }\nliveExports().default = function Other() {};`,
    ],
    [
      "nested module.exports escape",
      parserBody,
      `${parserBody}\nvar exportHolder = { nested: { value: module.exports } };\nexportHolder.nested.value.parseFaultUrl = function Other() {};`,
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /export|mutation|escape|binding/i);
      });
    });
  }
});

test("selected export objects reject computed module aliases", async () => {
  const source = replaceOnce(
    e2eBundleSource(),
    appBody,
    `${appBody}\nvar moduleAlias = module;\nmoduleAlias["exports"]["default"] = function Other() {};`,
  );
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "android", "e2e", source);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /export|module|alias|escape/i);
  });
});

test("selected named-export getters require the exact Babel descriptor shape", async (t) => {
  const mutations = [
    [
      "false enumerable default getter",
      'Object.defineProperty(exports, "default", {\n  enumerable: true,',
      'Object.defineProperty(exports, "default", {\n  enumerable: false,',
    ],
    [
      "extra default descriptor field",
      "  get: function () { return App; },\n});",
      "  get: function () { return App; },\n  configurable: true,\n});",
    ],
    [
      "side effect before sentinel getter return",
      "  get: function () { return E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL; },",
      "  get: function () { global.__getterSideEffect = true; return E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL; },",
    ],
    [
      "async FAULT_POINTS getter",
      "  get: function () { return FAULT_POINTS; },",
      "  get: async function () { return FAULT_POINTS; },",
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /export|descriptor|getter/i);
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

test("default App, AppComposition, host, and root registration reject inert or mutable chains", async (t) => {
  const mutations: readonly [string, (source: string) => string][] = [
    [
      "inert wrapper receives AppComposition",
      (source) => replaceOnce(source, "function App() { return AppComposition({}); }", "function App() { return ignore(AppComposition); }"),
    ],
    [
      "Promise.resolve receives AppComposition",
      (source) => replaceOnce(
        source,
        "function App() { return AppComposition({}); }",
        "function App() { return Promise.resolve(AppComposition); }",
      ),
    ],
    [
      "AppComposition destructuring write",
      (source) => replaceOnce(
        source,
        appBody,
        `${appBody}\n({ value: AppComposition } = { value: function OtherComposition() { return null; } });`,
      ),
    ],
    [
      "default App destructuring write",
      (source) => replaceOnce(source, appBody, `${appBody}\n({ value: App } = { value: function OtherApp() { return null; } });`),
    ],
    [
      "FaultControllerHost destructuring write",
      (source) => replaceOnce(
        source,
        appBody,
        `${appBody}\n({ value: FaultControllerHost } = { value: function OtherHost() { return null; } });`,
      ),
    ],
    [
      "AppComposition rewrites installFaults",
      (source) => replaceOnce(
        source,
        compositionBody,
        [
          "function AppComposition({ installFaults = _forMobileFaultController.installFaultController }) {",
          "  installFaults = async function hostileInstall() { return function hostileDispose() {}; };",
          "  return FaultControllerHost({ installFaults: installFaults });",
          "}",
        ].join("\n"),
      ),
    ],
    [
      "AppComposition never invokes FaultControllerHost",
      (source) => replaceOnce(
        source,
        compositionBody,
        [
          "function AppComposition({ installFaults = _forMobileFaultController.installFaultController }) {",
          "  return ignore({ installFaults: installFaults });",
          "}",
        ].join("\n"),
      ),
    ],
    [
      "root uses an arbitrary one-argument wrapper",
      (source) => replaceOnce(
        source,
        "var App = _interopDefault(_App);",
        "function wrap(value) { return value; }\nvar App = wrap(_App);",
      ),
    ],
    [
      "JSX runtime namespace reassignment",
      (source) => replaceOnce(
        jsxAppBundleSource(),
        "var _reactJsxRuntime = require(_dependencyMap[1]);",
        "var _reactJsxRuntime = require(_dependencyMap[1]);\n_reactJsxRuntime = { jsx: function hostileJsx() { return null; } };",
      ),
    ],
    [
      "JSX runtime method mutation",
      (source) => replaceOnce(
        jsxAppBundleSource(),
        "var _reactJsxRuntime = require(_dependencyMap[1]);",
        "var _reactJsxRuntime = require(_dependencyMap[1]);\n_reactJsxRuntime.jsx = function hostileJsx() { return null; };",
      ),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", mutate(e2eBundleSource()));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /App|composition|host|root|interop|JSX|binding/i);
      });
    });
  }
});

test("App host evidence rejects inert JSX props and dead installation or cleanup paths", async (t) => {
  const deadHost = [
    "function FaultControllerHost({ installFaults, children }) {",
    "  function neverMounted() {",
    "    var abortController = new AbortController();",
    "    return installFaults((request) => { global.__deliveredFault = request; }, abortController.signal);",
    "  }",
    "  return children;",
    "}",
  ].join("\n");
  const mutations: readonly [string, (source: string) => string][] = [
    ["FaultControllerHost hidden in an inert JSX prop", () => jsxCompositionBundleSource("inert")],
    ["installFaults hidden in dead nested code", (source) => replaceOnce(source, hostBody, deadHost)],
    [
      "host effect appears after an early return",
      (source) => replaceOnce(
        replaceOnce(
          source,
          "  (0, _react.useEffect)(() => {",
          "  return children;\n  (0, _react.useEffect)(() => {",
        ),
        "  if (setupError) throw setupError;\n  return children;",
        "  if (setupError) throw setupError;",
      ),
    ],
    [
      "installFaults receives no AbortSignal",
      (source) => replaceOnce(source, "abortController.signal).then", "undefined).then"),
    ],
    [
      "host cleanup neither aborts nor disposes",
      (source) => replaceOnce(
        source,
        "      abortController.abort();\n      dispose();",
        "      void abortController;\n      void dispose;",
      ),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", mutate(e2eBundleSource()));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /App|host|render|install|AbortSignal|cleanup/i);
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

test("selected dependency and interop namespaces are unique immutable top-level bindings", async (t) => {
  const mutations = [
    [
      "App controller namespace reassignment",
      "var _forMobileFaultController = require(_dependencyMap[0]);",
      [
        "var _forMobileFaultController = require(_dependencyMap[0]);",
        "_forMobileFaultController = { installFaultController: async function hostileInstall() { return function hostileDispose() {}; } };",
      ].join("\n"),
    ],
    [
      "App controller namespace destructuring write",
      "var _forMobileFaultController = require(_dependencyMap[0]);",
      [
        "var _forMobileFaultController = require(_dependencyMap[0]);",
        "({ value: _forMobileFaultController } = { value: { installFaultController: async function hostileInstall() {} } });",
      ].join("\n"),
    ],
    [
      "duplicate App controller namespace declaration",
      "var _forMobileFaultController = require(_dependencyMap[0]);",
      [
        "var _forMobileFaultController = require(_dependencyMap[0]);",
        "var _forMobileFaultController = { installFaultController: async function hostileInstall() {} };",
      ].join("\n"),
    ],
    [
      "listener parser namespace reassignment",
      "var _faultContract = require(_dependencyMap[1]);",
      [
        "var _faultContract = require(_dependencyMap[1]);",
        "_faultContract = { parseFaultUrl: function hostileParser() { return null; } };",
      ].join("\n"),
    ],
    [
      "listener runtime namespace reassignment",
      "var _reactNative = require(_dependencyMap[0]);",
      [
        "var _reactNative = require(_dependencyMap[0]);",
        "_reactNative = { Linking: { addEventListener: function () {}, getInitialURL: async function () {} } };",
      ].join("\n"),
    ],
    [
      "parser registry namespace reassignment",
      "var _faultPointsJson = require(_dependencyMap[0]);",
      "var _faultPointsJson = require(_dependencyMap[0]);\n_faultPointsJson = [];",
    ],
    [
      "root runtime namespace reassignment",
      "var _expo = require(_dependencyMap[0]);",
      "var _expo = require(_dependencyMap[0]);\n_expo = { registerRootComponent: function hostileRegister() {} };",
    ],
    [
      "root App import namespace reassignment",
      "var _App = require(_dependencyMap[1]);",
      "var _App = require(_dependencyMap[1]);\n_App = { default: function OtherApp() {} };",
    ],
    [
      "root interop result reassignment",
      "var App = _interopDefault(_App);",
      "var App = _interopDefault(_App);\nApp = { default: function OtherApp() {} };",
    ],
    [
      "noncanonical root interop helper",
      "function _interopDefault(value) { return value && value.__esModule ? value : { default: value }; }",
      "function _interopDefault(value) { return { default: function OtherApp() {} }; }",
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /binding|namespace|dependency|interop|runtime|parser|App/i);
      });
    });
  }
});

test("selected imported namespaces reject aliases and call-based mutators", async (t) => {
  const mutations: readonly [string, (source: string) => string][] = [
    [
      "App controller alias through Object.assign",
      (source) => replaceOnce(
        source,
        "var _forMobileFaultController = require(_dependencyMap[0]);",
        [
          "var _forMobileFaultController = require(_dependencyMap[0]);",
          "var controllerAlias = _forMobileFaultController;",
          "Object.assign(controllerAlias, { installFaultController: async function hostileInstall() { return () => {}; } });",
        ].join("\n"),
      ),
    ],
    [
      "listener parser namespace through Reflect.set",
      (source) => replaceOnce(
        source,
        "var _faultContract = require(_dependencyMap[1]);",
        [
          "var _faultContract = require(_dependencyMap[1]);",
          'Reflect.set(_faultContract, "parseFaultUrl", function hostileParser() { return null; });',
        ].join("\n"),
      ),
    ],
    [
      "listener runtime alias member mutation",
      (source) => replaceOnce(
        source,
        "var _reactNative = require(_dependencyMap[0]);",
        [
          "var _reactNative = require(_dependencyMap[0]);",
          "var runtimeAlias = _reactNative;",
          "runtimeAlias.Linking.addEventListener = function hostileAdd() { return { remove() {} }; };",
        ].join("\n"),
      ),
    ],
    [
      "root runtime alias through Object.assign",
      (source) => replaceOnce(
        source,
        "var _expo = require(_dependencyMap[0]);",
        [
          "var _expo = require(_dependencyMap[0]);",
          "var expoAlias = _expo;",
          "Object.assign(expoAlias, { registerRootComponent: function hostileRegister() {} });",
        ].join("\n"),
      ),
    ],
    [
      "JSX runtime alias member mutation",
      () => replaceOnce(
        jsxAppBundleSource(),
        "var _reactJsxRuntime = require(_dependencyMap[1]);",
        [
          "var _reactJsxRuntime = require(_dependencyMap[1]);",
          "var jsxAlias = _reactJsxRuntime;",
          "jsxAlias.jsx = function hostileJsx() { return null; };",
        ].join("\n"),
      ),
    ],
    [
      "parser registry namespace alias through Object.assign",
      (source) => replaceOnce(
        source,
        "var _faultPointsJson = require(_dependencyMap[0]);",
        [
          "var _faultPointsJson = require(_dependencyMap[0]);",
          "var registryAlias = _faultPointsJson;",
          'Object.assign(registryAlias, { 0: "hostile.point" });',
        ].join("\n"),
      ),
    ],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", mutate(e2eBundleSource()));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /binding|namespace|alias|mutation|runtime|parser|App|intrinsic|reference|canonical/i);
      });
    });
  }
});

test("selected Metro factories preserve the canonical require parameter binding", async (t) => {
  const mutations = [
    [
      "require declaration alias",
      "var _forMobileFaultController = require(_dependencyMap[0]);",
      "var _forMobileFaultController = require(_dependencyMap[0]);\nvar requireAlias = require;",
    ],
    [
      "require parameter reassignment",
      "var _forMobileFaultController = require(_dependencyMap[0]);",
      "var _forMobileFaultController = require(_dependencyMap[0]);\nrequire = function hostileRequire() { return {}; };",
    ],
    [
      "require parameter call-based mutation",
      "var _forMobileFaultController = require(_dependencyMap[0]);",
      "var _forMobileFaultController = require(_dependencyMap[0]);\nObject.assign(require, { hostile: true });",
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /Metro|require|binding|alias|mutation/i);
      });
    });
  }
});

test("selected functions reject wrong async or generator flags", async (t) => {
  const mutations: readonly [string, "production" | "e2e", (source: string) => string][] = [
    ["async default App", "e2e", (source) => replaceOnce(source, "function App()", "async function App()")],
    ["generator AppComposition", "e2e", (source) => replaceOnce(source, "function AppComposition(", "function* AppComposition(")],
    ["async FaultControllerHost", "e2e", (source) => replaceOnce(source, "function FaultControllerHost(", "async function FaultControllerHost(")],
    ["async parser", "e2e", (source) => replaceOnce(source, "function parseFaultUrl(value)", "async function parseFaultUrl(value)")],
    [
      "async-generator listener",
      "e2e",
      (source) => replaceOnce(source, "async function installFaultController(onFault, signal)", "async function* installFaultController(onFault, signal)"),
    ],
    [
      "generator root interop helper",
      "e2e",
      (source) => replaceOnce(source, "function _interopDefault(value)", "function* _interopDefault(value)"),
    ],
    [
      "async-generator production controller",
      "production",
      (source) => replaceOnce(source, "async function installFaultController()", "async function* installFaultController()"),
    ],
  ];
  for (const [name, flavor, mutate] of mutations) {
    await t.test(name, async () => {
      const production = flavor === "production" ? mutate(productionBundleSource()) : productionBundleSource();
      const e2e = flavor === "e2e" ? mutate(e2eBundleSource()) : e2eBundleSource();
      await withFixture(async ({ root, proof }) => {
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /function|async|generator|App|listener|parser|interop|production/i);
      }, production, e2e);
    });
  }
});

test("selected evidence rejects sequence-expression side effects", async (t) => {
  const registryBody = `module.exports = ${JSON.stringify(faultPoints, null, 2)};`;
  const mutations = [
    [
      "dependency-map argument side effect",
      "require(_dependencyMap[0])",
      "require((global.__sequenceSideEffect = true, _dependencyMap[0]))",
    ],
    [
      "abort guard side effect",
      "if (signal?.aborted) return noOp;",
      "if ((global.__sequenceSideEffect = true, signal?.aborted)) return noOp;",
    ],
    [
      "Linking receiver side effect",
      'var subscription = _reactNative.Linking.addEventListener("url", handleUrl);',
      'var subscription = (global.__sequenceSideEffect = true, _reactNative.Linking).addEventListener("url", handleUrl);',
    ],
    [
      "executing Metro root side effect",
      `__r(${entryModuleId});`,
      `(global.__sequenceSideEffect = true, __r(${entryModuleId}));`,
    ],
    [
      "registry assignment side effect",
      registryBody,
      `(global.__sequenceSideEffect = true, ${registryBody.slice(0, -1)});`,
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "android", "e2e", replaceOnce(e2eBundleSource(), before, after));
        await assert.rejects(
          validateFaultBundleProof(proof, { root, expectedSha: sha }),
          /sequence|side effect|dependency|listener|binding|runtime|Metro|root|registry/i,
        );
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

test("production App reaches an explicitly absent bootstrap trace sink", async () => {
  const hostile = replaceOnce(
    productionBundleSource(),
    "exports.traceBootstrap = undefined;",
    "exports.traceBootstrap = function traceBootstrap() { throw new Error('live trace'); };",
  );
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "ios", "production", hostile);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /production|trace|absent|undefined/i);
  });
});

test("App must wire the flavor-selected bootstrap trace into bootstrap creation", async () => {
  const hostile = replaceOnce(
    e2eBundleSource(),
    "(0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap)",
    "(0, _bootstrap.createProductionBootstrap)(function hostileTrace() {})",
  );
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "ios", "e2e", hostile);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /App|bootstrap|trace|controller/i);
  });
});

test("App binds the exact live bootstrap result to RootNavigator", async (t) => {
  const mutations = [
    [
      "dead canonical bootstrap",
      "var productionBootstrap = (0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap);",
      "var deadBootstrap = (0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap); var productionBootstrap = async function alternateBootstrap() {};",
    ],
    [
      "alternate RootNavigator bootstrap prop",
      "_navigation.RootNavigator({ bootstrap: productionBootstrap })",
      "_navigation.RootNavigator({ bootstrap: async function alternateBootstrap() {} })",
    ],
    [
      "discarded canonical factory result",
      "var productionBootstrap = (0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap);",
      "var productionBootstrap = ((0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap), async function alternateBootstrap() {});",
    ],
    [
      "post-factory bootstrap reassignment",
      "var productionBootstrap = (0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap);",
      "var productionBootstrap = (0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap); productionBootstrap = async function alternateBootstrap() {};",
    ],
    [
      "dependency-internal alternate factory export",
      "exports.createProductionBootstrap = createProductionBootstrap;",
      "exports.createProductionBootstrap = function alternateFactory() { return async function alternateBootstrap() {}; };",
    ],
    [
      "alternate bootstrap dependency namespace",
      "(0, _bootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap)",
      "(0, _alternateBootstrap.createProductionBootstrap)(_forMobileFaultController.traceBootstrap)",
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /App|bootstrap|RootNavigator|live|exact|binding/i);
      });
    });
  }
});

test("trace and live bootstrap modules reject intrinsic shadows, writes, and prototype monkeypatches", async (t) => {
  const mutations = [
    ["local JSON serializer shadow", "function traceBootstrap(record) {", "function traceBootstrap(record) { var JSON = { stringify: function () { return global.__secret; } };"],
    ["top-level console shadow", "function traceBootstrap(record) {", "var console = { info: function () {} };\nfunction traceBootstrap(record) {"],
    ["top-level Object shadow", "function traceBootstrap(record) {", "var Object = global.Object;\nfunction traceBootstrap(record) {"],
    ["local Number shadow", "function traceBootstrap(record) {", "function traceBootstrap(record) { var Number = global.Number;"],
    ["top-level Math shadow", "var traceSession =", "var Math = global.Math;\nvar traceSession ="],
    ["top-level Map shadow", "var traceAttempts =", "var Map = global.Map;\nvar traceAttempts ="],
    ["top-level Set shadow", "var traceFailureStages =", "var Set = global.Set;\nvar traceFailureStages ="],
    ["JSON intrinsic write", "function traceBootstrap(record) {", "function traceBootstrap(record) { JSON.stringify = JSON.stringify;"],
    ["console intrinsic write", "function traceBootstrap(record) {", "function traceBootstrap(record) { console.info = console.info;"],
    ["Object intrinsic write", "function traceBootstrap(record) {", "function traceBootstrap(record) { Object.freeze = Object.freeze;"],
    ["Number intrinsic write", "function traceBootstrap(record) {", "function traceBootstrap(record) { Number.isSafeInteger = Number.isSafeInteger;"],
    ["Math intrinsic write", "var traceSession =", "Math.random = Math.random;\nvar traceSession ="],
    ["Map prototype monkeypatch", "var traceAttempts =", "Map.prototype.set = Map.prototype.set;\nvar traceAttempts ="],
    ["Set prototype monkeypatch", "var traceFailureStages =", "Set.prototype.has = Set.prototype.has;\nvar traceFailureStages ="],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|intrinsic|shadow|write|prototype|binding/i);
      });
    });
  }
});

test("live bootstrap module rejects intrinsic monkeypatches", async () => {
  const hostile = replaceOnce(
    e2eBundleSource(),
    "function createProductionBootstrap(traceBootstrap) {",
    "Object.freeze = Object.freeze;\nfunction createProductionBootstrap(traceBootstrap) {",
  );
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "ios", "e2e", hostile);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bootstrap|intrinsic|write|monkeypatch/i);
  });
});

test("trace and live bootstrap modules reject indirect global and prototype corruption", async (t) => {
  const mutations = [
    [
      "Metro global JSON corruption",
      "function traceBootstrap(record) {",
      "global.JSON.stringify = function hostileStringify() { return global.__secret; };\nfunction traceBootstrap(record) {",
    ],
    [
      "globalThis JSON corruption",
      "function traceBootstrap(record) {",
      "globalThis.JSON.stringify = function hostileStringify() { return globalThis.__secret; };\nfunction traceBootstrap(record) {",
    ],
    [
      "Metro global alias JSON corruption",
      "function traceBootstrap(record) {",
      "var globalAlias = global; globalAlias.JSON.stringify = function hostileStringify() { return globalAlias.__secret; };\nfunction traceBootstrap(record) {",
    ],
    [
      "Reflect JSON corruption",
      "function traceBootstrap(record) {",
      'Reflect.set(global.JSON, "stringify", function hostileStringify() { return "secret"; });\nfunction traceBootstrap(record) {',
    ],
    [
      "String.prototype.padEnd corruption",
      "var traceSession =",
      'String.prototype.padEnd = function hostilePadEnd() { return "000000000000"; };\nvar traceSession =',
    ],
    [
      "String alias padEnd corruption",
      "var traceSession =",
      'var StringAlias = String; StringAlias.prototype.padEnd = function hostilePadEnd() { return "000000000000"; };\nvar traceSession =',
    ],
    [
      "Reflect String padEnd corruption",
      "var traceSession =",
      'Reflect.set(String.prototype, "padEnd", function hostilePadEnd() { return "000000000000"; });\nvar traceSession =',
    ],
    [
      "Metro global Number.prototype.toString corruption",
      "var traceSession =",
      'global.Number.prototype.toString = function hostileToString() { return "0"; };\nvar traceSession =',
    ],
    [
      "globalThis Number.prototype.toString corruption",
      "var traceSession =",
      'globalThis.Number.prototype.toString = function hostileToString() { return "0"; };\nvar traceSession =',
    ],
    [
      "Metro global Number alias corruption",
      "var traceSession =",
      'var NumberAlias = global.Number; NumberAlias.prototype.toString = function hostileToString() { return "0"; };\nvar traceSession =',
    ],
    [
      "Reflect Number toString corruption",
      "var traceSession =",
      'Reflect.set(global.Number.prototype, "toString", function hostileToString() { return "0"; });\nvar traceSession =',
    ],
    [
      "live bootstrap Metro global Number corruption",
      "var processNonce =",
      'global.Number.prototype.toString = function hostileToString() { return "0"; };\nvar processNonce =',
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bootstrap|trace|global|intrinsic|prototype|reference|canonical/i);
      });
    });
  }
});

test("trace and live bootstrap modules reject literal-rooted dangerous members and dynamic code", async (t) => {
  const mutations = [
    [
      "trace object-literal constructor chain",
      "function traceBootstrap(record) {",
      'function traceBootstrap(record) { ({}).constructor.constructor("return 1")();',
    ],
    [
      "trace computed constructor chain",
      "function traceBootstrap(record) {",
      'function traceBootstrap(record) { ({})["con" + "structor"]["constructor"]("return 1")();',
    ],
    [
      "trace literal prototype toJSON mutation",
      "function traceBootstrap(record) {",
      'function traceBootstrap(record) { ({})["constructor"]["pro" + "totype"]["to" + "JSON"] = function hostileToJSON() { return 1; };',
    ],
    [
      "trace array __proto__ toJSON mutation",
      "function traceBootstrap(record) {",
      'function traceBootstrap(record) { []["__pro" + "to__"]["toJSON"] = function hostileToJSON() { return 1; };',
    ],
    [
      "live bootstrap arrow constructor dynamic code",
      "function createProductionBootstrap(traceBootstrap) {",
      'function createProductionBootstrap(traceBootstrap) { (() => {})["con" + "structor"]("return 1")();',
    ],
    [
      "live bootstrap literal prototype mutation",
      "function createProductionBootstrap(traceBootstrap) {",
      'function createProductionBootstrap(traceBootstrap) { ({})["constructor"]["prototype"]["toJSON"] = function hostileToJSON() { return 1; };',
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bootstrap|trace|dangerous|constructor|prototype|dynamic|toJSON/i);
      });
    });
  }
});

test("selected bootstrap modules reject opaque computed dangerous members", async (t) => {
  const mutations = [
    [
      "trace sequence-expression constructor",
      "function traceBootstrap(record) {",
      'function traceBootstrap(record) { void ({})[(0, "constructor")];',
    ],
    [
      "trace call-expression prototype",
      "function traceBootstrap(record) {",
      'function traceBootstrap(record) { void ({})[["pro", "totype"].join("")];',
    ],
    [
      "trace computed toJSON",
      "function traceBootstrap(record) {",
      'function traceBootstrap(record) { void ({})[(() => "toJSON")()];',
    ],
    [
      "recovery sequence-expression constructor",
      "function failureCategory(error) {",
      'function failureCategory(error) { void ({})[(0, "constructor")];',
    ],
    [
      "recovery call-expression prototype",
      "function failureCategory(error) {",
      'function failureCategory(error) { void ({})[["pro", "totype"].join("")];',
    ],
    [
      "recovery computed toJSON",
      "function failureCategory(error) {",
      'function failureCategory(error) { void ({})[(() => "toJSON")()];',
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bootstrap|trace|recovery|computed|member|opaque/i);
      });
    });
  }
});

test("bootstrap trace intrinsics are closed to exact canonical references", async (t) => {
  const mutations = [
    ["JSON alias", "function traceBootstrap(record) {", "function traceBootstrap(record) { var jsonAlias = JSON;"],
    ["console escape", "function traceBootstrap(record) {", "function traceBootstrap(record) { global.__console = console;"],
    ["Object extra read", "function traceBootstrap(record) {", "function traceBootstrap(record) { void Object;"],
    ["Number alias", "function traceBootstrap(record) {", "function traceBootstrap(record) { var safeNumber = Number;"],
    ["Math escape", "var traceSession =", "global.__math = Math;\nvar traceSession ="],
    ["Map alias", "var traceAttempts =", "var MapAlias = Map;\nvar traceAttempts ="],
    ["Set escape", "var traceFailureStages =", 'Reflect.set(global, "__Set", Set);\nvar traceFailureStages ='],
    ["String alias", "var traceSession =", "var StringAlias = String;\nvar traceSession ="],
    ["Reflect alias", "function traceBootstrap(record) {", "var ReflectAlias = Reflect;\nfunction traceBootstrap(record) {"],
    ["Function alias", "function traceBootstrap(record) {", "var FunctionAlias = Function;\nfunction traceBootstrap(record) {"],
    ["eval alias", "function traceBootstrap(record) {", "var evalAlias = eval;\nfunction traceBootstrap(record) {"],
    ["Proxy alias", "function traceBootstrap(record) {", "var ProxyAlias = Proxy;\nfunction traceBootstrap(record) {"],
    ["Reflect JSON mutation", "function traceBootstrap(record) {", 'function traceBootstrap(record) { Reflect.set(JSON, "stringify", JSON.stringify);'],
    ["JSON prototype path", "function traceBootstrap(record) {", "function traceBootstrap(record) { void JSON.prototype?.toJSON;"],
    ["Object toJSON path", "function traceBootstrap(record) {", "function traceBootstrap(record) { void Object.prototype.toJSON;"],
    ["indirect JSON call", "JSON.stringify(output)", "(0, JSON.stringify)(output)"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|intrinsic|reference|canonical/i);
      });
    });
  }
});

test("live bootstrap factory consumes the selected sink through its returned recovery path", async (t) => {
  const mutations = [
    ["unused trace parameter", "traceBootstrap(record);", "void record;"],
    ["start bypasses shared sink", 'emit({ kind: "start", attempt: currentAttempt });', 'traceBootstrap({ kind: "start", attempt: currentAttempt });'],
    ["terminal bypasses shared sink", 'return (record) => emit({ kind: "terminal", attempt: currentAttempt, ...record });', 'return (record) => traceBootstrap({ kind: "terminal", attempt: currentAttempt, ...record });'],
    ["unconditional start sink", "var traceTerminal = tracing?.startAttempt();", "var traceTerminal = tracing.startAttempt();"],
    ["discarded terminal", "var traceTerminal = tracing?.startAttempt();", "tracing?.startAttempt(); var traceTerminal = undefined;"],
    ["terminal omitted", "{ ...(traceTerminal === undefined ? {} : { traceTerminal: traceTerminal }) }", "{}"],
    ["alternate terminal", "{ traceTerminal: traceTerminal }", "{ traceTerminal: function alternateTerminal() {} }"],
    ["alternate recovery", "(0, _recover.recoverAndOpen)", "(0, _recover.alternateRecoverAndOpen)"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bootstrap|trace|sink|terminal|recoverAndOpen|factory/i);
      });
    });
  }
});

test("live bootstrap recovery proof binds the exact dependency export and terminal control flow", async (t) => {
  const readyTerminal = 'emitTerminal(dependencies.traceTerminal, { stage: "ready", outcome: "success", closeOutcome: "not-attempted" });';
  const mutations = [
    [
      "dependency target rewired",
      `},${bootstrapModuleId},[${recoveryModuleId}]);`,
      `},${bootstrapModuleId},[${alternateRecoveryModuleId}]);`,
    ],
    [
      "final recoverAndOpen export replaced",
      "exports.recoverAndOpen = recoverAndOpen;",
      "exports.recoverAndOpen = alternateRecoverAndOpen;\nasync function alternateRecoverAndOpen() { return { services: {}, close: async function close() {} }; }",
    ],
    [
      "ready terminal ignores dependencies",
      readyTerminal,
      'emitTerminal(undefined, { stage: "ready", outcome: "success", closeOutcome: "not-attempted" });',
    ],
    [
      "ready terminal omitted",
      readyTerminal,
      "void dependencies.traceTerminal;",
    ],
    [
      "stage initializer omitted",
      'var stage = "open-configure";',
      "var stage;",
    ],
    [
      "migrate stage transition omitted",
      'stage = "migrate";',
      "void stage;",
    ],
    [
      "stage transitions reordered",
      'stage = "migrate";\n    await dependencies.coordinator.runMaintenance("migration", async function () { await database.migrate(signal); });\n    stage = "post-migrate";',
      'stage = "post-migrate";\n    await dependencies.coordinator.runMaintenance("migration", async function () { await database.migrate(signal); });\n    stage = "migrate";',
    ],
    [
      "cleanup helper dependency target rewired",
      `},${recoveryModuleId},[${cleanupFailureModuleId}]);`,
      `},${recoveryModuleId},[${alternateCleanupFailureModuleId}]);`,
    ],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /bootstrap|recoverAndOpen|dependency|export|terminal|ready|failure|close|sink/i);
      });
    });
  }
});

test("selected recovery and cleanup modules reject classifier drift and private-value sinks", async (t) => {
  const mutations = [
    ["cleanup helper raw-error console sink", "var failure = new AggregateError(errors, message);", "var failure = new AggregateError(errors, message); console.error(errors);"],
    ["cleanup helper raw-error JSON serialization", "var failure = new AggregateError(errors, message);", "var failure = new AggregateError(errors, message); JSON.stringify(errors);"],
    ["cleanup helper Metro global escape", "var failure = new AggregateError(errors, message);", "var failure = new AggregateError(errors, message); global.__cleanupErrors = errors;"],
    ["cleanup helper network escape", "var failure = new AggregateError(errors, message);", 'var failure = new AggregateError(errors, message); fetch("/leak", { method: "POST", body: message });'],
    ["Reflect.get wrong property", 'Reflect.get(error, "code")', 'Reflect.get(error, "message")'],
    ["extra allowed SQLite code", 'if (code === "ERR_INTERNAL_SQLITE_ERROR") return "sqlite";', 'if (code === "ERR_INTERNAL_SQLITE_ERROR" || code === "SQLITE_BUSY") return "sqlite";'],
    ["message-dependent category", 'if (error instanceof AggregateError) return "aggregate";', 'if (error.message === "cleanup") return "cleanup";\n    if (error instanceof AggregateError) return "aggregate";'],
    ["stack-dependent category", 'if (error instanceof AggregateError) return "aggregate";', 'if (error.stack) return "aggregate";\n    if (error instanceof AggregateError) return "aggregate";'],
    ["cause-dependent category", 'if (error instanceof AggregateError) return "aggregate";', 'if (error.cause) return "aggregate";\n    if (error instanceof AggregateError) return "aggregate";'],
    ["cleanupFailure final export replaced", "exports.cleanupFailure = cleanupFailure;", "exports.cleanupFailure = function cleanupFailure(error) { return error; };"],
    ["isCleanupFailure final export replaced", "exports.isCleanupFailure = isCleanupFailure;", "exports.isCleanupFailure = function isCleanupFailure() { return false; };"],
    ["cleanup helper extra marker code", 'descriptor?.value === CLEANUP_FAILURE_MARKER', 'descriptor?.value === CLEANUP_FAILURE_MARKER || descriptor?.value === "foreign"'],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(
          validateFaultBundleProof(proof, { root, expectedSha: sha }),
          /bootstrap|recoverAndOpen|recovery|cleanup|classifier|marker|privacy|console|JSON|global|network|output|import|serializ|reference|export/i,
        );
      });
    });
  }
});

test("E2E bootstrap trace rejects non-whitelist serialization from the input record", async () => {
  const hostile = replaceOnce(
    e2eBundleSource(),
    "JSON.stringify(output)",
    "JSON.stringify(record)",
  );
  await withFixture(async ({ root, proof }) => {
    await replaceBundle(root, proof, "ios", "e2e", hostile);
    await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|whitelist|serializ|record/i);
  });
});

test("E2E bootstrap trace rejects serializer aliases and global payloads", async (t) => {
  const mutations = [
    ["whitelist output alias", "var payload = output;\n  try { console.info(`${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(payload)}`); } catch {}"],
    ["global payload alias", "var payload = global.__secretPayload;\n  try { console.info(`${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(payload)}`); } catch {}"],
  ] as const;
  for (const [name, replacement] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(
        e2eBundleSource(),
        "try { console.info(`${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(output)}`); } catch {}",
        replacement,
      );
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|whitelist|serializ|payload|alias/i);
      });
    });
  }
});

test("E2E bootstrap trace rejects prefixed and appended template data", async (t) => {
  const mutations = [
    ["prefixed secret", "`${global.__secret}${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(output)}`"],
    ["appended secret", "`${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(output)}${global.__secret}`"],
  ] as const;
  for (const [name, replacement] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(
        e2eBundleSource(),
        "`${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(output)}`",
        replacement,
      );
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|console|sentinel|template|payload/i);
      });
    });
  }
});

test("E2E bootstrap trace rejects weakened attempt, session, sequence, and start-terminal validation", async (t) => {
  const mutations = [
    ["attempt bound removed", "if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_BOOTSTRAP_ATTEMPTS) return;", "if (false) return;"],
    ["session made constant", 'var traceSession = Math.random().toString(36).slice(2, 14).padEnd(12, "0");', 'var traceSession = "000000000000";'],
    ["sequence increment removed", "sequence: ++traceSequence", "sequence: traceSequence"],
    ["immutable terminal output removed", "Object.freeze(terminal)", "terminal"],
    ["start duplicate guard removed", "if (traceAttempts.has(attempt)) return;", "if (false) return;"],
    ["terminal state guard removed", 'traceAttempts.get(attempt) !== "started"', "false"],
    ["terminal state transition removed", 'traceAttempts.set(attempt, "terminal");', "void traceAttempts;"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|attempt|session|sequence|state|terminal/i);
      });
    });
  }
});

test("E2E bootstrap trace binds alternate-kind rejection and the correlated terminal truth table", async (t) => {
  const mutations = [
    ["alternate kind accepted", 'record.kind === "terminal"', "true"],
    ["success stage guard removed", 'record.stage === "ready"', "true"],
    ["success close guard removed", 'record.closeOutcome === "not-attempted"', "true"],
    ["success category absence guard removed", '&& !("failureCategory" in record)', ""],
    ["failure stage guard removed", "traceFailureStages.has(record.stage)", "true"],
    ["failure close guard removed", "traceFailureCloseOutcomes.has(record.closeOutcome)", "true"],
    ["failure category guard removed", "traceFailureCategories.has(record.failureCategory)", "true"],
    ["duplicate terminal accepted", 'traceAttempts.get(attempt) !== "started"', "false"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|kind|terminal|truth|state|stage|close|category/i);
      });
    });
  }
});

test("E2E bootstrap trace closes attempt-state and validation-set references", async (t) => {
  const mutations = [
    ["attempt state cleared", 'traceAttempts.set(attempt, "started");', 'traceAttempts.set(attempt, "started"); traceAttempts.clear();'],
    ["attempt state deleted", 'traceAttempts.set(attempt, "started");', 'traceAttempts.set(attempt, "started"); traceAttempts.delete(attempt);'],
    ["attempt state extra set", 'traceAttempts.set(attempt, "started");', 'traceAttempts.set(attempt, "started"); traceAttempts.set(attempt + 1, "started");'],
    ["attempt state alias escape", 'traceAttempts.set(attempt, "started");', 'traceAttempts.set(attempt, "started"); var attemptsAlias = traceAttempts;'],
    ["attempt state global escape", 'traceAttempts.set(attempt, "started");', 'traceAttempts.set(attempt, "started"); global.__traceAttempts = traceAttempts;'],
    ["validation set cleared", "traceFailureStages.has(record.stage)", "(traceFailureStages.clear(), traceFailureStages.has(record.stage))"],
    ["validation set deleted", "traceFailureCloseOutcomes.has(record.closeOutcome)", '(traceFailureCloseOutcomes.delete("failed"), traceFailureCloseOutcomes.has(record.closeOutcome))'],
    ["failure stage enum expanded", 'var traceFailureStages = new Set(["open-configure", "migrate", "post-migrate"]);', 'var traceFailureStages = new Set(["open-configure", "migrate", "post-migrate", "ready"]);'],
    ["failure close enum expanded", 'var traceFailureCloseOutcomes = new Set(["unobserved", "succeeded", "failed"]);', 'var traceFailureCloseOutcomes = new Set(["unobserved", "succeeded", "failed", "not-attempted"]);'],
    ["failure category enum expanded", 'var traceFailureCategories = new Set(["abort", "cleanup", "sqlite-open", "sqlite", "aggregate", "uncoded"]);', 'var traceFailureCategories = new Set(["abort", "cleanup", "sqlite-open", "sqlite", "aggregate", "uncoded", "foreign"]);'],
    ["validation set add", "traceFailureCategories.has(record.failureCategory)", '(traceFailureCategories.add("foreign"), traceFailureCategories.has(record.failureCategory))'],
    ["validation set alias escape", "traceFailureStages.has(record.stage)", "(global.__traceStages = traceFailureStages, traceFailureStages.has(record.stage))"],
  ] as const;
  for (const [name, before, after] of mutations) {
    await t.test(name, async () => {
      const hostile = replaceOnce(e2eBundleSource(), before, after);
      await withFixture(async ({ root, proof }) => {
        await replaceBundle(root, proof, "ios", "e2e", hostile);
        await assert.rejects(validateFaultBundleProof(proof, { root, expectedSha: sha }), /trace|binding|reference|state|validation|set|enum|global/i);
      });
    });
  }
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
  const markerFreeListener = listenerBody
    .replace(`var E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL = "${FAULT_CONTROLLER_SENTINEL}";\n`, "")
    .replace(`var E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL = "${BOOTSTRAP_TRACE_SENTINEL}";\n`, "");
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
    ["abort guard", "if (signal?.aborted) return noOp;", "if (false) return noOp;"],
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
