import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import {
  inspectRetainedPodInputs,
  PINNED_APP_TOOLS,
  verifyPrebuiltApps,
} from "../../../tools/ios-prebuilt-gate.mjs";

const tool = resolve("tools/ios-prebuilt-gate.mjs");
const sha = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const prebuiltFalse = `[ReactNativeDependencies] Building from source: false
[ReactNativeCore] Building from source: false
`;
const sourceTrue = `[ReactNativeDependencies] Building from source: true
[ReactNativeCore] Building from source: true
`;
const requiredFrameworks = ["React.framework", "ReactNativeDependencies.framework"] as const;
const supportFunctionBlocks = {
  on_error: [
    "function on_error {",
    '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"',
    "}",
  ].join("\n"),
  install_framework: [
    "install_framework()",
    "{",
    '  if [ -r "${BUILT_PRODUCTS_DIR}/$1" ]; then',
    '    local source="${BUILT_PRODUCTS_DIR}/$1"',
    '  elif [ -r "${BUILT_PRODUCTS_DIR}/$(basename "$1")" ]; then',
    '    local source="${BUILT_PRODUCTS_DIR}/$(basename "$1")"',
    '  elif [ -r "$1" ]; then',
    '    local source="$1"',
    "  fi",
    '  local destination="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"',
    '  if [ -L "${source}" ]; then',
    '    echo "Symlinked..."',
    '    source="$(readlink -f "${source}")"',
    "  fi",
    '  if [ -d "${source}/${BCSYMBOLMAP_DIR}" ]; then',
    '    find "${source}/${BCSYMBOLMAP_DIR}" -name "*.bcsymbolmap"|while read f; do',
    '      echo "Installing $f"',
    '      install_bcsymbolmap "$f" "$destination"',
    '      rm "$f"',
    "    done",
    '    rmdir "${source}/${BCSYMBOLMAP_DIR}"',
    "  fi",
    '  echo "rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --links --filter \\"- CVS/\\" --filter \\"- .svn/\\" --filter \\"- .git/\\" --filter \\"- .hg/\\" --filter \\"- Headers\\" --filter \\"- PrivateHeaders\\" --filter \\"- Modules\\" \\"${source}\\" \\"${destination}\\""',
    '  rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --links --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${source}" "${destination}"',
    "  local basename",
    '  basename="$(basename -s .framework "$1")"',
    '  binary="${destination}/${basename}.framework/${basename}"',
    '  if ! [ -r "$binary" ]; then',
    '    binary="${destination}/${basename}"',
    '  elif [ -L "${binary}" ]; then',
    '    echo "Destination binary is symlinked..."',
    '    dirname="$(dirname "${binary}")"',
    '    binary="${dirname}/$(readlink "${binary}")"',
    "  fi",
    '  if [[ "$(file "$binary")" == *"dynamically linked shared library"* ]]; then',
    '    strip_invalid_archs "$binary"',
    "  fi",
    '  code_sign_if_enabled "${destination}/$(basename "$1")"',
    '  if [ "${XCODE_VERSION_MAJOR}" -lt 7 ]; then',
    "    local swift_runtime_libs",
    '    swift_runtime_libs=$(xcrun otool -LX "$binary" | grep --color=never @rpath/libswift | sed -E s/@rpath\\\\/\\(.+dylib\\).*/\\\\1/g | uniq -u)',
    "    for lib in $swift_runtime_libs; do",
    '      echo "rsync -auv \\"${SWIFT_STDLIB_PATH}/${lib}\\" \\"${destination}\\""',
    '      rsync -auv "${SWIFT_STDLIB_PATH}/${lib}" "${destination}"',
    '      code_sign_if_enabled "${destination}/${lib}"',
    "    done",
    "  fi",
    "}",
  ].join("\n"),
  install_dsym: [
    "install_dsym() {",
    '  local source="$1"',
    "  warn_missing_arch=${2:-true}",
    '  if [ -r "$source" ]; then',
    '    echo "rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter \\"- CVS/\\" --filter \\"- .svn/\\" --filter \\"- .git/\\" --filter \\"- .hg/\\" --filter \\"- Headers\\" --filter \\"- PrivateHeaders\\" --filter \\"- Modules\\" \\"${source}\\" \\"${DERIVED_FILES_DIR}\\""',
    '  rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${source}" "${DERIVED_FILES_DIR}"',
    "    local basename",
    '    basename="$(basename -s .dSYM "$source")"',
    '    binary_name="$(ls "$source/Contents/Resources/DWARF")"',
    '    binary="${DERIVED_FILES_DIR}/${basename}.dSYM/Contents/Resources/DWARF/${binary_name}"',
    '    if [[ "$(file "$binary")" == *"Mach-O "*"dSYM companion"* ]]; then',
    '      strip_invalid_archs "$binary" "$warn_missing_arch"',
    "    fi",
    "  if [[ $STRIP_BINARY_RETVAL == 0 ]]; then",
    '    echo "rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --links --filter \\"- CVS/\\" --filter \\"- .svn/\\" --filter \\"- .git/\\" --filter \\"- .hg/\\" --filter \\"- Headers\\" --filter \\"- PrivateHeaders\\" --filter \\"- Modules\\" \\"${DERIVED_FILES_DIR}/${basename}.framework.dSYM\\" \\"${DWARF_DSYM_FOLDER_PATH}\\""',
    '    rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --links --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${DERIVED_FILES_DIR}/${basename}.dSYM" "${DWARF_DSYM_FOLDER_PATH}"',
    "  else",
    '    mkdir -p "${DWARF_DSYM_FOLDER_PATH}"',
    '    touch "${DWARF_DSYM_FOLDER_PATH}/${basename}.dSYM"',
    "  fi",
    "  fi",
    "}",
  ].join("\n"),
  strip_invalid_archs: [
    "strip_invalid_archs() {",
    '  binary="$1"',
    "  warn_missing_arch=${2:-true}",
    '  binary_archs="$(lipo -info "$binary" | rev | cut -d \':\' -f1 | awk \'{$1=$1;print}\' | rev)"',
    '  intersected_archs="$(echo ${ARCHS[@]} ${binary_archs[@]} | tr \' \' \'\\n\' | sort | uniq -d)"',
    '  if [[ -z "$intersected_archs" ]]; then',
    '    if [[ "$warn_missing_arch" == "true" ]]; then',
    '      echo "warning: [CP] Vendored binary \'$binary\' contains architectures ($binary_archs) none of which match the current build architectures ($ARCHS)."',
    "    fi",
    "    STRIP_BINARY_RETVAL=1",
    "    return",
    "  fi",
    '  stripped=""',
    "  for arch in $binary_archs; do",
    '    if ! [[ "${ARCHS}" == *"$arch"* ]]; then',
    '      lipo -remove "$arch" -output "$binary" "$binary"',
    '      stripped="$stripped $arch"',
    "    fi",
    "  done",
    '  if [[ "$stripped" ]]; then',
    '    echo "Stripped $binary of architectures:$stripped"',
    "  fi",
    "  STRIP_BINARY_RETVAL=0",
    "}",
  ].join("\n"),
  install_bcsymbolmap: [
    "install_bcsymbolmap() {",
    '  local bcsymbolmap_path="$1"',
    '  local destination="${BUILT_PRODUCTS_DIR}"',
    '  echo "rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${bcsymbolmap_path}" "${destination}""',
    '  rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${bcsymbolmap_path}" "${destination}"',
    "}",
  ].join("\n"),
  code_sign_if_enabled: [
    "code_sign_if_enabled() {",
    '  if [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" -a "${CODE_SIGNING_REQUIRED:-}" != "NO" -a "${CODE_SIGNING_ALLOWED}" != "NO" ]; then',
    '    echo "Code Signing $1 with Identity ${EXPANDED_CODE_SIGN_IDENTITY_NAME}"',
    '    local code_sign_cmd="/usr/bin/codesign --force --sign ${EXPANDED_CODE_SIGN_IDENTITY} ${OTHER_CODE_SIGN_FLAGS:-} --preserve-metadata=identifier,entitlements \'$1\'"',
    '    if [ "${COCOAPODS_PARALLEL_CODE_SIGN}" == "true" ]; then',
    '      code_sign_cmd="$code_sign_cmd &"',
    "    fi",
    '    echo "$code_sign_cmd"',
    '    eval "$code_sign_cmd"',
    "  fi",
    "}",
  ].join("\n"),
} as const;

const requiredSupportLines = [
  "set -e",
  "set -u",
  "set -o pipefail",
  "trap 'on_error $LINENO' ERR",
  'echo "mkdir -p ${CONFIGURATION_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"',
  'mkdir -p "${CONFIGURATION_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"',
  'COCOAPODS_PARALLEL_CODE_SIGN="${COCOAPODS_PARALLEL_CODE_SIGN:-false}"',
  'SWIFT_STDLIB_PATH="${TOOLCHAIN_DIR}/usr/lib/swift/${PLATFORM_NAME}"',
  'BCSYMBOLMAP_DIR="BCSymbolMaps"',
  'RSYNC_PROTECT_TMP_FILES=(--filter "P .*.??????")',
  "STRIP_BINARY_RETVAL=0",
] as const;

function frameworkCalls(frameworks: readonly string[] = requiredFrameworks) {
  return frameworks.map((framework) => `  install_framework "\${PODS_XCFRAMEWORKS_BUILD_DIR}/${framework === "React.framework" ? "React-Core-prebuilt" : "ReactNativeDependencies"}/${framework}"`);
}

function configurationCalls(frameworks: readonly string[] = requiredFrameworks) {
  return [
    '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoModulesJSI/ExpoModulesJSI.framework"',
    ...frameworkCalls(frameworks),
    '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built/hermesvm.framework"',
  ];
}

