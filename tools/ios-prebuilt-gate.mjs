import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PODS = ["React-Core-prebuilt", "ReactNativeDependencies"];
const REQUIRED_POD_VERSIONS = Object.freeze({
  "React-Core-prebuilt": "0.86.0",
  ReactNativeDependencies: "0.86.0",
});
const REQUIRED_FRAMEWORKS = ["React.framework", "ReactNativeDependencies.framework"];
const COCOAPODS_CONFIGURATION_ENTRIES = [
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoFileSystem/ExpoFileSystem.framework",
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoFont/ExpoFont.framework",
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoModulesCore/ExpoModulesCore.framework",
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoModulesJSI/ExpoModulesJSI.framework",
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoModulesWorklets/ExpoModulesWorklets.framework",
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/React-Core-prebuilt/React.framework",
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/ReactNativeDependencies/ReactNativeDependencies.framework",
  "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built/hermesvm.framework",
];
const POD_SELECTORS = Object.freeze({
  EXPO_USE_PRECOMPILED_MODULES: "1",
  RCT_USE_RN_DEP: "1",
  RCT_USE_PREBUILT_RNCORE: "1",
});
const REQUIRED_ARCHITECTURES = ["arm64"];
const CONFIGURATIONS = ["Debug", "Release"];
const RESOLVERS = ["ReactNativeDependencies", "ReactNativeCore"];
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const SYSTEM_ABSOLUTE_PREFIXES = ["/System/Library/", "/usr/lib/"];
const POD_REPORT_TYPE = "ios-react-native-prebuilt-pods";
const APP_REPORT_TYPE = "ios-react-native-prebuilt-app-closure";
const REPORT_SCHEMA_VERSION = 3;
const SDK_TARGET = "arm64-ios-simulator";
const MAX_RUNPATH_CONTEXTS = 512;
const MAX_RESOLVED_LOADS = 4096;
const RETAINED_POD_FILES = Object.freeze({
  podfile: { token: "podfile-lock", name: "Podfile.lock" },
  manifest: { token: "manifest-lock", name: "Manifest.lock" },
  support: { token: "framework-support-script", name: "Pods-ForMobile-frameworks.sh" },
});
const COCOAPODS_TOP_LEVEL_EVENTS = Object.freeze({
  "set -e": 1,
  "set -u": 2,
  "set -o pipefail": 3,
  "trap 'on_error $LINENO' ERR": 5,
  'echo "mkdir -p ${CONFIGURATION_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"': 7,
  'mkdir -p "${CONFIGURATION_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"': 8,
  'COCOAPODS_PARALLEL_CODE_SIGN="${COCOAPODS_PARALLEL_CODE_SIGN:-false}"': 9,
  'SWIFT_STDLIB_PATH="${TOOLCHAIN_DIR}/usr/lib/swift/${PLATFORM_NAME}"': 10,
  'BCSYMBOLMAP_DIR="BCSymbolMaps"': 11,
  'RSYNC_PROTECT_TMP_FILES=(--filter "P .*.??????")': 12,
  "STRIP_BINARY_RETVAL=0": 15,
});
const COCOAPODS_FUNCTION_EVENTS = Object.freeze({
  on_error: 4,
  install_framework: 13,
  install_dsym: 14,
  strip_invalid_archs: 16,
  install_bcsymbolmap: 17,
  code_sign_if_enabled: 18,
});
const COCOAPODS_FUNCTION_DECLARATIONS = Object.freeze({
  on_error: { line: "function on_error {", separateBrace: false },
  install_framework: { line: "install_framework()", separateBrace: true },
  install_dsym: { line: "install_dsym() {", separateBrace: false },
  strip_invalid_archs: { line: "strip_invalid_archs() {", separateBrace: false },
  install_bcsymbolmap: { line: "install_bcsymbolmap() {", separateBrace: false },
  code_sign_if_enabled: { line: "code_sign_if_enabled() {", separateBrace: false },
});
// SHA-256 of trimmed, non-comment, non-blank body lines joined by LF from CocoaPods 1.16.2.
const COCOAPODS_FUNCTION_BODY_HASHES = Object.freeze({
  on_error: "a84f8a16d6fb63f89b1948eff820b969eb9eabe6fc31806c4330ecd9c5c0e4c7",
  install_framework: "9b3e7c4c5b020b9a5952a20060f096d69dda88f1a916780ccd977e356866a26f",
  install_dsym: "8ae998f5168710928c2a1fa1b934b1df559b122ed573851645c00f8e59819c5d",
  strip_invalid_archs: "156d369cfecc18bc21f1b273a9aa0d7793a67ea483c828ce9d97c550ed9d2d20",
  install_bcsymbolmap: "25b2209102e1d9364f5977fefd155f76fd857b8d79bbf24271adb38c1efe30e1",
  code_sign_if_enabled: "b33581e98b1ad3b374aeac57b3a2e2463e314039c9d57371169fb0ae56f68460",
});

export const PINNED_APP_TOOLS = Object.freeze({
  otool: "/usr/bin/otool",
  lipo: "/usr/bin/lipo",
  xcrun: "/usr/bin/xcrun",
});

class GateError extends Error {
  constructor(stage, code, message) {
    super(message);
    this.name = "GateError";
    this.stage = stage;
    this.code = code;
  }
}

function fail(stage, code, message) {
  throw new GateError(stage, code, message);
}

function requireGate(condition, stage, code, message) {
  if (!condition) fail(stage, code, message);
}

function option(args, name) {
  const index = args.indexOf(name);
  assert(index >= 0 && args[index + 1], `${name} is required`);
  return args[index + 1];
}

function parseOptions(args, names) {
  const allowed = new Set(names);
  for (let index = 0; index < args.length; index += 2) {
    assert(allowed.has(args[index]), `Unknown option: ${args[index] ?? "<missing>"}`);
    assert(args[index + 1], `${args[index]} is required`);
  }
  return Object.fromEntries(names.map((name) => [name, option(args, name)]));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function failure(error, fallbackStage) {
  if (error instanceof GateError) {
    return { stage: error.stage, code: error.code, message: `${error.stage} failed closed; inspect retained logs for details` };
  }
  return {
    stage: fallbackStage,
    code: "unexpected-failure",
    message: "iOS prebuilt gate failed unexpectedly",
  };
}

function commonReport(reportType, flavor, checkedOutSha, expectedSha) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportType,
    platform: "ios",
    flavor: ["production", "e2e"].includes(flavor) ? flavor : null,
    checkedOutSha: /^[0-9a-f]{40}$/.test(checkedOutSha ?? "") ? checkedOutSha : null,
    expectedSha: /^[0-9a-f]{40}$/.test(expectedSha ?? "") ? expectedSha : null,
  };
}

function validateIdentity({ checkedOutSha, expectedSha, flavor, allowedFlavors }, stage) {
  requireGate(/^[0-9a-f]{40}$/.test(expectedSha ?? ""), stage, "invalid-expected-sha", "Expected SHA must be a full lowercase commit SHA");
  requireGate(/^[0-9a-f]{40}$/.test(checkedOutSha ?? ""), stage, "invalid-checked-out-sha", "Checked-out SHA must be a full lowercase commit SHA");
  requireGate(checkedOutSha === expectedSha, stage, "sha-mismatch", "Checked-out SHA does not match expected SHA");
  requireGate(allowedFlavors.includes(flavor), stage, "invalid-flavor", `Flavor must be ${allowedFlavors.join(" or ")}`);
}

