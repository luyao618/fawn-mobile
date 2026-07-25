import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  assertCleanTrackedStatus,
  CI_EVIDENCE_SCHEMA_VERSION,
  CLEAN_REPOSITORY_STATUS_ARGS,
  collectFaultBundleEvidence,
  collectProfileRestartEvidence,
  collectProfilePrivacyProof,
  loadReport,
  validateNativeReports,
  validateIosPrebuiltReports,
  validateProfileRestartReport,
  validateTestResultInput,
  validatePersistenceReport,
} from "../../../tools/collect-ci-evidence.mjs";
import { NATIVE_EVIDENCE_PATHS, NATIVE_SCHEME_PLACEMENTS } from "../../../tools/check-native-schemes.mjs";
import {
  inspectRetainedPodInputs,
  PINNED_APP_TOOLS,
  verifyPrebuiltApps,
} from "../../../tools/ios-prebuilt-gate.mjs";

const sha = "a".repeat(40);
const opening = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity">`;
const filter = `<intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="formobile-test"/></intent-filter>`;
const closing = `</activity></application></manifest>`;
const productionBytes = opening + closing;
const e2eBytes = opening + filter + closing;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function baseConfig() {
  return {
    name: "For Mobile",
    slug: "for-mobile",
    version: "0.1.0",
    userInterfaceStyle: "light",
    android: { package: "com.luyao618.formobile", softwareKeyboardLayoutMode: "resize" },
    ios: { bundleIdentifier: "com.luyao618.formobile", supportsTablet: true },
    plugins: ["@react-native-vector-icons/lucide", ["expo-secure-store", { configureAndroidBackup: true, faceIDPermission: false }], ["expo-dev-client", { toolsButton: false, skipOnboarding: true, showMenuAtLaunch: false }]],
    sdkVersion: "57.0.0",
    platforms: ["ios", "android"],
  };
}

function configReport(flavor: "production" | "e2e") {
  const config: any = baseConfig();
  if (flavor === "e2e") {
    config.scheme = "formobile-test";
    config.extra = { e2eFaults: true };
  }
  return { schemaVersion: 1, reportType: "resolved-app-config", platform: "android", flavor, checkedOutSha: sha, expectedSha: sha, configSha256: hash(JSON.stringify(config)), config };
}