function completeSupportScript(plans: PodGraphOptions["plans"] = {}) {
  return [
    "#!/bin/sh",
    ...requiredSupportLines.slice(0, 3),
    supportFunctionBlocks.on_error,
    requiredSupportLines[3],
    "if [ -z ${FRAMEWORKS_FOLDER_PATH+x} ]; then\n  exit 0\nfi",
    ...requiredSupportLines.slice(4, 10),
    supportFunctionBlocks.install_framework,
    supportFunctionBlocks.install_dsym,
    requiredSupportLines[10],
    supportFunctionBlocks.strip_invalid_archs,
    supportFunctionBlocks.install_bcsymbolmap,
    supportFunctionBlocks.code_sign_if_enabled,
    ...(["Debug", "Release"] as const).map((configuration) => [
      `if [[ "$CONFIGURATION" == "${configuration}" ]]; then`,
      ...configurationCalls(plans?.[configuration] ?? requiredFrameworks),
      "fi",
    ].join("\n")),
    'if [ "${COCOAPODS_PARALLEL_CODE_SIGN}" == "true" ]; then\n  wait\nfi',
    "",
  ].join("\n");
}

type PodGraphOptions = {
  lock?: string;
  manifest?: string;
  target?: string;
  plans?: Partial<Record<"Debug" | "Release", readonly string[]>>;
  script?: string;
  xcfilelists?: Partial<Record<"Debug" | "Release", Partial<Record<"input" | "output", string>>>>;
};

async function writePodGraph(ios: string, options: PodGraphOptions = {}) {
  const target = options.target ?? "Pods-ForMobile";
  const support = join(ios, "Pods/Target Support Files", target);
  await mkdir(support, { recursive: true });
  const lock = options.lock ?? `PODS:
  - React-Core-prebuilt (0.86.0)
  - ReactNativeDependencies (0.86.0)
`;
  await writeFile(join(ios, "Podfile.lock"), lock);
  await writeFile(join(ios, "Pods/Manifest.lock"), options.manifest ?? lock);
  await writeFile(join(support, `${target}-frameworks.sh`), options.script ?? completeSupportScript(options.plans));
  for (const configuration of ["Debug", "Release"] as const) {
    for (const kind of ["input", "output"] as const) {
      const source = options.xcfilelists?.[configuration]?.[kind];
      if (source !== undefined) {
        await writeFile(join(support, `${target}-frameworks-${configuration}-${kind}-files.xcfilelist`), source);
      }
    }
  }
}

function simulatorTbd(installName: string, targets = ["x86_64-ios-simulator", "arm64-ios-simulator"]) {
  return `--- !tapi-tbd\ntbd-version: 4\ntargets: [ ${targets.join(", ")} ]\ninstall-name: '${installName}'\nexports: []\n`;
}

function simulatorAliasTbd(primaryInstallName: string, previousInstallName: string) {
  return `--- !tapi-tbd\ntbd-version: 4\ntargets: [ x86_64-ios-simulator, arm64-ios-simulator ]\ninstall-name: '${primaryInstallName}'\nexports:\n  - targets: [ x86_64-ios-simulator, arm64-ios-simulator ]\n    symbols: [ '_unrelated',\n               '$ld$previous$${previousInstallName}$$2$17.0$_symbol$' ]\n`;
}

async function makePodHarness(outputs: (string | readonly string[])[], statuses = outputs.map(() => 0)) {
  const root = await mkdtemp(join(tmpdir(), "fawn-ios-prebuilt-pods-"));
  const ios = join(root, "ios");
  const bin = join(root, "bin");
  const logs = join(root, "logs");
  const retained = join(root, "retained");
  const report = join(root, "report.json");
  const calls = join(root, "calls");
  await mkdir(ios);
  await mkdir(bin);
  await writePodGraph(ios);
  await writeFile(join(root, "outputs.json"), JSON.stringify(outputs.map((output) => typeof output === "string" ? [output] : output)));
  await writeFile(join(root, "statuses.json"), JSON.stringify(statuses));
  await writeFile(join(bin, "pod"), `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
if (process.env.EXPO_USE_PRECOMPILED_MODULES !== "0" || process.env.RCT_USE_RN_DEP !== "1" || process.env.RCT_USE_PREBUILT_RNCORE !== "1") process.exit(97);
const count = existsSync(process.env.CALLS_FILE) ? readFileSync(process.env.CALLS_FILE, "utf8").trim().split("\\n").filter(Boolean).length : 0;
appendFileSync(process.env.CALLS_FILE, process.argv.slice(2).join(" ") + "\\n");
const chunks = JSON.parse(readFileSync(process.env.OUTPUTS_FILE, "utf8"))[count];
const statuses = JSON.parse(readFileSync(process.env.STATUSES_FILE, "utf8"));
(async () => {
  for (const chunk of chunks) {
    process.stdout.write(chunk);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  process.exit(statuses[count]);
})();
`, { mode: 0o755 });
  await chmod(join(bin, "pod"), 0o755);
  return { root, ios, bin, logs, retained, report, calls };
}

function runInstall(fixture: Awaited<ReturnType<typeof makePodHarness>>, flavor = "e2e") {
  return spawnSync(process.execPath, [
    tool,
    "install-pods",
    "--ios-dir", fixture.ios,
    "--log-dir", fixture.logs,
    "--retained-dir", fixture.retained,
    "--report", fixture.report,
    "--expected-sha", sha,
    "--flavor", flavor,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      CALLS_FILE: fixture.calls,
      OUTPUTS_FILE: join(fixture.root, "outputs.json"),
      STATUSES_FILE: join(fixture.root, "statuses.json"),
    },
  });
}