async function regularFile(path, stage, code, message) {
  let details;
  try {
    details = await stat(path);
  } catch {
    fail(stage, code, message);
  }
  requireGate(details.isFile(), stage, code, message);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableMetadata(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function validAncestor(details, path, rejectSymlinks, isPinnedPath) {
  if (isPinnedPath) return details.isDirectory() && !details.isSymbolicLink();
  if (details.isDirectory()) return true;
  return details.isSymbolicLink() && (!rejectSymlinks || dirname(path) === "/");
}

export async function pinPathAncestors(path, { includePath = false, rejectSymlinks = true } = {}) {
  const pinned = [];
  let current = includePath ? resolve(path) : dirname(resolve(path));
  while (true) {
    const details = await lstat(current, { bigint: true });
    const isPinnedPath = includePath && pinned.length === 0;
    if (!validAncestor(details, current, rejectSymlinks, isPinnedPath)) throw new Error("Path ancestor is not a stable directory");
    pinned.push({ path: current, details, rejectSymlinks, isPinnedPath });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return pinned;
}

export async function verifyPinnedAncestors(pinned) {
  for (const entry of pinned) {
    const details = await lstat(entry.path, { bigint: true });
    if (!validAncestor(details, entry.path, entry.rejectSymlinks, entry.isPinnedPath)
      || !sameFileIdentity(details, entry.details)) {
      throw new Error("Path ancestor changed during inspection");
    }
  }
}

async function gatePinnedAncestors(path, stage, code, message, options) {
  try {
    return await pinPathAncestors(path, options);
  } catch {
    fail(stage, code, message);
  }
}

async function gateVerifyPinnedAncestors(pinned, stage, code, message) {
  try {
    await verifyPinnedAncestors(pinned);
  } catch {
    fail(stage, code, message);
  }
}

async function stableRegularFileBytes(path, stage, code, message, { rejectParentSymlinks = true, afterRead } = {}) {
  const pinned = await gatePinnedAncestors(path, stage, code, message, { rejectSymlinks: rejectParentSymlinks });
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail(stage, code, message);
  }
  let bytes;
  let operationError = null;
  try {
    const before = await handle.stat({ bigint: true });
    const pathBefore = await lstat(path, { bigint: true });
    requireGate(before.isFile() && pathBefore.isFile() && !pathBefore.isSymbolicLink() && sameFileIdentity(before, pathBefore), stage, code, message);
    bytes = await handle.readFile();
    await afterRead?.(path);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    requireGate(
      after.isFile() && pathAfter.isFile() && !pathAfter.isSymbolicLink()
        && sameStableMetadata(before, after) && sameFileIdentity(after, pathAfter),
      stage,
      code,
      message,
    );
    await gateVerifyPinnedAncestors(pinned, stage, code, message);
  } catch (error) {
    operationError = error instanceof GateError ? error : new GateError(stage, code, message);
  }
  try {
    await handle.close();
  } catch {
    operationError ??= new GateError(stage, code, message);
  }
  if (operationError !== null) throw operationError;
  return bytes;
}

async function canonicalDirectory(path, stage, code, message) {
  try {
    return await pinPathAncestors(path, { includePath: true });
  } catch (error) {
    if (error instanceof GateError) throw error;
    fail(stage, code, message);
  }
}

function resolverModes(output) {
  const clean = output.replace(ANSI_ESCAPE, "");
  const modes = {};
  for (const resolver of RESOLVERS) {
    const expression = new RegExp(`^\\[${resolver}\\] Building from source: (true|false)\\s*$`, "gm");
    const matches = [...clean.matchAll(expression)].map((match) => match[1]);
    requireGate(matches.length === 1, "pod-install", "malformed-resolver-output", `Pod install attempt has malformed resolver output for ${resolver}`);
    modes[resolver] = matches[0] === "true";
  }
  return modes;
}

async function runPodAttempt({ iosDirectory, logDirectory, attempt }) {
  await mkdir(logDirectory, { recursive: true });
  const logPath = join(logDirectory, `attempt-${attempt}.log`);
  const args = ["install", ...(attempt === 2 ? ["--clean-install"] : [])];
  const child = spawn("pod", args, {
    cwd: iosDirectory,
    env: {
      ...process.env,
      ...POD_SELECTORS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const result = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  return {
    output: `${stdout}\n${stderr}`,
    logPath,
    record: {
      attempt,
      command: args,
      exit: result,
      log: null,
      diagnostics: {
        rawOutputRetained: false,
        stderrBytes: Buffer.byteLength(stderr),
        stdoutBytes: Buffer.byteLength(stdout),
      },
      resolverModes: null,
    },
  };
}

async function retainSafePodDiagnostics(result) {
  const modes = result.record.resolverModes;
  const lines = [
    `pod attempt ${result.record.attempt}: raw CocoaPods output suppressed`,
    `stdoutBytes=${result.record.diagnostics.stdoutBytes}`,
    `stderrBytes=${result.record.diagnostics.stderrBytes}`,
    `exitCode=${result.record.exit.code ?? "null"}`,
    `signal=${result.record.exit.signal ?? "none"}`,
    ...(modes === null ? [] : RESOLVERS.map((resolver) => `${resolver}=${modes[resolver]}`)),
    "",
  ];
  const bytes = Buffer.from(lines.join("\n"));
  await writeFile(result.logPath, bytes, { flag: "wx" });
  result.record.log = {
    token: `pod-attempt-${result.record.attempt}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  process.stdout.write(bytes);
}

function frameworkEntry(framework) {
  const pod = framework === "React.framework" ? "React-Core-prebuilt" : "ReactNativeDependencies";
  return `\${PODS_XCFRAMEWORKS_BUILD_DIR}/${pod}/${framework}`;
}

function lockPodsSection(source) {
  const lines = source.split(/\r\n|\n|\r/);
  const sections = lines.map((line, index) => line === "PODS:" ? index : -1).filter((index) => index >= 0);
  requireGate(sections.length > 0, "pod-graph", "missing-pods-section", "Podfile.lock PODS section is missing");
  requireGate(sections.length === 1, "pod-graph", "duplicate-pods-section", "Podfile.lock must contain exactly one top-level PODS section");
  const [start] = sections;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^[A-Z][A-Z _-]+:\s*$/.test(line));
  return lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset).join("\n");
}

function podSelections(source, pod) {
  const escapedPod = pod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`^  - ${escapedPod} \\(([^)]+)\\):?\\s*$`, "gm");
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function supportScriptPlan(source) {
  const lines = source.split(/\r\n|\n|\r/);
  const plans = {};
  const seenEvents = new Set();
  const seenFunctions = new Set();
  const functionBodies = {};
  let activeConfiguration = null;
  let activeFunction = null;
  let pendingFunction = null;
  let activeGuard = null;
  let lastEvent = 0;
  const recordEvent = (event, key) => {
    requireGate(event > lastEvent && !seenEvents.has(key), "pod-graph", "unsafe-top-level-command", "Framework support script violates the CocoaPods 1.16.2 top-level contract");
    lastEvent = event;
    seenEvents.add(key);
  };
  const requireFunctionBody = (functionName) => {
    const body = functionBodies[functionName];
    const bodyHash = createHash("sha256").update(body.join("\n")).digest("hex");
    requireGate(
      bodyHash === COCOAPODS_FUNCTION_BODY_HASHES[functionName],
      "pod-graph",
      "unsafe-function-body",
      `Framework support script ${functionName} function body is not the CocoaPods 1.16.2 implementation`,
    );
  };
  const requireCompletePrefix = () => {
    const hasTopLevelLines = Object.keys(COCOAPODS_TOP_LEVEL_EVENTS).every((line) => seenEvents.has(`line:${line}`));
    const hasFunctions = Object.keys(COCOAPODS_FUNCTION_EVENTS).every((functionName) => seenEvents.has(`function:${functionName}`));
    requireGate(
      lastEvent === 18 && hasTopLevelLines && hasFunctions && seenEvents.has("frameworks-folder-guard"),
      "pod-graph",
      "incomplete-support-contract",
      "Framework support script is missing required CocoaPods 1.16.2 controls or functions",
    );
  };
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (activeFunction !== null) {
      if (trimmed === "}") {
        requireFunctionBody(activeFunction);
        activeFunction = null;
      } else {
        functionBodies[activeFunction].push(trimmed);
      }
      continue;
    }
    if (pendingFunction !== null) {
      requireGate(trimmed === "{", "pod-graph", "malformed-support-script", "Framework support script function declaration is malformed");
      activeFunction = pendingFunction;
      pendingFunction = null;
      continue;
    }

    if (activeConfiguration !== null) {
      if (trimmed === "fi") {
        activeConfiguration = null;
        continue;
      }
      requireGate(!/^(?:elif|else)\b/.test(trimmed), "pod-graph", "ambiguous-configuration-plan", `${activeConfiguration} embed plan has ambiguous branch flow`);
      const call = /^install_framework "([^"\r\n]+)"$/.exec(trimmed);
      requireGate(call, "pod-graph", "unexpected-configuration-command", `${activeConfiguration} embed plan contains an unexpected command`);
      plans[activeConfiguration].push(call[1]);
      continue;
    }

    if (activeGuard !== null) {
      if (trimmed === "fi") {
        requireGate(activeGuard.commandSeen, "pod-graph", "malformed-support-script", "Framework support script CocoaPods guard is incomplete");
        activeGuard = null;
        continue;
      }
      const expectedCommand = activeGuard.kind === "frameworks-folder-guard" ? "exit 0" : "wait";
      requireGate(!activeGuard.commandSeen && trimmed === expectedCommand, "pod-graph", "unsafe-top-level-command", "Framework support script violates the CocoaPods 1.16.2 top-level contract");
      activeGuard.commandSeen = true;
      continue;
    }

    const configurationMatch = /^if \[\[ "\$CONFIGURATION" == "(Debug|Release)" \]\]; then$/.exec(trimmed);
    if (configurationMatch) {
      const configuration = configurationMatch[1];
      requireGate(plans[configuration] === undefined, "pod-graph", "duplicate-configuration-plan", `${configuration} embed plan must be unique`);
      if (configuration === "Debug") requireCompletePrefix();
      recordEvent(configuration === "Debug" ? 19 : 20, `configuration:${configuration}`);
      plans[configuration] = [];
      activeConfiguration = configuration;
      continue;
    }
    if (trimmed.includes("$CONFIGURATION") && /^(?:if|elif)\b/.test(trimmed)) {
      fail("pod-graph", "ambiguous-configuration-plan", "Framework support script has an ambiguous configuration selector");
    }

    if (trimmed === "if [ -z ${FRAMEWORKS_FOLDER_PATH+x} ]; then") {
      recordEvent(6, "frameworks-folder-guard");
      activeGuard = { kind: "frameworks-folder-guard", commandSeen: false };
      continue;
    }
    if (trimmed === 'if [ "${COCOAPODS_PARALLEL_CODE_SIGN}" == "true" ]; then') {
      requireGate(
        CONFIGURATIONS.every((configuration) => plans[configuration] !== undefined),
        "pod-graph",
        "unsafe-top-level-command",
        "Framework support script violates the CocoaPods 1.16.2 top-level contract",
      );
      recordEvent(21, "parallel-code-sign-guard");
      activeGuard = { kind: "parallel-code-sign-guard", commandSeen: false };
      continue;
    }

    const oneLineFunction = /^(?:function\s+([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)\(\))\s*\{$/.exec(trimmed);
    const twoLineFunction = /^([A-Za-z_][A-Za-z0-9_]*)\(\)$/.exec(trimmed);
    const functionName = oneLineFunction?.[1] ?? oneLineFunction?.[2] ?? twoLineFunction?.[1] ?? null;
    if (functionName !== null) {
      const event = COCOAPODS_FUNCTION_EVENTS[functionName];
      requireGate(event !== undefined && !seenFunctions.has(functionName), "pod-graph", "unsafe-top-level-command", "Framework support script declares an unapproved top-level function");
      const declaration = COCOAPODS_FUNCTION_DECLARATIONS[functionName];
      requireGate(
        trimmed === declaration.line && Boolean(twoLineFunction) === declaration.separateBrace,
        "pod-graph",
        "unsafe-top-level-command",
        "Framework support script function declaration is not the CocoaPods 1.16.2 form",
      );
      recordEvent(event, `function:${functionName}`);
      seenFunctions.add(functionName);
      functionBodies[functionName] = [];
      if (twoLineFunction) pendingFunction = functionName;
      else activeFunction = functionName;
      continue;
    }

    const event = COCOAPODS_TOP_LEVEL_EVENTS[trimmed];
    if (event !== undefined) {
      recordEvent(event, `line:${trimmed}`);
      continue;
    }
    fail("pod-graph", "unsafe-top-level-command", "Framework support script contains unapproved top-level executable text");
  }
  requireGate(activeConfiguration === null && activeFunction === null && pendingFunction === null && activeGuard === null, "pod-graph", "malformed-support-script", "Framework support script control flow is malformed");
  requireGate(lastEvent === 21 && seenEvents.size === 21 && seenFunctions.size === Object.keys(COCOAPODS_FUNCTION_EVENTS).length, "pod-graph", "incomplete-support-contract", "Framework support script is missing required CocoaPods 1.16.2 controls or functions");
  requireGate(Object.keys(plans).length === CONFIGURATIONS.length, "pod-graph", "missing-configuration-plan", "Debug and Release embed plans must each be present exactly once");
  return plans;
}

function podGraphProof(podfile, manifest, scriptBytes) {
  requireGate(podfile.equals(manifest), "pod-graph", "lockfile-drift", "Podfile.lock and Pods/Manifest.lock must match exactly");
  const lockSource = lockPodsSection(podfile.toString("utf8"));
  for (const pod of REQUIRED_PODS) {
    const version = REQUIRED_POD_VERSIONS[pod];
    const selections = podSelections(lockSource, pod);
    requireGate(selections.length === 1 && selections[0] === version, "pod-graph", "invalid-required-pod-selection", `Podfile.lock must select exactly one ${pod} ${version}`);
  }

  requireGate(
    scriptBytes.subarray(0, 10).equals(Buffer.from("#!/bin/sh\n")),
    "pod-graph",
    "malformed-support-script",
    "Framework support script has a noncanonical executable header",
  );
  const scriptSource = scriptBytes.toString("utf8");
  const scriptPlans = supportScriptPlan(scriptSource);
  const supportPlans = {};
  for (const configuration of CONFIGURATIONS) {
    const requiredEntries = REQUIRED_FRAMEWORKS.map(frameworkEntry);
    const observedEntries = scriptPlans[configuration].filter((entry) => requiredEntries.includes(entry));
    for (const [index, entry] of requiredEntries.entries()) {
      requireGate(
        observedEntries.filter((candidate) => candidate === entry).length === 1,
        "pod-graph",
        "missing-framework-embed",
        `${configuration} embed plan does not select ${REQUIRED_FRAMEWORKS[index]}`,
      );
    }
    requireGate(
      scriptPlans[configuration].length === COCOAPODS_CONFIGURATION_ENTRIES.length
        && scriptPlans[configuration].every((entry, index) => entry === COCOAPODS_CONFIGURATION_ENTRIES[index]),
      "pod-graph",
      "noncanonical-framework-embed-plan",
      `${configuration} embed plan must exactly match the CocoaPods 1.16.2 framework order`,
    );
    requireGate(
      observedEntries.length === requiredEntries.length
        && observedEntries.every((entry, index) => entry === requiredEntries[index]),
      "pod-graph",
      "noncanonical-framework-embed-plan",
      `${configuration} prebuilt embed plan must exactly match the canonical ordered entries`,
    );
    supportPlans[configuration] = {
      entries: [...observedEntries],
      frameworks: observedEntries.map((entry) => basename(entry)),
    };
  }
  const leaves = [
    { ...RETAINED_POD_FILES.podfile, bytes: podfile },
    { ...RETAINED_POD_FILES.manifest, bytes: manifest },
    { ...RETAINED_POD_FILES.support, bytes: scriptBytes },
  ];
  return {
    report: {
      lockfiles: {
        equal: true,
        files: leaves.slice(0, 2).map(({ token, bytes }) => ({ token, sha256: createHash("sha256").update(bytes).digest("hex") })),
      },
      supportPlan: {
        file: { token: RETAINED_POD_FILES.support.token, sha256: createHash("sha256").update(scriptBytes).digest("hex") },
        configurations: supportPlans,
      },
    },
    leaves,
  };
}

async function verifyPodGraph(iosDirectory) {
  const podfilePath = join(iosDirectory, "Podfile.lock");
  const manifestPath = join(iosDirectory, "Pods/Manifest.lock");
  await regularFile(podfilePath, "pod-graph", "missing-lockfile", "Podfile.lock is missing");
  await regularFile(manifestPath, "pod-graph", "missing-lockfile", "Pods/Manifest.lock is missing");
  const target = "Pods-ForMobile";
  const supportRoot = join(iosDirectory, "Pods/Target Support Files", target);
  try {
    await readdir(supportRoot, { withFileTypes: true });
  } catch {
    fail("pod-graph", "missing-app-support-plan", "Pods-ForMobile framework support plan is missing");
  }
  const scriptPath = join(supportRoot, `${target}-frameworks.sh`);
  await regularFile(scriptPath, "pod-graph", "missing-app-support-plan", "Pods-ForMobile framework support plan is missing");
  const [podfile, manifest, scriptBytes] = await Promise.all([
    stableRegularFileBytes(podfilePath, "pod-graph", "invalid-pod-input", "Podfile.lock changed while being inspected"),
    stableRegularFileBytes(manifestPath, "pod-graph", "invalid-pod-input", "Pods/Manifest.lock changed while being inspected"),
    stableRegularFileBytes(scriptPath, "pod-graph", "invalid-pod-input", "Pods-ForMobile framework support plan changed while being inspected"),
  ]);
  return podGraphProof(podfile, manifest, scriptBytes);
}

async function retainPodInputs(retainedDirectory, leaves) {
  await mkdir(retainedDirectory, { recursive: true, mode: 0o700 });
  for (const leaf of leaves) await writeFile(join(retainedDirectory, leaf.name), leaf.bytes, { flag: "wx", mode: 0o600 });
}

function parseRetainedAttempt(bytes, expectedAttempt) {
  const expression = /^pod attempt ([12]): raw CocoaPods output suppressed\nstdoutBytes=(\d+)\nstderrBytes=(\d+)\nexitCode=(\d+)\nsignal=none\nReactNativeDependencies=(true|false)\nReactNativeCore=(true|false)\n$/;
  const match = expression.exec(bytes.toString("utf8"));
  requireGate(match && Number(match[1]) === expectedAttempt, "pod-graph", "invalid-retained-attempt", "Retained pod attempt log is malformed");
  return {
    attempt: expectedAttempt,
    exit: { code: Number(match[4]), signal: null },
    diagnostics: { rawOutputRetained: false, stderrBytes: Number(match[3]), stdoutBytes: Number(match[2]) },
    resolverModes: { ReactNativeDependencies: match[5] === "true", ReactNativeCore: match[6] === "true" },
    log: { token: `pod-attempt-${expectedAttempt}`, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

/**
 * @param {{ retainedDirectory: string, logDirectory: string, attemptCount: number, afterRead?: (path: string) => Promise<void> | void }} input
 */
export async function inspectRetainedPodInputs(input) {
  const { retainedDirectory, logDirectory, attemptCount, afterRead } = input;
  requireGate(Number.isInteger(attemptCount) && [1, 2].includes(attemptCount), "pod-graph", "invalid-retained-input", "Retained pod attempt count is invalid");
  const directoryPins = [];
  for (const directory of [retainedDirectory, logDirectory]) {
    directoryPins.push(await canonicalDirectory(directory, "pod-graph", "invalid-retained-input", "Retained pod input directory must be a non-symlink directory with non-symlink parents"));
  }
  const retainedEntries = (await readdir(retainedDirectory)).sort();
  requireGate(
    JSON.stringify(retainedEntries) === JSON.stringify(Object.values(RETAINED_POD_FILES).map((file) => file.name).sort()),
    "pod-graph",
    "invalid-retained-input",
    "Retained pod input inventory is invalid",
  );
  const [podfile, manifest, support] = await Promise.all([
    stableRegularFileBytes(join(retainedDirectory, RETAINED_POD_FILES.podfile.name), "pod-graph", "invalid-retained-input", "Retained pod input must remain one regular non-symlink file", { afterRead }),
    stableRegularFileBytes(join(retainedDirectory, RETAINED_POD_FILES.manifest.name), "pod-graph", "invalid-retained-input", "Retained pod input must remain one regular non-symlink file", { afterRead }),
    stableRegularFileBytes(join(retainedDirectory, RETAINED_POD_FILES.support.name), "pod-graph", "invalid-retained-input", "Retained pod input must remain one regular non-symlink file", { afterRead }),
  ]);
  const graph = podGraphProof(podfile, manifest, support).report;
  const attempts = [];
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const bytes = await stableRegularFileBytes(join(logDirectory, `attempt-${attempt}.log`), "pod-graph", "invalid-retained-input", "Retained pod input must remain one regular non-symlink file", { afterRead });
    attempts.push(parseRetainedAttempt(bytes, attempt));
  }
  for (const pinned of directoryPins) {
    await gateVerifyPinnedAncestors(pinned, "pod-graph", "invalid-retained-input", "Retained pod input directory changed while being inspected");
  }
  return { graph, attempts };
}

export async function installPrebuiltPods({ iosDirectory, logDirectory, retainedDirectory, reportPath, expectedSha, checkedOutSha, flavor }) {
  const base = commonReport(POD_REPORT_TYPE, flavor, checkedOutSha, expectedSha);
  const attempts = [];
  const selectors = { ...POD_SELECTORS };
  try {
    validateIdentity({ checkedOutSha, expectedSha, flavor, allowedFlavors: ["production", "e2e"] }, "pod-install");
    let acceptedAttempt = null;
    for (const attempt of [1, 2]) {
      const result = await runPodAttempt({ iosDirectory, logDirectory, attempt });
      attempts.push(result.record);
      let attemptError = null;
      try {
        requireGate(result.record.exit.signal === null, "pod-install", "pod-command-signaled", `pod ${result.record.command.join(" ")} attempt ${attempt} ended by signal`);
        requireGate(result.record.exit.code === 0, "pod-install", "pod-command-failed", `pod ${result.record.command.join(" ")} attempt ${attempt} exited ${result.record.exit.code}`);
        result.record.resolverModes = resolverModes(result.output);
      } catch (error) {
        attemptError = error;
      }
      await retainSafePodDiagnostics(result);
      if (attemptError !== null) throw attemptError;
      requireGate(
        Object.values(result.record.resolverModes).every((mode) => mode === false),
        "pod-install",
        "source-mode-fallback",
        "React Native pod resolvers selected source mode despite pinned prebuilt selectors",
      );
      acceptedAttempt = attempt;
      break;
    }
    requireGate(acceptedAttempt !== null, "pod-install", "missing-prebuilt-mode", "React Native pod resolvers did not reach prebuilt mode");
    const graph = await verifyPodGraph(iosDirectory);
    await retainPodInputs(retainedDirectory, graph.leaves);
    const report = {
      ...base,
      status: "pass",
      selectors,
      attempts,
      acceptedAttempt,
      configurations: [...CONFIGURATIONS],
      pods: [...REQUIRED_PODS],
      podVersions: { ...REQUIRED_POD_VERSIONS },
      frameworks: [...REQUIRED_FRAMEWORKS],
      privacy: { rawOutputRetained: false },
      graph: graph.report,
    };
    await writeJson(reportPath, report);
    return report;
  } catch (error) {
    await writeJson(reportPath, {
      ...base,
      status: "fail",
      selectors,
      attempts,
      failure: failure(error, "pod-install"),
    });
    throw error;
  }
}

function isSystemAbsolute(path) {
  return SYSTEM_ABSOLUTE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function containsTraversal(path) {
  return path.split("/").includes("..");
}

function inside(root, path) {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

async function appBinaries(appPath, configuration) {
  const binaries = [join(appPath, "ForMobile")];
  if (configuration === "Debug") {
    try {
      const debugDylib = join(appPath, "ForMobile.debug.dylib");
      const details = await lstat(debugDylib);
      requireGate(!details.isSymbolicLink(), "app-closure", "symlinked-app-binary", `${configuration} app binary cannot be a symlink`);
      if (details.isFile()) binaries.push(debugDylib);
    } catch (error) {
      if (error instanceof GateError) throw error;
    }
  }
  const frameworksDirectory = join(appPath, "Frameworks");
  let frameworksDetails;
  try {
    frameworksDetails = await lstat(frameworksDirectory);
  } catch {
    fail("app-closure", "missing-frameworks-directory", `${configuration} app Frameworks directory is missing`);
  }
  requireGate(frameworksDetails.isDirectory() && !frameworksDetails.isSymbolicLink(), "app-closure", "symlinked-frameworks-directory", `${configuration} app Frameworks directory cannot be a symlink`);
  let entries;
  try {
    entries = await readdir(frameworksDirectory, { withFileTypes: true });
  } catch {
    fail("app-closure", "missing-frameworks-directory", `${configuration} app Frameworks directory is missing`);
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".framework")) {
      requireGate(!entry.isSymbolicLink(), "app-closure", "symlinked-framework", `${configuration} ${entry.name} cannot be a symlink`);
      requireGate(entry.isDirectory(), "app-closure", "malformed-framework", `${configuration} ${entry.name} must be a directory`);
      binaries.push(join(frameworksDirectory, entry.name, entry.name.slice(0, -".framework".length)));
    } else if (entry.name.endsWith(".dylib")) {
      requireGate(!entry.isSymbolicLink(), "app-closure", "symlinked-app-binary", `${configuration} app binary cannot be a symlink`);
      requireGate(entry.isFile(), "app-closure", "malformed-app-binary", `${configuration} app binary must be a file`);
      binaries.push(join(frameworksDirectory, entry.name));
    }
  }
  for (const binary of binaries) {
    let details;
    try {
      details = await lstat(binary);
    } catch {
      fail("app-closure", "missing-app-binary", `${configuration} app binary is missing`);
    }
    requireGate(!details.isSymbolicLink(), "app-closure", "symlinked-app-binary", `${configuration} app binary cannot be a symlink`);
    requireGate(details.isFile(), "app-closure", "missing-app-binary", `${configuration} app binary is missing`);
  }
  return binaries;
}

async function captureTool(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const result = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  return { ...result, stdout, stderr };
}

async function pinnedOutput(runTool, command, args, configuration, binary) {
  let result;
  try {
    result = await runTool(command, args);
  } catch {
    fail("app-closure", "tool-failed", `Pinned tool failed for ${configuration} ${basename(binary)}`);
  }
  requireGate(result?.signal === null && result?.code === 0, "app-closure", "tool-failed", `Pinned tool failed for ${configuration} ${basename(binary)}`);
  return result.stdout;
}

function parseDependencies(output, configuration, binary) {
  const lines = output.split(/\r\n|\n|\r/).filter(Boolean);
  requireGate(lines.length > 0, "app-closure", "malformed-otool-output", `otool returned malformed dependencies for ${configuration} ${basename(binary)}`);
  const escapedBinary = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^${escapedBinary}(?: \\(architecture [^)]+\\))?:$`);
  const dependencies = [];
  for (const line of lines) {
    if (header.test(line)) continue;
    const match = /^\s+(\S+)\s+\(/.exec(line);
    requireGate(match, "app-closure", "malformed-otool-output", `otool returned a malformed dependency for ${configuration} ${basename(binary)}`);
    dependencies.push(match[1]);
  }
  return [...new Set(dependencies)];
}

function parseRpaths(output, configuration, binary) {
  const lines = output.split(/\r\n|\n|\r/);
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    let path = null;
    for (index += 1; index < lines.length && !/^Load command \d+$/.test(lines[index]); index += 1) {
      const match = /^\s*path (.+) \(offset \d+\)\s*$/.exec(lines[index]);
      if (match) path = match[1];
    }
    index -= 1;
    requireGate(path, "app-closure", "malformed-rpath-output", `otool returned malformed LC_RPATH for ${configuration} ${basename(binary)}`);
    rpaths.push(path);
  }
  return rpaths;
}

function tokenSuffix(value, token) {
  if (value === token) return "";
  return value.startsWith(`${token}/`) ? value.slice(token.length + 1) : null;
}

function expandPath(value, binary, appPath, configuration, kind) {
  requireGate(!containsTraversal(value), "app-closure", "path-traversal", `${configuration} ${basename(binary)} has traversal ${kind}: ${value}`);
  const loaderSuffix = tokenSuffix(value, "@loader_path");
  if (loaderSuffix !== null) return resolve(dirname(binary), loaderSuffix);
  const executableSuffix = tokenSuffix(value, "@executable_path");
  if (executableSuffix !== null) return resolve(appPath, executableSuffix);
  if (isAbsolute(value)) return value;
  fail("app-closure", "unsupported-load-path", `${configuration} ${basename(binary)} has unsupported ${kind}: ${value}`);
}

async function rejectSymlinkComponents(root, path, configuration, kind) {
  const suffix = relative(root, path);
  let componentPath = root;
  for (const component of suffix.split("/").filter(Boolean)) {
    componentPath = join(componentPath, component);
    let details;
    try {
      details = await lstat(componentPath);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false;
      fail("app-closure", `invalid-${kind}`, `${configuration} binary has an unreadable ${kind} component`);
    }
    requireGate(
      !details.isSymbolicLink(),
      "app-closure",
      `symlinked-${kind}`,
      kind === "rpath"
        ? `${configuration} binary has a symlinked LC_RPATH component`
        : `${configuration} binary has a symlinked dependency component`,
    );
  }
  return true;
}

async function expandRpaths(rpaths, binary, appPath, appRealPath, sdkPath, configuration) {
  const expandedRpaths = [];
  for (const rpath of rpaths) {
    if (isAbsolute(rpath) && rpath !== "/usr/lib/swift") {
      fail("app-closure", "non-system-absolute-rpath", `${configuration} binary has a non-system absolute LC_RPATH`);
    }
    const expanded = expandPath(rpath, binary, appPath, configuration, "LC_RPATH");
    if (expanded === "/usr/lib/swift") {
      const sdkSwiftPath = await realpath(join(sdkPath, "usr/lib/swift"));
      requireGate(inside(sdkPath, sdkSwiftPath) && (await stat(sdkSwiftPath)).isDirectory(), "app-closure", "external-rpath", `${configuration} binary has an unowned system Swift LC_RPATH`);
      expandedRpaths.push({ kind: "system-swift", path: expanded });
      continue;
    }
    requireGate(inside(appPath, expanded), "app-closure", "external-rpath", `${configuration} binary has an external LC_RPATH`);
    await rejectSymlinkComponents(appPath, expanded, configuration, "rpath");
    try {
      const resolved = await realpath(expanded);
      requireGate(inside(appRealPath, resolved), "app-closure", "external-rpath", `${configuration} binary has an externally resolving LC_RPATH`);
    } catch (error) {
      if (error instanceof GateError) throw error;
    }
    expandedRpaths.push({ kind: "bundle", path: expanded });
  }
  return expandedRpaths;
}

function sdkStubCandidates(sdkPath, dependency) {
  const sdkDependency = `${sdkPath}${dependency}`;
  if (dependency.endsWith(".dylib")) return [sdkDependency.slice(0, -".dylib".length) + ".tbd"];
  return [`${sdkDependency}.tbd`, sdkDependency];
}

function tbdLineWithoutComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && line[index + 1] === "'") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function parseTbdScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || !/^(?:[^']|'')*$/.test(trimmed.slice(1, -1))) return null;
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (/^[\[\]{}|>&*!]/.test(trimmed)) return null;
  return trimmed;
}

function parseTbdFlowSequence(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const scalars = [];
  let start = 1;
  let quote = null;
  let escaped = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && trimmed[index + 1] === "'") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === ",") {
      const scalar = parseTbdScalar(trimmed.slice(start, index));
      if (scalar === null) return null;
      scalars.push(scalar);
      start = index + 1;
    }
  }
  if (quote !== null) return null;
  const tail = trimmed.slice(start, -1).trim();
  if (tail !== "") {
    const scalar = parseTbdScalar(tail);
    if (scalar === null) return null;
    scalars.push(scalar);
  }
  return scalars;
}

function completeTbdFlow(lines, startIndex, initialValue) {
  let value = initialValue.trim();
  let quote = null;
  let escaped = false;
  let depth = 0;
  const scan = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quote === '"') {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (quote === "'") {
        if (character === "'" && text[index + 1] === "'") index += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"') quote = character;
      else if (character === "[") depth += 1;
      else if (character === "]") depth -= 1;
    }
  };
  scan(value);
  let endIndex = startIndex;
  while (depth > 0 && endIndex + 1 < lines.length) {
    endIndex += 1;
    const next = tbdLineWithoutComment(lines[endIndex]).trim();
    value += ` ${next}`;
    scan(next);
  }
  return depth === 0 && quote === null ? { endIndex, value } : null;
}