function schemeReport(flavor: "production" | "e2e", bytes: string) {
  return {
    schemaVersion: 1,
    reportType: "native-scheme",
    platform: "android",
    flavor,
    checkedOutSha: sha,
    expectedSha: sha,
    scheme: "formobile-test",
    count: flavor === "e2e" ? 1 : 0,
    placement: NATIVE_SCHEME_PLACEMENTS.android,
    nativeInput: { path: NATIVE_EVIDENCE_PATHS.android[flavor], sha256: hash(bytes) },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "g018-evidence-"));
  for (const [flavor, bytes] of [["production", productionBytes], ["e2e", e2eBytes]] as const) {
    const path = join(root, NATIVE_EVIDENCE_PATHS.android[flavor]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return {
    root,
    value: {
      platform: "android",
      expectedSha: sha,
      root,
      configReports: { production: configReport("production"), e2e: configReport("e2e") },
      schemeReports: { production: schemeReport("production", productionBytes), e2e: schemeReport("e2e", e2eBytes) },
    },
  };
}

function rehashConfig(report: any) {
  report.configSha256 = hash(JSON.stringify(report.config));
}

function simulatorTbd(installName: string) {
  return `--- !tapi-tbd\ntbd-version: 4\ntargets: [ x86_64-ios-simulator, arm64-ios-simulator ]\ninstall-name: '${installName}'\nexports: []\n`;
}

function completeCocoaPodsSupportScript() {
  const functions = {
    on_error: [
      "function on_error {",
      '  echo "$(realpath -mq "${0}"):$1: error: Unexpected failure"',
      "}",
    ],
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
    ],
    install_dsym: [
      "install_dsym() {",
      '  local source="$1"',
      "  warn_missing_arch=${2:-true}",
      '  if [ -r "$source" ]; then',
      '    echo "rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter \\"- CVS/\\" --filter \\"- .svn/\\" --filter \\"- .git/\\" --filter \\"- .hg/\\" --filter \\"- Headers\\" --filter \\"- PrivateHeaders\\" --filter \\"- Modules\\" \\"${source}\\" \\"${DERIVED_FILES_DIR}\\""',
      '    rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${source}" "${DERIVED_FILES_DIR}"',
      "    local basename",
      '    basename="$(basename -s .dSYM "$source")"',
      '    binary_name="$(ls "$source/Contents/Resources/DWARF")"',
      '    binary="${DERIVED_FILES_DIR}/${basename}.dSYM/Contents/Resources/DWARF/${binary_name}"',
      '    if [[ "$(file "$binary")" == *"Mach-O "*"dSYM companion"* ]]; then',
      '      strip_invalid_archs "$binary" "$warn_missing_arch"',
      "    fi",
      "    if [[ $STRIP_BINARY_RETVAL == 0 ]]; then",
      '      echo "rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --links --filter \\"- CVS/\\" --filter \\"- .svn/\\" --filter \\"- .git/\\" --filter \\"- .hg/\\" --filter \\"- Headers\\" --filter \\"- PrivateHeaders\\" --filter \\"- Modules\\" \\"${DERIVED_FILES_DIR}/${basename}.framework.dSYM\\" \\"${DWARF_DSYM_FOLDER_PATH}\\""',
      '      rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --links --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${DERIVED_FILES_DIR}/${basename}.dSYM" "${DWARF_DSYM_FOLDER_PATH}"',
      "    else",
      '      mkdir -p "${DWARF_DSYM_FOLDER_PATH}"',
      '      touch "${DWARF_DSYM_FOLDER_PATH}/${basename}.dSYM"',
      "    fi",
      "  fi",
      "}",
    ],
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
    ],
    install_bcsymbolmap: [
      "install_bcsymbolmap() {",
      '  local bcsymbolmap_path="$1"',
      '  local destination="${BUILT_PRODUCTS_DIR}"',
      '  echo "rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${bcsymbolmap_path}" "${destination}""',
      '  rsync --delete -av "${RSYNC_PROTECT_TMP_FILES[@]}" --filter "- CVS/" --filter "- .svn/" --filter "- .git/" --filter "- .hg/" --filter "- Headers" --filter "- PrivateHeaders" --filter "- Modules" "${bcsymbolmap_path}" "${destination}"',
      "}",
    ],
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
    ],
  } as const;
  const calls = [
    '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoModulesJSI/ExpoModulesJSI.framework"',
    '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/React-Core-prebuilt/React.framework"',
    '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/ReactNativeDependencies/ReactNativeDependencies.framework"',
    '  install_framework "${PODS_XCFRAMEWORKS_BUILD_DIR}/hermes-engine/Pre-built/hermesvm.framework"',
  ];
  return [
    "#!/bin/sh",
    "set -e",
    "set -u",
    "set -o pipefail",
    ...functions.on_error,
    "trap 'on_error $LINENO' ERR",
    "if [ -z ${FRAMEWORKS_FOLDER_PATH+x} ]; then",
    "  exit 0",
    "fi",
    'echo "mkdir -p ${CONFIGURATION_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"',
    'mkdir -p "${CONFIGURATION_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"',
    'COCOAPODS_PARALLEL_CODE_SIGN="${COCOAPODS_PARALLEL_CODE_SIGN:-false}"',
    'SWIFT_STDLIB_PATH="${TOOLCHAIN_DIR}/usr/lib/swift/${PLATFORM_NAME}"',
    'BCSYMBOLMAP_DIR="BCSymbolMaps"',
    'RSYNC_PROTECT_TMP_FILES=(--filter "P .*.??????")',
    ...functions.install_framework,
    ...functions.install_dsym,
    "STRIP_BINARY_RETVAL=0",
    ...functions.strip_invalid_archs,
    ...functions.install_bcsymbolmap,
    ...functions.code_sign_if_enabled,
    'if [[ "$CONFIGURATION" == "Debug" ]]; then',
    ...calls,
    "fi",
    'if [[ "$CONFIGURATION" == "Release" ]]; then',
    ...calls,
    "fi",
    'if [ "${COCOAPODS_PARALLEL_CODE_SIGN}" == "true" ]; then',
    "  wait",
    "fi",
    "",
  ].join("\n");
}