async function loadReport(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("pod install pins both selectors and records a same-SHA prebuilt attempt", async () => {
  const fixture = await makePodHarness([prebuiltFalse]);
  try {
    const result = runInstall(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(fixture.calls, "utf8"), "install\n");
    const log = await readFile(join(fixture.logs, "attempt-1.log"), "utf8");
    assert.match(log, /raw CocoaPods output suppressed/);
    assert.match(log, /ReactNativeDependencies=false/);
    assert.match(log, /ReactNativeCore=false/);
    const report = await loadReport(fixture.report);
    assert.equal(report.status, "pass");
    assert.equal(report.platform, "ios");
    assert.equal(report.flavor, "e2e");
    assert.equal(report.checkedOutSha, sha);
    assert.equal(report.expectedSha, sha);
    assert.equal(report.acceptedAttempt, 1);
    assert.deepEqual(report.attempts, [{
      attempt: 1,
      command: ["install"],
      exit: { code: 0, signal: null },
      log: { token: "pod-attempt-1", sha256: report.attempts[0].log.sha256 },
      diagnostics: { rawOutputRetained: false, stderrBytes: 0, stdoutBytes: Buffer.byteLength(prebuiltFalse) },
      resolverModes: { ReactNativeDependencies: false, ReactNativeCore: false },
    }]);
    assert.deepEqual(report.configurations, ["Debug", "Release"]);
    assert.equal(report.graph.lockfiles.equal, true);
    assert.deepEqual(report.graph.lockfiles.files.map((file: any) => file.token), ["podfile-lock", "manifest-lock"]);
    assert.ok(report.graph.lockfiles.files.every((file: any) => /^[0-9a-f]{64}$/.test(file.sha256)));
    assert.equal(report.graph.supportPlan.file.token, "framework-support-script");
    assert.match(report.graph.supportPlan.file.sha256, /^[0-9a-f]{64}$/);
    assert.equal(await readFile(join(fixture.retained, "Podfile.lock"), "utf8"), await readFile(join(fixture.ios, "Podfile.lock"), "utf8"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source fallback gets one clean recovery and retains both structured modes", async () => {
  const fixture = await makePodHarness([sourceTrue, prebuiltFalse]);
  try {
    const result = runInstall(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(fixture.calls, "utf8"), "install\ninstall --clean-install\n");
    assert.doesNotMatch(await readFile(join(fixture.logs, "attempt-1.log"), "utf8"), /Building from source/);
    assert.doesNotMatch(await readFile(join(fixture.logs, "attempt-2.log"), "utf8"), /Building from source/);
    const report = await loadReport(fixture.report);
    assert.equal(report.acceptedAttempt, 2);
    assert.deepEqual(report.attempts.map((attempt: any) => attempt.resolverModes), [
      { ReactNativeDependencies: true, ReactNativeCore: true },
      { ReactNativeDependencies: false, ReactNativeCore: false },
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("first and second pod command failures retain only privacy-safe structured diagnostics", async () => {
  const rawFirst = "artifact transport failed https://user:credential@example.invalid/pod?token=query-secret /private/tmp/private-token\n";
  const rawSecond = `Authorization: Bearer header-secret\n${process.env.HOME}/private-pod\n`;
  const first = await makePodHarness([["artifact transport ", "failed https://user:credential@", "example.invalid/pod?token=query-secret /private/tmp/private-token\n"]], [7]);
  const second = await makePodHarness([sourceTrue, ["Authorization: Bearer header-", `secret\n${process.env.HOME}/private-pod\n`]], [0, 9]);
  try {
    const firstResult = runInstall(first);
    assert.notEqual(firstResult.status, 0);
    assert.equal(await readFile(first.calls, "utf8"), "install\n");
    const firstPublicBytes = `${firstResult.stdout}${firstResult.stderr}${await readFile(join(first.logs, "attempt-1.log"), "utf8")}`;
    assert.doesNotMatch(firstPublicBytes, /credential|query-secret|private-token|example\.invalid|\/private\/tmp/);
    assert.match(firstPublicBytes, /raw CocoaPods output suppressed/);
    const firstReport = await loadReport(first.report);
    assert.equal(firstReport.status, "fail");
    assert.equal(firstReport.failure.stage, "pod-install");
    assert.equal(firstReport.failure.code, "pod-command-failed");
    assert.deepEqual(firstReport.attempts[0].exit, { code: 7, signal: null });

    const secondResult = runInstall(second);
    assert.notEqual(secondResult.status, 0);
    assert.equal(await readFile(second.calls, "utf8"), "install\ninstall --clean-install\n");
    const secondPublicBytes = `${secondResult.stdout}${secondResult.stderr}${await readFile(join(second.logs, "attempt-2.log"), "utf8")}`;
    assert.doesNotMatch(secondPublicBytes, /header-secret|Authorization|Bearer|private-pod/);
    assert.equal(secondPublicBytes.includes(process.env.HOME ?? "<absent-home>"), false);
    const secondReport = await loadReport(second.report);
    assert.equal(secondReport.status, "fail");
    assert.equal(secondReport.attempts.length, 2);
    assert.deepEqual(secondReport.attempts[0].resolverModes, { ReactNativeDependencies: true, ReactNativeCore: true });
    assert.equal(secondReport.attempts[1].resolverModes, null);
    assert.deepEqual(secondReport.attempts[1].exit, { code: 9, signal: null });
    assert.equal(firstReport.attempts[0].diagnostics.stdoutBytes, Buffer.byteLength(rawFirst));
    assert.equal(secondReport.attempts[1].diagnostics.stdoutBytes, Buffer.byteLength(rawSecond));
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

test("persistent and malformed resolver output fail closed with durable diagnostics", async () => {
  const persistent = await makePodHarness([sourceTrue, sourceTrue]);
  const malformed = await makePodHarness([`[ReactNativeDependencies] Building from source: false\n`]);
  try {
    const persistentResult = runInstall(persistent);
    assert.notEqual(persistentResult.status, 0);
    const persistentReport = await loadReport(persistent.report);
    assert.equal(persistentReport.failure.code, "persistent-source-mode");
    assert.equal(persistentReport.attempts.length, 2);

    const malformedResult = runInstall(malformed);
    assert.notEqual(malformedResult.status, 0);
    const malformedReport = await loadReport(malformed.report);
    assert.equal(malformedReport.failure.code, "malformed-resolver-output");
    assert.equal(malformedReport.attempts.length, 1);
    assert.equal(malformedReport.attempts[0].resolverModes, null);
  } finally {
    await rm(persistent.root, { recursive: true, force: true });
    await rm(malformed.root, { recursive: true, force: true });
  }
});

test("pod proof rejects exact lock drift, wrong RN versions, and a decoy aggregate target", async () => {
  const drift = await makePodHarness([prebuiltFalse]);
  const decoy = await makePodHarness([prebuiltFalse]);
  const wrongSection = await makePodHarness([prebuiltFalse]);
  const wrongVersions = await makePodHarness([prebuiltFalse]);
  try {
    await writePodGraph(drift.ios, { manifest: `PODS:\n  - React-Core-prebuilt (0.86.1)\n  - ReactNativeDependencies (0.86.0)\n` });
    const driftResult = runInstall(drift);
    assert.notEqual(driftResult.status, 0);
    assert.match(driftResult.stderr, /pod-graph\/lockfile-drift/);

    await rm(join(decoy.ios, "Pods/Target Support Files/Pods-ForMobile"), { recursive: true, force: true });
    await writePodGraph(decoy.ios, { target: "Pods-Decoy" });
    const decoyResult = runInstall(decoy);
    assert.notEqual(decoyResult.status, 0);
    assert.match(decoyResult.stderr, /pod-graph\/missing-app-support-plan/);

    const sectionDecoy = `PODS:\n  - Unrelated (1.0.0)\nDEPENDENCIES:\n  - React-Core-prebuilt (0.86.0)\n  - ReactNativeDependencies (0.86.0)\n`;
    await writePodGraph(wrongSection.ios, { lock: sectionDecoy, manifest: sectionDecoy });
    const wrongSectionResult = runInstall(wrongSection);
    assert.notEqual(wrongSectionResult.status, 0);
    assert.match(wrongSectionResult.stderr, /pod-graph\/invalid-required-pod-selection/);

    const wrongVersionLock = `PODS:\n  - React-Core-prebuilt (0.85.0)\n  - ReactNativeDependencies (0.86.1)\n`;
    await writePodGraph(wrongVersions.ios, { lock: wrongVersionLock, manifest: wrongVersionLock });
    const wrongVersionsResult = runInstall(wrongVersions);
    assert.notEqual(wrongVersionsResult.status, 0);
    assert.match(wrongVersionsResult.stderr, /pod-graph\/invalid-required-pod-selection/);
  } finally {
    await rm(drift.root, { recursive: true, force: true });
    await rm(decoy.root, { recursive: true, force: true });
    await rm(wrongSection.root, { recursive: true, force: true });
    await rm(wrongVersions.root, { recursive: true, force: true });
  }
});

test("pod proof requires exactly one exact-version root selection for each required pod", async () => {
  const duplicate = await makePodHarness([prebuiltFalse]);
  const conflicting = await makePodHarness([prebuiltFalse]);
  const duplicateSection = await makePodHarness([prebuiltFalse]);
  try {
    const duplicateLock = `PODS:\n  - React-Core-prebuilt (0.86.0)\n  - React-Core-prebuilt (0.86.0)\n  - ReactNativeDependencies (0.86.0)\n`;
    await writePodGraph(duplicate.ios, { lock: duplicateLock, manifest: duplicateLock });
    assert.notEqual(runInstall(duplicate).status, 0);

    const conflictingLock = `PODS:\n  - React-Core-prebuilt (0.86.0)\n  - React-Core-prebuilt (0.85.0)\n  - ReactNativeDependencies (0.86.0)\n`;
    await writePodGraph(conflicting.ios, { lock: conflictingLock, manifest: conflictingLock });
    assert.notEqual(runInstall(conflicting).status, 0);

    const duplicateSectionLock = `PODS:\n  - React-Core-prebuilt (0.86.0)\n  - ReactNativeDependencies (0.86.0)\nDEPENDENCIES:\n  - React-Core-prebuilt\nPODS:\n  - React-Core-prebuilt (0.85.0)\n  - ReactNativeDependencies (0.85.0)\n`;
    await writePodGraph(duplicateSection.ios, { lock: duplicateSectionLock, manifest: duplicateSectionLock });
    const duplicateSectionResult = runInstall(duplicateSection);
    assert.notEqual(duplicateSectionResult.status, 0);
    assert.match(duplicateSectionResult.stderr, /pod-graph\/duplicate-pods-section/);
  } finally {
    await rm(duplicate.root, { recursive: true, force: true });
    await rm(conflicting.root, { recursive: true, force: true });
    await rm(duplicateSection.root, { recursive: true, force: true });
  }
});

test("package lint owns the iOS prebuilt gate without dependency lock changes", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts.lint.split("tools/ios-prebuilt-gate.mjs").length - 1, 1);
  assert.equal(spawnSync("/usr/bin/git", ["diff", "--quiet", "--", "package-lock.json"]).status, 0);
});

test("each exact Pods-ForMobile configuration must embed both required frameworks", async () => {
  const cases = [
    { configuration: "Debug", framework: "React.framework" },
    { configuration: "Debug", framework: "ReactNativeDependencies.framework" },
    { configuration: "Release", framework: "React.framework" },
    { configuration: "Release", framework: "ReactNativeDependencies.framework" },
  ] as const;
  for (const { configuration, framework } of cases) {
    const fixture = await makePodHarness([prebuiltFalse]);
    try {
      await writePodGraph(fixture.ios, {
        plans: { [configuration]: requiredFrameworks.filter((candidate) => candidate !== framework) },
      });
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /pod-graph\/missing-framework-embed/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Debug and Release embed plans reject extra, executable, duplicate, and reordered entries", async () => {
  const canonical = configurationCalls();
  const hostilePlans = [
    [...canonical, '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/Unapproved/Unapproved.framework"'],
    [...canonical, '  install_framework "$(id)"'],
    [...canonical, '  install_framework "`id`"'],
    [canonical[0], ...canonical],
    [...canonical].reverse(),
  ];
  for (const configuration of ["Debug", "Release"] as const) {
    for (const [index, plan] of hostilePlans.entries()) {
      const fixture = await makePodHarness([prebuiltFalse]);
      try {
        const source = completeSupportScript();
        const canonicalBlock = [
          `if [[ "$CONFIGURATION" == "${configuration}" ]]; then`,
          ...canonical,
          "fi",
        ].join("\n");
        const hostileBlock = [
          `if [[ "$CONFIGURATION" == "${configuration}" ]]; then`,
          ...plan,
          "fi",
        ].join("\n");
        assert.equal(source.split(canonicalBlock).length, 2);
        await writePodGraph(fixture.ios, { script: source.replace(canonicalBlock, hostileBlock) });
        const result = runInstall(fixture);
        assert.notEqual(result.status, 0, `${configuration} hostile plan ${index + 1} passed`);
        assert.match(result.stderr, /pod-graph\/(?:missing-framework-embed|noncanonical-framework-embed-plan)/);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }
});

test("embed proof rejects comments, suffix decoys, stale plans, and wrong-configuration xcfilelists", async () => {
  const fixtures = await Promise.all(Array.from({ length: 5 }, () => makePodHarness([prebuiltFalse])));
  try {
    const supportPath = (fixture: Awaited<ReturnType<typeof makePodHarness>>) => join(
      fixture.ios,
      "Pods/Target Support Files/Pods-ForMobile/Pods-ForMobile-frameworks.sh",
    );
    const exactReact = '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/React-Core-prebuilt/React.framework"';

    const commentSource = await readFile(supportPath(fixtures[0]), "utf8");
    await writeFile(supportPath(fixtures[0]), commentSource.replace(exactReact, `  # ${exactReact.trim()}`));

    const suffixSource = await readFile(supportPath(fixtures[1]), "utf8");
    await writeFile(supportPath(fixtures[1]), suffixSource.replace("React-Core-prebuilt/React.framework\"", "React-Core-prebuilt/React.framework.disabled\""));

    await writePodGraph(fixtures[2].ios, {
      plans: { Debug: ["ReactNativeDependencies.framework"] },
      xcfilelists: {
        Debug: { input: "# \${PODS_XCFRAMEWORKS_BUILD_DIR}/React-Core-prebuilt/React.framework\n" },
      },
    });

    await writePodGraph(fixtures[3].ios, {
      plans: { Debug: ["ReactNativeDependencies.framework"] },
      xcfilelists: {
        Release: { input: "\${PODS_XCFRAMEWORKS_BUILD_DIR}/React-Core-prebuilt/React.framework\n" },
      },
    });

    await writePodGraph(fixtures[4].ios, {
      plans: { Debug: ["ReactNativeDependencies.framework"] },
      xcfilelists: {
        Debug: { input: "\${PODS_XCFRAMEWORKS_BUILD_DIR}/React-Core-prebuilt/React.framework\n" },
      },
    });

    for (const fixture of fixtures) {
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /pod-graph\/missing-framework-embed/);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })));
  }
});

test("embed proof rejects nested, dead, early-terminated, duplicate, and ambiguous configuration flow", async () => {
  const fixtures = await Promise.all(Array.from({ length: 7 }, () => makePodHarness([prebuiltFalse])));
  const calls = requiredFrameworks.map((framework) => `  install_framework "\${PODS_XCFRAMEWORKS_BUILD_DIR}/${framework === "React.framework" ? "React-Core-prebuilt" : "ReactNativeDependencies"}/${framework}"`);
  const validRelease = [
    'if [[ "$CONFIGURATION" == "Release" ]]; then',
    ...calls,
    "fi",
  ];
  try {
    const scripts = [
      ["#!/bin/sh", 'if [[ "$CONFIGURATION" == "Debug" ]]; then', "  if false; then", ...calls.map((line) => `  ${line}`), "  fi", "fi", ...validRelease, ""],
      ["#!/bin/sh", 'if [[ "$CONFIGURATION" == "Debug" ]]; then', "  exit 0", ...calls, "fi", ...validRelease, ""],
      ["#!/bin/sh", 'if [[ "$CONFIGURATION" == "Debug" ]]; then', "  return 0", ...calls, "fi", ...validRelease, ""],
      ["#!/bin/sh", 'if [[ "$CONFIGURATION" == "Debug" ]]; then', ...calls, "fi", 'if [[ "$CONFIGURATION" == "Debug" ]]; then', ...calls, "fi", ...validRelease, ""],
      ["#!/bin/sh", 'if [ "$CONFIGURATION" = "Debug" ]; then', ...calls, "fi", ...validRelease, ""],
      ["#!/bin/sh", "exit 0", 'if [[ "$CONFIGURATION" == "Debug" ]]; then', ...calls, "fi", ...validRelease, ""],
      ["#!/bin/sh", "if true; then", "  exit 0", "fi", 'if [[ "$CONFIGURATION" == "Debug" ]]; then', ...calls, "fi", ...validRelease, ""],
    ];
    for (const [index, fixture] of fixtures.entries()) {
      await writePodGraph(fixture.ios, { script: scripts[index].join("\n") });
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0, `hostile script ${index + 1} passed`);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })));
  }
});

test("embed proof denies every unapproved CocoaPods top-level command or control form", async () => {
  const calls = requiredFrameworks.map((framework) => `  install_framework "\${PODS_XCFRAMEWORKS_BUILD_DIR}/${framework === "React.framework" ? "React-Core-prebuilt" : "ReactNativeDependencies"}/${framework}"`);
  const validPlans = [
    'if [[ "$CONFIGURATION" == "Debug" ]]; then',
    ...calls,
    "fi",
    'if [[ "$CONFIGURATION" == "Release" ]]; then',
    ...calls,
    "fi",
  ];
  const hostilePrefixes = [
    ["if true; then exit 0; fi"],
    ['[ "${BYPASS:-}" = yes ] || exit 0'],
    ["true && exit 0"],
    ["(exit 0)"],
    ["{ exit 0; }"],
    [":; exit 0"],
    ["command exit 0"],
    ["set -e", "false"],
    ["printf '%s\\n' unapproved"],
  ];
  const scripts = hostilePrefixes.map((prefix) => ["#!/bin/sh", ...prefix, ...validPlans, ""]);
  scripts.push(["#!/bin/sh", "cat <<'DEAD'", ...validPlans, "DEAD", ""]);

  for (const [index, script] of scripts.entries()) {
    const fixture = await makePodHarness([prebuiltFalse]);
    try {
      await writePodGraph(fixture.ios, { script: script.join("\n") });
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0, `unapproved top-level form ${index + 1} passed`);
      assert.match(result.stderr, /pod-graph\/(?:unsafe-top-level-command|missing-configuration-plan)/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("embed proof accepts and reports the observed complete CocoaPods 1.16.2 support contract", async () => {
  const fixture = await makePodHarness([prebuiltFalse]);
  try {
    await writePodGraph(fixture.ios, { script: completeSupportScript() });
    assert.equal(runInstall(fixture).status, 0);
    const report = await loadReport(fixture.report);
    const expectedEntries = frameworkCalls().map((call) => /^  install_framework "(.+)"$/.exec(call)?.[1]);
    for (const configuration of ["Debug", "Release"] as const) {
      assert.deepEqual(report.graph.supportPlan.configurations[configuration], {
        entries: expectedEntries,
        frameworks: [...requiredFrameworks],
      });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("embed proof rejects a branches-only support script", async () => {
  const fixture = await makePodHarness([prebuiltFalse]);
  try {
    const script = [
      "#!/bin/sh",
      'if [[ "$CONFIGURATION" == "Debug" ]]; then',
      ...frameworkCalls(),
      "fi",
      'if [[ "$CONFIGURATION" == "Release" ]]; then',
      ...frameworkCalls(),
      "fi",
      'if [ "${COCOAPODS_PARALLEL_CODE_SIGN}" == "true" ]; then',
      "  wait",
      "fi",
      "",
    ].join("\n");
    await writePodGraph(fixture.ios, { script });
    const result = runInstall(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pod-graph\/incomplete-support-contract/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("embed proof rejects every required CocoaPods control, assignment, guard, and function when omitted", async () => {
  const complete = completeSupportScript();
  const omissions = [
    ...requiredSupportLines.filter((line) => line !== "STRIP_BINARY_RETVAL=0").map((line) => ({ label: line, block: `${line}\n`, replacement: "" })),
    {
      label: "STRIP_BINARY_RETVAL=0",
      block: "}\nSTRIP_BINARY_RETVAL=0\nstrip_invalid_archs() {",
      replacement: "}\nstrip_invalid_archs() {",
    },
    { label: "frameworks folder guard", block: "if [ -z ${FRAMEWORKS_FOLDER_PATH+x} ]; then\n  exit 0\nfi\n", replacement: "" },
    { label: "parallel code-sign guard", block: 'if [ "${COCOAPODS_PARALLEL_CODE_SIGN}" == "true" ]; then\n  wait\nfi\n', replacement: "" },
    ...Object.entries(supportFunctionBlocks).map(([label, block]) => ({ label, block: `${block}\n`, replacement: "" })),
  ];
  for (const { label, block, replacement } of omissions) {
    const fixture = await makePodHarness([prebuiltFalse]);
    try {
      assert.equal(complete.split(block).length, 2, `${label} omission target is not unique`);
      await writePodGraph(fixture.ios, { script: complete.replace(block, replacement) });
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0, `${label} omission passed`);
      assert.match(result.stderr, /pod-graph\/(?:incomplete-support-contract|unsafe-top-level-command)/, `${label} did not fail the complete contract`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("embed proof rejects declared no-op CocoaPods functions", async () => {
  for (const [functionName, block] of Object.entries(supportFunctionBlocks)) {
    const fixture = await makePodHarness([prebuiltFalse]);
    try {
      const declaration = block.split("\n").slice(0, block.startsWith("install_framework()\n") ? 2 : 1);
      const noOp = [...declaration, "  :", "}"].join("\n");
      await writePodGraph(fixture.ios, { script: completeSupportScript().replace(block, noOp) });
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0, `${functionName} no-op passed`);
      assert.match(result.stderr, /pod-graph\/unsafe-function-body/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("embed proof rejects every executable mutation of an authentic CocoaPods 1.16.2 helper body", async () => {
  const complete = completeSupportScript();
  const mutations = [
    [
      "early return",
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"',
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"\n  return',
    ],
    [
      "exit",
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"',
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"\n  exit 0',
    ],
    [
      "dead branch",
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"',
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"\n  if false; then\n    printf dead\n  fi',
    ],
    [
      "injected command",
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"',
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"\n  printf injected',
    ],
    [
      "injected command substitution",
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"',
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"\n  injected="$(id)"',
    ],
    [
      "per-line omission",
      '    echo "Symlinked..."\n',
      "",
    ],
    [
      "line reordering",
      '    echo "Symlinked..."\n    source="$(readlink -f "${source}")"',
      '    source="$(readlink -f "${source}")"\n    echo "Symlinked..."',
    ],
    [
      "line replacement",
      '    echo "Symlinked..."',
      '    echo "Replacement"',
    ],
  ] as const;
  for (const [label, target, replacement] of mutations) {
    const fixture = await makePodHarness([prebuiltFalse]);
    try {
      assert.equal(complete.split(target).length, 2, `${label} target is not unique`);
      await writePodGraph(fixture.ios, { script: complete.replace(target, replacement) });
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0, `${label} passed`);
      assert.match(result.stderr, /pod-graph\/unsafe-function-body/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("embed proof requires the exact CocoaPods 1.16.2 executable header", async () => {
  for (const header of ["#!/usr/bin/false", "\uFEFF#!/bin/sh", "prefix#!/bin/sh", "# !/bin/sh"]) {
    const fixture = await makePodHarness([prebuiltFalse]);
    try {
      const path = join(fixture.ios, "Pods/Target Support Files/Pods-ForMobile/Pods-ForMobile-frameworks.sh");
      const canonical = await readFile(path, "utf8");
      await writeFile(path, canonical.replace("#!/bin/sh", header));
      const result = runInstall(fixture);
      assert.notEqual(result.status, 0, `header ${JSON.stringify(header)} passed`);
      assert.match(result.stderr, /pod-graph\/(?:malformed-support-script|unsafe-top-level-command)/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("repeated concurrent retained reads normalize parent replacement without raw paths or ENOENT", async () => {
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const fixture = await makePodHarness([prebuiltFalse]);
    try {
      assert.equal(runInstall(fixture).status, 0);
      const movedRetained = `${fixture.retained}-pinned`;
      let replacement: Promise<void> | undefined;
      await assert.rejects(inspectRetainedPodInputs({
        retainedDirectory: fixture.retained,
        logDirectory: fixture.logs,
        attemptCount: 1,
        afterRead: () => replacement ??= (async () => {
          await rename(fixture.retained, movedRetained);
          await mkdir(fixture.retained);
        })(),
      }), (error: any) => {
        assert.equal(error.name, "GateError");
        assert.equal(error.stage, "pod-graph");
        assert.equal(error.code, "invalid-retained-input");
        assert.equal(error.message, "Retained pod input must remain one regular non-symlink file");
        const publicFailure = `${error.message}\n${error.stack ?? ""}`;
        assert.doesNotMatch(publicFailure, /ENOENT|no such file|Podfile\.lock|Manifest\.lock|Pods-ForMobile-frameworks\.sh|fawn-ios-prebuilt-pods-/);
        return true;
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

async function makeApp(root: string, configuration: "Debug" | "Release", omitFramework?: string) {
  const app = join(root, `${configuration}.app`);
  const frameworks = join(app, "Frameworks");
  await mkdir(frameworks, { recursive: true });
  await writeFile(join(app, "ForMobile"), configuration);
  if (configuration === "Debug") await writeFile(join(app, "ForMobile.debug.dylib"), "debug");
  for (const name of ["React", "ReactNativeDependencies", "ExpoModulesCore"]) {
    if (`${name}.framework` === omitFramework) continue;
    const directory = join(frameworks, `${name}.framework`);
    await mkdir(directory);
    await writeFile(join(directory, name), name);
  }
  return app;
}

type ToolScenario = {
  architectures?: (binary: string) => string;
  dependencies?: (binary: string, architecture: string) => readonly string[];
  rpaths?: (binary: string, architecture: string) => readonly string[];
  failWithSecret?: boolean;
  sdkPath?: string;
  toolCalls?: { command: string; args: readonly string[] }[];
  onToolCall?: (command: string, args: readonly string[]) => Promise<void> | void;
  openFile?: typeof open;
};

function configuration(binary: string) {
  return binary.includes("/Debug.app/") ? "Debug" : "Release";
}

function defaultDependencies(binary: string): readonly string[] {
  switch (basename(binary)) {
    case "ForMobile":
      return [
        "@rpath/React.framework/React",
        "@rpath/ReactNativeDependencies.framework/ReactNativeDependencies",
        "@executable_path/Frameworks/ExpoModulesCore.framework/ExpoModulesCore",
      ];
    case "ForMobile.debug.dylib":
      return ["@loader_path/Frameworks/React.framework/React"];
    case "React":
      return ["@rpath/ReactNativeDependencies.framework/ReactNativeDependencies"];
    default:
      return ["/usr/lib/libSystem.B.dylib"];
  }
}

function defaultRpaths(): readonly string[] {
  return ["@executable_path/Frameworks"];
}

function makeToolRunner(scenario: ToolScenario = {}) {
  return async (command: string, args: readonly string[]) => {
    assert.ok((Object.values(PINNED_APP_TOOLS) as string[]).includes(command), `unpinned command: ${command}`);
    scenario.toolCalls?.push({ command, args: [...args] });
    await scenario.onToolCall?.(command, args);
    if (command === PINNED_APP_TOOLS.xcrun) {
      assert.deepEqual(args, ["--sdk", "iphonesimulator", "--show-sdk-path"]);
      return { code: 0, signal: null, stdout: `${scenario.sdkPath}\n`, stderr: "" };
    }
    const binary = args.at(-1) ?? "";
    if (scenario.failWithSecret) {
      return { code: 71, signal: null, stdout: "", stderr: "https://user:secret@example.invalid /private/tmp/private-token" };
    }
    if (command === PINNED_APP_TOOLS.lipo) {
      return { code: 0, signal: null, stdout: `${scenario.architectures?.(binary) ?? "arm64 x86_64"}\n`, stderr: "" };
    }
    const pinnedArchitecture = args[0] === "-arch" ? args[1] : null;
    const operation = pinnedArchitecture === null ? args[0] : args[2];
    const architectures = pinnedArchitecture === null ? ["x86_64", "arm64"] : [pinnedArchitecture];
    if (operation === "-L") {
      const section = (architecture: string) => [
        pinnedArchitecture === null ? `${binary} (architecture ${architecture}):` : `${binary}:`,
        ...(scenario.dependencies?.(binary, architecture) ?? defaultDependencies(binary))
          .map((dependency) => `\t${dependency} (compatibility version 1.0.0, current version 1.0.0)`),
      ];
      const stdout = [...architectures.flatMap(section), ""].join("\n");
      return { code: 0, signal: null, stdout, stderr: "" };
    }
    assert.equal(operation, "-l");
    const stdout = architectures.flatMap((architecture) => (
      scenario.rpaths?.(binary, architecture) ?? defaultRpaths()
    ).flatMap((rpath, index) => [
      `Load command ${index}`,
      "          cmd LC_RPATH",
      "      cmdsize 48",
      `         path ${rpath} (offset 12)`,
    ])).join("\n");
    return { code: 0, signal: null, stdout: `${stdout}\n`, stderr: "" };
  };
}

async function appFixture() {
  const root = await mkdtemp(join(tmpdir(), "fawn-ios-prebuilt-apps-"));
  const sdk = join(root, "iPhoneSimulator.sdk");
  await mkdir(join(sdk, "usr/lib/swift"), { recursive: true });
  await writeFile(join(sdk, "usr/lib/libSystem.B.tbd"), simulatorTbd("/usr/lib/libSystem.B.dylib"));
  await writeFile(join(sdk, "usr/lib/swift/libswiftCore.tbd"), simulatorTbd("/usr/lib/swift/libswiftCore.dylib"));
  return {
    root,
    sdk,
    debug: await makeApp(root, "Debug"),
    release: await makeApp(root, "Release"),
    report: join(root, "report.json"),
  };
}

async function verifyApps(fixture: Awaited<ReturnType<typeof appFixture>>, scenario: ToolScenario = {}) {
  return verifyPrebuiltApps({
    debugApp: fixture.debug,
    releaseApp: fixture.release,
    reportPath: fixture.report,
    expectedSha: sha,
    checkedOutSha: sha,
    flavor: "e2e",
    runTool: makeToolRunner({ ...scenario, sdkPath: fixture.sdk }),
    openFile: scenario.openFile,
  });
}

test("Debug and Release closure expands actual rpaths plus loader/executable paths with arm64 slices", async () => {
  const fixture = await appFixture();
  const toolCalls: { command: string; args: readonly string[] }[] = [];
  const debugExecutable = join(fixture.debug, "ForMobile");
  const debugExecutableLifecycle: string[] = [];
  const openFile: typeof open = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (path === debugExecutable) {
      debugExecutableLifecycle.push("open");
      const close = handle.close.bind(handle);
      handle.close = async () => {
        debugExecutableLifecycle.push("close");
        await close();
      };
    }
    return handle;
  };
  try {
    const report: any = await verifyApps(fixture, {
      toolCalls,
      openFile,
      onToolCall: (command, args) => {
        if (args.at(-1) !== debugExecutable) return;
        if (command === PINNED_APP_TOOLS.lipo) debugExecutableLifecycle.push("lipo");
        else debugExecutableLifecycle.push(args[2]);
      },
    });
    assert.equal(report.status, "pass");
    assert.equal(report.checkedOutSha, sha);
    assert.deepEqual(report.tools, PINNED_APP_TOOLS);
    assert.deepEqual(report.requiredArchitectures, ["arm64"]);
    assert.equal(report.apps.Debug.requiredFrameworks, 2);
    assert.equal(report.apps.Release.requiredFrameworks, 2);
    assert.ok(report.apps.Debug.checkedBinaries > report.apps.Release.checkedBinaries);
    assert.ok(report.apps.Debug.resolvedLoads > 0);
    assert.deepEqual(report.systemRuntime, {
      sdk: "iphonesimulator",
      target: "arm64-ios-simulator",
      verifiedLoads: report.systemRuntime.verifiedLoads,
      uniqueInstallNames: report.systemRuntime.uniqueInstallNames,
      ownershipSha256: report.systemRuntime.ownershipSha256,
    });
    assert.ok(report.systemRuntime.verifiedLoads > 0);
    const otoolCalls = toolCalls.filter((call) => call.command === PINNED_APP_TOOLS.otool);
    assert.ok(otoolCalls.length > 0);
    assert.ok(otoolCalls.every((call) => call.args[0] === "-arch" && call.args[1] === "arm64"));
    assert.deepEqual(debugExecutableLifecycle, ["open", "lipo", "-L", "-l", "close"]);
    assert.equal(toolCalls.filter((call) => call.args.at(-1) === debugExecutable && call.command === PINNED_APP_TOOLS.lipo).length, 1);
    assert.equal(toolCalls.filter((call) => call.args.at(-1) === debugExecutable && call.command === PINNED_APP_TOOLS.otool && call.args[2] === "-L").length, 1);
    assert.equal(toolCalls.filter((call) => call.args.at(-1) === debugExecutable && call.command === PINNED_APP_TOOLS.otool && call.args[2] === "-l").length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("arm64 loads and LC_RPATH cannot borrow valid x86_64 metadata", async () => {
  const fixture = await appFixture();
  const x86Only = join(fixture.debug, "Frameworks/X86Only");
  await mkdir(x86Only);
  await writeFile(join(x86Only, "Only.dylib"), "x86-only");
  try {
    await assert.rejects(verifyApps(fixture, {
      dependencies: (binary, architecture) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? architecture === "arm64" ? ["@rpath/Only.dylib"] : ["@rpath/Only.dylib"]
        : defaultDependencies(binary),
      rpaths: (binary, architecture) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? architecture === "x86_64" ? ["@executable_path/Frameworks/X86Only"] : []
        : defaultRpaths(),
    }), /unresolved in-bundle dependency: @rpath\/Only\.dylib/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("system Swift loads must exist in the pinned simulator SDK", async () => {
  const valid = await appFixture();
  const fabricated = await appFixture();
  try {
    await assert.doesNotReject(verifyApps(valid, {
      dependencies: (binary) => basename(binary) === "ExpoModulesCore"
        ? ["@rpath/libswiftCore.dylib"]
        : defaultDependencies(binary),
    }));
    await assert.rejects(verifyApps(fabricated, {
      dependencies: (binary) => basename(binary) === "ExpoModulesCore"
        ? ["@rpath/libswiftDefinitelyMissing.dylib"]
        : defaultDependencies(binary),
    }), /Swift dependency absent from the pinned simulator SDK/);
  } finally {
    await rm(valid.root, { recursive: true, force: true });
    await rm(fabricated.root, { recursive: true, force: true });
  }
});

test("every absolute system load requires exact simulator-arm64 SDK ownership metadata", async () => {
  const cases = [
    { dependency: "/usr/lib/libDefinitelyMissing.dylib" },
    { dependency: "/System/Library/Frameworks/DefinitelyMissing.framework/DefinitelyMissing" },
    { dependency: "/usr/lib/libCounterfeit.dylib", body: simulatorTbd("/usr/lib/libOther.dylib") },
    { dependency: "/usr/lib/libCounterfeit.dylib", body: simulatorTbd("/usr/lib/libCounterfeit.dylib", ["x86_64-ios-simulator"]) },
    { dependency: "/usr/lib/libCounterfeit.dylib", body: simulatorTbd("/usr/lib/libCounterfeit.dylib", ["arm64-macos"]) },
    { dependency: "/usr/lib/libCounterfeit.dylib", body: simulatorTbd("/usr/lib/libCounterfeit.dylib", ["arm64-ios"]) },
  ] as const;
  for (const testCase of cases) {
    const fixture = await appFixture();
    try {
      if ("body" in testCase) await writeFile(join(fixture.sdk, "usr/lib/libCounterfeit.tbd"), testCase.body);
      await assert.rejects(verifyApps(fixture, {
        dependencies: (binary) => basename(binary) === "ExpoModulesCore"
          ? [testCase.dependency]
          : defaultDependencies(binary),
      }));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("SDK ownership rejects a TAPI stub symlink that resolves outside the pinned SDK", async () => {
  const fixture = await appFixture();
  try {
    const outside = join(fixture.root, "outside-libCounterfeit.tbd");
    await writeFile(outside, simulatorTbd("/usr/lib/libCounterfeit.dylib"));
    await symlink(outside, join(fixture.sdk, "usr/lib/libCounterfeit.tbd"));
    await assert.rejects(verifyApps(fixture, {
      dependencies: (binary) => basename(binary) === "ExpoModulesCore"
        ? ["/usr/lib/libCounterfeit.dylib"]
        : defaultDependencies(binary),
    }));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("SDK ownership rejects a regular TAPI stub reached through an outside parent symlink", async () => {
  const fixture = await appFixture();
  const dependency = "/usr/lib/aliases/libCounterfeit.dylib";
  try {
    const outside = join(fixture.root, "outside-sdk-parent");
    await mkdir(outside);
    await writeFile(join(outside, "libCounterfeit.tbd"), simulatorTbd(dependency));
    await symlink(outside, join(fixture.sdk, "usr/lib/aliases"));
    await assert.rejects(verifyApps(fixture, {
      dependencies: (binary) => basename(binary) === "ExpoModulesCore"
        ? [dependency]
        : defaultDependencies(binary),
    }), /pinned simulator SDK/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("SDK ownership proof records only simulator target counts and an install-name digest", async () => {
  const fixture = await appFixture();
  try {
    const report = await verifyApps(fixture);
    assert.equal(report.systemRuntime.sdk, "iphonesimulator");
    assert.equal(report.systemRuntime.target, "arm64-ios-simulator");
    assert.ok(report.systemRuntime.uniqueInstallNames > 0);
    assert.match(report.systemRuntime.ownershipSha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(report.systemRuntime), /\/Applications|\/private|libSystem/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ordered system Swift rpaths accept only simulator-arm64 TAPI previous-install-name ownership", async () => {
  const valid = await appFixture();
  const counterfeit = await appFixture();
  try {
    const validNetwork = join(valid.sdk, "System/Library/Frameworks/Network.framework/Network.tbd");
    await mkdir(join(valid.sdk, "System/Library/Frameworks/Network.framework"), { recursive: true });
    await writeFile(
      validNetwork,
      simulatorAliasTbd("/System/Library/Frameworks/Network.framework/Network", "/usr/lib/swift/libswiftNetwork.dylib"),
    );
    await symlink(validNetwork, join(valid.sdk, "usr/lib/swift/libswiftNetwork.tbd"));
    await writeFile(
      join(counterfeit.sdk, "usr/lib/swift/libswiftNetwork.tbd"),
      simulatorAliasTbd("/System/Library/Frameworks/Network.framework/Network", "/usr/lib/swift/libswiftCounterfeit.dylib"),
    );
    const scenario = {
      dependencies: (binary: string) => basename(binary) === "ExpoModulesCore"
        ? ["@rpath/libswiftNetwork.dylib"]
        : defaultDependencies(binary),
      rpaths: () => ["/usr/lib/swift", "@executable_path/Frameworks"],
    };
    await assert.doesNotReject(verifyApps(valid, scenario));
    await assert.rejects(verifyApps(counterfeit, scenario));
  } finally {
    await rm(valid.root, { recursive: true, force: true });
    await rm(counterfeit.root, { recursive: true, force: true });
  }
});

test("TAPI ownership ignores previous-install-name text that exists only in a YAML comment", async () => {
  const fixture = await appFixture();
  const dependency = "/usr/lib/swift/libswiftNetwork.dylib";
  try {
    await writeFile(
      join(fixture.sdk, "usr/lib/swift/libswiftNetwork.tbd"),
      `${simulatorTbd("/System/Library/Frameworks/Network.framework/Network")}# symbols: [ '$ld$previous$${dependency}$$2$17.0$_symbol$' ]\n`,
    );
    await assert.rejects(verifyApps(fixture, {
      dependencies: (binary) => basename(binary) === "ExpoModulesCore"
        ? ["@rpath/libswiftNetwork.dylib"]
        : defaultDependencies(binary),
      rpaths: () => ["/usr/lib/swift", "@executable_path/Frameworks"],
    }), /Swift dependency absent from the pinned simulator SDK/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TAPI aliases count only in simulator-arm64 export entries, never metadata or block scalars", async () => {
  const dependency = "/usr/lib/swift/libswiftNetwork.dylib";
  const alias = `$ld$previous$${dependency}$$2$17.0$_symbol$`;
  const bodies = [
    `--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-ios-simulator ]\ninstall-name: '/System/Library/Frameworks/Network.framework/Network'\nmetadata:\n  symbols: [ '${alias}' ]\nexports: []\n`,
    `--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-ios-simulator ]\ninstall-name: '/System/Library/Frameworks/Network.framework/Network'\nnotes: |\n  symbols: [ '${alias}' ]\nexports: []\n`,
    `--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-ios-simulator ]\ninstall-name: '/System/Library/Frameworks/Network.framework/Network'\nexports:\n  - targets: [ arm64-ios ]\n    symbols: [ '${alias}' ]\n`,
    `--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-ios-simulator ]\ninstall-name: '/System/Library/Frameworks/Network.framework/Network'\nexports:\n  - targets: [ arm64-ios-simulator ]\n    symbols: [ '${alias}'\n`,
  ];
  for (const body of bodies) {
    const fixture = await appFixture();
    try {
      await writeFile(join(fixture.sdk, "usr/lib/swift/libswiftNetwork.tbd"), body);
      await assert.rejects(verifyApps(fixture, {
        dependencies: (binary) => basename(binary) === "ExpoModulesCore"
          ? ["@rpath/libswiftNetwork.dylib"]
          : defaultDependencies(binary),
        rpaths: () => ["/usr/lib/swift", "@executable_path/Frameworks"],
      }), /Swift dependency absent from the pinned simulator SDK/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("TAPI alias ownership rejects multiple matching semantic documents", async () => {
  const fixture = await appFixture();
  const dependency = "/usr/lib/swift/libswiftNetwork.dylib";
  try {
    const document = simulatorAliasTbd("/System/Library/Frameworks/Network.framework/Network", dependency);
    await writeFile(join(fixture.sdk, "usr/lib/swift/libswiftNetwork.tbd"), `${document}${document}`);
    await assert.rejects(verifyApps(fixture, {
      dependencies: (binary) => basename(binary) === "ExpoModulesCore"
        ? ["@rpath/libswiftNetwork.dylib"]
        : defaultDependencies(binary),
      rpaths: () => ["/usr/lib/swift", "@executable_path/Frameworks"],
    }), /Swift dependency absent from the pinned simulator SDK/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Xcode 26.6 v4 multi-document stubs accept a unique simulator-arm64 owner", async () => {
  const fixture = await appFixture();
  const dependency = "/usr/lib/libCounterfeit.dylib";
  const body = `--- !tapi-tbd\ntbd-version:     4\ntargets:         [ arm64-ios ]\ninstall-name:    '/usr/lib/libDeviceOnly.dylib'\nexports:\n  - targets:         [ arm64-ios ]\n    symbols:         [ _device ]\n--- !tapi-tbd\ntbd-version:     4\ntargets:         [ x86_64-ios-simulator, arm64-ios-simulator ]\ninstall-name:    '${dependency}'\ncurrent-version: 1\nexports:\n  - targets:         [ x86_64-ios-simulator, arm64-ios-simulator ]\n    symbols:         [ _first,\n                       _second ]\n...\n`;
  try {
    await writeFile(join(fixture.sdk, "usr/lib/libCounterfeit.tbd"), body);
    await assert.doesNotReject(verifyApps(fixture, {
      dependencies: (binary) => basename(binary) === "ExpoModulesCore"
        ? [dependency]
        : defaultDependencies(binary),
    }));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TAPI ownership fails closed on duplicate semantic keys, wrong versions, and malformed hierarchy", async () => {
  const dependency = "/usr/lib/libCounterfeit.dylib";
  const valid = simulatorTbd(dependency);
  const bodies = [
    valid.replace("exports: []", "exports: []\nexports: []"),
    valid.replace("tbd-version: 4", "tbd-version: 4\ntbd-version: 4"),
    valid.replace("targets:", "targets: [ arm64-ios-simulator ]\ntargets:"),
    valid.replace("install-name:", "install-name: '/usr/lib/decoy.dylib'\ninstall-name:"),
    valid.replace("tbd-version: 4\n", ""),
    valid.replace("tbd-version: 4", "tbd-version: 3"),
    valid.replace("tbd-version: 4", "tbd-version: '4'"),
    valid.replace("exports: []", "exports:\n    - targets: [ arm64-ios-simulator ]\n      symbols: [ _malformed ]"),
    `${valid}--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-ios-simulator ]\n  install-name: '${dependency}'\nexports: []\n`,
  ];
  for (const body of bodies) {
    const fixture = await appFixture();
    try {
      await writeFile(join(fixture.sdk, "usr/lib/libCounterfeit.tbd"), body);
      await assert.rejects(verifyApps(fixture, {
        dependencies: (binary) => basename(binary) === "ExpoModulesCore"
          ? [dependency]
          : defaultDependencies(binary),
      }), /absent from the pinned simulator SDK/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("device-only document targets may own a simulator alias only through its exact export target", async () => {
  const dependency = "/usr/lib/swift/libswiftNetwork.dylib";
  const alias = `$ld$previous$${dependency}$$2$17.0$_symbol$`;
  for (const [exportTarget, accepted] of [["arm64-ios-simulator", true], ["arm64-ios", false]] as const) {
    const fixture = await appFixture();
    const body = `--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-ios ]\ninstall-name: '/System/Library/Frameworks/Network.framework/Network'\nexports:\n  - targets: [ ${exportTarget} ]\n    symbols: [ '${alias}' ]\n`;
    try {
      await writeFile(join(fixture.sdk, "usr/lib/swift/libswiftNetwork.tbd"), body);
      const proof = verifyApps(fixture, {
        dependencies: (binary) => basename(binary) === "ExpoModulesCore"
          ? ["@rpath/libswiftNetwork.dylib"]
          : defaultDependencies(binary),
        rpaths: () => ["/usr/lib/swift", "@executable_path/Frameworks"],
      });
      if (accepted) await assert.doesNotReject(proof);
      else await assert.rejects(proof, /Swift dependency absent from the pinned simulator SDK/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("each binary is revalidated under every ordered transitive runpath context", async () => {
  const fixture = await appFixture();
  const frameworks = join(fixture.debug, "Frameworks");
  for (const name of ["A", "B"]) {
    await mkdir(join(frameworks, `${name}.framework`));
    await writeFile(join(frameworks, `${name}.framework`, name), name);
  }
  await mkdir(join(frameworks, "Internal"));
  await writeFile(join(frameworks, "Internal/Shared.dylib"), "shared");
  await mkdir(join(frameworks, "A.framework/Good"));
  await writeFile(join(frameworks, "A.framework/Good/Leaf.dylib"), "leaf");
  await symlink(join(frameworks, "Internal/Shared.dylib"), join(frameworks, "A.framework/Shared.dylib"));
  await symlink(join(frameworks, "Internal/Shared.dylib"), join(frameworks, "B.framework/Shared.dylib"));
  try {
    await assert.rejects(verifyApps(fixture, {
      dependencies: (binary) => {
        if (["A", "B"].includes(basename(binary))) return ["@rpath/Shared.dylib"];
        if (basename(binary) === "Shared.dylib") return ["@rpath/Leaf.dylib"];
        return defaultDependencies(binary);
      },
      rpaths: (binary) => {
        if (basename(binary) === "A") return ["@loader_path/Good", "@loader_path"];
        if (basename(binary) === "B") return ["@loader_path/Missing", "@loader_path"];
        if (basename(binary) === "Shared.dylib") return [];
        return defaultRpaths();
      },
    }), /symlink/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("both configurations require both prebuilt frameworks", async () => {
  for (const configurationName of ["Debug", "Release"] as const) {
    for (const framework of requiredFrameworks) {
      const fixture = await appFixture();
      try {
        await rm(configurationName === "Debug" ? fixture.debug : fixture.release, { recursive: true, force: true });
        if (configurationName === "Debug") fixture.debug = await makeApp(fixture.root, "Debug", framework);
        else fixture.release = await makeApp(fixture.root, "Release", framework);
        await assert.rejects(verifyApps(fixture), new RegExp(`${configurationName} app is missing ${framework.replace(".", "\\.")}`));
        const report = await loadReport(fixture.report);
        assert.equal(report.status, "fail");
        assert.equal(report.failure.stage, "app-closure");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }
});

test("unresolved @rpath, @loader_path, and @executable_path loads fail closed", async () => {
  const unresolved = [
    "@rpath/Missing.framework/Missing",
    "@loader_path/Missing.framework/Missing",
    "@executable_path/Missing.framework/Missing",
  ];
  for (const dependency of unresolved) {
    const fixture = await appFixture();
    try {
      await assert.rejects(verifyApps(fixture, {
        dependencies: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
          ? [...defaultDependencies(binary), dependency]
          : defaultDependencies(binary),
      }), /unresolved in-bundle dependency/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  const noActualRpath = await appFixture();
  try {
    await assert.rejects(verifyApps(noActualRpath, {
      rpaths: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug" ? [] : defaultRpaths(),
    }), /unresolved in-bundle dependency: @rpath\/React\.framework\/React/);
  } finally {
    await rm(noActualRpath.root, { recursive: true, force: true });
  }
});

test("absolute, traversal, and out-of-bundle realpath loads are rejected", async () => {
  const absolute = await appFixture();
  const traversal = await appFixture();
  const escaped = await appFixture();
  try {
    await assert.rejects(verifyApps(absolute, {
      dependencies: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? [...defaultDependencies(binary), "/opt/hostile/libEscape.dylib"]
        : defaultDependencies(binary),
    }), /non-system absolute dependency/);
    assert.doesNotMatch(await readFile(absolute.report, "utf8"), /\/opt\/hostile/);

    await assert.rejects(verifyApps(traversal, {
      dependencies: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? [...defaultDependencies(binary), "@rpath/../escape.dylib"]
        : defaultDependencies(binary),
    }), /traversal dependency/);

    const outside = join(escaped.root, "outside.dylib");
    const link = join(escaped.debug, "Frameworks", "Escape.dylib");
    await writeFile(outside, "outside");
    await symlink(outside, link);
    await assert.rejects(verifyApps(escaped, {
      dependencies: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? [...defaultDependencies(binary), "@rpath/Escape.dylib"]
        : defaultDependencies(binary),
    }), /symlink/);
  } finally {
    await rm(absolute.root, { recursive: true, force: true });
    await rm(traversal.root, { recursive: true, force: true });
    await rm(escaped.root, { recursive: true, force: true });
  }
});

test("non-system absolute LC_RPATH values are rejected even when they currently point inside the app", async () => {
  const fixture = await appFixture();
  try {
    await assert.rejects(verifyApps(fixture, {
      rpaths: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? [join(fixture.debug, "Frameworks")]
        : defaultRpaths(),
    }), /non-system absolute LC_RPATH/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rpath, loader, and executable dependency candidates reject every intermediate symlink", async () => {
  const dependencies = [
    "@rpath/Alias/React",
    "@loader_path/Frameworks/Alias/React",
    "@executable_path/Frameworks/Alias/React",
  ];
  for (const dependency of dependencies) {
    const fixture = await appFixture();
    try {
      await symlink(join(fixture.debug, "Frameworks/React.framework"), join(fixture.debug, "Frameworks/Alias"));
      await assert.rejects(verifyApps(fixture, {
        dependencies: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
          ? [...defaultDependencies(binary), dependency]
          : defaultDependencies(binary),
      }), /symlinked dependency component/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("missing bundle rpaths preserve ordered fallback to the first real dependency", async () => {
  const fixture = await appFixture();
  try {
    await assert.doesNotReject(verifyApps(fixture, {
      rpaths: () => ["@executable_path/Missing", "@executable_path/Frameworks"],
    }));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("executable RPATH swap-back is rejected inside the pinned binary lifecycle", async () => {
  const fixture = await appFixture();
  const executable = join(fixture.debug, "ForMobile");
  const original = join(fixture.debug, "ForMobile.original");
  const replacement = join(fixture.debug, "ForMobile.replacement");
  await writeFile(replacement, "replacement-with-rpath");
  const stableRunTool = makeToolRunner({ sdkPath: fixture.sdk });
  let swapped = false;
  let restored = false;
  const runTool = async (command: string, args: readonly string[]) => {
    if (!swapped && command === PINNED_APP_TOOLS.otool && args[2] === "-l" && args.at(-1) === executable) {
      await rename(executable, original);
      await rename(replacement, executable);
      swapped = true;
      try {
        return await stableRunTool(command, args);
      } finally {
        await rename(executable, replacement);
        await rename(original, executable);
        restored = true;
      }
    }
    return stableRunTool(command, args);
  };
  try {
    await assert.rejects(verifyPrebuiltApps({
      debugApp: fixture.debug,
      releaseApp: fixture.release,
      reportPath: fixture.report,
      expectedSha: sha,
      checkedOutSha: sha,
      flavor: "e2e",
      runTool,
    }), (error: any) => {
      assert.equal(error.name, "GateError");
      assert.equal(error.stage, "app-closure");
      assert.equal(error.code, "unstable-app-binary");
      return true;
    });
    assert.equal(swapped, true);
    assert.equal(restored, true);
    assert.equal(await readFile(executable, "utf8"), "Debug");
    const report = JSON.parse(await readFile(fixture.report, "utf8"));
    assert.deepEqual(report.failure, {
      stage: "app-closure",
      code: "unstable-app-binary",
      message: "app-closure failed closed; inspect retained logs for details",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("path-based binary inspection rejects atomic identity replacement during a pinned tool call", async () => {
  const fixture = await appFixture();
  let replaced = false;
  try {
    await assert.rejects(verifyApps(fixture, {
      onToolCall: async (command, args) => {
        const binary = args.at(-1);
        if (!replaced && command === PINNED_APP_TOOLS.lipo && binary === join(fixture.debug, "ForMobile")) {
          const replacement = join(fixture.debug, "ForMobile.replacement");
          await writeFile(replacement, "replacement");
          await rename(replacement, binary);
          replaced = true;
        }
      },
    }), /changed during inspection/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("path-based binary inspection rejects an atomically replaced app parent symlink", async () => {
  const fixture = await appFixture();
  const movedApp = `${fixture.debug}.pinned`;
  let replaced = false;
  try {
    await assert.rejects(verifyApps(fixture, {
      onToolCall: async (command, args) => {
        const binary = args.at(-1);
        if (!replaced && command === PINNED_APP_TOOLS.lipo && binary === join(fixture.debug, "ForMobile")) {
          await rename(fixture.debug, movedApp);
          await symlink(movedApp, fixture.debug);
          replaced = true;
        }
      },
    }), /changed during inspection/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function assertUnstableProbeFailure(
  mutate: (fixture: Awaited<ReturnType<typeof appFixture>>, command: string, args: readonly string[]) => Promise<boolean>,
) {
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const fixture = await appFixture();
    let mutated = false;
    try {
      await assert.rejects(verifyApps(fixture, {
        onToolCall: async (command, args) => {
          if (!mutated) mutated = await mutate(fixture, command, args);
        },
      }), (error: any) => {
        assert.equal(error.name, "GateError");
        assert.equal(error.stage, "app-closure");
        assert.equal(error.code, "unstable-app-binary");
        assert.equal(error.message, "Debug app binary changed during inspection");
        const publicError = `${error.message}\n${error.stack ?? ""}`;
        assert.doesNotMatch(publicError, /ENOENT|ENOTDIR|no such file|fawn-ios-prebuilt-apps-/i);
        assert.equal(publicError.includes(fixture.root), false);
        return true;
      });
      assert.equal(mutated, true);
      const reportBytes = await readFile(fixture.report, "utf8");
      const report = JSON.parse(reportBytes);
      assert.deepEqual(report.failure, {
        stage: "app-closure",
        code: "unstable-app-binary",
        message: "app-closure failed closed; inspect retained logs for details",
      });
      assert.equal(reportBytes.includes(fixture.root), false);
      assert.doesNotMatch(reportBytes, /ENOENT|ENOTDIR|no such file/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
}

test("binary deletion during repeated lipo probes is a deterministic private GateError", async () => {
  await assertUnstableProbeFailure(async (fixture, command, args) => {
    const binary = args.at(-1);
    if (command !== PINNED_APP_TOOLS.lipo || binary !== join(fixture.debug, "ForMobile")) return false;
    await rm(binary);
    return true;
  });
});

test("app parent replacement during repeated otool probes is a deterministic private GateError", async () => {
  await assertUnstableProbeFailure(async (fixture, command, args) => {
    const binary = args.at(-1);
    if (command !== PINNED_APP_TOOLS.otool || args[2] !== "-L" || binary !== join(fixture.debug, "ForMobile")) return false;
    await rename(fixture.debug, `${fixture.debug}.pinned`);
    await mkdir(fixture.debug);
    return true;
  });
});

test("per-handle binary close failure is attempted without replacing the primary GateError", async () => {
  const fixture = await appFixture();
  let closeAttempts = 0;
  const openFile: typeof open = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      closeAttempts += 1;
      await close();
      throw new Error("injected per-handle close failure");
    };
    return handle;
  };
  try {
    await assert.rejects(verifyApps(fixture, { architectures: () => "x86_64", openFile }), (error: any) => {
      assert.equal(error.name, "GateError");
      assert.equal(error.stage, "app-closure");
      assert.equal(error.code, "missing-architecture");
      assert.doesNotMatch(`${error.message}\n${error.stack ?? ""}`, /injected per-handle close failure|fawn-ios-prebuilt-apps-/);
      return true;
    });
    assert.equal(closeAttempts, 1);
    const report = JSON.parse(await readFile(fixture.report, "utf8"));
    assert.equal(report.failure.code, "missing-architecture");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lexical escapes and outside-to-inside symlinked rpaths are rejected", async () => {
  const fixture = await appFixture();
  const outside = join(fixture.root, "outside");
  await mkdir(outside);
  await symlink(join(fixture.debug, "Frameworks"), join(outside, "inside-frameworks"));
  try {
    await assert.rejects(verifyApps(fixture, {
      rpaths: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? [join(outside, "inside-frameworks")]
        : defaultRpaths(),
    }), /(?:external|non-system absolute) LC_RPATH/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("bundle rpaths reject absolute symlink components even when both endpoints remain inside the app", async () => {
  const fixture = await appFixture();
  const linkedFrameworks = join(fixture.debug, "LinkedFrameworks");
  await symlink(join(fixture.debug, "Frameworks"), linkedFrameworks);
  try {
    await assert.rejects(verifyApps(fixture, {
      rpaths: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? ["@executable_path/LinkedFrameworks"]
        : defaultRpaths(),
    }), /symlink.*LC_RPATH/i);

    await rm(linkedFrameworks);
    await assert.doesNotReject(verifyApps(fixture, {
      rpaths: () => ["@executable_path/Frameworks"],
    }));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ordered LC_RPATH rejects lexical or real external entries before a later bundle match", async () => {
  const lexical = await appFixture();
  const real = await appFixture();
  try {
    await assert.rejects(verifyApps(lexical, {
      rpaths: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? [join(lexical.root, "external"), "@executable_path/Frameworks"]
        : defaultRpaths(),
    }));

    const linkedRpath = join(real.debug, "ExternalRpath");
    const external = join(real.root, "external-rpath");
    await mkdir(external);
    await symlink(external, linkedRpath);
    await assert.rejects(verifyApps(real, {
      rpaths: (binary) => basename(binary) === "ForMobile" && configuration(binary) === "Debug"
        ? ["@executable_path/ExternalRpath", "@executable_path/Frameworks"]
        : defaultRpaths(),
    }));
  } finally {
    await rm(lexical.root, { recursive: true, force: true });
    await rm(real.root, { recursive: true, force: true });
  }
});

test("required and top-level framework directories cannot be symlinks", async () => {
  const escaped = await appFixture();
  const inside = await appFixture();
  try {
    const escapedReact = join(escaped.debug, "Frameworks/React.framework");
    const externalReact = join(escaped.root, "external/React.framework");
    await mkdir(externalReact, { recursive: true });
    await writeFile(join(externalReact, "React"), "external-react");
    await rm(escapedReact, { recursive: true, force: true });
    await symlink(externalReact, escapedReact);
    await assert.rejects(verifyApps(escaped, {
      dependencies: (binary) => configuration(binary) === "Debug" && ["ForMobile", "ForMobile.debug.dylib"].includes(basename(binary))
        ? defaultDependencies(binary).filter((dependency) => !dependency.includes("React.framework"))
        : defaultDependencies(binary),
    }), /React\.framework.*symlink/);

    const insideReact = join(inside.debug, "Frameworks/React.framework");
    const retainedReact = join(inside.debug, "Frameworks/RetainedReact.framework");
    await rm(retainedReact, { recursive: true, force: true });
    await rename(insideReact, retainedReact);
    await symlink(retainedReact, insideReact);
    await assert.rejects(verifyApps(inside), /React\.framework.*symlink/);
  } finally {
    await rm(escaped.root, { recursive: true, force: true });
    await rm(inside.root, { recursive: true, force: true });
  }
});

test("executable, framework, and dylib binaries cannot be symlinks even when absolute targets remain inside the app", async () => {
  for (const kind of ["executable", "framework", "dylib"] as const) {
    const fixture = await appFixture();
    try {
      const target = kind === "executable"
        ? join(fixture.debug, "ForMobile.real")
        : kind === "framework"
          ? join(fixture.debug, "Frameworks/React.framework/React.real")
          : join(fixture.debug, "ForMobile.debug.real.dylib");
      const link = kind === "executable"
        ? join(fixture.debug, "ForMobile")
        : kind === "framework"
          ? join(fixture.debug, "Frameworks/React.framework/React")
          : join(fixture.debug, "ForMobile.debug.dylib");
      await rename(link, target);
      await symlink(target, link);
      await assert.rejects(verifyApps(fixture), /symlink/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("every required simulator binary must contain arm64", async () => {
  const fixture = await appFixture();
  try {
    await assert.rejects(verifyApps(fixture, {
      architectures: (binary) => basename(binary) === "React" && configuration(binary) === "Release" ? "x86_64" : "arm64 x86_64",
    }), /Release React is missing required arm64 architecture/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("closure traversal fails closed at the bounded runpath-context limit", async () => {
  const fixture = await appFixture();
  try {
    for (let index = 0; index < 513; index += 1) {
      await writeFile(join(fixture.debug, `Frameworks/Context-${index}.dylib`), `context-${index}`);
    }
    await assert.rejects(verifyApps(fixture), /bounded runpath context limit/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("structured app failure reports do not retain paths, command output, or credentials", async () => {
  const fixture = await appFixture();
  const invalidIdentity = await appFixture();
  try {
    await assert.rejects(verifyApps(fixture, { failWithSecret: true }), /pinned tool failed/i);
    const bytes = await readFile(fixture.report, "utf8");
    const report = JSON.parse(bytes);
    assert.equal(report.status, "fail");
    assert.equal(report.failure.stage, "app-closure");
    assert.equal(report.failure.code, "tool-failed");
    assert.doesNotMatch(bytes, /private-token|user:secret|example\.invalid/);
    assert.equal(bytes.includes(fixture.root), false);
    assert.equal(bytes.includes(fixture.debug), false);
    assert.equal(bytes.includes(fixture.release), false);

    await assert.rejects(verifyPrebuiltApps({
      debugApp: invalidIdentity.debug,
      releaseApp: invalidIdentity.release,
      reportPath: invalidIdentity.report,
      expectedSha: "credential-like-invalid-sha",
      checkedOutSha: sha,
      flavor: "e2e",
      runTool: makeToolRunner(),
    }), /Expected SHA/);
    const invalidIdentityBytes = await readFile(invalidIdentity.report, "utf8");
    assert.doesNotMatch(invalidIdentityBytes, /credential-like-invalid-sha/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(invalidIdentity.root, { recursive: true, force: true });
  }
});

test("spawned CLI failures emit only a fixed stage and code without hostile path values", async () => {
  const root = await mkdtemp(join(tmpdir(), "fawn-ios-prebuilt-cli-"));
  const secret = join(root, "credential-token.app");
  const report = join(root, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      tool,
      "verify-apps",
      "--debug-app", secret,
      "--release-app", secret,
      "--report", report,
      "--expected-sha", sha,
      "--flavor", "e2e",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^iOS prebuilt gate failed closed: [a-z-]+\/[a-z-]+\n$/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /credential-token|\/private|\/tmp|user:secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