function tbdDocuments(source) {
  const documents = [];
  let current = null;
  let ended = false;
  for (const line of source.split(/\r\n|\n|\r/)) {
    const trimmed = tbdLineWithoutComment(line).trim();
    if (trimmed === "--- !tapi-tbd") {
      if (ended || current?.length === 0) return null;
      if (current !== null) documents.push(current);
      current = [];
      continue;
    }
    if (trimmed === "...") {
      if (current === null || current.length === 0) return null;
      documents.push(current);
      current = null;
      ended = true;
      continue;
    }
    if (trimmed === "") continue;
    if (current === null || ended) return null;
    current.push(line);
  }
  if (current !== null) {
    if (current.length === 0) return null;
    documents.push(current);
  }
  return documents.length > 0 ? documents : null;
}

function tbdScalarNode(raw) {
  const value = parseTbdScalar(raw);
  return value === null ? null : { kind: "scalar", raw: raw.trim(), value };
}

function tbdValue(lines, index, raw, indentation) {
  if (raw === "") return { endIndex: index, node: null };
  if (raw.startsWith("[")) {
    const complete = completeTbdFlow(lines, index, raw);
    if (complete === null) return null;
    const values = parseTbdFlowSequence(complete.value);
    if (values === null) return null;
    return {
      endIndex: complete.endIndex,
      node: { kind: "sequence", items: values.map((value) => ({ kind: "scalar", raw: value, value })) },
    };
  }
  if (/^[|>][+-]?[1-9]?$/.test(raw)) {
    let endIndex = index;
    while (endIndex + 1 < lines.length) {
      const next = tbdLineWithoutComment(lines[endIndex + 1]);
      if (next.trim() !== "" && /^ */.exec(next)[0].length <= indentation) break;
      endIndex += 1;
    }
    return { endIndex, node: { kind: "scalar", raw, value: raw } };
  }
  const node = tbdScalarNode(raw);
  return node === null ? null : { endIndex: index, node };
}