async function prebuiltPodFixture(root: string, flavor: "production" | "e2e") {
  const retainedDirectory = join(root, flavor, "retained");
  const logDirectory = join(root, flavor, "logs");
  await mkdir(retainedDirectory, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  const lock = `PODS:\n  - React-Core-prebuilt (0.86.0)\n  - ReactNativeDependencies (0.86.0)\n`;
  const support = completeCocoaPodsSupportScript();
  await writeFile(join(retainedDirectory, "Podfile.lock"), lock);
  await writeFile(join(retainedDirectory, "Manifest.lock"), lock);
  await writeFile(join(retainedDirectory, "Pods-ForMobile-frameworks.sh"), support);
  const attemptLog = "pod attempt 1: raw CocoaPods output suppressed\nstdoutBytes=100\nstderrBytes=0\nexitCode=0\nsignal=none\nReactNativeDependencies=false\nReactNativeCore=false\n";
  await writeFile(join(logDirectory, "attempt-1.log"), attemptLog);
  const inspected = await inspectRetainedPodInputs({ retainedDirectory, logDirectory, attemptCount: 1 });
  return {
    input: { retainedDirectory, logDirectory },
    leaves: [
      join(logDirectory, "attempt-1.log"),
      join(retainedDirectory, "Podfile.lock"),
      join(retainedDirectory, "Manifest.lock"),
      join(retainedDirectory, "Pods-ForMobile-frameworks.sh"),
    ],
    report: {
      schemaVersion: 3,
    reportType: "ios-react-native-prebuilt-pods",
    platform: "ios",
    flavor,
    checkedOutSha: sha,
    expectedSha: sha,
    status: "pass",
    selectors: { EXPO_USE_PRECOMPILED_MODULES: "0", RCT_USE_RN_DEP: "1", RCT_USE_PREBUILT_RNCORE: "1" },
    attempts: [{
      attempt: 1,
      command: ["install"],
      exit: { code: 0, signal: null },
      log: inspected.attempts[0].log,
      diagnostics: { rawOutputRetained: false, stderrBytes: 0, stdoutBytes: 100 },
      resolverModes: { ReactNativeDependencies: false, ReactNativeCore: false },
    }],
    acceptedAttempt: 1,
    configurations: ["Debug", "Release"],
    pods: ["React-Core-prebuilt", "ReactNativeDependencies"],
    podVersions: { "React-Core-prebuilt": "0.86.0", ReactNativeDependencies: "0.86.0" },
    frameworks: ["React.framework", "ReactNativeDependencies.framework"],
    privacy: { rawOutputRetained: false },
      graph: inspected.graph,
    },
  };
}

async function collectorAppFixture(root: string) {
  const sdk = join(root, "iPhoneSimulator.sdk");
  await mkdir(join(sdk, "usr/lib"), { recursive: true });
  await writeFile(join(sdk, "usr/lib/libSystem.B.tbd"), simulatorTbd("/usr/lib/libSystem.B.dylib"));
  const binaries: string[] = [];
  const makeApp = async (configuration: "Debug" | "Release") => {
    const app = join(root, `${configuration}.app`);
    await mkdir(join(app, "Frameworks"), { recursive: true });
    const executable = join(app, "ForMobile");
    await writeFile(executable, configuration);
    binaries.push(executable);
    for (const name of ["React", "ReactNativeDependencies", "ExpoModulesCore"]) {
      const binary = join(app, `Frameworks/${name}.framework/${name}`);
      await mkdir(dirname(binary), { recursive: true });
      await writeFile(binary, name);
      binaries.push(binary);
    }
    return app;
  };
  const debugApp = await makeApp("Debug");
  const releaseApp = await makeApp("Release");
  const runTool = async (command: string, args: readonly string[]) => {
    if (command === PINNED_APP_TOOLS.xcrun) return { code: 0, signal: null, stdout: `${sdk}\n`, stderr: "" };
    if (command === PINNED_APP_TOOLS.lipo) return { code: 0, signal: null, stdout: "arm64\n", stderr: "" };
    const binary = args.at(-1) ?? "";
    if (args[2] === "-L") {
      const dependencies = basename(binary) === "ForMobile"
        ? ["@rpath/React.framework/React", "@rpath/ReactNativeDependencies.framework/ReactNativeDependencies"]
        : ["/usr/lib/libSystem.B.dylib"];
      return { code: 0, signal: null, stdout: `${binary}:\n${dependencies.map((dependency) => `\t${dependency} (compatibility version 1.0.0, current version 1.0.0)`).join("\n")}\n`, stderr: "" };
    }
    return { code: 0, signal: null, stdout: "Load command 0\n          cmd LC_RPATH\n      cmdsize 48\n         path @executable_path/Frameworks (offset 12)\n", stderr: "" };
  };
  const reportPath = join(root, "apps-report.json");
  const report = await verifyPrebuiltApps({ debugApp, releaseApp, reportPath, expectedSha: sha, checkedOutSha: sha, flavor: "e2e", runTool });
  return { report, binaries, input: { debugApp, releaseApp, runTool } };
}

async function prebuiltFixture() {
  const root = await mkdtemp(join(tmpdir(), "g018-prebuilt-evidence-"));
  const production = await prebuiltPodFixture(root, "production");
  const e2e = await prebuiltPodFixture(root, "e2e");
  const apps = await collectorAppFixture(root);
  const reports: any = structuredClone({ pods: { production: production.report, e2e: e2e.report }, apps: apps.report });
  return {
    root,
    reports,
    inputs: { pods: { production: production.input, e2e: e2e.input }, apps: apps.input },
    leaves: { pods: { production: production.leaves, e2e: e2e.leaves }, apps: apps.binaries },
  };
}

test("CI evidence reparses and hashes both canonical retained native files", async () => {
  const { root, value } = await fixture();
  try {
    const result: any = await validateNativeReports(value);
    assert.equal(result.scheme.production.count, 0);
    assert.equal(result.scheme.e2e.count, 1);
    assert.equal(result.nativeFiles.production.path, NATIVE_EVIDENCE_PATHS.android.production);
    assert.equal(result.nativeFiles.production.sha256, hash(productionBytes));
    assert.equal(result.nativeFiles.e2e.sha256, hash(e2eBytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-SHA collector independently reparses and rehashes all successful iOS prebuilt inputs", async () => {
  const fixture = await prebuiltFixture();
  try {
    const summary: any = await validateIosPrebuiltReports(fixture.reports, sha, fixture.inputs);
    assert.deepEqual(summary.pods, {
      production: { acceptedAttempt: 1, attempts: 1 },
      e2e: { acceptedAttempt: 1, attempts: 1 },
    });
    for (const configuration of ["Debug", "Release"] as const) {
      assert.equal(summary.apps[configuration].checkedBinaries, fixture.reports.apps.apps[configuration].checkedBinaries);
      assert.equal(summary.apps[configuration].resolvedLoads, fixture.reports.apps.apps[configuration].resolvedLoads);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-SHA collector rejects a transient Debug executable swap-back during its first RPATH probe", async () => {
  const fixture = await prebuiltFixture();
  const executable = join(fixture.inputs.apps.debugApp, "ForMobile");
  const original = join(fixture.inputs.apps.debugApp, "ForMobile.original");
  const replacement = join(fixture.inputs.apps.debugApp, "ForMobile.replacement");
  await writeFile(replacement, "replacement-with-rpath");
  const stableRunTool = fixture.inputs.apps.runTool;
  let swapped = false;
  let restored = false;
  fixture.inputs.apps.runTool = async (command: string, args: readonly string[]) => {
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
    await assert.rejects(validateIosPrebuiltReports(fixture.reports, sha, fixture.inputs), (error: any) => {
      assert.equal(error.name, "GateError");
      assert.equal(error.stage, "app-closure");
      assert.equal(error.code, "unstable-app-binary");
      return true;
    });
    assert.equal(swapped, true);
    assert.equal(restored, true);
    assert.equal(await readFile(executable, "utf8"), "Debug");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function openWithInjectedCloseFailure(onClose: () => void) {
  return async (path: string, flags: number) => {
    const handle = await open(path, flags);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      onClose();
      await close();
      throw new Error("injected per-handle close failure");
    };
    return handle;
  };
}

test("report parsing and SHA use one stable byte read and reject atomic path replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-stable-report-"));
  const path = join(root, "report.json");
  const originalBytes = Buffer.from('{"value":"original"}\n');
  try {
    await writeFile(path, originalBytes);
    const loaded = await loadReport(path);
    assert.deepEqual(loaded.report, { value: "original" });
    assert.equal(loaded.sha256, createHash("sha256").update(originalBytes).digest("hex"));

    const replacement = join(root, "replacement.json");
    await writeFile(replacement, '{"value":"replacement"}\n');
    let closeAttempts = 0;
    await assert.rejects(loadReport(path, {
      afterRead: async () => rename(replacement, path),
      openFile: openWithInjectedCloseFailure(() => { closeAttempts += 1; }),
    }), (error: any) => {
      assert.match(error.message, /changed during read/);
      assert.doesNotMatch(`${error.message}\n${error.stack ?? ""}`, /injected per-handle close failure/);
      return true;
    });
    assert.equal(closeAttempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report parse failure remains primary when the same real handle close also fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-stable-report-parse-close-"));
  const path = join(root, "report.json");
  let closeAttempts = 0;
  try {
    await writeFile(path, "{malformed-json\n");
    await assert.rejects(loadReport(path, {
      openFile: openWithInjectedCloseFailure(() => { closeAttempts += 1; }),
    }), (error: any) => {
      assert.match(error.message, /absent or malformed/);
      assert.equal(error.cause?.name, "SyntaxError");
      assert.doesNotMatch(`${error.cause?.message ?? ""}\n${error.cause?.stack ?? ""}`, /injected per-handle close failure/);
      return true;
    });
    assert.equal(closeAttempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report close failure is surfaced when stable parsing has no primary error", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-stable-report-close-only-"));
  const path = join(root, "report.json");
  let closeAttempts = 0;
  try {
    await writeFile(path, '{"value":"stable"}\n');
    await assert.rejects(loadReport(path, {
      openFile: openWithInjectedCloseFailure(() => { closeAttempts += 1; }),
    }), (error: any) => {
      assert.match(error.message, /absent or malformed/);
      assert.equal(error.cause?.message, "injected per-handle close failure");
      return true;
    });
    assert.equal(closeAttempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report reads reject an atomically replaced parent even when its symlink preserves the leaf identity", async () => {
  const outer = await mkdtemp(join(tmpdir(), "g018-stable-report-parent-"));
  const parent = join(outer, "reports");
  const movedParent = join(outer, "reports-pinned");
  const path = join(parent, "report.json");
  try {
    await mkdir(parent);
    await writeFile(path, '{"value":"original"}\n');
    await assert.rejects(loadReport(path, {
      afterRead: async () => {
        await rename(parent, movedParent);
        await symlink(movedParent, parent);
      },
    }), /parent|ancestor|changed during read/i);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("same-SHA collector rejects stale, failed, drifted, and malformed iOS prebuilt reports", async () => {
  const mutations = [
    (value: any) => { value.pods.production.schemaVersion = 1; },
    (value: any) => { value.pods.production.checkedOutSha = "c".repeat(40); },
    (value: any) => { value.pods.e2e.status = "fail"; },
    (value: any) => { value.pods.production.attempts[0].resolverModes.ReactNativeCore = true; },
    (value: any) => { value.pods.e2e.graph.lockfiles.equal = false; },
    (value: any) => { value.pods.production.graph.supportPlan.configurations.Release.frameworks.pop(); },
    (value: any) => { value.pods.production.podVersions["React-Core-prebuilt"] = "0.85.0"; },
    (value: any) => { value.pods.e2e.graph.supportPlan.file.token = "release-xcfilelist"; },
    (value: any) => { value.pods.e2e.graph.supportPlan.configurations.Debug.extra = true; },
    (value: any) => { value.pods.production.attempts[0].log.sha256 = "a".repeat(64); },
    (value: any) => { value.pods.e2e.graph.lockfiles.files[0].sha256 = "b".repeat(64); },
    (value: any) => { value.apps.tools.otool = "otool"; },
    (value: any) => { value.apps.systemRuntime.sdk = "iphoneos"; },
    (value: any) => { value.apps.systemRuntime.target = "arm64-ios"; },
    (value: any) => { value.apps.systemRuntime.ownershipSha256 = "c".repeat(64); },
    (value: any) => { value.apps.requiredArchitectures = ["x86_64"]; },
    (value: any) => { value.apps.apps.Debug.architectures.arm64 = 0; },
    (value: any) => { value.apps.apps.Release.resolvedLoads = 0; },
    (value: any) => { value.apps.apps.Release.runpathContexts = 3; },
    (value: any) => { value.apps.forged = true; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const fixture = await prebuiltFixture();
    try {
      mutate(fixture.reports);
      await assert.rejects(() => validateIosPrebuiltReports(fixture.reports, sha, fixture.inputs), `mutation ${index + 1} must fail`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("same-SHA collector rejects mutation and symlink replacement of every retained prebuilt leaf", async () => {
  for (const mode of ["mutation", "replacement"] as const) {
    const template = await prebuiltFixture();
    const leafCount = [
      ...template.leaves.pods.production,
      ...template.leaves.pods.e2e,
      ...template.leaves.apps,
    ].length;
    await rm(template.root, { recursive: true, force: true });
    for (let index = 0; index < leafCount; index += 1) {
      const fixture = await prebuiltFixture();
      try {
        const leaves = [...fixture.leaves.pods.production, ...fixture.leaves.pods.e2e, ...fixture.leaves.apps];
        const leaf = leaves[index];
        if (mode === "mutation") {
          await writeFile(leaf, `mutated retained leaf ${index}\n`);
        } else {
          const replacement = join(fixture.root, `replacement-${index}`);
          await writeFile(replacement, await readFile(leaf));
          await rm(leaf);
          await symlink(replacement, leaf);
        }
        await assert.rejects(validateIosPrebuiltReports(fixture.reports, sha, fixture.inputs));
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }
});

test("same-SHA collector rejects nonexistent retained prebuilt inputs despite syntactically valid hashes", async () => {
  const fixture = await prebuiltFixture();
  try {
    await rm(fixture.leaves.pods.production[0]);
    await assert.rejects(validateIosPrebuiltReports(fixture.reports, sha, fixture.inputs));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-SHA collector rejects retained inputs reached through a symlinked parent directory", async () => {
  const fixture = await prebuiltFixture();
  try {
    const retained = fixture.inputs.pods.production.retainedDirectory;
    const parentAlias = join(fixture.root, "retained-parent-alias");
    await symlink(dirname(retained), parentAlias);
    fixture.inputs.pods.production.retainedDirectory = join(parentAlias, basename(retained));
    await assert.rejects(validateIosPrebuiltReports(fixture.reports, sha, fixture.inputs), /non-symlink directory/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("spawned collector failures never echo hostile report or output paths", () => {
  const secret = "/private/tmp/user:credential-token/report.json";
  const result = spawnSync(process.execPath, [
    "tools/collect-ci-evidence.mjs",
    "--expected-sha", sha,
    "--platform", "ios",
    "--prebuilt-apps-report", secret,
    "--output", secret,
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "CI evidence collection failed closed\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /credential-token|\/private|\/tmp/);
});

test("CI evidence rejects forged config identity, privacy, plugins, native placement, paths, and counts", async () => {
  const mutations = [
    (value: any) => { value.configReports.production.config.android.package = "com.attacker.fake"; rehashConfig(value.configReports.production); },
    (value: any) => { value.configReports.e2e.config.ios.infoPlist = { NSCameraUsageDescription: "fake" }; rehashConfig(value.configReports.e2e); },
    (value: any) => { value.configReports.production.config.plugins = []; rehashConfig(value.configReports.production); },
    (value: any) => { value.schemeReports.production.placement = "not-structural"; },
    (value: any) => { value.schemeReports.e2e.nativeInput.path = "android/app/src/main/AndroidManifest.xml"; },
    (value: any) => { delete value.schemeReports.production.nativeInput.path; },
    (value: any) => { value.schemeReports.e2e.count = 0; },
    (value: any) => { value.schemeReports.production = null; },
  ];
  for (const mutate of mutations) {
    const { root, value } = await fixture();
    try {
      mutate(value);
      await assert.rejects(validateNativeReports(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});


test("CI evidence rejects hostile links, telemetry, and undeclared nested or root config fields", async () => {
  const mutations = [
    (config: any) => { config.android.intentFilters = [{ action: "VIEW", data: [{ scheme: "https", host: "attacker.example" }] }]; },
    (config: any) => { config.ios.associatedDomains = ["applinks:attacker.example"]; },
    (config: any) => { config.extra = { telemetryUrl: "https://attacker.example/collect" }; },
    (config: any) => { config.android.adaptiveIcon = { foregroundImage: "./attacker.png" }; },
    (config: any) => { config.ios.config = { usesNonExemptEncryption: false }; },
    (config: any) => { config.web = { bundler: "metro" }; },
    (config: any) => { config.experiments = { typedRoutes: true }; },
  ];
  for (const mutate of mutations) {
    const { root, value } = await fixture();
    try {
      mutate(value.configReports.production.config);
      rehashConfig(value.configReports.production);
      await assert.rejects(validateNativeReports(value), /exactly match|resolved public config/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("CI evidence rejects stale or forged production bytes and mismatched E2E bytes", async () => {
  for (const [flavor, replacement] of [["production", e2eBytes], ["e2e", productionBytes]] as const) {
    const { root, value } = await fixture();
    try {
      await writeFile(join(root, NATIVE_EVIDENCE_PATHS.android[flavor]), replacement);
      await assert.rejects(validateNativeReports(value));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("same-commit provenance rejects tracked, index, and nonignored untracked dirtiness and requires a hashed explicit passing result", () => {
  assert.deepEqual(CLEAN_REPOSITORY_STATUS_ARGS, ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.doesNotThrow(() => assertCleanTrackedStatus(""));
  for (const status of [" M App.tsx", "M  App.tsx", "MM App.tsx", "?? rogue.txt"]) assert.throws(() => assertCleanTrackedStatus(status), /clean/);
  const result = validateTestResultInput("pass", ".artifacts/test-results/static.log", Buffer.from("real gate output\n"));
  assert.equal(result.status, "pass");
  assert.equal(result.file.sha256, hash("real gate output\n"));
  assert.throws(() => validateTestResultInput(undefined, "result.log", Buffer.from("output")), /test-result pass/);
  assert.throws(() => validateTestResultInput("pass", null, Buffer.from("output")), /test-result-file/);
  assert.throws(() => validateTestResultInput("pass", "result.log", Buffer.alloc(0)), /nonempty/);
});

test("schema-v4 fault bundle collector preserves established sentinel leaves exactly", () => {
  const leaf = { path: "bundle.js", bytes: 12, sha256: "f".repeat(64), sentinelOccurrences: 1 };
  const bundles = {
    android: { production: { ...leaf, sentinelOccurrences: 0 }, e2e: leaf },
    ios: { production: { ...leaf, sentinelOccurrences: 0 }, e2e: leaf },
  };
  const evidence = collectFaultBundleEvidence({ path: "proof.json", sha256: "e".repeat(64) }, bundles);
  assert.deepEqual(evidence.bundles, bundles);
  for (const platform of ["android", "ios"] as const) {
    for (const flavor of ["production", "e2e"] as const) {
      assert.deepEqual(Object.keys(evidence.bundles[platform][flavor]), ["path", "bytes", "sha256", "sentinelOccurrences"]);
      assert.equal((evidence.bundles[platform][flavor] as any).observedMarkerCounts, undefined);
      assert.equal((evidence.bundles[platform][flavor] as any).moduleGraph, undefined);
    }
  }
});

test("schema-v5 aggregate binds profile restart only through its validated report leaf", () => {
  assert.equal(CI_EVIDENCE_SCHEMA_VERSION, 5);
  assert.deepEqual(collectProfileRestartEvidence(".artifacts/android-profile-restart.json", "a".repeat(64)), {
    path: ".artifacts/android-profile-restart.json",
    sha256: "a".repeat(64),
  });
  assert.throws(() => collectProfileRestartEvidence("", "a".repeat(64)), /path/);
  assert.throws(() => collectProfileRestartEvidence("profile.json", "not-a-hash"), /SHA/);
});

function poisonSnapshot() {
  const column = (cid: number, name: string, notnull = 0, pk = 0) => ({ cid, name, type: "TEXT", notnull, dflt_value: null, pk });
  return {
    objects: ["chat_turns", "committed_job_effects", "local_jobs", "messages", "pending_agent_tasks", "photos"].map((name) => ({ type: "table", name })),
    columns: {
      chat_turns: [column(0, "id", 0, 1), column(1, "conversation_id", 1), column(2, "status", 1), column(3, "error_code"), column(4, "completed_at"), column(5, "updated_at", 1)],
      committed_job_effects: [column(0, "effect_key", 0, 1)],
      local_jobs: [column(0, "id", 0, 1), column(1, "effect_key", 1), column(2, "status", 1), column(3, "lease_owner"), column(4, "lease_expires_at"), column(5, "next_attempt_at"), column(6, "last_error_code"), column(7, "updated_at", 1)],
      messages: [column(0, "id", 0, 1), column(1, "conversation_id", 1), column(2, "turn_id", 1), column(3, "role", 1)],
      pending_agent_tasks: [column(0, "id", 0, 1), column(1, "status", 1), column(2, "expires_at", 1), column(3, "updated_at", 1)],
      photos: [column(0, "id", 0, 1), column(1, "import_state", 1)],
    },
    rows: {
      chat_turns: [{ id: "poison-turn", conversation_id: "poison-conversation", status: "completed", error_code: null, completed_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
      messages: [{ id: "poison-message", conversation_id: "poison-conversation", turn_id: "poison-turn", role: "user" }],
      pending_agent_tasks: [{ id: "poison-task", status: "completed", expires_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
      local_jobs: [{ id: "poison-job", effect_key: "poison-effect", status: "queued", lease_owner: null, lease_expires_at: null, next_attempt_at: null, last_error_code: null, updated_at: "2026-01-01T00:00:00.000Z" }],
      committed_job_effects: [{ effect_key: "poison-effect" }],
      photos: [{ id: "poison-photo", import_state: "committed" }],
    },
    foreignKeyViolations: [], journalMode: "wal",
  };
}


test("native persistence evidence requires exact nested same-SHA startup facts", () => {
  const sha = "a".repeat(40);
  const migrationSha = "b".repeat(64);
  const snapshot = {
    sha256: "c".repeat(64), migration: [{ version: 1, name: "initial-schema", sha256: migrationSha }], journalMode: "wal",
    objectTypes: [{ type: "index", total: 14 }, { type: "table", total: 26 }, { type: "trigger", total: 3 }],
    meta: null, jobs: [], turns: [], tasks: [],
  };
  const recovered = { ...snapshot, meta: { value_json: '"preserved"' },
    jobs: [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }],
    turns: [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }],
    tasks: [{ id: "e2e-p", status: "expired" }],
  };
  const poison = poisonSnapshot();
  const report = {
    schemaVersion: 2, reportType: "startup-persistence", platform: "android",
    checkedOutSha: sha, expectedSha: sha, migrationSha256: migrationSha, skipped: [],
    scenarios: {
      firstOpen: { status: "pass", snapshot },
      recoveryRelaunch: { status: "pass", snapshot: structuredClone(recovered), noOpSnapshot: structuredClone(recovered) },
      migrationHashRetry: { status: "pass", snapshot: structuredClone(recovered) },
      failedMigrationRollback: { status: "pass", collisionObject: "chat_turns", beforeSnapshot: structuredClone(poison), afterSnapshot: structuredClone(poison) },
    },
  };
  assert.deepEqual(validatePersistenceReport(report, "android", sha, migrationSha).scenarios, [
    "firstOpen", "recoveryRelaunch", "migrationHashRetry", "failedMigrationRollback",
  ]);
  assert.throws(() => validatePersistenceReport({ ...report, skipped: ["failedMigrationRollback"] }, "android", sha, migrationSha), /cannot be skipped/);
  assert.throws(() => validatePersistenceReport({ ...report, checkedOutSha: "d".repeat(40) }, "android", sha, migrationSha), /checked-out SHA/);
  assert.throws(() => validatePersistenceReport({ ...report, migrationSha256: "e".repeat(64) }, "android", sha, migrationSha), /frozen source/);
  for (const key of ["meta", "jobs", "turns", "tasks"] as const) {
    const hostile = structuredClone(report);
    (hostile.scenarios.migrationHashRetry.snapshot as Record<string, unknown>)[key] = key === "meta" ? null : [];
    assert.throws(() => validatePersistenceReport(hostile, "android", sha, migrationSha), new RegExp(`migration retry ${key}`));
  }
  const hostileRecovery = structuredClone(report); hostileRecovery.scenarios.recoveryRelaunch.snapshot.jobs[0].status = "leased";
  assert.throws(() => validatePersistenceReport(hostileRecovery, "android", sha, migrationSha), /recovery jobs/);
  const extra = structuredClone(report); (extra.scenarios.firstOpen.snapshot as Record<string, unknown>).databasePath = "private";
  assert.throws(() => validatePersistenceReport(extra, "android", sha, migrationSha), /snapshot keys/);
  const poisonMutations = [
    (value: any) => { value.scenarios.failedMigrationRollback.collisionObject = "messages"; },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.objects.push({ type: "table", name: "schema_migrations" }); },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.columns.chat_turns.pop(); },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.rows.local_jobs[0].status = "leased"; },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.foreignKeyViolations = [{ table: "messages" }]; },
    (value: any) => { value.scenarios.failedMigrationRollback.afterSnapshot.journalMode = "delete"; },
    (value: any) => { value.scenarios.failedMigrationRollback.beforeSnapshot.rows.photos = []; },
  ];
  for (const mutate of poisonMutations) {
    const hostile = structuredClone(report);
    mutate(hostile);
    assert.throws(() => validatePersistenceReport(hostile, "android", sha, migrationSha));
  }
});

async function profileReport(platform: "android" | "ios") {
  const valueSha256 = "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db";
  const row = {
    singleton_id: 1, name: "G031LeapBaby", sex: "female", birth_date: "2024-02-29",
    birth_weight_g: 3200, birth_height_cm: 50.5, birth_head_cm: 34.2, is_premature: 1,
    gestational_weeks: 36, created_at: "2026-07-18T01:02:03.000Z", updated_at: "2026-07-18T01:02:03.000Z",
  };
  const rowSha256 = hash(JSON.stringify(row));
  const savePath = "e2e/maestro/profile-save.yaml";
  const restartPath = "e2e/maestro/profile-restart.yaml";
  const binary = platform === "android"
    ? {
        kind: "apk",
        embeddedJsBundle: true,
        localBeforeSha256: "1".repeat(64), installedBeforeSha256: "1".repeat(64),
        localAfterSha256: "1".repeat(64), installedAfterSha256: "1".repeat(64),
      }
    : {
        kind: "ios-app",
        embeddedJsBundle: true,
        before: { executableSha256: "1".repeat(64), mainJsBundleSha256: "2".repeat(64), infoPlistSha256: "3".repeat(64) },
        after: { executableSha256: "1".repeat(64), mainJsBundleSha256: "2".repeat(64), infoPlistSha256: "3".repeat(64) },
      };
  const populated = { babyProfileCount: 1, modelConfigCount: 0, modelCapabilitiesCount: 0, row, valueSha256, rowSha256 };
  return {
    schemaVersion: 1,
    reportType: "baby-profile-offline-restart",
    platform,
    flavor: "e2e-release",
    checkedOutSha: sha,
    expectedSha: sha,
    testId: "E2E-001/profile",
    fixture: {
      id: "synthetic-leap-day-v1",
      values: { birthDate: "2024-02-29", birthHeadCm: 34.2, birthHeightCm: 50.5, birthWeightG: 3200, gestationalWeeks: 36, isPremature: true, name: "G031LeapBaby", sex: "female" },
      valueSha256,
    },
    calendar: { source: "device-local-date", beforeSave: "2026-07-18", afterSave: "2026-07-18", afterRelaunch: "2026-07-18", timeZone: "Asia/Shanghai", stable: true },
    ageOracle: { algorithm: "independent-gregorian-v1", birthDate: "2024-02-29", localDate: "2026-07-18", ageDays: 870, completedMonths: 28, remainingDays: 19, display: "28个月19天" },
    binary,
    database: {
      preSave: { babyProfileCount: 0, modelConfigCount: 0, modelCapabilitiesCount: 0, row: null, valueSha256: null, rowSha256: null },
      postSave: structuredClone(populated),
      postRelaunch: structuredClone(populated),
    },
    lifecycle: {
      releaseInstalledFresh: true,
      metro: { killCount: 1, waitCount: 1, pidCleared: true, androidReverseRemoved: platform === "android", negativeProbe: true },
      directLaunches: { preSavePid: "101", savePid: "202", relaunchPid: "303" },
      terminatedBeforeEmptySnapshot: true,
      savePidGone: true,
      relaunchPidDifferent: true,
      postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 },
    },
    privacy: await collectProfilePrivacyProof(),
    migration: {
      recordedSha256: "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec",
      sourceSha256: "c45896b3eb02762c0cf8f62c584889951a15fadc13fd34b9183bfa717ec75975",
      sqlBytes: 10526,
      inventory: { tables: 26, indexes: 14, triggers: 3 },
    },
    evidence: {
      saveFlow: { path: savePath, sha256: hash(await readFile(savePath, "utf8")) },
      restartFlow: { path: restartPath, sha256: hash(await readFile(restartPath, "utf8")) },
    },
    status: "pass",
    skipped: [],
  };
}

test("schema-v5 profile evidence independently binds the exact offline Release restart proof", async () => {
  for (const platform of ["android", "ios"] as const) {
    const report = await profileReport(platform);
    assert.deepEqual(await validateProfileRestartReport(report, platform, sha), {
      testId: "E2E-001/profile",
      fixtureId: "synthetic-leap-day-v1",
      valueSha256: "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db",
    });
    const mutations = [
      (value: any) => { value.database.preSave.babyProfileCount = 1; },
      (value: any) => { value.database.postRelaunch.row.updated_at = "2026-07-18T01:02:04.000Z"; },
      (value: any) => { value.calendar.afterRelaunch = "2026-07-19"; },
      (value: any) => { value.ageOracle.display = "app-reported"; },
      (value: any) => { value.lifecycle.directLaunches.relaunchPid = value.lifecycle.directLaunches.savePid; },
      (value: any) => { value.lifecycle.metro.negativeProbe = false; },
      (value: any) => { value.lifecycle.postInstallMutations.metroRestart = 1; },
      (value: any) => { value.privacy.requestPrimitiveMatches = ["src/hostile.ts:fetch("]; },
      (value: any) => { value.binary.embeddedJsBundle = false; },
      (value: any) => { value.evidence.saveFlow.sha256 = "0".repeat(64); },
      (value: any) => { value.skipped = ["profile"]; },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(report);
      mutate(hostile);
      await assert.rejects(validateProfileRestartReport(hostile, platform, sha));
    }
  }
});