function tokenizeTbdDocument(lines) {
  const tokens = [];
  for (let index = 0; index < lines.length; index += 1) {
    const uncommented = tbdLineWithoutComment(lines[index]);
    if (uncommented.trim() === "") continue;
    if (/^\s*\t/.test(lines[index])) return null;
    const indentation = /^ */.exec(uncommented)[0].length;
    const trimmed = uncommented.trim();
    const sequence = trimmed.startsWith("- ");
    const content = sequence ? trimmed.slice(2) : trimmed;
    const mapping = /^([a-z][a-z0-9-]*):(?:\s*(.*))?$/.exec(content);
    if (mapping) {
      const [, key, raw = ""] = mapping;
      const value = tbdValue(lines, index, raw, indentation);
      if (value === null) return null;
      tokens.push({ indentation, sequence, key, node: value.node });
      index = value.endIndex;
      continue;
    }
    if (!sequence) return null;
    const node = tbdScalarNode(content);
    if (node === null) return null;
    tokens.push({ indentation, sequence: true, key: null, node });
  }
  return tokens;
}

function parseTbdNode(tokens, startIndex, indentation, depth = 0) {
  if (depth > 32 || tokens[startIndex]?.indentation !== indentation) return null;
  const sequence = tokens[startIndex].sequence;
  const node = sequence ? { kind: "sequence", items: [] } : { kind: "mapping", entries: [] };
  let index = startIndex;
  while (index < tokens.length && tokens[index].indentation === indentation) {
    const token = tokens[index];
    if (token.sequence !== sequence) return null;
    index += 1;
    if (sequence && token.key === null) {
      node.items.push(token.node);
      continue;
    }
    if (!sequence && token.key === null) return null;
    const entries = [{ key: token.key, node: token.node ?? { kind: "null" } }];
    if (token.node === null && tokens[index]?.indentation > indentation) {
      if (tokens[index].indentation !== indentation + 2) return null;
      const child = parseTbdNode(tokens, index, indentation + 2, depth + 1);
      if (child === null) return null;
      entries[0].node = child.node;
      index = child.nextIndex;
    }
    if (sequence && tokens[index]?.indentation > indentation) {
      if (tokens[index].indentation !== indentation + 2 || tokens[index].sequence) return null;
      const continuation = parseTbdNode(tokens, index, indentation + 2, depth + 1);
      if (continuation === null || continuation.node.kind !== "mapping") return null;
      entries.push(...continuation.node.entries);
      index = continuation.nextIndex;
    }
    const entryNode = sequence ? { kind: "mapping", entries } : null;
    if (sequence) node.items.push(entryNode);
    else node.entries.push(entries[0]);
  }
  if (tokens[index]?.indentation > indentation) return null;
  return { node, nextIndex: index };
}

function uniqueTbdEntries(mapping) {
  if (mapping?.kind !== "mapping") return null;
  const entries = new Map();
  for (const entry of mapping.entries) {
    if (entries.has(entry.key)) return null;
    entries.set(entry.key, entry.node);
  }
  return entries;
}

function tbdScalarSequence(node) {
  if (node?.kind !== "sequence" || node.items.some((item) => item.kind !== "scalar")) return null;
  return node.items.map((item) => item.value);
}

function parseTbdDocument(lines) {
  const tokens = tokenizeTbdDocument(lines);
  if (tokens === null || tokens.length === 0 || tokens[0].indentation !== 0 || tokens[0].sequence) return null;
  const parsedRoot = parseTbdNode(tokens, 0, 0);
  if (parsedRoot === null || parsedRoot.nextIndex !== tokens.length) return null;
  const root = uniqueTbdEntries(parsedRoot.node);
  if (root === null) return null;
  const version = root.get("tbd-version");
  const targets = tbdScalarSequence(root.get("targets"));
  const installName = root.get("install-name");
  if (version?.kind !== "scalar" || version.raw !== "4" || targets === null || installName?.kind !== "scalar") return null;
  const exportsNode = root.get("exports");
  if (exportsNode !== undefined && exportsNode.kind !== "sequence") return null;
  const exports = [];
  for (const item of exportsNode?.items ?? []) {
    const entry = uniqueTbdEntries(item);
    if (entry === null) return null;
    const exportTargets = entry.has("targets") ? tbdScalarSequence(entry.get("targets")) : null;
    const symbols = entry.has("symbols") ? tbdScalarSequence(entry.get("symbols")) : [];
    if ((entry.has("targets") && exportTargets === null) || symbols === null) return null;
    exports.push({ targets: exportTargets, symbols });
  }
  return { installName: installName.value, targets, exports };
}

function previousTbdInstallName(symbol) {
  const prefix = "$ld$previous$";
  if (!symbol.startsWith(prefix)) return null;
  const suffix = symbol.slice(prefix.length);
  const delimiter = suffix.indexOf("$");
  return delimiter < 0 ? null : suffix.slice(0, delimiter);
}

function tbdOwnsDependency(source, dependency) {
  const documents = tbdDocuments(source);
  if (documents === null) return false;
  const parsedDocuments = documents.map(parseTbdDocument);
  if (parsedDocuments.some((document) => document === null)) return false;
  const matches = parsedDocuments.filter((parsed) => {
    const directInstallName = parsed.targets.includes(SDK_TARGET) && parsed.installName === dependency;
    const previousInstallName = parsed.exports.some((entry) => (
      entry.targets?.includes(SDK_TARGET)
        && entry.symbols.some((symbol) => previousTbdInstallName(symbol) === dependency)
    ));
    return directInstallName || previousInstallName;
  });
  return matches.length === 1;
}

async function resolvedSdkCandidate(sdkPath, candidate) {
  requireGate(inside(sdkPath, candidate), "app-closure", "external-sdk-candidate", "SDK dependency candidate escapes the pinned simulator SDK");
  let componentPath = sdkPath;
  for (const component of relative(sdkPath, candidate).split("/").filter(Boolean)) {
    componentPath = join(componentPath, component);
    try {
      await lstat(componentPath);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) return null;
      throw error;
    }
    const resolvedComponent = await realpath(componentPath);
    requireGate(inside(sdkPath, resolvedComponent), "app-closure", "external-sdk-candidate", "SDK dependency candidate resolves outside the pinned simulator SDK");
  }
  const resolvedCandidate = await realpath(candidate);
  requireGate(inside(sdkPath, resolvedCandidate), "app-closure", "external-sdk-candidate", "SDK dependency candidate resolves outside the pinned simulator SDK");
  return resolvedCandidate;
}

async function sdkDependencyProof(sdkPath, dependency) {
  for (const candidate of sdkStubCandidates(sdkPath, dependency)) {
    try {
      const ownedCandidate = await resolvedSdkCandidate(sdkPath, candidate);
      if (ownedCandidate === null || !(await stat(ownedCandidate)).isFile()) continue;
      const bytes = await stableRegularFileBytes(
        ownedCandidate,
        "app-closure",
        "unstable-sdk-candidate",
        "SDK dependency candidate changed while being inspected",
        { rejectParentSymlinks: false },
      );
      if (tbdOwnsDependency(bytes.toString("utf8"), dependency)) {
        return {
          installName: dependency,
          stubSha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
    } catch (error) {
      if (error instanceof GateError) throw error;
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    }
  }
  return null;
}

async function cachedSdkDependencyProof(cache, sdkPath, dependency) {
  if (!cache.has(dependency)) cache.set(dependency, await sdkDependencyProof(sdkPath, dependency));
  return cache.get(dependency);
}

async function resolveDependency({ dependency, binary, appPath, appRealPath, configuration, rpaths, sdkPath, sdkProofCache }) {
  requireGate(!containsTraversal(dependency), "app-closure", "path-traversal", `${configuration} ${basename(binary)} has traversal dependency: ${dependency}`);
  if (isAbsolute(dependency)) {
    requireGate(isSystemAbsolute(dependency), "app-closure", "non-system-absolute-load", `${configuration} ${basename(binary)} has non-system absolute dependency: ${dependency}`);
    const systemProof = await cachedSdkDependencyProof(sdkProofCache, sdkPath, dependency);
    requireGate(systemProof !== null, "app-closure", "unowned-system-load", `${configuration} binary has a system dependency absent from the pinned simulator SDK`);
    return { binary: null, system: true, systemProof };
  }

  const rpathSuffix = tokenSuffix(dependency, "@rpath");
  let candidates;
  if (rpathSuffix !== null) {
    candidates = rpaths.map((rpath) => ({ ...rpath, candidate: rpath.kind === "bundle" ? resolve(rpath.path, rpathSuffix) : null }));
  } else {
    const loaderSuffix = tokenSuffix(dependency, "@loader_path");
    const executableSuffix = tokenSuffix(dependency, "@executable_path");
    if (loaderSuffix !== null) candidates = [{ kind: "bundle", candidate: resolve(dirname(binary), loaderSuffix) }];
    else if (executableSuffix !== null) candidates = [{ kind: "bundle", candidate: resolve(appPath, executableSuffix) }];
    else fail("app-closure", "unsupported-load-path", `${configuration} ${basename(binary)} has unsupported dependency: ${dependency}`);
  }

  for (const entry of candidates) {
    if (entry.kind === "system-swift") {
      const systemProof = await cachedSdkDependencyProof(sdkProofCache, sdkPath, `/usr/lib/swift/${rpathSuffix}`);
      if (systemProof !== null) return { binary: null, system: true, systemProof };
      continue;
    }
    const candidate = entry.candidate;
    requireGate(inside(appPath, candidate), "app-closure", "out-of-bundle-load", `${configuration} ${basename(binary)} dependency path escapes the app bundle: ${dependency}`);
    const candidateExists = await rejectSymlinkComponents(appPath, candidate, configuration, "dependency");
    if (!candidateExists) continue;
    let details;
    try {
      details = await lstat(candidate);
    } catch {
      continue;
    }
    if (!details.isFile()) continue;
    const resolved = await realpath(candidate);
    requireGate(inside(appRealPath, resolved), "app-closure", "out-of-bundle-load", `${configuration} ${basename(binary)} dependency resolves outside the app bundle: ${dependency}`);
    return { binary: candidate, system: false };
  }
  if (rpathSuffix !== null && !rpathSuffix.includes("/") && rpathSuffix.startsWith("libswift") && rpathSuffix.endsWith(".dylib")) {
    const systemProof = await cachedSdkDependencyProof(sdkProofCache, sdkPath, `/usr/lib/swift/${rpathSuffix}`);
    requireGate(systemProof !== null, "app-closure", "unowned-system-load", `${configuration} binary has a Swift dependency absent from the pinned simulator SDK`);
    return { binary: null, system: true, systemProof };
  }
  fail("app-closure", "unresolved-load", `${configuration} ${basename(binary)} has unresolved in-bundle dependency: ${dependency}`);
}

async function inspectBinary(binary, appPath, appRealPath, configuration, runTool, openFile, inheritedRpaths, sdkPath) {
  await rejectSymlinkComponents(appPath, binary, configuration, "dependency");
  const ancestorPins = await gatePinnedAncestors(
    binary,
    "app-closure",
    "unstable-app-binary",
    `${configuration} app binary changed during inspection`,
  );
  let handle;
  let result;
  let operationError = null;
  try {
    handle = await openFile(binary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail("app-closure", "unstable-app-binary", `${configuration} app binary changed during inspection`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    const pathBefore = await lstat(binary, { bigint: true });
    requireGate(
      before.isFile() && pathBefore.isFile() && !pathBefore.isSymbolicLink() && sameFileIdentity(before, pathBefore),
      "app-closure",
      "unstable-app-binary",
      `${configuration} app binary changed during inspection`,
    );
    const binaryRealPath = await realpath(binary);
    requireGate(inside(appRealPath, binaryRealPath), "app-closure", "out-of-bundle-binary", `${configuration} ${basename(binary)} resolves outside the app bundle`);
    const architectureOutput = await pinnedOutput(runTool, PINNED_APP_TOOLS.lipo, ["-archs", binary], configuration, binary);
    await gateVerifyPinnedAncestors(ancestorPins, "app-closure", "unstable-app-binary", `${configuration} app binary changed during inspection`);
    const architectures = architectureOutput.trim().split(/\s+/);
    for (const architecture of REQUIRED_ARCHITECTURES) {
      requireGate(architectures.includes(architecture), "app-closure", "missing-architecture", `${configuration} ${basename(binary)} is missing required ${architecture} architecture`);
    }
    const loadOutput = await pinnedOutput(runTool, PINNED_APP_TOOLS.otool, ["-arch", "arm64", "-L", binary], configuration, binary);
    await gateVerifyPinnedAncestors(ancestorPins, "app-closure", "unstable-app-binary", `${configuration} app binary changed during inspection`);
    const rpathOutput = await pinnedOutput(runTool, PINNED_APP_TOOLS.otool, ["-arch", "arm64", "-l", binary], configuration, binary);
    await gateVerifyPinnedAncestors(ancestorPins, "app-closure", "unstable-app-binary", `${configuration} app binary changed during inspection`);
    const ownRpaths = await expandRpaths(parseRpaths(rpathOutput, configuration, binary), binary, appPath, appRealPath, sdkPath, configuration);
    const rpaths = [];
    for (const rpath of [...ownRpaths, ...inheritedRpaths]) {
      if (!rpaths.some((candidate) => candidate.kind === rpath.kind && candidate.path === rpath.path)) rpaths.push(rpath);
    }
    const binaryBytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(binary, { bigint: true });
    requireGate(
      sameStableMetadata(before, after) && pathAfter.isFile() && !pathAfter.isSymbolicLink() && sameFileIdentity(after, pathAfter),
      "app-closure",
      "unstable-app-binary",
      `${configuration} app binary changed during inspection`,
    );
    await gateVerifyPinnedAncestors(ancestorPins, "app-closure", "unstable-app-binary", `${configuration} app binary changed during inspection`);
    result = {
      binaryRealPath,
      binarySha256: createHash("sha256").update(binaryBytes).digest("hex"),
      dependencies: parseDependencies(loadOutput, configuration, binary),
      rpaths,
    };
  } catch (error) {
    operationError = error instanceof GateError
      ? error
      : new GateError("app-closure", "unstable-app-binary", `${configuration} app binary changed during inspection`);
  }
  try {
    await handle.close();
  } catch {
    operationError ??= new GateError("app-closure", "unstable-app-binary", `${configuration} app binary changed during inspection`);
  }
  if (operationError !== null) throw operationError;
  return result;
}

async function requiredFrameworkBinary(appPath, appRealPath, framework, configuration) {
  const frameworkPath = join(appPath, "Frameworks", framework);
  let details;
  try {
    details = await lstat(frameworkPath);
  } catch {
    fail("app-closure", "missing-required-framework", `${configuration} app is missing ${framework}`);
  }
  requireGate(!details.isSymbolicLink(), "app-closure", "symlinked-required-framework", `${configuration} ${framework} cannot be a symlink`);
  requireGate(details.isDirectory(), "app-closure", "missing-required-framework", `${configuration} app is missing ${framework}`);
  const resolvedFramework = await realpath(frameworkPath);
  requireGate(inside(appRealPath, resolvedFramework), "app-closure", "out-of-bundle-framework", `${configuration} ${framework} resolves outside the app bundle`);
  const binary = join(frameworkPath, framework.slice(0, -".framework".length));
  let binaryDetails;
  try {
    binaryDetails = await lstat(binary);
  } catch {
    fail("app-closure", "missing-required-framework", `${configuration} app is missing a required framework binary`);
  }
  requireGate(binaryDetails.isFile() && !binaryDetails.isSymbolicLink(), "app-closure", "symlinked-app-binary", `${configuration} required framework binary cannot be a symlink`);
  return binary;
}

async function verifyApp(appPath, configuration, runTool, openFile, sdkPath, sdkProofCache) {
  const appPins = await gatePinnedAncestors(
    appPath,
    "app-closure",
    "symlinked-app",
    `${configuration} app must remain one non-symlink directory`,
    { includePath: true },
  );
  const appRealPath = await realpath(appPath);
  for (const framework of REQUIRED_FRAMEWORKS) {
    await requiredFrameworkBinary(appPath, appRealPath, framework, configuration);
  }
  const initialBinaries = await appBinaries(appPath, configuration);
  const executable = initialBinaries[0];
  const queue = [{ binary: executable, inheritedRpaths: [] }];
  let initialBinariesSeeded = false;
  const checkedStates = new Set();
  const checkedBinaries = new Set();
  const binaryInputs = new Map();
  const systemProofs = [];
  let resolvedLoads = 0;
  while (queue.length > 0) {
    requireGate(checkedStates.size < MAX_RUNPATH_CONTEXTS, "app-closure", "closure-limit-exceeded", `${configuration} app exceeded the bounded runpath context limit`);
    const current = queue.shift();
    const { binary } = current;
    const binaryRealPath = await realpath(binary);
    const lexicalBinary = relative(appPath, binary);
    requireGate(lexicalBinary !== "" && !lexicalBinary.startsWith("..") && !isAbsolute(lexicalBinary), "app-closure", "out-of-bundle-binary", `${configuration} binary has a noncanonical lexical identity`);
    const stateKey = JSON.stringify([binaryRealPath, lexicalBinary, current.inheritedRpaths]);
    if (checkedStates.has(stateKey)) continue;
    const inspected = await inspectBinary(binary, appPath, appRealPath, configuration, runTool, openFile, current.inheritedRpaths, sdkPath);
    checkedStates.add(stateKey);
    checkedBinaries.add(inspected.binaryRealPath);
    binaryInputs.set(lexicalBinary, inspected.binarySha256);
    if (!initialBinariesSeeded) {
      initialBinariesSeeded = true;
      for (const initialBinary of initialBinaries.slice(1)) {
        queue.push({ binary: initialBinary, inheritedRpaths: inspected.rpaths });
      }
    }
    for (const dependency of inspected.dependencies) {
      const resolved = await resolveDependency({
        dependency,
        binary,
        appPath,
        appRealPath,
        configuration,
        rpaths: inspected.rpaths,
        sdkPath,
        sdkProofCache,
      });
      if (resolved.system) {
        systemProofs.push(resolved.systemProof);
      } else {
        resolvedLoads += 1;
        requireGate(resolvedLoads <= MAX_RESOLVED_LOADS, "app-closure", "closure-limit-exceeded", `${configuration} app exceeded the bounded dependency limit`);
        queue.push({ binary: resolved.binary, inheritedRpaths: inspected.rpaths });
      }
    }
  }
  const binaryManifest = createHash("sha256");
  for (const entry of [...binaryInputs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    binaryManifest.update(JSON.stringify(entry)).update("\n");
  }
  await gateVerifyPinnedAncestors(appPins, "app-closure", "unstable-app-binary", `${configuration} app changed during inspection`);
  return {
    requiredFrameworks: REQUIRED_FRAMEWORKS.length,
    checkedBinaries: checkedBinaries.size,
    resolvedLoads,
    runpathContexts: checkedStates.size,
    architectures: { arm64: checkedBinaries.size },
    input: {
      token: configuration === "Debug" ? "e2e-debug-app" : "e2e-release-app",
      binaryCount: binaryInputs.size,
      binaryManifestSha256: binaryManifest.digest("hex"),
    },
    systemProofs,
  };
}

export async function inspectPrebuiltAppInputs({ debugApp, releaseApp, runTool = captureTool, openFile = open }) {
  const sdkOutput = await pinnedOutput(
    runTool,
    PINNED_APP_TOOLS.xcrun,
    ["--sdk", "iphonesimulator", "--show-sdk-path"],
    "simulator",
    debugApp,
  );
  const sdkLines = sdkOutput.trim().split(/\r\n|\n|\r/).filter(Boolean);
  requireGate(sdkLines.length === 1 && isAbsolute(sdkLines[0]), "app-closure", "malformed-sdk-path", "Pinned simulator SDK path is malformed");
  const sdkPath = await realpath(sdkLines[0]);
  requireGate((await stat(sdkPath)).isDirectory(), "app-closure", "malformed-sdk-path", "Pinned simulator SDK path is malformed");
  const sdkProofCache = new Map();
  const inspectedApps = {
    Debug: await verifyApp(debugApp, "Debug", runTool, openFile, sdkPath, sdkProofCache),
    Release: await verifyApp(releaseApp, "Release", runTool, openFile, sdkPath, sdkProofCache),
  };
  const allSystemProofs = CONFIGURATIONS.flatMap((configuration) => inspectedApps[configuration].systemProofs);
  const uniqueSystemProofs = [...new Map(allSystemProofs.map((proof) => [proof.installName, proof])).values()]
    .sort((left, right) => left.installName.localeCompare(right.installName));
  const ownership = createHash("sha256");
  for (const proof of uniqueSystemProofs) ownership.update(JSON.stringify([proof.installName, proof.stubSha256])).update("\n");
  const apps = Object.fromEntries(CONFIGURATIONS.map((configuration) => {
    const { systemProofs, ...summary } = inspectedApps[configuration];
    return [configuration, summary];
  }));
  return {
    systemRuntime: {
      sdk: "iphonesimulator",
      target: SDK_TARGET,
      verifiedLoads: allSystemProofs.length,
      uniqueInstallNames: uniqueSystemProofs.length,
      ownershipSha256: ownership.digest("hex"),
    },
    apps,
  };
}

export async function verifyPrebuiltApps({ debugApp, releaseApp, reportPath, expectedSha, checkedOutSha, flavor, runTool = captureTool, openFile = open }) {
  const base = commonReport(APP_REPORT_TYPE, flavor, checkedOutSha, expectedSha);
  let apps = {};
  let systemRuntime = null;
  try {
    validateIdentity({ checkedOutSha, expectedSha, flavor, allowedFlavors: ["e2e"] }, "app-closure");
    ({ apps, systemRuntime } = await inspectPrebuiltAppInputs({ debugApp, releaseApp, runTool, openFile }));
    const report = {
      ...base,
      status: "pass",
      tools: PINNED_APP_TOOLS,
      requiredArchitectures: [...REQUIRED_ARCHITECTURES],
      frameworks: [...REQUIRED_FRAMEWORKS],
      systemRuntime,
      apps,
    };
    await writeJson(reportPath, report);
    return report;
  } catch (error) {
    await writeJson(reportPath, {
      ...base,
      status: "fail",
      tools: PINNED_APP_TOOLS,
      requiredArchitectures: [...REQUIRED_ARCHITECTURES],
      frameworks: [...REQUIRED_FRAMEWORKS],
      systemRuntime,
      apps,
      failure: failure(error, "app-closure"),
    });
    throw error;
  }
}

function checkedOutSha() {
  const result = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(result.status, 0, "Unable to read checked-out SHA");
  return result.stdout.trim();
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "install-pods") {
    const options = parseOptions(rest, ["--ios-dir", "--log-dir", "--retained-dir", "--report", "--expected-sha", "--flavor"]);
    const report = await installPrebuiltPods({
      iosDirectory: resolve(options["--ios-dir"]),
      logDirectory: resolve(options["--log-dir"]),
      retainedDirectory: resolve(options["--retained-dir"]),
      reportPath: resolve(options["--report"]),
      expectedSha: options["--expected-sha"],
      checkedOutSha: checkedOutSha(),
      flavor: options["--flavor"],
    });
    console.log(JSON.stringify(report));
    return;
  }
  if (command === "verify-apps") {
    const options = parseOptions(rest, ["--debug-app", "--release-app", "--report", "--expected-sha", "--flavor"]);
    const report = await verifyPrebuiltApps({
      debugApp: resolve(options["--debug-app"]),
      releaseApp: resolve(options["--release-app"]),
      reportPath: resolve(options["--report"]),
      expectedSha: options["--expected-sha"],
      checkedOutSha: checkedOutSha(),
      flavor: options["--flavor"],
    });
    console.log(JSON.stringify(report));
    return;
  }
  assert.fail("Command must be install-pods or verify-apps");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const publicFailure = failure(error, "gate-cli");
    console.error(`iOS prebuilt gate failed closed: ${publicFailure.stage}/${publicFailure.code}`);
    process.exitCode = 1;
  });
}
