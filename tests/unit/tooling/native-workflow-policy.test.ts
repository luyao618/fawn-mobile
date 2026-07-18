import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

function ordered(text: string, ...needles: string[]) {
  let offset = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, offset + 1);
    assert(next > offset, `${needle} is absent or out of order`);
    offset = next;
  }
}

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
};

type WorkflowJob = {
  "runs-on"?: unknown;
  env?: Record<string, unknown>;
  needs?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
  steps?: WorkflowStep[];
  if?: unknown;
  "continue-on-error"?: unknown;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

type NativeWorkflows = {
  ci: Workflow;
  android: Workflow;
  ios: Workflow;
};

const checkoutAction = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const setupNodeAction = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const uploadArtifactAction = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const androidEmulatorAction = "ReactiveCircus/android-emulator-runner@1dcd0090116d15e7c562f8db72807de5e036a4ed";
const uploadArtifactRepository = "actions/upload-artifact";
const androidEmulatorRepository = "reactivecircus/android-emulator-runner";
const exactHeadSha = "${{ github.event.pull_request.head.sha || github.sha }}";
const expectedShaInput = "${{ inputs.expected_sha }}";
const exactStaticShaAssertion = `test "$(git rev-parse HEAD)" = "${exactHeadSha}"`;
const exactChildShaAssertion = `test "$(git rev-parse HEAD)" = "${expectedShaInput}"`;
const iosDeveloperDir = "/Applications/Xcode_26.3.app/Contents/Developer";
const iosPreflightStepName = "Preflight pinned Xcode and Swift";
const exactIosJobEnv = { DEVELOPER_DIR: iosDeveloperDir };
const exactIosPreflightScript = String.raw`set -euo pipefail
test "$DEVELOPER_DIR" = "/Applications/Xcode_26.3.app/Contents/Developer"
test -d "$DEVELOPER_DIR"
xcode_version=$(/usr/bin/xcodebuild -version)
printf '%s\n' "$xcode_version"
test "$(printf '%s\n' "$xcode_version" | sed -n '1p')" = "Xcode 26.3"
swift_version=$(/usr/bin/xcrun swift --version)
printf '%s\n' "$swift_version"
SWIFT_VERSION="$swift_version" node - <<'NODE'
const match = /^Apple Swift version (\d+)\.(\d+)(?:\.\d+)?/m.exec(process.env.SWIFT_VERSION ?? "");
if (match === null) throw new Error("Unable to parse Apple Swift version");
const major = Number(match[1]);
const minor = Number(match[2]);
if (major < 6 || (major === 6 && minor < 2)) {
  throw new Error("Apple Swift 6.2 or newer is required; found " + major + "." + minor);
}
console.log("Apple Swift preflight passed: " + major + "." + minor);
NODE
`;
const exactStaticCollector = `node tools/collect-ci-evidence.mjs --expected-sha "${exactHeadSha}" --platform host --flavor static --test-result pass --test-result-file .artifacts/test-results/static-gates.log --fault-bundle-proof .artifacts/fault-bundles/proof.json --output .artifacts/static.json`;
const whoProvisionStepName = "Populate hash-pinned WHO cache";
const whoDownloadCommand = "PYTHONDONTWRITEBYTECODE=1 python3 tools/knowledge/download_who_sources.py";
const whoOfflineVerificationCommand = `${whoDownloadCommand} --offline`;
const exactWhoProvisionScript = `${whoDownloadCommand}\n${whoOfflineVerificationCommand}\n`;
const exactStaticUploadPath = ".artifacts/static.json\n.artifacts/test-results/static-gates.log\n.artifacts/fault-bundles/proof.json\n.artifacts/fault-bundles/android/production/**/*.js\n.artifacts/fault-bundles/android/production/metadata.json\n.artifacts/fault-bundles/android/e2e/**/*.js\n.artifacts/fault-bundles/android/e2e/metadata.json\n.artifacts/fault-bundles/ios/production/**/*.js\n.artifacts/fault-bundles/ios/production/metadata.json\n.artifacts/fault-bundles/ios/e2e/**/*.js\n.artifacts/fault-bundles/ios/e2e/metadata.json\n";
const exactChildPrimaryUploadPaths = {
  android: ".artifacts/android-e2e.json\n.artifacts/config/android-*.json\n.artifacts/schemes/android-*.json\n.artifacts/native/android/**\n.artifacts/launch/android-dev-client.log\n.artifacts/test-results/android-maestro.log\n.artifacts/android-persistence.json\n.artifacts/android-profile-restart.json\n.artifacts/persistence/android/*.json\n",
  ios: ".artifacts/ios-e2e.json\n.artifacts/config/ios-*.json\n.artifacts/schemes/ios-*.json\n.artifacts/native/ios/**\n.artifacts/launch/ios-dev-client.log\n.artifacts/test-results/ios-maestro.log\n.artifacts/ios-persistence.json\n.artifacts/ios-profile-restart.json\n.artifacts/persistence/ios/*.json\n",
} as const;
const forbiddenStaticUploadPath = /knowledge\/sources|knowledge\/generated|\.xlsx|fawn-slice0-who-reference\.csv|who-growth-reference\.csv/i;
const exactAndroidRunnerSha256 = "52236399b43c99f85a9820351612e0228b835ad8f67c15eee23e9025b803fcb9";
const exactNdkSelector = 'const ndk = readdirSync(join(sdk, "ndk")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];';

const exactPreflightNodeProgram = `const { accessSync, constants, readdirSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
const ndk = readdirSync(join(sdk, "ndk")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const buildTools = readdirSync(join(sdk, "build-tools")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const platform = readdirSync(join(sdk, "platforms")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
if (ndk === undefined || buildTools === undefined || platform === undefined) {
  console.error(\`Android SDK selection failed: ndk=\${ndk ?? "missing"}, build-tools=\${buildTools ?? "missing"}, platform=\${platform ?? "missing"}\`);
  process.exit(1);
}

const toolchainBin = join(sdk, "ndk", ndk, "toolchains/llvm/prebuilt/darwin-x86_64/bin");
const executableTools = [
  join(toolchainBin, "aarch64-linux-android35-clang"),
  join(toolchainBin, "aarch64-linux-android35-clang++"),
  join(toolchainBin, "llvm-nm"),
  join(toolchainBin, "llvm-readelf"),
  join(sdk, "build-tools", buildTools, "aapt"),
  join(sdk, "build-tools", buildTools, "zipalign"),
  join(sdk, "build-tools", buildTools, "apksigner"),
  join(sdk, "cmdline-tools", "latest", "bin", "apkanalyzer"),
];
for (const tool of executableTools) {
  try {
    accessSync(tool, constants.X_OK);
  } catch {
    console.error(\`Required Android executable is unavailable: \${tool}\`);
    process.exit(1);
  }
}

const androidJar = join(sdk, "platforms", platform, "android.jar");
try {
  accessSync(androidJar, constants.R_OK);
} catch {
  console.error(\`Selected Android platform jar is unreadable: \${androidJar}\`);
  process.exit(1);
}
console.log(\`Android preflight passed: SDK=\${sdk || "<empty>"}, NDK=\${ndk}, build-tools=\${buildTools}, platform=\${platform}\`);`;

const exactRequiredTools = [
  "/usr/bin/xcrun",
  "/usr/bin/codesign",
  "/usr/bin/keytool",
  "/usr/bin/zip",
  "/usr/bin/unzip",
  "/usr/bin/nm",
  "/usr/bin/lipo",
  "/usr/bin/otool",
  "/usr/bin/zipinfo",
  "/usr/bin/plutil",
];

const exactSimulatorCompilerProbes = [
  "simulator_clang=$(/usr/bin/xcrun --sdk iphonesimulator --find clang)",
  "simulator_clangxx=$(/usr/bin/xcrun --sdk iphonesimulator --find clang++)",
];

const exactChildCollectorRuns = {
  android: String.raw`node tools/collect-ci-evidence.mjs \
  --expected-sha "${expectedShaInput}" --platform android --flavor e2e \
  --test-result pass --test-result-file .artifacts/test-results/android-maestro.log \
  --config-report-production .artifacts/config/android-production.json \
  --config-report-e2e .artifacts/config/android-e2e.json \
  --scheme-report-production .artifacts/schemes/android-production.json \
  --scheme-report-e2e .artifacts/schemes/android-e2e.json \
  --persistence-report .artifacts/android-persistence.json \
  --profile-restart-report .artifacts/android-profile-restart.json \
  --output .artifacts/android-e2e.json` + "\n",
  ios: String.raw`node tools/collect-ci-evidence.mjs \
  --expected-sha "${expectedShaInput}" --platform ios --flavor e2e \
  --test-result pass --test-result-file .artifacts/test-results/ios-maestro.log \
  --config-report-production .artifacts/config/ios-production.json \
  --config-report-e2e .artifacts/config/ios-e2e.json \
  --scheme-report-production .artifacts/schemes/ios-production.json \
  --scheme-report-e2e .artifacts/schemes/ios-e2e.json \
  --persistence-report .artifacts/ios-persistence.json \
  --profile-restart-report .artifacts/ios-profile-restart.json \
  --output .artifacts/ios-e2e.json` + "\n",
} as const;

const originalStaticGateRuns = [
  "npm ci --workspaces --include-workspace-root",
  "npm --prefix spikes/sqlite-fts ci --ignore-scripts --workspaces=false",
  "npm --prefix spikes/backup-crypto ci --ignore-scripts --workspaces=false",
  "npm --prefix spikes/model-transport ci --ignore-scripts --workspaces=false",
  "npm run test:dependencies",
  "npm run typecheck",
  "npm run lint",
  "npm test -- --runInBand",
  "npm run test:node",
  "npm run test:knowledge",
  "npm run test:config",
  "npm run test:licenses",
  "npm run test:audit",
  "npm audit signatures --workspaces=false",
  "npx --no-install expo install --check",
  "npm run expo:doctor",
  "npm run test:fault-scaffold",
  "npm run test:fault-bundles",
  "npm run slice0",
  "npm run test:g017",
  "npm run expo:doctor:g017",
  "npm run g017:export:android",
  "npm run g017:export:ios",
  "node spikes/model-transport/deviceEvidenceValidator.mjs --fingerprint",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkflow(source: string, path: string): Workflow {
  const workflow: unknown = parse(source);
  assert.ok(isRecord(workflow), `${path} must parse as an object`);
  assert.ok(isRecord(workflow.jobs), `${path} must contain a jobs object`);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.ok(isRecord(job), `${path} job ${jobName} must be an object`);
    if ("steps" in job) assert.ok(Array.isArray(job.steps), `${path} job ${jobName} steps must be an array`);
  }
  return workflow as Workflow;
}

async function loadNativeWorkflows(): Promise<NativeWorkflows> {
  const paths = [
    ".github/workflows/ci.yml",
    ".github/workflows/e2e-android.yml",
    ".github/workflows/e2e-ios.yml",
  ] as const;
  const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  return {
    ci: parseWorkflow(sources[0], paths[0]),
    android: parseWorkflow(sources[1], paths[1]),
    ios: parseWorkflow(sources[2], paths[2]),
  };
}

function requiredJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name];
  assert.ok(job, `Workflow job ${name} is absent`);
  return job;
}

function assertExactJobKeys(workflow: Workflow, expected: string[], label: string): void {
  assert.deepEqual(
    Object.keys(workflow.jobs).sort(),
    [...expected].sort(),
    `${label} workflow jobs must contain only the approved exact keys`,
  );
}

function requiredSteps(job: WorkflowJob, name: string): WorkflowStep[] {
  assert.ok(Array.isArray(job.steps), `Workflow job ${name} has no parsed steps`);
  return job.steps;
}

function stepIndex(steps: WorkflowStep[], predicate: (step: WorkflowStep) => boolean, label: string): number {
  const index = steps.findIndex(predicate);
  assert.notEqual(index, -1, `${label} step is absent`);
  return index;
}

function assertUnconditionalFailClosed(node: WorkflowStep | WorkflowJob, label: string): void {
  assert.equal(Object.hasOwn(node, "if"), false, `${label} must not be conditional`);
  assert.equal(Object.hasOwn(node, "continue-on-error"), false, `${label} must fail closed`);
}

function usesActionRepository(step: WorkflowStep, repository: string): boolean {
  if (typeof step.uses !== "string") return false;
  const separator = step.uses.indexOf("@");
  const referencedRepository = separator === -1 ? step.uses : step.uses.slice(0, separator);
  return referencedRepository.toLowerCase() === repository.toLowerCase();
}

function pinnedAndroidActionScript(workflow: Workflow): string {
  const steps = requiredSteps(requiredJob(workflow, "android"), "android");
  const matches = steps.filter((step) => usesActionRepository(step, androidEmulatorRepository));
  assert.equal(matches.length, 1, "Android must contain exactly one emulator action family step");
  const step = matches[0];
  assert.equal(step.uses, androidEmulatorAction, "Android emulator action must remain pinned to the reviewed SHA");
  assert.deepEqual(step.with, {
    "api-level": 35,
    arch: "x86_64",
    profile: "pixel_2",
    cores: 4,
    "disable-linux-hw-accel": false,
    "emulator-options": "-no-window -gpu swiftshader -no-snapshot -noaudio -no-boot-anim -accel on",
    script: "bash scripts/e2e/run-android-emulator.sh",
  }, "Android emulator action inputs must remain exact");
  assertUnconditionalFailClosed(step, "Android emulator action");
  return step.with.script as string;
}

function withoutTerminalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function extractPreflightNodeProgram(script: string): string {
  const lines = script.split("\n");
  const openerIndexes = lines.flatMap((line, index) => line === "node - <<'NODE'" ? [index] : []);
  const terminatorIndexes = lines.flatMap((line, index) => line === "NODE" ? [index] : []);
  assert.equal(openerIndexes.length, 1, "Preflight must contain exactly one Node heredoc opener");
  assert.equal(terminatorIndexes.length, 1, "Preflight must contain exactly one Node heredoc terminator");
  const start = openerIndexes[0];
  const end = terminatorIndexes[0];
  assert.ok(start < end, "Preflight Node heredoc terminator must follow its opener");
  return withoutTerminalNewline(lines.slice(start + 1, end).join("\n"));
}

function extractRequiredTools(script: string): string[] {
  const lines = script.split("\n");
  const startIndexes = lines.flatMap((line, index) => line === "required_tools=(" ? [index] : []);
  assert.equal(startIndexes.length, 1, "Preflight must contain exactly one required_tools array");
  const start = startIndexes[0];
  const end = lines.indexOf(")", start + 1);
  assert.notEqual(end, -1, "Preflight required_tools array is unterminated");
  return lines.slice(start + 1, end).map((line, index) => {
    const match = /^  "(\/[^"\n]+)"$/.exec(line);
    assert.ok(match, `required_tools entry ${index + 1} must be one exact quoted absolute path`);
    return match[1];
  });
}

function assertPreflightSemanticPolicy(script: string): void {
  assert.equal(
    extractPreflightNodeProgram(script),
    withoutTerminalNewline(exactPreflightNodeProgram),
    "Embedded Android preflight Node program must remain exact",
  );
  assert.deepEqual(
    extractRequiredTools(script),
    exactRequiredTools,
    "Bash required_tools inventory must remain exact and ordered",
  );
  assert.deepEqual(
    script.split("\n").filter((line) => /^simulator_clang(?:xx)?=/.test(line)),
    exactSimulatorCompilerProbes,
    "Simulator compiler probes must remain exact and ordered",
  );
}

function assertChildWorkflowPolicy(workflow: Workflow, jobName: "android" | "ios"): void {
  assertExactJobKeys(workflow, [jobName], jobName);
  const job = requiredJob(workflow, jobName);
  assertUnconditionalFailClosed(job, `${jobName} job`);
  const steps = requiredSteps(job, jobName);
  const checkoutIndex = stepIndex(steps, (step) => step.uses === checkoutAction, `${jobName} checkout`);
  assert.equal(steps[checkoutIndex].with?.ref, expectedShaInput, `${jobName} checkout must use inputs.expected_sha`);
  const assertionIndex = stepIndex(steps, (step) => step.run === exactChildShaAssertion, `${jobName} SHA assertion`);
  const installIndex = stepIndex(steps, (step) => step.run === "npm ci --workspaces --include-workspace-root", `${jobName} npm install`);
  assert.ok(checkoutIndex < assertionIndex && assertionIndex < installIndex, `${jobName} must assert the checked-out SHA before install`);
  if (jobName === "ios") {
    assert.deepEqual(job.env, exactIosJobEnv, "iOS job environment must remain exactly pinned to Xcode 26.3");
    const preflightIndexes = steps.flatMap((step, index) => step.name === iosPreflightStepName ? [index] : []);
    assert.equal(preflightIndexes.length, 1, "iOS must contain exactly one pinned Xcode and Swift preflight");
    const preflightIndex = preflightIndexes[0];
    const preflight = steps[preflightIndex];
    assert.equal(preflightIndex, assertionIndex + 1, "iOS toolchain preflight must immediately follow the SHA assertion");
    assert.equal(installIndex, preflightIndex + 1, "iOS install must immediately follow the toolchain preflight");
    assert.equal(preflight.run, exactIosPreflightScript, "iOS Xcode and Swift preflight must remain exact");
    assert.equal(Object.hasOwn(preflight, "if"), false, "iOS toolchain preflight must not be conditional");
    assert.equal(Object.hasOwn(preflight, "continue-on-error"), false, "iOS toolchain preflight must fail closed");
  } else {
    assert.equal(job["runs-on"], exactAndroidRunner, "Android runner must remain ubuntu-latest");
    assert.deepEqual(
      job.env,
      { MAESTRO_DRIVER_STARTUP_TIMEOUT: exactAndroidMaestroTimeout },
      "Android Maestro driver startup timeout must remain exactly bounded at 60000ms",
    );
    const e2ePrebuildIndex = stepIndex(steps, (step) => step.name === "Clean-prebuild, inspect, and build E2E", "Android E2E prebuild");
    const kvmIndexes = steps.flatMap((step, index) => step.name === androidKvmStepName ? [index] : []);
    assert.equal(kvmIndexes.length, 1, "Android must contain exactly one named KVM hardware acceleration step");
    const kvmIndex = kvmIndexes[0];
    const kvmStep = steps[kvmIndex];
    assert.equal(kvmStep.run, exactAndroidKvmScript, "Android KVM hardware acceleration setup must remain exact and fail closed");
    assertUnconditionalFailClosed(kvmStep, "Android KVM hardware acceleration setup");
    const emulatorIndex = stepIndex(steps, (step) => usesActionRepository(step, androidEmulatorRepository), "Android emulator");
    const kvmLaunchProbeIndexes = steps.flatMap((step, index) => step.name === androidKvmLaunchProbeStepName ? [index] : []);
    assert.equal(kvmLaunchProbeIndexes.length, 1, "Android must contain exactly one launch-adjacent KVM verification step");
    const kvmLaunchProbeIndex = kvmLaunchProbeIndexes[0];
    const kvmLaunchProbeStep = steps[kvmLaunchProbeIndex];
    assert.equal(kvmLaunchProbeStep.run, exactAndroidKvmLaunchProbeScript, "Android launch-adjacent KVM verification must remain exact and fail closed");
    assertUnconditionalFailClosed(kvmLaunchProbeStep, "Android launch-adjacent KVM verification");
    const e2ePrebuild = steps[e2ePrebuildIndex];
    assert.ok(typeof e2ePrebuild.run === "string", "Android E2E prebuild must have an enabled run script");
    assert.deepEqual(
      e2ePrebuild.run.split(/\r\n|\n|\r/).filter((line) => line.trim().includes("gradlew")),
      [exactAndroidBuildCommand],
      "Android E2E prebuild must contain only the exact x86_64 build command",
    );
    assert.equal(kvmIndex, assertionIndex + 1, "Android KVM setup must immediately follow the exact SHA assertion");
    assert.equal(installIndex, kvmIndex + 1, "Android npm install must immediately follow the exact KVM setup");
    assert.ok(e2ePrebuildIndex < kvmLaunchProbeIndex, "Android x86_64 E2E build must complete before launch-adjacent KVM verification");
    assert.equal(kvmLaunchProbeIndex, emulatorIndex - 1, "Android KVM verification must immediately precede the emulator action");
  }

  const collectorIndexes = steps.flatMap((step, index) => step.name === "Collect same-SHA evidence" ? [index] : []);
  assert.equal(collectorIndexes.length, 1, `${jobName} must contain exactly one same-SHA evidence collector`);
  const collectorIndex = collectorIndexes[0];
  const collector = steps[collectorIndex];
  assert.equal(collector.run, exactChildCollectorRuns[jobName], `${jobName} evidence collector command must remain exact`);
  assert.equal(Object.hasOwn(collector, "if"), false, `${jobName} evidence collector must not be conditional`);
  assert.equal(Object.hasOwn(collector, "continue-on-error"), false, `${jobName} evidence collector must fail closed`);
  const smokeIndex = jobName === "android"
    ? stepIndex(steps, (step) => step.uses === androidEmulatorAction, "android device smoke")
    : stepIndex(steps, (step) => step.name === "Serial production and E2E builds, install, and smoke", "ios device smoke");
  assert.ok(collectorIndex > smokeIndex, `${jobName} evidence collector must follow the device smoke step`);
  const uploadIndexes = steps.flatMap((step, index) => usesActionRepository(step, uploadArtifactRepository) ? [index] : []);
  assert.equal(uploadIndexes.length, 2, `${jobName} must contain exactly the approved primary and diagnostics artifact uploads`);
  for (const uploadIndex of uploadIndexes) {
    assert.equal(steps[uploadIndex].uses, uploadArtifactAction, `${jobName} artifact upload actions must remain pinned`);
  }
  const primaryUploadName = `${jobName}-e2e-evidence-${expectedShaInput}`;
  const primaryUploadIndexes = uploadIndexes.filter((index) => steps[index].with?.name === primaryUploadName);
  assert.equal(primaryUploadIndexes.length, 1, `${jobName} must contain exactly one primary evidence upload`);
  const primaryUploadIndex = primaryUploadIndexes[0];
  const primaryUpload = steps[primaryUploadIndex];
  assert.deepEqual(primaryUpload.with, {
    name: primaryUploadName,
    path: exactChildPrimaryUploadPaths[jobName],
    "if-no-files-found": "error",
  }, `${jobName} primary evidence upload inputs must remain exact`);
  assertUnconditionalFailClosed(primaryUpload, `${jobName} primary evidence upload`);
  assert.ok(primaryUploadIndex > collectorIndex, `${jobName} primary evidence upload must follow the same-SHA collector`);

  const diagnosticsUploadName = `${jobName}-e2e-diagnostics-${expectedShaInput}`;
  const diagnosticsUploadIndexes = uploadIndexes.filter((index) => steps[index].with?.name === diagnosticsUploadName);
  assert.equal(diagnosticsUploadIndexes.length, 1, `${jobName} must retain exactly one diagnostics upload`);
  const diagnosticsUploadIndex = diagnosticsUploadIndexes[0];
  const diagnosticsUpload = steps[diagnosticsUploadIndex];
  assert.equal(diagnosticsUpload.uses, uploadArtifactAction, `${jobName} diagnostics upload must remain pinned`);
  assert.equal(diagnosticsUpload.if, "always()", `${jobName} diagnostics upload must always run`);
  assert.equal(Object.hasOwn(diagnosticsUpload, "continue-on-error"), false, `${jobName} diagnostics upload must fail closed`);
  assert.deepEqual(diagnosticsUpload.with, {
    name: diagnosticsUploadName,
    path: ".artifacts/launch/**\n.artifacts/test-results/**\n",
    "include-hidden-files": true,
    "if-no-files-found": "ignore",
  }, `${jobName} diagnostics upload inputs must remain exact`);
  assert.ok(
    diagnosticsUploadIndex > primaryUploadIndex,
    `${jobName} diagnostics upload must follow the primary evidence upload`,
  );
  if (jobName === "android") pinnedAndroidActionScript(workflow);
}

function assertNativeWorkflowPolicy(workflows: NativeWorkflows): void {
  assertExactJobKeys(workflows.ci, ["static", "android-e2e", "ios-e2e"], "CI");
  const staticJob = requiredJob(workflows.ci, "static");
  assertUnconditionalFailClosed(staticJob, "Static job");
  assert.equal(staticJob["runs-on"], "macos-15-intel", "Static runner must be the Intel macOS image");
  const steps = requiredSteps(staticJob, "static");
  const checkoutIndex = stepIndex(steps, (step) => step.uses === checkoutAction, "Static checkout");
  assert.equal(steps[checkoutIndex].with?.ref, exactHeadSha);
  assert.equal(steps[checkoutIndex + 1]?.run, exactStaticShaAssertion, "Static checkout must immediately assert the exact head SHA");

  const setupNodeIndex = stepIndex(steps, (step) => step.uses === setupNodeAction, "Pinned setup-node");
  assert.equal(setupNodeIndex, checkoutIndex + 2, "Pinned setup-node must immediately follow the checkout assertion");
  assert.deepEqual(steps[setupNodeIndex].with, { "node-version": "22.18.0", cache: "npm" });

  const preflightIndex = stepIndex(steps, (step) => step.name === "Preflight frozen native tooling", "Native preflight");
  assert.equal(preflightIndex, setupNodeIndex + 1, "Preflight must immediately follow pinned setup-node");
  const preflight = steps[preflightIndex];
  assert.equal(Object.hasOwn(preflight, "if"), false, "Preflight must not be conditionally disabled");
  assert.equal(Object.hasOwn(preflight, "continue-on-error"), false, "Preflight must fail closed");
  const preflightRun = preflight.run;
  assert.ok(typeof preflightRun === "string", "Preflight must have an enabled run script");
  assertPreflightSemanticPolicy(preflightRun);

  const whoProvisionIndexes = steps.flatMap((step, index) => step.name === whoProvisionStepName ? [index] : []);
  assert.equal(whoProvisionIndexes.length, 1, "Static job must contain exactly one named WHO cache provision step");
  const whoProvisionIndex = whoProvisionIndexes[0];
  const whoProvision = steps[whoProvisionIndex];
  assert.equal(whoProvision.run, exactWhoProvisionScript, "WHO cache provision script must remain exact");
  assert.equal(Object.hasOwn(whoProvision, "if"), false, "WHO cache provision step must not be conditionally disabled");
  assert.equal(Object.hasOwn(whoProvision, "continue-on-error"), false, "WHO cache provision step must fail closed");
  const nodeGateIndex = stepIndex(steps, (step) => step.run === "npm run test:node", "Node test gate");
  const knowledgeGateIndex = stepIndex(steps, (step) => step.run === "npm run test:knowledge", "Knowledge test gate");
  const slice0Index = stepIndex(steps, (step) => step.run === "npm run slice0", "Slice 0 gate");
  assert.equal(whoProvisionIndex, nodeGateIndex + 1, "WHO cache provision must immediately follow the Node test gate");
  assert.equal(knowledgeGateIndex, whoProvisionIndex + 1, "Knowledge tests must immediately follow WHO cache provision");
  assert.ok(whoProvisionIndex < slice0Index, "WHO cache provision must precede Slice 0");

  let previousGateIndex = preflightIndex;
  for (const run of originalStaticGateRuns) {
    const matchingGates = steps.filter((step) => step.run === run);
    assert.equal(matchingGates.length, 1, `${run} must occur as exactly one mandatory static gate`);
    assertUnconditionalFailClosed(matchingGates[0], `Mandatory static gate ${run}`);
    const gateIndex = stepIndex(steps, (step) => step === matchingGates[0], run);
    assert.ok(gateIndex > previousGateIndex, `${run} is out of its original static-gate order`);
    previousGateIndex = gateIndex;
  }
  assert.ok(preflightIndex < stepIndex(steps, (step) => step.run === originalStaticGateRuns[0], "First install"));

  const collectorIndex = stepIndex(steps, (step) => step.run === exactStaticCollector, "Static evidence collector");
  assert.ok(collectorIndex > previousGateIndex, "Static evidence must be collected after all original gates");
  assertUnconditionalFailClosed(steps[collectorIndex], "Static evidence collector");
  const staticUploadIndexes = steps.flatMap((step, index) =>
    usesActionRepository(step, uploadArtifactRepository) ? [index] : []
  );
  assert.equal(staticUploadIndexes.length, 1, "Static job must contain exactly one artifact upload");
  const staticUploadIndex = staticUploadIndexes[0];
  const staticUpload = steps[staticUploadIndex];
  assert.equal(staticUpload.uses, uploadArtifactAction, "Static evidence upload action must remain pinned");
  assertUnconditionalFailClosed(staticUpload, "Static evidence upload");
  assert.ok(staticUploadIndex > collectorIndex, "Static evidence upload must follow the static evidence collector");
  const staticUploadPath = staticUpload.with?.path;
  assert.ok(typeof staticUploadPath === "string", "Static evidence upload path must be a string");
  assert.ok(staticUploadPath.split("\n").includes(".artifacts/static.json"), "Static evidence upload must retain static.json");
  assert.doesNotMatch(staticUploadPath, forbiddenStaticUploadPath, "Static evidence upload must not include raw or generated WHO data");
  assert.equal(staticUploadPath, exactStaticUploadPath, "Static evidence upload path must retain only the approved evidence and text bundles");
  assert.deepEqual(staticUpload.with, {
    name: `static-evidence-${exactHeadSha}`,
    path: exactStaticUploadPath,
    "if-no-files-found": "error",
  }, "Static evidence upload inputs must remain exact");

  for (const [jobName, workflowPath] of [["android-e2e", "./.github/workflows/e2e-android.yml"], ["ios-e2e", "./.github/workflows/e2e-ios.yml"]] as const) {
    const reusableJob = requiredJob(workflows.ci, jobName);
    assertUnconditionalFailClosed(reusableJob, `${jobName} reusable CI job`);
    assert.equal(reusableJob.needs, "static");
    assert.equal(reusableJob.uses, workflowPath);
    assert.equal(reusableJob.with?.expected_sha, exactHeadSha);
  }

  assertChildWorkflowPolicy(workflows.android, "android");
  assertChildWorkflowPolicy(workflows.ios, "ios");
}

// Mirrors parseScript() in the pinned action commit exactly.
function parsePinnedActionScript(rawScript: string) {
  return rawScript
    .trim()
    .split(/\r\n|\n|\r/)
    .map((value) => value.trim())
    .filter((value) => !value.startsWith("#") && value.length > 0);
}

const encodedDevClientUrl = "formobile-test://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081";
type NativePlatform = "Android" | "iOS";

const exactHeadlessMetroCommands: Record<NativePlatform, string> = {
  Android: 'CI=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 EXPO_UNSTABLE_BONJOUR=0 NODE_OPTIONS=--dns-result-order=ipv4first REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR=e2e npx --no-install expo start --dev-client --localhost --port 8081 > "$metro_log" 2>&1 &',
  iOS: "CI=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 EXPO_UNSTABLE_BONJOUR=0 NODE_OPTIONS=--dns-result-order=ipv4first REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR=e2e npx --no-install expo start --dev-client --localhost --port 8081 > /tmp/metro.log 2>&1 &",
};
const exactMetroStatusLines = [
  "for attempt in $(seq 1 60); do curl --silent --fail http://127.0.0.1:8081/status >/dev/null && break; sleep 2; done",
  "curl --silent --fail http://127.0.0.1:8081/status",
] as const;
const exactMetroNegativeProbeLines: Record<NativePlatform, string> = {
  Android: "  if curl --silent --fail http://127.0.0.1:8081/status >/dev/null; then",
  iOS: "if curl --silent --fail http://127.0.0.1:8081/status >/dev/null; then",
};
const exactDevClientUrlAssignment = `dev_client_url='${encodedDevClientUrl}'`;
const exactAndroidBuildCommand = "(cd android && ./gradlew :app:assembleDebug :app:assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon)";
const exactAndroidInstallCommand = '  install_output=$(adb -s "$emulator_serial" install --no-streaming -r android/app/build/outputs/apk/debug/app-debug.apk 2>&1)';
const exactAndroidPackageServiceLines = [
  "  for attempt in $(seq 1 60); do adb -s \"$emulator_serial\" shell service check package 2>/dev/null | tr -d '\\r' | grep -Fxq 'Service package: found' && break; sleep 2; done",
  "  adb -s \"$emulator_serial\" shell service check package 2>/dev/null | tr -d '\\r' | grep -Fxq 'Service package: found'",
] as const;
const exactAndroidPackageServiceCall = "wait_for_package_service";
const exactAndroidPackageServiceRetryCall = "    wait_for_package_service";
const exactAndroidInstallCall = "install_apk";
const exactAndroidTransientInstallClassifier = `  if grep -Eq -e "^(cmd: )?Can't find service: package$" -e '^(cmd: )?Failure calling service package: Broken pipe( \\([0-9]+\\))?$' <<< "\${install_output//$'\\r'/}"; then`;
const exactIosFailureScreenshotCommand = '    xcrun simctl io "$simulator_udid" screenshot .artifacts/launch/simulator/ios-failure.png';
const exactIosFailureLogCommand = `    xcrun simctl spawn "$simulator_udid" log show --style compact --last 15m --predicate 'process == "ForMobile" OR process == "SpringBoard"' > .artifacts/launch/simulator/ios-simulator-app.log 2>&1`;
const iosOpenConfirmationFlow = "e2e/maestro/ios-open-confirmation.yaml";
const readinessFlow = "e2e/maestro/shell-readiness.yaml";
const smokeFlow = "e2e/maestro/shell-smoke.yaml";
const exactAndroidMaestroTimeout = "60000";
const exactAndroidRunner = "ubuntu-latest";
const androidKvmStepName = "Enable KVM hardware acceleration";
const androidKvmLaunchProbeStepName = "Verify KVM immediately before emulator launch";
const exactAndroidKvmScript = `set -euo pipefail
test -c /dev/kvm
sudo chmod 0666 /dev/kvm
test -r /dev/kvm
test -w /dev/kvm
`;
const exactAndroidKvmLaunchProbeScript = `set -euo pipefail
test -c /dev/kvm
test -r /dev/kvm
test -w /dev/kvm
`;
const exactReadinessCommands: Record<NativePlatform, string> = {
  Android: `maestro --device "$emulator_serial" test --debug-output .artifacts/launch/maestro/android-readiness ${readinessFlow} 2>&1 | tee .artifacts/launch/android-readiness.log`,
  iOS: `maestro --device "$simulator_udid" test --debug-output .artifacts/launch/maestro/ios-readiness ${readinessFlow} 2>&1 | tee .artifacts/launch/ios-readiness.log`,
};
const exactAndroidOpenUrlCommand = 'adb -s "$emulator_serial" shell am start -a android.intent.action.VIEW -d "$dev_client_url" -p com.luyao618.formobile 2>&1 | tee -a .artifacts/launch/android-dev-client.log';
const exactIosOpenUrlCommand = 'xcrun simctl openurl "$simulator_udid" "$dev_client_url" 2>&1 | tee -a .artifacts/launch/ios-dev-client.log';
const exactIosConfirmationCommand = `maestro --device "$simulator_udid" test --debug-output .artifacts/launch/maestro/ios-open-confirmation ${iosOpenConfirmationFlow} 2>&1 | tee .artifacts/launch/ios-open-confirmation.log`;
const exactAndroidSmokeCommand = `maestro --device "$emulator_serial" test --debug-output .artifacts/launch/maestro/android-smoke ${smokeFlow} 2>&1 | tee .artifacts/test-results/android-maestro.attempt.log`;
const exactIosSmokeCommand = `maestro --device "$simulator_udid" test --debug-output .artifacts/launch/maestro/ios-smoke ${smokeFlow} 2>&1 | tee .artifacts/test-results/ios-maestro.attempt.log`;
const exactAndroidFailureScreenshotCommand = '    adb -s "$emulator_serial" exec-out screencap -p > .artifacts/launch/device/android-failure.png';
const exactAndroidFailureHierarchyCommand = '    adb -s "$emulator_serial" exec-out uiautomator dump /dev/tty > .artifacts/launch/device/android-ui-hierarchy.xml 2>&1';
const exactAndroidFailureSystemLogCommand = '    adb -s "$emulator_serial" logcat -b all -d > .artifacts/launch/device/android-system.log 2>&1';
const exactAndroidFailureLastAnrCommand = '    adb -s "$emulator_serial" shell dumpsys activity lastanr > .artifacts/launch/device/android-lastanr.txt 2>&1';
const exactAndroidFailureRootCommand = '    adb -s "$emulator_serial" root';
const exactAndroidFailureWaitForDeviceCommand = '    timeout 30s adb -s "$emulator_serial" wait-for-device';
const exactAndroidFailureAnrFilesCommand = "    adb -s \"$emulator_serial\" shell 'ls -la /data/anr; cat /data/anr/*' > .artifacts/launch/device/android-anr-files.txt 2>&1";
const exactAndroidFailurePidCommand = String.raw`    app_pid=$(adb -s "$emulator_serial" shell pidof -s com.luyao618.formobile 2>/dev/null | tr -d "\r")`;
const exactAndroidFailureLogCommand = '      adb -s "$emulator_serial" logcat -d --pid="$app_pid" > .artifacts/launch/device/android-app.log 2>&1';
const exactAndroidFallbackLogCommand = "      adb -s \"$emulator_serial\" logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V '*:S' > .artifacts/launch/device/android-app.log 2>&1";
const exactAndroidFailureDiagnosticCommands = [
  exactAndroidFailureScreenshotCommand,
  exactAndroidFailureHierarchyCommand,
  exactAndroidFailureSystemLogCommand,
  exactAndroidFailureLastAnrCommand,
  exactAndroidFailureRootCommand,
  exactAndroidFailureWaitForDeviceCommand,
  exactAndroidFailureAnrFilesCommand,
  exactAndroidFailurePidCommand,
  exactAndroidFailureLogCommand,
  exactAndroidFallbackLogCommand,
] as const;
const exactAndroidFailureDiagnosticPaths = [
  ".artifacts/launch/device/android-failure.png",
  ".artifacts/launch/device/android-ui-hierarchy.xml",
  ".artifacts/launch/device/android-system.log",
  ".artifacts/launch/device/android-lastanr.txt",
  ".artifacts/launch/device/android-anr-files.txt",
  ".artifacts/launch/device/android-app.log",
] as const;
const exactPinnedSimulatorOpenLine = 'open "$DEVELOPER_DIR/Applications/Simulator.app" --args -CurrentDeviceUDID "$simulator_udid"';

const exactIosOpenConfirmationFlow = `appId: com.luyao618.formobile
---
- runFlow:
    when:
      visible: '^Open in .For Mobile.\\?$'
    commands:
      - tapOn:
          point: '69%,54%'
          label: 'Tap the right-side Open button in the iOS confirmation alert'
      - runFlow:
          when:
            visible: '^Open in .For Mobile.\\?$'
          commands:
            - tapOn:
                point: '69%,54%'
                label: 'Retry the right-side Open button'
      - assertNotVisible: '^Open in .For Mobile.\\?$'
`;

const exactReadinessFlow = `appId: com.luyao618.formobile
---
- extendedWaitUntil:
    visible: "照护空间尚未设置"
    timeout: 120000
`;

const exactSmokeFlow = `appId: com.luyao618.formobile
---
- launchApp
- assertVisible: "照护空间尚未设置"
- tapOn: "记录"
- assertVisible: "还没有照护记录"
- tapOn: "成长"
- assertVisible: "还没有可展示的成长数据"
- tapOn: "相册"
- assertVisible: "还没有照片"
- tapOn: "我的"
- assertVisible: "宝宝资料"
- tapOn: "管家"
- assertVisible: "照护空间尚未设置"
`;

function assertExactHeadlessMetroLaunch(script: string, platform: NativePlatform): void {
  const launchLines = script.split("\n").filter((line) => line.includes("expo start"));
  assert.deepEqual(
    launchLines,
    [exactHeadlessMetroCommands[platform]],
    `${platform} Metro launch must remain the exact loopback-only fail-closed headless command`,
  );
}

function assertExactMetroStatusProbes(script: string, platform: NativePlatform): void {
  const statusLines = script.split(/\r\n|\n|\r/).filter((line) => line.includes("/status"));
  assert.deepEqual(
    statusLines,
    [...exactMetroStatusLines, exactMetroNegativeProbeLines[platform]],
    `${platform} Metro status probes must remain exactly the bounded retry loop, final IPv4 probe, and offline negative probe in order`,
  );
}

function assertExactMetroStartupPolicy(script: string, platform: NativePlatform): void {
  assertExactHeadlessMetroLaunch(script, platform);
  assertExactMetroStatusProbes(script, platform);
  const lines = script.split(/\r\n|\n|\r/);
  const devClientUrlAssignments = lines.filter((line) => line.includes("dev_client_url="));
  assert.deepEqual(
    devClientUrlAssignments,
    [exactDevClientUrlAssignment],
    `${platform} dev-client URL assignment must appear exactly once as the exact full line`,
  );
  const launchIndex = lines.indexOf(exactHeadlessMetroCommands[platform]);
  const retryIndex = lines.indexOf(exactMetroStatusLines[0]);
  const finalProbeIndex = lines.indexOf(exactMetroStatusLines[1]);
  const devClientUrlIndex = lines.indexOf(exactDevClientUrlAssignment);
  assert.ok(
    launchIndex < retryIndex && retryIndex < finalProbeIndex && finalProbeIndex < devClientUrlIndex,
    `${platform} Metro startup must preserve exact launch, retry loop, final probe, and dev-client URL assignment order`,
  );
}

function assertMetroProcessGroupPolicy(script: string, platform: NativePlatform): void {
  const lines = script.split(/\r\n|\n|\r/);
  const launchIndex = lines.indexOf(exactHeadlessMetroCommands[platform]);
  assert.ok(launchIndex > 0, `${platform} Metro launch is absent`);
  assert.deepEqual(
    lines.slice(launchIndex - 1, launchIndex + 3),
    ["set -m", exactHeadlessMetroCommands[platform], "metro_pid=$!", "set +m"],
    `${platform} Metro must start as a monitored Bash process group`,
  );
  assert.deepEqual(
    lines.filter((line) => line.trim().startsWith("kill ")).map((line) => line.trim()),
    ['kill -- "-$metro_pid" 2>/dev/null', 'kill -- "-$metro_pid"'],
    `${platform} Metro teardown must signal the complete process group in cleanup and the offline transition`,
  );
}

function assertExactReadinessCommand(script: string, platform: NativePlatform): void {
  const readinessLines = script.split("\n").filter((line) => line.includes(readinessFlow));
  assert.deepEqual(
    readinessLines,
    [exactReadinessCommands[platform]],
    `${platform} readiness must appear exactly once as the exact fail-closed command`,
  );
}

function assertExactAndroidUrlHandoff(script: string): void {
  const lines = script.split(/\r\n|\n|\r/);
  const launchLines = lines.filter((line) => /\badb\b.*\bshell\b.*\bam\b.*\bstart\b/.test(line));
  assert.deepEqual(
    launchLines,
    [exactAndroidOpenUrlCommand],
    "Android deep-link handoff must be the exact non-waiting am start command",
  );
  assert.deepEqual(
    lines.filter((line) => /\bgrep\b.*Status:/.test(line)),
    [],
    "Android launch must not gate on textual am start status",
  );
  const urlIndex = lines.indexOf(exactDevClientUrlAssignment);
  const launchIndex = lines.indexOf(exactAndroidOpenUrlCommand);
  const readinessIndex = lines.indexOf(exactReadinessCommands.Android);
  assert.ok(
    urlIndex < launchIndex && launchIndex < readinessIndex,
    "Android must assign the URL, issue non-waiting am start, then fail closed on Maestro readiness",
  );
}

function assertExactAndroidInstallPolicy(script: string): void {
  const installLines = script.split(/\r\n|\n|\r/).filter((line) => !/^\s*#/.test(line) && /\badb\b.*\binstall\b/.test(line));
  assert.deepEqual(
    installLines,
    [exactAndroidInstallCommand],
    "Android runner must contain exactly one captured --no-streaming -r install command",
  );
  assert.match(script, /printf '%s\\n' "\$install_output"/);
  assert.deepEqual(
    script.split(/\r\n|\n|\r/).filter((line) => line.includes("grep -Eq")),
    [exactAndroidTransientInstallClassifier],
    "Android retry classification must remain pipeline-free, CR-tolerant, and match only exact transport-failure lines",
  );
}

function assertExactAndroidPackageServicePolicy(script: string): void {
  const lines = script.split(/\r\n|\n|\r/);
  const packageServiceLines = lines.filter((line) => line.includes("service check package"));
  assert.deepEqual(
    packageServiceLines,
    exactAndroidPackageServiceLines,
    "Android package service readiness must remain the exact bounded loop and final fail-closed probe",
  );
  assert.deepEqual(
    lines.filter((line) => line.trim() === exactAndroidPackageServiceCall),
    [exactAndroidPackageServiceCall, exactAndroidPackageServiceRetryCall],
    "Android must call the bounded package-service wait initially and before the sole transient retry",
  );
  const trapIndex = lines.indexOf("trap cleanup EXIT");
  const initialWaitIndex = lines.indexOf(exactAndroidPackageServiceCall);
  const firstInstallIndex = lines.indexOf(`if ! ${exactAndroidInstallCall}; then`);
  const retryWaitIndex = lines.indexOf(exactAndroidPackageServiceRetryCall);
  const retryInstallIndex = lines.indexOf(`    ${exactAndroidInstallCall}`);
  assert.ok(
    trapIndex < initialWaitIndex && initialWaitIndex < firstInstallIndex && firstInstallIndex < retryWaitIndex && retryWaitIndex < retryInstallIndex,
    "Android must register cleanup, wait before the first install, and wait again before the sole retry",
  );
}

function assertExactAndroidRunnerSha256(script: string): void {
  assert.equal(
    createHash("sha256").update(script).digest("hex"),
    exactAndroidRunnerSha256,
    "Android runner bytes must match the reviewed SHA-256",
  );
}

function assertAndroidDiagnosticsPolicy(script: string, workflow: Workflow): void {
  const job = requiredJob(workflow, "android");
  assert.deepEqual(
    job.env,
    { MAESTRO_DRIVER_STARTUP_TIMEOUT: exactAndroidMaestroTimeout },
    "Android Maestro driver startup timeout must remain exactly bounded at 60000ms",
  );
  const lines = script.split(/\r\n|\n|\r/);
  assert.equal(
    lines.filter((line) => line === "cleanup() {").length,
    1,
    "Android runner must contain exactly one cleanup definition",
  );
  assert.equal(
    lines.filter((line) => line === "trap cleanup EXIT").length,
    1,
    "Android runner must contain exactly one EXIT trap registration",
  );
  const maestroLines = lines.filter((line) => /(^|\s)maestro(?:\s|$)/.test(line));
  assert.deepEqual(
    maestroLines,
    [exactReadinessCommands.Android, exactAndroidSmokeCommand],
    "Android Maestro commands must remain the two exact non-retried readiness and smoke commands",
  );
  assert.deepEqual(
    lines.filter((line) => line.includes("sleep ")),
    [exactAndroidPackageServiceLines[0], exactMetroStatusLines[0]],
    "Android runner must retain only the two existing bounded service sleeps",
  );
  assert.doesNotMatch(
    script,
    /\bforce-stop\b|(?:^|\s)input\s+(?:tap|keyevent)(?:\s|$)|android:id\/aerr_(?:close|wait)|Quickstep isn't responding/m,
    "Android runner must not dismiss ANR dialogs or force-stop the launcher",
  );
  const cleanupStart = lines.indexOf("cleanup() {");
  const cleanupEnd = lines.indexOf("trap cleanup EXIT", cleanupStart + 1);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "Android cleanup function and EXIT trap must remain exact");
  const actualDiagnosticCommands = lines
    .slice(cleanupStart, cleanupEnd)
    .filter((line) => line.includes('adb -s "$emulator_serial"'));
  assert.deepEqual(
    actualDiagnosticCommands,
    exactAndroidFailureDiagnosticCommands,
    "Android failure diagnostic command inventory must remain exact and ordered",
  );
  const cleanupLines = [
    "cleanup() {",
    "  status=$?",
    "  trap - EXIT",
    "  set +e",
    '  if [ "$status" -ne 0 ]; then',
    exactAndroidFailureScreenshotCommand,
    exactAndroidFailureHierarchyCommand,
    exactAndroidFailureSystemLogCommand,
    exactAndroidFailureLastAnrCommand,
    exactAndroidFailureRootCommand,
    exactAndroidFailureWaitForDeviceCommand,
    exactAndroidFailureAnrFilesCommand,
    exactAndroidFailurePidCommand,
    '    if [ -n "$app_pid" ]; then',
    exactAndroidFailureLogCommand,
    "    else",
    exactAndroidFallbackLogCommand,
    "    fi",
    "  fi",
    '  if [ -n "$metro_pid" ]; then',
    '    kill -- "-$metro_pid" 2>/dev/null',
    '    wait "$metro_pid" 2>/dev/null',
    "  fi",
    '  if [ -f "$metro_log" ]; then',
    '    cat "$metro_log"',
    "  fi",
    '  exit "$status"',
    "}",
    "trap cleanup EXIT",
  ];
  assert.deepEqual(
    lines.slice(cleanupStart, cleanupEnd + 1),
    cleanupLines,
    "Android cleanup must preserve exact status, failure diagnostics, teardown, retained Metro log, and exit order",
  );
  const diagnosticUploads = requiredSteps(job, "android")
    .filter((step) => step.with?.name === `android-e2e-diagnostics-${expectedShaInput}`);
  assert.equal(diagnosticUploads.length, 1, "Android must retain exactly one diagnostics upload");
  const upload = diagnosticUploads[0];
  assert.equal(upload.if, "always()", "Android diagnostics upload must run after failure");
  assert.equal(upload.with?.path, ".artifacts/launch/**\n.artifacts/test-results/**\n");
  assert.equal(upload.with?.["include-hidden-files"], true, "Android diagnostics upload must retain hidden Maestro files");
}

function assertExactIosUrlHandoff(script: string): void {
  const lines = script.split(/\r\n|\n|\r/);
  const openUrlLines = lines.filter((line) => line.includes("simctl openurl"));
  assert.deepEqual(
    openUrlLines,
    [exactIosOpenUrlCommand, exactIosOpenUrlCommand],
    "iOS must contain exactly two identical exact simctl openurl commands",
  );
  const confirmationLines = lines.filter((line) => line.includes(iosOpenConfirmationFlow));
  assert.deepEqual(
    confirmationLines,
    [exactIosConfirmationCommand, exactIosConfirmationCommand],
    "iOS confirmation must appear exactly twice as the exact fail-closed command",
  );
  const smokeLines = lines.filter((line) => line.includes(smokeFlow));
  assert.deepEqual(smokeLines, [exactIosSmokeCommand], "iOS smoke must remain one exact fail-closed command");

  const assignmentIndex = lines.indexOf(exactDevClientUrlAssignment);
  const firstOpenIndex = lines.indexOf(exactIosOpenUrlCommand);
  const firstConfirmationIndex = lines.indexOf(exactIosConfirmationCommand);
  const secondOpenIndex = lines.lastIndexOf(exactIosOpenUrlCommand);
  const secondConfirmationIndex = lines.lastIndexOf(exactIosConfirmationCommand);
  const readinessIndex = lines.indexOf(exactReadinessCommands.iOS);
  const smokeIndex = lines.indexOf(exactIosSmokeCommand);
  assert.ok(
    assignmentIndex < firstOpenIndex
      && firstOpenIndex < firstConfirmationIndex
      && firstConfirmationIndex < secondOpenIndex
      && secondOpenIndex < secondConfirmationIndex
      && secondConfirmationIndex < readinessIndex
      && readinessIndex < smokeIndex,
    "iOS handoff must preserve assignment, open, confirmation, open, confirmation, readiness, and smoke order",
  );
}

function assertIosFailureDiagnosticsPolicy(script: string, workflow: Workflow): void {
  const lines = script.split(/\r\n|\n|\r/);
  const diagnosticLines = lines.filter((line) => /^\s*xcrun\s+simctl\s+(?:io|spawn)(?:\s|$)/.test(line));
  assert.deepEqual(
    diagnosticLines,
    [exactIosFailureScreenshotCommand, exactIosFailureLogCommand],
    "iOS executable simctl io/spawn command inventory must exactly match the approved diagnostics in order",
  );
  const cleanupLines = [
    "cleanup() {",
    "  status=$?",
    "  trap - EXIT",
    "  set +e",
    '  if [ "$status" -ne 0 ]; then',
    exactIosFailureScreenshotCommand,
    exactIosFailureLogCommand,
    "  fi",
    '  if [ -n "$metro_pid" ]; then',
    '    kill -- "-$metro_pid" 2>/dev/null',
    '    wait "$metro_pid" 2>/dev/null',
    "  fi",
    "  cat /tmp/metro.log",
    '  exit "$status"',
    "}",
    "trap cleanup EXIT",
  ];
  const cleanupStart = lines.indexOf("cleanup() {");
  const cleanupEnd = lines.indexOf("trap cleanup EXIT", cleanupStart + 1);
  assert.deepEqual(
    lines.slice(cleanupStart, cleanupEnd + 1),
    cleanupLines,
    "iOS cleanup must preserve exact status-preserving diagnostic and teardown order",
  );
  const steps = requiredSteps(requiredJob(workflow, "ios"), "ios");
  const diagnosticUploads = steps.filter((step) => step.with?.name === `ios-e2e-diagnostics-${expectedShaInput}`);
  assert.equal(diagnosticUploads.length, 1, "iOS must retain exactly one diagnostics upload");
  const upload = diagnosticUploads[0];
  assert.equal(upload.if, "always()", "iOS diagnostics upload must run after failure");
  assert.equal(upload.with?.path, ".artifacts/launch/**\n.artifacts/test-results/**\n");
  assert.equal(upload.with?.["include-hidden-files"], true, "iOS diagnostics upload must retain hidden Maestro files");
}

function assertExactPinnedSimulatorOpen(script: string): void {
  const simulatorOpenLines = script.split("\n").filter((line) => line.includes("-CurrentDeviceUDID"));
  assert.deepEqual(
    simulatorOpenLines,
    [exactPinnedSimulatorOpenLine],
    "iOS must open the pinned Xcode Simulator app on the exact selected UDID",
  );
}

function assertIosOpenConfirmationFlow(flow: string): void {
  assert.equal(flow, exactIosOpenConfirmationFlow, "iOS open-confirmation flow bytes must remain exact");
}

test("pinned Android action receives exactly one Bash command and the runner is valid ordered Bash", async () => {
  const [workflow, runner] = await Promise.all([
    readFile(".github/workflows/e2e-android.yml", "utf8"),
    readFile("scripts/e2e/run-android-emulator.sh", "utf8"),
  ]);
  const parsedWorkflow = parseWorkflow(workflow, ".github/workflows/e2e-android.yml");
  const commands = parsePinnedActionScript(pinnedAndroidActionScript(parsedWorkflow));
  assert.deepEqual(commands, ["bash scripts/e2e/run-android-emulator.sh"]);
  assert.equal(spawnSync("bash", ["-n", "scripts/e2e/run-android-emulator.sh"]).status, 0);
  assert.match(runner, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
  assertExactAndroidRunnerSha256(runner);
  assertExactMetroStartupPolicy(runner, "Android");
  assertMetroProcessGroupPolicy(runner, "Android");
  assertExactReadinessCommand(runner, "Android");
  assertExactAndroidUrlHandoff(runner);
  assertExactAndroidPackageServicePolicy(runner);
  assertExactAndroidInstallPolicy(runner);
  assertAndroidDiagnosticsPolicy(runner, parsedWorkflow);
  assert.equal(runner.includes("gradlew"), false, "Android runner must not build while the emulator is live");
  assert.equal(
    workflow.split(/\r\n|\n|\r/).filter((line) => line.trim() === exactAndroidBuildCommand).length,
    1,
    "Android workflow must contain exactly one pre-emulator x86_64 E2E build",
  );
  ordered(runner,
    "mapfile -t emulator_serials",
    'emulator_serial="${emulator_serials[0]}"',
    "metro_log=.artifacts/launch/metro/android-metro.log",
    "metro_pid=",
    "trap cleanup EXIT",
    exactAndroidPackageServiceCall,
    `if ! ${exactAndroidInstallCall}; then`,
    exactAndroidPackageServiceRetryCall,
    `    ${exactAndroidInstallCall}`,
    'adb -s "$emulator_serial" reverse tcp:8081 tcp:8081',
    exactHeadlessMetroCommands.Android,
    exactDevClientUrlAssignment,
    exactAndroidOpenUrlCommand,
    exactReadinessCommands.Android,
    exactAndroidSmokeCommand,
    "mv .artifacts/test-results/android-maestro.attempt.log .artifacts/test-results/android-maestro.log",
  );
});

test("Android deep-link handoff rejects waiting, textual status gates, and hostile readiness ordering", async () => {
  const runner = await readFile("scripts/e2e/run-android-emulator.sh", "utf8");
  const hostileMutations = [
    runner.replace(" shell am start -a ", " shell am start -W -a "),
    runner.replace(`${exactAndroidOpenUrlCommand}\n`, `${exactAndroidOpenUrlCommand}\ngrep -q '^Status: ok' .artifacts/launch/android-dev-client.log\n`),
    runner.replace(
      `${exactAndroidOpenUrlCommand}\n${exactReadinessCommands.Android}`,
      `${exactReadinessCommands.Android}\n${exactAndroidOpenUrlCommand}`,
    ),
  ];
  for (const mutatedRunner of hostileMutations) {
    assert.notEqual(mutatedRunner, runner, "hostile Android launch fixture must change the runner");
    assert.throws(() => assertExactAndroidUrlHandoff(mutatedRunner));
  }
});

test("Android runner lock and cleanup cardinality reject hostile whole-file mutations", async () => {
  const [runner, workflowSource] = await Promise.all([
    readFile("scripts/e2e/run-android-emulator.sh", "utf8"),
    readFile(".github/workflows/e2e-android.yml", "utf8"),
  ]);
  const workflow = parseWorkflow(workflowSource, ".github/workflows/e2e-android.yml");

  const duplicateCleanup = `${runner}cleanup() {
  :
}
`;
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(duplicateCleanup, workflow),
    /exactly one cleanup definition/,
  );

  const duplicateExitTrap = `${runner}trap cleanup EXIT
`;
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(duplicateExitTrap, workflow),
    /exactly one EXIT trap registration/,
  );

  const hostileMutations = [
    ["later cleanup redefinition", `${runner}cleanup () { :; }
`],
    ["later EXIT trap override", `${runner}trap ':' EXIT
`],
    ["quote joining", runner.replace("mkdir -p", "m''kdir -p")],
    ["line continuation", runner.replace("mkdir -p", "mkdir " + "\\\n" + "  -p")],
    ["comment insertion", runner.replace("mkdir -p", "# hostile mutation\nmkdir -p")],
    ["arbitrary line insertion", `${runner}printf '%s\n' hostile-mutation >/dev/null
`],
  ] as const;
  for (const [label, mutatedRunner] of hostileMutations) {
    assert.notEqual(mutatedRunner, runner, `${label} fixture must change the runner bytes`);
    assert.throws(
      () => assertExactAndroidRunnerSha256(mutatedRunner),
      /must match the reviewed SHA-256/,
      label,
    );
  }
});

async function runAndroidTransientInstallHarness(firstFailure: string, secondFailure?: string) {
  const root = await mkdtemp(join(tmpdir(), "g018-android-transient-install-"));
  const fakeBin = join(root, "bin");
  const adbLog = join(root, "adb.log");
  const installCount = join(root, "install-count");
  const firstInstallOutput = join(root, "first-install-output.log");
  const downstreamLog = join(root, "downstream.log");
  const bashEnv = join(root, "bash-env");
  await mkdir(fakeBin);
  await writeFile(adbLog, "");
  await writeFile(installCount, "0\n");
  await writeFile(firstInstallOutput, `${firstFailure}\n`);
  await writeFile(downstreamLog, "");
  await writeFile(bashEnv, `mapfile() {
  test "$1" = "-t"
  local array_name="$2"
  local values=()
  local line
  while IFS= read -r line; do values[\${#values[@]}]="$line"; done
  eval "$array_name=(\\"\${values[@]}\\")"
}
`);
  await writeFile(join(fakeBin, "adb"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ANDROID_ADB_LOG"
if [ "\${1:-}" = "devices" ]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice\\n'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "install" ]; then
  count=$(cat "$ANDROID_INSTALL_COUNT")
  count=$((count + 1))
  printf '%s\\n' "$count" > "$ANDROID_INSTALL_COUNT"
  if [ "$count" -eq 1 ]; then
    cat "$ANDROID_FIRST_INSTALL_OUTPUT" >&2
    exit 1
  fi
  ${secondFailure === undefined ? "printf '%s\\n' 'Success'" : `printf '%s\\n' ${JSON.stringify(secondFailure)} >&2\n  exit 1`}
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "service" ]; then
  printf '%s\\r\\n' 'Service package: found'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "am" ] && [ "\${5:-}" = "start" ]; then
  printf '%s\\n' 'Status: timeout'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "exec-out" ] && [ "\${4:-}" = "screencap" ]; then
  printf 'png-sentinel'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "exec-out" ] && [ "\${4:-}" = "uiautomator" ]; then
  printf 'hierarchy-sentinel'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "pidof" ]; then
  :
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "logcat" ]; then
  printf 'logcat-sentinel'
fi
`);
  await writeFile(join(fakeBin, "curl"), "#!/usr/bin/env bash\nexit 0\n");
  for (const command of ["npx", "maestro"]) {
    await writeFile(join(fakeBin, command), `#!/usr/bin/env bash
printf '%s %s\\n' ${JSON.stringify(command)} "$*" >> "$ANDROID_DOWNSTREAM_LOG"
exit 97
`);
  }
  await Promise.all([
    chmod(join(fakeBin, "adb"), 0o755),
    chmod(join(fakeBin, "curl"), 0o755),
    chmod(join(fakeBin, "npx"), 0o755),
    chmod(join(fakeBin, "maestro"), 0o755),
  ]);
  const result = spawnSync("bash", [resolve("scripts/e2e/run-android-emulator.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ANDROID_ADB_LOG: adbLog,
      ANDROID_FIRST_INSTALL_OUTPUT: firstInstallOutput,
      ANDROID_INSTALL_COUNT: installCount,
      ANDROID_DOWNSTREAM_LOG: downstreamLog,
      BASH_ENV: bashEnv,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  return { root, adbLog, downstreamLog, result };
}

test("Android am start timeout text remains nonblocking until bounded Maestro readiness", async () => {
  const harness = await runAndroidTransientInstallHarness("Failure calling service package: Broken pipe (32)");
  try {
    assert.equal(harness.result.status, 97, "am start timeout text must reach the deliberately failing Maestro readiness stub");
    assert.match(harness.result.stdout, /Status: timeout/);
    const adbCalls = (await readFile(harness.adbLog, "utf8")).trim().split("\n");
    assert.equal(
      adbCalls.filter((call) => call.includes(" shell am start ")).at(0),
      '-s emulator-5554 shell am start -a android.intent.action.VIEW -d formobile-test://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081 -p com.luyao618.formobile',
    );
    assert.match(await readFile(harness.downstreamLog, "utf8"), /maestro --device emulator-5554 test --debug-output .*android-readiness/);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("Android retries one broken package transport install after renewed readiness and then continues", async () => {
  const harness = await runAndroidTransientInstallHarness("Failure calling service package: Broken pipe (32)");
  try {
    assert.equal(harness.result.status, 97, "successful retry must reach the deliberately failing Maestro stub");
    assert.match(harness.result.stdout, /Failure calling service package: Broken pipe \(32\)\nSuccess/);
    const adbCalls = (await readFile(harness.adbLog, "utf8")).trim().split("\n");
    assert.equal(adbCalls.filter((call) => call === "-s emulator-5554 shell service check package").length, 4);
    assert.equal(adbCalls.filter((call) => call.includes(" install ")).length, 2);
    assert.equal(adbCalls.filter((call) => call === "-s emulator-5554 reverse tcp:8081 tcp:8081").length, 1);
    assert.match(await readFile(harness.downstreamLog, "utf8"), /maestro --device emulator-5554 test --debug-output .*android-readiness/);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("Android retries both exact package transport lines with the adb cmd prefix", async () => {
  for (const transportFailure of [
    "cmd: Can't find service: package",
    "cmd: Failure calling service package: Broken pipe (32)",
  ]) {
    const harness = await runAndroidTransientInstallHarness(transportFailure);
    try {
      assert.equal(harness.result.status, 97, `${transportFailure} must retry and continue`);
      const adbCalls = (await readFile(harness.adbLog, "utf8")).trim().split("\n");
      assert.equal(adbCalls.filter((call) => call.includes(" install ")).length, 2);
      assert.equal(adbCalls.filter((call) => call === "-s emulator-5554 reverse tcp:8081 tcp:8081").length, 1);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  }
});

test("Android retries an exact transport line followed by a large benign diagnostic", async () => {
  const largeDiagnostic = `diagnostic: ${"x".repeat(512 * 1024)}`;
  const harness = await runAndroidTransientInstallHarness(
    `Failure calling service package: Broken pipe (32)\n${largeDiagnostic}`,
  );
  try {
    assert.equal(harness.result.status, 97, "large output after an exact transport line must still retry and continue");
    assert.match(harness.result.stdout, /Failure calling service package: Broken pipe \(32\)\ndiagnostic: x+/);
    const adbCalls = (await readFile(harness.adbLog, "utf8")).trim().split("\n");
    assert.equal(adbCalls.filter((call) => call.includes(" install ")).length, 2);
    assert.equal(adbCalls.filter((call) => call === "-s emulator-5554 reverse tcp:8081 tcp:8081").length, 1);
    assert.match(await readFile(harness.downstreamLog, "utf8"), /maestro --device emulator-5554 test --debug-output .*android-readiness/);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("Android stops after a second transient package transport install failure", async () => {
  const harness = await runAndroidTransientInstallHarness(
    "Can't find service: package",
    "Failure calling service package: Broken pipe (32)",
  );
  try {
    assert.notEqual(harness.result.status, 0);
    assert.match(harness.result.stdout, /Can't find service: package\nFailure calling service package: Broken pipe \(32\)/);
    const adbCalls = (await readFile(harness.adbLog, "utf8")).trim().split("\n");
    assert.equal(adbCalls.filter((call) => call === "-s emulator-5554 shell service check package").length, 4);
    assert.equal(adbCalls.filter((call) => call.includes(" install ")).length, 2);
    assert.equal(adbCalls.some((call) => call.includes(" reverse ")), false);
    assert.equal(await readFile(harness.downstreamLog, "utf8"), "");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("Android does not retry transport-signature supersets or content failures", async () => {
  const terminalFailures = [
    "Can't find service: package manager unavailable",
    "Failure calling service package: Broken pipeline parser",
    "Failure [INSTALL_FAILED_INVALID_APK]: Can't find service: package metadata",
    "cmd:  Can't find service: package",
    "cmd: cmd: Failure calling service package: Broken pipe (32)",
    "cmd: Failure calling service package: Broken pipe (32) trailing diagnostic",
  ];
  for (const terminalFailure of terminalFailures) {
    const harness = await runAndroidTransientInstallHarness(terminalFailure);
    try {
      assert.notEqual(harness.result.status, 0, `${terminalFailure} must fail closed`);
      assert.match(harness.result.stdout, new RegExp(terminalFailure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const adbCalls = (await readFile(harness.adbLog, "utf8")).trim().split("\n");
      assert.equal(adbCalls.filter((call) => call.includes(" install ")).length, 1, `${terminalFailure} must not retry`);
      assert.equal(adbCalls.some((call) => call.includes(" reverse ")), false, `${terminalFailure} must stop before reverse`);
      assert.equal(await readFile(harness.downstreamLog, "utf8"), "", `${terminalFailure} must stop before downstream execution`);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  }
});

test("Android invalid APK install fails once before reverse, Metro, or Maestro", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-android-install-"));
  try {
    const fakeBin = join(root, "bin");
    const adbLog = join(root, "adb.log");
    const downstreamLog = join(root, "downstream.log");
    const bashEnv = join(root, "bash-env");
    await mkdir(fakeBin);
    await writeFile(adbLog, "");
    await writeFile(downstreamLog, "");
    await writeFile(bashEnv, `mapfile() {
  test "$1" = "-t"
  local array_name="$2"
  local values=()
  local line
  while IFS= read -r line; do values[\${#values[@]}]="$line"; done
  eval "$array_name=(\\"\${values[@]}\\")"
}
`);
    await writeFile(join(fakeBin, "adb"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ANDROID_ADB_LOG"
if [ "\${1:-}" = "devices" ]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice\\n'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "install" ]; then
  printf '%s\\n' 'Failure [INSTALL_FAILED_INVALID_APK]' >&2
  exit 1
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "service" ]; then
  printf '%s\\r\\n' 'Service package: found'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "exec-out" ] && [ "\${4:-}" = "screencap" ]; then
  printf 'png-sentinel'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "exec-out" ] && [ "\${4:-}" = "uiautomator" ]; then
  printf 'hierarchy-sentinel'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "pidof" ]; then
  :
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "logcat" ]; then
  printf 'logcat-sentinel'
fi
`);
    for (const command of ["npx", "maestro"]) {
      await writeFile(join(fakeBin, command), `#!/usr/bin/env bash
printf '%s %s\\n' ${JSON.stringify(command)} "$*" >> "$ANDROID_DOWNSTREAM_LOG"
exit 97
`);
    }
    await Promise.all([
      chmod(join(fakeBin, "adb"), 0o755),
      chmod(join(fakeBin, "npx"), 0o755),
      chmod(join(fakeBin, "maestro"), 0o755),
    ]);

    const result = spawnSync("bash", [resolve("scripts/e2e/run-android-emulator.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ANDROID_ADB_LOG: adbLog,
        ANDROID_DOWNSTREAM_LOG: downstreamLog,
        BASH_ENV: bashEnv,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(result.status, 0, "invalid APK install must fail closed");
    assert.match(result.stdout, /Failure \[INSTALL_FAILED_INVALID_APK\]/);
    const adbCalls = (await readFile(adbLog, "utf8")).trim().split("\n");
    assert.equal(adbCalls[0], "devices");
    assert.equal(adbCalls.filter((call) => call === "-s emulator-5554 shell service check package").length, 2);
    assert.equal(adbCalls.filter((call) => call.includes(" install ")).length, 1);
    assert.equal(adbCalls.some((call) => call.includes(" reverse ")), false);
    assert.equal(await readFile(downstreamLog, "utf8"), "", "Metro and Maestro must not be reached");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-failure.png"), "utf8"), "png-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-ui-hierarchy.xml"), "utf8"), "hierarchy-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-app.log"), "utf8"), "logcat-sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android unavailable package service exhausts the bounded wait before install", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-android-package-service-"));
  try {
    const fakeBin = join(root, "bin");
    const adbLog = join(root, "adb.log");
    const downstreamLog = join(root, "downstream.log");
    const sleepLog = join(root, "sleep.log");
    const bashEnv = join(root, "bash-env");
    await mkdir(fakeBin);
    await writeFile(adbLog, "");
    await writeFile(downstreamLog, "");
    await writeFile(sleepLog, "");
    await writeFile(bashEnv, `mapfile() {
  test "$1" = "-t"
  local array_name="$2"
  local values=()
  local line
  while IFS= read -r line; do values[\${#values[@]}]="$line"; done
  eval "$array_name=(\\"\${values[@]}\\")"
}
`);
    await writeFile(join(fakeBin, "adb"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$ANDROID_ADB_LOG"
if [ "\${1:-}" = "devices" ]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice\\n'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "service" ]; then
  printf '%s\\n' 'Service package: not found'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "exec-out" ] && [ "\${4:-}" = "screencap" ]; then
  printf 'png-sentinel'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "exec-out" ] && [ "\${4:-}" = "uiautomator" ]; then
  printf 'hierarchy-sentinel'
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "pidof" ]; then
  :
elif [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "logcat" ]; then
  printf 'logcat-sentinel'
fi
`);
    await writeFile(join(fakeBin, "sleep"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ANDROID_SLEEP_LOG"
`);
    for (const command of ["npx", "maestro"]) {
      await writeFile(join(fakeBin, command), `#!/usr/bin/env bash
printf '%s %s\\n' ${JSON.stringify(command)} "$*" >> "$ANDROID_DOWNSTREAM_LOG"
exit 97
`);
    }
    await Promise.all([
      chmod(join(fakeBin, "adb"), 0o755),
      chmod(join(fakeBin, "sleep"), 0o755),
      chmod(join(fakeBin, "npx"), 0o755),
      chmod(join(fakeBin, "maestro"), 0o755),
    ]);

    const result = spawnSync("bash", [resolve("scripts/e2e/run-android-emulator.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ANDROID_ADB_LOG: adbLog,
        ANDROID_DOWNSTREAM_LOG: downstreamLog,
        ANDROID_SLEEP_LOG: sleepLog,
        BASH_ENV: bashEnv,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    assert.notEqual(result.status, 0, "missing package service must fail closed");
    const adbCalls = (await readFile(adbLog, "utf8")).trim().split("\n");
    assert.equal(adbCalls.filter((call) => call === "-s emulator-5554 shell service check package").length, 61);
    assert.equal(adbCalls.filter((call) => call.includes(" install ")).length, 0);
    assert.equal(adbCalls.some((call) => call.includes(" reverse ")), false);
    assert.equal((await readFile(sleepLog, "utf8")).trim().split("\n").filter((call) => call === "2").length, 60);
    assert.equal(await readFile(downstreamLog, "utf8"), "", "Metro and Maestro must not be reached");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-failure.png"), "utf8"), "png-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-ui-hierarchy.xml"), "utf8"), "hierarchy-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-app.log"), "utf8"), "logcat-sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android EXIT cleanup preserves success and failure status with failure-only diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-android-exit-"));
  try {
    const runner = await readFile("scripts/e2e/run-android-emulator.sh", "utf8");
    const start = runner.indexOf("cleanup() {");
    const end = runner.indexOf("trap cleanup EXIT", start);
    assert.ok(start >= 0 && end > start, "Android cleanup function and EXIT trap must be extractable");
    const cleanup = runner.slice(start, end + "trap cleanup EXIT".length);
    const adbLog = join(root, "adb.log");
    const runCleanup = async (
      status: number,
      appPid = "",
      options: { failCommand?: string; metroPid?: string; metroLogPresent?: boolean; timeoutStatus?: number } = {},
    ) => {
      const { failCommand = "", metroPid = "424242", metroLogPresent = true, timeoutStatus = 0 } = options;
      const deviceDir = join(root, ".artifacts/launch/device");
      const metroLog = join(root, `metro-${status}-${metroPid || "empty"}.log`);
      await rm(deviceDir, { recursive: true, force: true });
      await mkdir(deviceDir, { recursive: true });
      await writeFile(adbLog, "");
      if (metroLogPresent) await writeFile(metroLog, "metro-sentinel\n");
      else await rm(metroLog, { force: true });
      const harness = `set -euo pipefail
cd "$HARNESS_ROOT"
emulator_serial=emulator-5554
metro_pid="$HARNESS_METRO_PID"
metro_log="$HARNESS_METRO_LOG"
HARNESS_ADBD_ROOTED=0
HARNESS_DEVICE_WAITED=0
adb() {
  command="$*"
  printf '%s\\n' "$command" >> "$HARNESS_ADB_LOG"
  if [ -n "$HARNESS_FAIL_COMMAND" ] && [[ "$command" == *"$HARNESS_FAIL_COMMAND"* ]]; then
    return 91
  fi
  case "$command" in
    *"screencap -p") printf 'png-sentinel' ;;
    *"uiautomator dump /dev/tty") printf 'hierarchy-sentinel' ;;
    *"logcat -b all -d") printf 'system-logcat-sentinel' ;;
    *"dumpsys activity lastanr") printf 'lastanr-sentinel' ;;
    *" root") HARNESS_ADBD_ROOTED=1 ;;
    *" wait-for-device")
      if [ "$HARNESS_ADBD_ROOTED" -ne 1 ]; then
        echo 'wait-for-device called before adb root' >&2
        return 92
      fi
      HARNESS_DEVICE_WAITED=1
      ;;
    *"ls -la /data/anr; cat /data/anr/"*)
      if [ "$HARNESS_ADBD_ROOTED" -ne 1 ] || [ "$HARNESS_DEVICE_WAITED" -ne 1 ]; then
        echo 'cat: /data/anr: Permission denied' >&2
        return 13
      fi
      printf 'anr-files-sentinel'
      ;;
    *"pidof -s com.luyao618.formobile") printf '%s' "$HARNESS_APP_PID" ;;
    *"logcat -d --pid="*) printf 'pid-logcat-sentinel' ;;
    *"logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V *:S") printf 'logcat-sentinel' ;;
  esac
}
timeout() {
  printf 'timeout %s\\n' "$*" >> "$HARNESS_ADB_LOG"
  duration="$1"
  shift
  if [ "$duration" != "30s" ]; then
    return 93
  fi
  if [ "$HARNESS_TIMEOUT_STATUS" -ne 0 ]; then
    return "$HARNESS_TIMEOUT_STATUS"
  fi
  "$@"
}
kill() { printf 'kill %s\\n' "$*" >> "$HARNESS_ADB_LOG"; }
wait() { printf 'wait %s\\n' "$*" >> "$HARNESS_ADB_LOG"; }
if adb -s "$emulator_serial" shell 'ls -la /data/anr; cat /data/anr/*' >/dev/null 2>&1; then
  echo 'unprivileged /data/anr read unexpectedly succeeded' >&2
  exit 98
fi
: > "$HARNESS_ADB_LOG"
${cleanup}
exit ${status}
`;
      return spawnSync("bash", { encoding: "utf8", input: harness, env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_ADB_LOG: adbLog,
        HARNESS_APP_PID: appPid,
        HARNESS_FAIL_COMMAND: failCommand,
        HARNESS_METRO_PID: metroPid,
        HARNESS_METRO_LOG: metroLog,
        HARNESS_TIMEOUT_STATUS: String(timeoutStatus),
      } });
    };

    const emptyCleanup = await runCleanup(0, "", { metroPid: "", metroLogPresent: false });
    assert.equal(emptyCleanup.status, 0, emptyCleanup.stderr);
    assert.equal(emptyCleanup.stdout, "");
    assert.doesNotMatch(await readFile(adbLog, "utf8"), /^(?:kill|wait) /m);

    const success = await runCleanup(0);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, "metro-sentinel\n");
    assert.match(await readFile(adbLog, "utf8"), /^kill -- -424242$/m);
    assert.match(await readFile(adbLog, "utf8"), /^wait 424242$/m);
    for (const path of exactAndroidFailureDiagnosticPaths) {
      await assert.rejects(readFile(join(root, path)), `${path} must remain absent after success`);
    }

    const pidFailure = await runCleanup(37, "1234");
    assert.equal(pidFailure.status, 37, pidFailure.stderr);
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-failure.png"), "utf8"), "png-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-ui-hierarchy.xml"), "utf8"), "hierarchy-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-system.log"), "utf8"), "system-logcat-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-lastanr.txt"), "utf8"), "lastanr-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-anr-files.txt"), "utf8"), "anr-files-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-app.log"), "utf8"), "pid-logcat-sentinel");
    const pidFailureAdbLog = await readFile(adbLog, "utf8");
    const pidFailureAdbCalls = pidFailureAdbLog.trim().split("\n");
    for (const exactCall of [
      "-s emulator-5554 root",
      "timeout 30s adb -s emulator-5554 wait-for-device",
      "-s emulator-5554 wait-for-device",
      "-s emulator-5554 shell ls -la /data/anr; cat /data/anr/*",
    ]) {
      assert.equal(
        pidFailureAdbCalls.filter((call) => call === exactCall).length,
        1,
        `${exactCall} must run exactly once during failure cleanup`,
      );
    }
    ordered(
      pidFailureAdbLog,
      "screencap -p",
      "uiautomator dump /dev/tty",
      "logcat -b all -d",
      "dumpsys activity lastanr",
      "-s emulator-5554 root",
      "timeout 30s adb -s emulator-5554 wait-for-device",
      "-s emulator-5554 wait-for-device",
      "ls -la /data/anr; cat /data/anr/*",
      "pidof -s com.luyao618.formobile",
      "logcat -d --pid=1234",
    );
    assert.doesNotMatch(pidFailureAdbLog, /logcat -d -s AndroidRuntime/);

    const fallbackFailure = await runCleanup(38);
    assert.equal(fallbackFailure.status, 38, fallbackFailure.stderr);
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-failure.png"), "utf8"), "png-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-ui-hierarchy.xml"), "utf8"), "hierarchy-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-app.log"), "utf8"), "logcat-sentinel");
    assert.match(await readFile(adbLog, "utf8"), /logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V \*:S/);
    assert.doesNotMatch(await readFile(adbLog, "utf8"), /logcat -d --pid=/);

    const reconnectTimeout = await runCleanup(74, "1234", { timeoutStatus: 124 });
    assert.equal(reconnectTimeout.status, 74, `timeout status 124 must preserve the original status: ${reconnectTimeout.stderr}`);
    assert.equal(reconnectTimeout.stdout, "metro-sentinel\n");
    assert.match(
      await readFile(join(root, ".artifacts/launch/device/android-anr-files.txt"), "utf8"),
      /cat: \/data\/anr: Permission denied/,
    );
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-app.log"), "utf8"), "pid-logcat-sentinel");
    const reconnectTimeoutLog = await readFile(adbLog, "utf8");
    assert.equal(
      reconnectTimeoutLog.split("\n").filter((call) => call === "timeout 30s adb -s emulator-5554 wait-for-device").length,
      1,
      "failure cleanup must invoke the exact reconnect timeout once",
    );
    assert.doesNotMatch(reconnectTimeoutLog, /^-s emulator-5554 wait-for-device$/m, "timed-out reconnect must not complete");
    ordered(
      reconnectTimeoutLog,
      "logcat -b all -d",
      "dumpsys activity lastanr",
      "-s emulator-5554 root",
      "timeout 30s adb -s emulator-5554 wait-for-device",
      "ls -la /data/anr; cat /data/anr/*",
      "pidof -s com.luyao618.formobile",
      "logcat -d --pid=1234",
      "kill -- -424242",
      "wait 424242",
    );

    for (const [failCommand, appPid] of [
      ["screencap -p", "1234"],
      ["uiautomator dump /dev/tty", "1234"],
      ["logcat -b all -d", "1234"],
      ["dumpsys activity lastanr", "1234"],
      ["emulator-5554 root", "1234"],
      ["wait-for-device", "1234"],
      ["ls -la /data/anr", "1234"],
      ["pidof -s com.luyao618.formobile", "1234"],
      ["logcat -d --pid=", "1234"],
      ["logcat -d -s AndroidRuntime", ""],
    ] as const) {
      const diagnosticFailure = await runCleanup(73, appPid, { failCommand });
      assert.equal(
        diagnosticFailure.status,
        73,
        `${failCommand} failure must preserve the original status: ${diagnosticFailure.stderr}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android retains both native flavors and records smoke provenance after exact-device readiness", async () => {
  const [workflow, runner] = await Promise.all([
    readFile(".github/workflows/e2e-android.yml", "utf8"),
    readFile("scripts/e2e/run-android-emulator.sh", "utf8"),
  ]);
  ordered(workflow,
    "prebuild:android:production",
    "cp android/app/src/main/AndroidManifest.xml .artifacts/native/android/production/AndroidManifest.xml",
    "--flavor production --input .artifacts/native/android/production/AndroidManifest.xml",
    ":app:assembleDebug",
    "prebuild:android:e2e",
    "cp android/app/src/main/AndroidManifest.xml .artifacts/native/android/e2e/AndroidManifest.xml",
    "--flavor e2e --input .artifacts/native/android/e2e/AndroidManifest.xml",
    exactAndroidBuildCommand,
    "bash scripts/e2e/run-android-emulator.sh",
    "collect-ci-evidence.mjs",
    "--test-result pass --test-result-file .artifacts/test-results/android-maestro.log",
  );
  ordered(runner,
    exactAndroidOpenUrlCommand,
    exactReadinessCommands.Android,
    exactAndroidSmokeCommand,
  );
  assertExactAndroidUrlHandoff(runner);
  assert.match(workflow, /\.artifacts\/native\/android\/\*\*/);
  assert.match(workflow, /\.artifacts\/launch\/\*\*/);
});

test("iOS opens on the exact UDID, requires readiness, then records unchanged smoke provenance", async () => {
  const workflow = await readFile(".github/workflows/e2e-ios.yml", "utf8");
  const parsedWorkflow = parseWorkflow(workflow, ".github/workflows/e2e-ios.yml");
  const iosSteps = requiredSteps(requiredJob(parsedWorkflow, "ios"), "ios");
  const smokeIndex = stepIndex(iosSteps, (step) => step.name === "Serial production and E2E builds, install, and smoke", "iOS device smoke");
  const smokeRun = iosSteps[smokeIndex].run;
  assert.ok(typeof smokeRun === "string", "iOS device smoke must have an enabled run script");
  assertExactMetroStartupPolicy(smokeRun, "iOS");
  assertMetroProcessGroupPolicy(smokeRun, "iOS");
  assertExactReadinessCommand(smokeRun, "iOS");
  assertExactIosUrlHandoff(smokeRun);
  assertIosFailureDiagnosticsPolicy(smokeRun, parsedWorkflow);
  assertExactPinnedSimulatorOpen(smokeRun);
  ordered(workflow,
    "simulator_udid=$(xcrun simctl list devices available -j",
    'simctl boot "$simulator_udid"',
    exactPinnedSimulatorOpenLine,
    'simctl bootstatus "$simulator_udid" -b',
    "prebuild:ios:production",
    "cp ios/ForMobile/Info.plist .artifacts/native/ios/production/Info.plist",
    "--flavor production --input .artifacts/native/ios/production/Info.plist",
    'destination "platform=iOS Simulator,id=$simulator_udid"',
    "prebuild:ios:e2e",
    "cp ios/ForMobile/Info.plist .artifacts/native/ios/e2e/Info.plist",
    "--flavor e2e --input .artifacts/native/ios/e2e/Info.plist",
    'simctl install "$simulator_udid"',
    exactHeadlessMetroCommands.iOS,
    exactDevClientUrlAssignment,
    exactIosOpenUrlCommand,
    exactIosConfirmationCommand,
    exactIosOpenUrlCommand,
    exactIosConfirmationCommand,
    exactReadinessCommands.iOS,
    exactIosSmokeCommand,
    "mv .artifacts/test-results/ios-maestro.attempt.log .artifacts/test-results/ios-maestro.log",
    "collect-ci-evidence.mjs",
    "--test-result pass --test-result-file .artifacts/test-results/ios-maestro.log",
  );
  assert.match(workflow, /set -euo pipefail/);
  assert.doesNotMatch(workflow, /simctl boot[^\n]*\|\| true/);
  assert.doesNotMatch(workflow, /simctl launch/);
  assert.match(workflow, /\.artifacts\/launch\/\*\*/);
});

test("iOS confirmation is exact while readiness and smoke retain their required behavior", async () => {
  const [confirmation, readiness, smoke] = await Promise.all([
    readFile(iosOpenConfirmationFlow, "utf8"),
    readFile(readinessFlow, "utf8"),
    readFile(smokeFlow, "utf8"),
  ]);
  assertIosOpenConfirmationFlow(confirmation);
  assert.doesNotMatch(confirmation, /optional|extendedWaitUntil|assertVisible|launchApp|stopApp|openLink/);
  assert.equal(readiness, exactReadinessFlow);
  assert.doesNotMatch(readiness, /launchApp|stopApp|openLink/);
  assert.equal(smoke, exactSmokeFlow);
});

test("headless Metro, readiness, and iOS confirmation policies reject hostile counterexamples", async () => {
  const [androidRunner, androidSource, iosSource, confirmation] = await Promise.all([
    readFile("scripts/e2e/run-android-emulator.sh", "utf8"),
    readFile(".github/workflows/e2e-android.yml", "utf8"),
    readFile(".github/workflows/e2e-ios.yml", "utf8"),
    readFile(iosOpenConfirmationFlow, "utf8"),
  ]);
  const iosWorkflow = parseWorkflow(iosSource, ".github/workflows/e2e-ios.yml");
  const iosSteps = requiredSteps(requiredJob(iosWorkflow, "ios"), "ios");
  const iosSmoke = iosSteps.find((step) => step.name === "Serial production and E2E builds, install, and smoke");
  assert.ok(iosSmoke && typeof iosSmoke.run === "string");

  for (const [platform, script] of [["Android", androidRunner], ["iOS", iosSmoke.run]] as const) {
    const withoutDnsOrder = script.replace("NODE_OPTIONS=--dns-result-order=ipv4first ", "");
    assert.notEqual(withoutDnsOrder, script);
    assert.throws(
      () => assertExactHeadlessMetroLaunch(withoutDnsOrder, platform),
      /exact loopback-only fail-closed headless command/,
    );

    const verbatimDnsOrder = script.replace(
      "NODE_OPTIONS=--dns-result-order=ipv4first",
      "NODE_OPTIONS=--dns-result-order=verbatim",
    );
    assert.notEqual(verbatimDnsOrder, script);
    assert.throws(
      () => assertExactHeadlessMetroLaunch(verbatimDnsOrder, platform),
      /exact loopback-only fail-closed headless command/,
    );

    const lanBound = script.replace("--localhost", "--lan");
    assert.notEqual(lanBound, script);
    assert.throws(
      () => assertExactHeadlessMetroLaunch(lanBound, platform),
      /exact loopback-only fail-closed headless command/,
    );

    const withoutHeadless = script.replace("EXPO_UNSTABLE_HEADLESS=1 ", "");
    assert.notEqual(withoutHeadless, script);
    assert.throws(
      () => assertExactHeadlessMetroLaunch(withoutHeadless, platform),
      /exact loopback-only fail-closed headless command/,
    );

    const processGroupMutations = [
      script.replace("set -m\n", ""),
      script.replaceAll('kill -- "-$metro_pid"', 'kill "$metro_pid"'),
      script.replace(
        `set -m\n${exactHeadlessMetroCommands[platform]}\nmetro_pid=$!\nset +m`,
        `set +m\n${exactHeadlessMetroCommands[platform]}\nmetro_pid=$!`,
      ),
    ];
    for (const mutation of processGroupMutations) {
      assert.notEqual(mutation, script);
      assert.throws(
        () => assertMetroProcessGroupPolicy(mutation, platform),
        /monitored Bash process group|signal the complete process group/,
      );
    }

    const localhostStatusProbes = script.replaceAll(
      "http://127.0.0.1:8081/status",
      "http://localhost:8081/status",
    );
    assert.notEqual(localhostStatusProbes, script);
    assert.throws(
      () => assertExactMetroStatusProbes(localhostStatusProbes, platform),
      /exactly the bounded retry loop, final IPv4 probe, and offline negative probe in order/,
    );

    const withoutFinalStatusProbe = script
      .split(/\r\n|\n|\r/)
      .filter((line) => line !== exactMetroStatusLines[1])
      .join("\n");
    assert.notEqual(withoutFinalStatusProbe, script);
    assert.throws(
      () => assertExactMetroStatusProbes(withoutFinalStatusProbe, platform),
      /exactly the bounded retry loop, final IPv4 probe, and offline negative probe in order/,
    );

    const withoutApprovedStatusLines = script
      .split(/\r\n|\n|\r/)
      .filter((line) => !exactMetroStatusLines.some((statusLine) => line === statusLine))
      .join("\n");
    const statusProbesBeforeLaunch = withoutApprovedStatusLines.replace(
      exactHeadlessMetroCommands[platform],
      `${exactMetroStatusLines.join("\n")}\n${exactHeadlessMetroCommands[platform]}`,
    );
    assert.notEqual(statusProbesBeforeLaunch, script);
    assert.throws(
      () => assertExactMetroStartupPolicy(statusProbesBeforeLaunch, platform),
      /must preserve exact launch, retry loop, final probe, and dev-client URL assignment order/,
    );

    const exactReadinessCommand = exactReadinessCommands[platform];
    const readinessMutations = [
      script.replace(exactReadinessCommand, `${exactReadinessCommand} || true`),
      script.replace(exactReadinessCommand, `# ${exactReadinessCommand}`),
      script.replace(exactReadinessCommand, ""),
    ];
    for (const mutatedScript of readinessMutations) {
      assert.notEqual(mutatedScript, script);
      assert.throws(
        () => assertExactReadinessCommand(mutatedScript, platform),
        /readiness must appear exactly once as the exact fail-closed command/,
      );
    }
  }

  const duplicateAndroidInstall = androidRunner.replace(
    exactAndroidInstallCommand,
    `${exactAndroidInstallCommand}\n${exactAndroidInstallCommand}`,
  );
  assert.notEqual(duplicateAndroidInstall, androidRunner);
  assert.throws(
    () => assertExactAndroidInstallPolicy(duplicateAndroidInstall),
    /exactly one captured --no-streaming -r install command/,
  );

  const wrongAndroidArchitecture = androidSource.replace(
    exactAndroidBuildCommand,
    exactAndroidBuildCommand.replace("x86_64", "arm64-v8a"),
  );
  assert.notEqual(wrongAndroidArchitecture, androidSource);
  assert.throws(
    () => assertChildWorkflowPolicy(parseWorkflow(wrongAndroidArchitecture, "wrong-architecture Android"), "android"),
    /exact x86_64 build command/,
  );

  const packageServiceMutations = [
    androidRunner.replace("seq 1 60", "seq 1 59"),
    androidRunner.replace(exactAndroidPackageServiceLines[1], ""),
    androidRunner.replace(
      `trap cleanup EXIT\n${exactAndroidPackageServiceCall}`,
      `${exactAndroidPackageServiceCall}\ntrap cleanup EXIT`,
    ),
  ];
  for (const mutatedScript of packageServiceMutations) {
    assert.notEqual(mutatedScript, androidRunner);
    assert.throws(
      () => assertExactAndroidPackageServicePolicy(mutatedScript),
      /exact bounded loop and final fail-closed probe|call the bounded package-service wait|register cleanup, wait before the first install/,
    );
  }

  const exactInitialConfirmationTap = "      - tapOn:\n          point: '69%,54%'\n          label: 'Tap the right-side Open button in the iOS confirmation alert'\n";
  const exactConditionalConfirmationRetry = "      - runFlow:\n          when:\n            visible: '^Open in .For Mobile.\\?$'\n          commands:\n            - tapOn:\n                point: '69%,54%'\n                label: 'Retry the right-side Open button'\n";
  const exactFinalConfirmationAssertion = "      - assertNotVisible: '^Open in .For Mobile.\\?$'\n";
  const confirmationFlowMutations: [string, string][] = [
    ["missing outer prompt-conditioned flow", confirmation.replace("- runFlow:\n", "")],
    ["duplicated outer prompt-conditioned flow", confirmation.replace("- runFlow:\n", "- runFlow:\n- runFlow:\n")],
    ["missing conditional retry", confirmation.replace(exactConditionalConfirmationRetry, "")],
    [
      "unconditional retry",
      confirmation.replace(
        "          when:\n            visible: '^Open in .For Mobile.\\?$'\n          commands:\n",
        "          commands:\n",
      ),
    ],
    [
      "optional retry",
      confirmation.replace(
        "                label: 'Retry the right-side Open button'\n",
        "                label: 'Retry the right-side Open button'\n                optional: true\n",
      ),
    ],
    [
      "changed retry point",
      confirmation.replace(
        "                point: '69%,54%'\n                label: 'Retry the right-side Open button'",
        "                point: '50%,50%'\n                label: 'Retry the right-side Open button'",
      ),
    ],
    [
      "reordered retry",
      confirmation.replace(
        `${exactConditionalConfirmationRetry}${exactFinalConfirmationAssertion}`,
        `${exactFinalConfirmationAssertion}${exactConditionalConfirmationRetry}`,
      ),
    ],
    [
      "duplicated third retry",
      confirmation.replace(exactConditionalConfirmationRetry, exactConditionalConfirmationRetry.repeat(2)),
    ],
    ["removed final assertion", confirmation.replace(exactFinalConfirmationAssertion, "")],
    ["changed confirmation prompt", confirmation.replaceAll("^Open in .For Mobile.\\?$", "^Open in For Mobile\\?$")],
    [
      "changed initial tap point",
      confirmation.replace(
        exactInitialConfirmationTap,
        exactInitialConfirmationTap.replace("point: '69%,54%'", "point: '50%,50%'"),
      ),
    ],
  ];
  for (const [label, mutatedFlow] of confirmationFlowMutations) {
    assert.notEqual(mutatedFlow, confirmation, `${label} fixture must change the confirmation flow`);
    assert.throws(
      () => assertIosOpenConfirmationFlow(mutatedFlow),
      /flow bytes must remain exact/,
      `${label} must be rejected`,
    );
  }

  const withReadinessWait = `${confirmation}- extendedWaitUntil:\n    visible: "照护空间尚未设置"\n    timeout: 120000\n`;
  assert.throws(() => assertIosOpenConfirmationFlow(withReadinessWait), /flow bytes must remain exact/);

  const iosHandoffMutations = [
    iosSmoke.run.replace(`${exactIosOpenUrlCommand}\n${exactIosConfirmationCommand}\n${exactReadinessCommands.iOS}`, `${exactIosOpenUrlCommand}\n${exactReadinessCommands.iOS}`),
    iosSmoke.run.replace(
      `${exactIosOpenUrlCommand}\n${exactIosConfirmationCommand}\n${exactReadinessCommands.iOS}`,
      `${exactIosOpenUrlCommand}\n${exactIosConfirmationCommand}\n${exactIosConfirmationCommand}\n${exactReadinessCommands.iOS}`,
    ),
    iosSmoke.run.replace(
      `${exactIosConfirmationCommand}\n${exactIosOpenUrlCommand}`,
      `${exactIosOpenUrlCommand}\n${exactIosConfirmationCommand}`,
    ),
    iosSmoke.run.replace(
      `${exactIosOpenUrlCommand}\n${exactIosConfirmationCommand}\n${exactReadinessCommands.iOS}`,
      `xcrun simctl openurl "$simulator_udid" "${encodedDevClientUrl}" 2>&1 | tee -a .artifacts/launch/ios-dev-client.log\n${exactIosConfirmationCommand}\n${exactReadinessCommands.iOS}`,
    ),
    iosSmoke.run.replace(exactIosConfirmationCommand, `${exactIosConfirmationCommand} || true`),
    iosSmoke.run.replace(
      `${exactIosConfirmationCommand}\n${exactReadinessCommands.iOS}`,
      `${exactIosConfirmationCommand} || :\n${exactReadinessCommands.iOS}`,
    ),
  ];
  for (const mutatedScript of iosHandoffMutations) {
    assert.notEqual(mutatedScript, iosSmoke.run);
    assert.throws(
      () => assertExactIosUrlHandoff(mutatedScript),
      /exactly two identical exact simctl openurl commands|confirmation must appear exactly twice as the exact fail-closed command|must preserve assignment, open, confirmation, open, confirmation, readiness, and smoke order/,
    );
  }

  const androidWorkflow = parseWorkflow(
    await readFile(".github/workflows/e2e-android.yml", "utf8"),
    ".github/workflows/e2e-android.yml",
  );
  const androidPolicyMutations = [
    androidRunner.replace(exactAndroidFailureScreenshotCommand, `    # ${exactAndroidFailureScreenshotCommand.trim()}`),
    androidRunner.replace("  status=$?", "  status=0"),
    androidRunner.replace('    wait "$metro_pid" 2>/dev/null\n', ""),
    androidRunner.replace('  if [ -n "$metro_pid" ]; then\n', ""),
    androidRunner.replace('  if [ -f "$metro_log" ]; then\n', ""),
    androidRunner.replace(`${exactAndroidFailureSystemLogCommand}\n`, ""),
    androidRunner.replace(`${exactAndroidFailureLastAnrCommand}\n`, ""),
    androidRunner.replace(`${exactAndroidFailureAnrFilesCommand}\n`, ""),
    androidRunner.replace(`${exactAndroidFallbackLogCommand}\n`, ""),
    androidRunner.replace(".artifacts/launch/maestro/android-smoke", ".artifacts/launch/maestro/android-readiness"),
    androidRunner.replace(exactReadinessCommands.Android, `${exactReadinessCommands.Android}\n${exactReadinessCommands.Android}`),
    androidRunner.replace(exactReadinessCommands.Android, `adb -s "$emulator_serial" shell input tap 500 1300\n${exactReadinessCommands.Android}`),
    androidRunner.replace(exactReadinessCommands.Android, `adb -s "$emulator_serial" shell am force-stop com.google.android.apps.nexuslauncher\n${exactReadinessCommands.Android}`),
    androidRunner.replace(exactReadinessCommands.Android, `sleep 10\n${exactReadinessCommands.Android}`),
  ];
  for (const mutatedScript of androidPolicyMutations) {
    assert.notEqual(mutatedScript, androidRunner);
    assert.throws(
      () => assertAndroidDiagnosticsPolicy(mutatedScript, androidWorkflow),
      /Android cleanup must preserve|failure diagnostic command inventory|non-retried readiness and smoke commands|only the two existing bounded service sleeps|must not dismiss ANR dialogs/,
    );
  }

  const androidAnrPrivilegeMutations = [
    ["removed root", androidRunner.replace(`${exactAndroidFailureRootCommand}\n`, "")],
    [
      "bare wait-for-device",
      androidRunner.replace(exactAndroidFailureWaitForDeviceCommand, '    adb -s "$emulator_serial" wait-for-device'),
    ],
    ["removed timeout wrapper", androidRunner.replace(`${exactAndroidFailureWaitForDeviceCommand}\n`, "")],
    [
      "widened timeout wrapper",
      androidRunner.replace(exactAndroidFailureWaitForDeviceCommand, '    timeout 60s adb -s "$emulator_serial" wait-for-device'),
    ],
    ["removed ANR read", androidRunner.replace(`${exactAndroidFailureAnrFilesCommand}\n`, "")],
    [
      "root before full logcat",
      androidRunner.replace(
        `${exactAndroidFailureSystemLogCommand}\n${exactAndroidFailureLastAnrCommand}\n${exactAndroidFailureRootCommand}`,
        `${exactAndroidFailureRootCommand}\n${exactAndroidFailureSystemLogCommand}\n${exactAndroidFailureLastAnrCommand}`,
      ),
    ],
    [
      "root before lastanr",
      androidRunner.replace(
        `${exactAndroidFailureLastAnrCommand}\n${exactAndroidFailureRootCommand}`,
        `${exactAndroidFailureRootCommand}\n${exactAndroidFailureLastAnrCommand}`,
      ),
    ],
    [
      "reordered timeout wrapper before root",
      androidRunner.replace(
        `${exactAndroidFailureRootCommand}\n${exactAndroidFailureWaitForDeviceCommand}`,
        `${exactAndroidFailureWaitForDeviceCommand}\n${exactAndroidFailureRootCommand}`,
      ),
    ],
    [
      "ANR read before wait-for-device",
      androidRunner.replace(
        `${exactAndroidFailureWaitForDeviceCommand}\n${exactAndroidFailureAnrFilesCommand}`,
        `${exactAndroidFailureAnrFilesCommand}\n${exactAndroidFailureWaitForDeviceCommand}`,
      ),
    ],
    [
      "duplicated root",
      androidRunner.replace(
        exactAndroidFailureRootCommand,
        `${exactAndroidFailureRootCommand}\n${exactAndroidFailureRootCommand}`,
      ),
    ],
    [
      "duplicated timeout wrapper",
      androidRunner.replace(
        exactAndroidFailureWaitForDeviceCommand,
        `${exactAndroidFailureWaitForDeviceCommand}\n${exactAndroidFailureWaitForDeviceCommand}`,
      ),
    ],
    [
      "duplicated ANR read",
      androidRunner.replace(
        exactAndroidFailureAnrFilesCommand,
        `${exactAndroidFailureAnrFilesCommand}\n${exactAndroidFailureAnrFilesCommand}`,
      ),
    ],
    [
      "fail-open root",
      androidRunner.replace(exactAndroidFailureRootCommand, `${exactAndroidFailureRootCommand} || true`),
    ],
    [
      "fail-open timeout wrapper",
      androidRunner.replace(
        exactAndroidFailureWaitForDeviceCommand,
        `${exactAndroidFailureWaitForDeviceCommand} || :`,
      ),
    ],
    [
      "fail-open ANR read",
      androidRunner.replace(exactAndroidFailureAnrFilesCommand, `${exactAndroidFailureAnrFilesCommand} || true`),
    ],
  ] as const;
  for (const [label, mutatedScript] of androidAnrPrivilegeMutations) {
    assert.notEqual(mutatedScript, androidRunner, `${label} fixture must change the runner`);
    assert.throws(
      () => assertAndroidDiagnosticsPolicy(mutatedScript, androidWorkflow),
      /Android cleanup must preserve|failure diagnostic command inventory/,
      label,
    );
  }

  const extraAndroidDiagnostics = [
    '    adb -s "$emulator_serial" exec-out screencap -p > .artifacts/launch/device/extra-android-failure.png',
    '    adb -s "$emulator_serial" exec-out uiautomator dump /dev/tty > .artifacts/launch/device/extra-android-ui-hierarchy.xml 2>&1',
    String.raw`    extra_app_pid=$(adb -s "$emulator_serial" shell pidof -s com.luyao618.formobile 2>/dev/null | tr -d "\r")`,
    '    adb -s "$emulator_serial" logcat -d > .artifacts/launch/device/extra-android.log 2>&1',
    "    a''db -s \"$emulator_serial\" logcat -d > .artifacts/launch/device/quote-joined-adb.log 2>&1",
    "    adb -s \"$emulator_serial\" log''cat -d > .artifacts/launch/device/quote-joined-logcat.log 2>&1",
  ];
  for (const extraDiagnostic of extraAndroidDiagnostics) {
    const mutatedScript = androidRunner.replace(
      exactAndroidFailureScreenshotCommand,
      `${exactAndroidFailureScreenshotCommand}\n${extraDiagnostic}`,
    );
    assert.notEqual(mutatedScript, androidRunner);
    assert.throws(
      () => assertAndroidDiagnosticsPolicy(mutatedScript, androidWorkflow),
      /Android cleanup must preserve|failure diagnostic command inventory/,
    );
  }

  const continuedAndroidDiagnostics = [
    '    adb -s "$emulator_serial" \\\n      logcat -d > .artifacts/launch/device/continued-before-logcat.log 2>&1',
    '    adb -s "$emulator_serial" log\\\r\ncat -d > .artifacts/launch/device/continued-within-logcat.log 2>&1',
    '    a\\\rdb -s "$emulator_serial" logcat -d > .artifacts/launch/device/continued-within-adb.log 2>&1',
  ];
  for (const continuedDiagnostic of continuedAndroidDiagnostics) {
    const mutatedScript = androidRunner.replace(
      exactAndroidFailureScreenshotCommand,
      `${exactAndroidFailureScreenshotCommand}\n${continuedDiagnostic}`,
    );
    assert.notEqual(mutatedScript, androidRunner);
    assert.throws(
      () => assertAndroidDiagnosticsPolicy(mutatedScript, androidWorkflow),
      /Android cleanup must preserve|failure diagnostic command inventory/,
    );
  }

  const duplicatedAndroidDiagnostic = androidRunner.replace(
    exactAndroidFailureScreenshotCommand,
    `${exactAndroidFailureScreenshotCommand}\n${exactAndroidFailureScreenshotCommand}`,
  );
  assert.notEqual(duplicatedAndroidDiagnostic, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(duplicatedAndroidDiagnostic, androidWorkflow),
    /Android cleanup must preserve|failure diagnostic command inventory/,
  );

  const reorderedAndroidDiagnostics = androidRunner.replace(
    `${exactAndroidFailureScreenshotCommand}\n${exactAndroidFailureHierarchyCommand}`,
    `${exactAndroidFailureHierarchyCommand}\n${exactAndroidFailureScreenshotCommand}`,
  );
  assert.notEqual(reorderedAndroidDiagnostics, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(reorderedAndroidDiagnostics, androidWorkflow),
    /Android cleanup must preserve|failure diagnostic command inventory/,
  );

  const commentedExtraAndroidDiagnostic = androidRunner.replace(
    exactAndroidFailureScreenshotCommand,
    `${exactAndroidFailureScreenshotCommand}\n    # adb -s "$emulator_serial" logcat -d > .artifacts/launch/device/comment-only.log 2>&1`,
  );
  assert.notEqual(commentedExtraAndroidDiagnostic, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(commentedExtraAndroidDiagnostic, androidWorkflow),
    /Android cleanup must preserve|failure diagnostic command inventory/,
  );

  const bashCommentBoundary = spawnSync("/bin/bash", ["-c", String.raw`# comment \
printf 'next-line-ran'`], { encoding: "utf8" });
  assert.equal(bashCommentBoundary.status, 0);
  assert.equal(bashCommentBoundary.stdout, "next-line-ran");

  const commentFollowedByExecutableAndroidDiagnostic = androidRunner.replace(
    exactAndroidFailureScreenshotCommand,
    `${exactAndroidFailureScreenshotCommand}\n    # a full-line comment ending in backslash \\\n    adb -s "$emulator_serial" logcat -d > .artifacts/launch/device/comment-boundary.log 2>&1`,
  );
  assert.notEqual(commentFollowedByExecutableAndroidDiagnostic, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(commentFollowedByExecutableAndroidDiagnostic, androidWorkflow),
    /Android cleanup must preserve|failure diagnostic command inventory/,
  );

  const continuedCommentOnlyAndroidDiagnostic = androidRunner.replace(
    exactAndroidFailureScreenshotCommand,
    `${exactAndroidFailureScreenshotCommand}\n    # adb -s "$emulator_serial" \\\n    # logcat -d > .artifacts/launch/device/comment-only-continued.log 2>&1`,
  );
  assert.notEqual(continuedCommentOnlyAndroidDiagnostic, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(continuedCommentOnlyAndroidDiagnostic, androidWorkflow),
    /Android cleanup must preserve|failure diagnostic command inventory/,
  );

  const unboundedAndroidTimeout = structuredClone(androidWorkflow);
  requiredJob(unboundedAndroidTimeout, "android").env = { MAESTRO_DRIVER_STARTUP_TIMEOUT: "120000" };
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(androidRunner, unboundedAndroidTimeout),
    /must remain exactly bounded at 60000ms/,
  );

  const androidWithoutHiddenDiagnostics = structuredClone(androidWorkflow);
  const androidDiagnosticsUpload = requiredSteps(requiredJob(androidWithoutHiddenDiagnostics, "android"), "android")
    .find((step) => step.with?.name === `android-e2e-diagnostics-${expectedShaInput}`);
  assert.ok(androidDiagnosticsUpload?.with);
  delete androidDiagnosticsUpload.with["include-hidden-files"];
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(androidRunner, androidWithoutHiddenDiagnostics),
    /must retain hidden Maestro files/,
  );

  const iosWithoutHiddenDiagnostics = structuredClone(iosWorkflow);
  const diagnosticsUpload = requiredSteps(requiredJob(iosWithoutHiddenDiagnostics, "ios"), "ios")
    .find((step) => step.with?.name === `ios-e2e-diagnostics-${expectedShaInput}`);
  assert.ok(diagnosticsUpload?.with);
  delete diagnosticsUpload.with["include-hidden-files"];
  assert.throws(
    () => assertIosFailureDiagnosticsPolicy(iosSmoke.run!, iosWithoutHiddenDiagnostics),
    /must retain hidden Maestro files/,
  );

  const commentedIosDiagnostic = iosSmoke.run.replace(
    exactIosFailureScreenshotCommand,
    `    # ${exactIosFailureScreenshotCommand.trim()}`,
  );
  const removedIosDiagnostic = iosSmoke.run.replace(`${exactIosFailureLogCommand}\n`, "");
  for (const mutatedScript of [commentedIosDiagnostic, removedIosDiagnostic]) {
    assert.notEqual(mutatedScript, iosSmoke.run);
    assert.throws(
      () => assertIosFailureDiagnosticsPolicy(mutatedScript, iosWorkflow),
      /executable simctl io\/spawn command inventory must exactly match/,
    );
  }

  const reorderedIosDiagnostics = iosSmoke.run.replace(
    `${exactIosFailureScreenshotCommand}\n${exactIosFailureLogCommand}`,
    `${exactIosFailureLogCommand}\n${exactIosFailureScreenshotCommand}`,
  );
  assert.notEqual(reorderedIosDiagnostics, iosSmoke.run);
  assert.throws(
    () => assertIosFailureDiagnosticsPolicy(reorderedIosDiagnostics, iosWorkflow),
    /executable simctl io\/spawn command inventory must exactly match/,
  );

  const extraIosDiagnostic = iosSmoke.run.replace(
    exactIosFailureLogCommand,
    `${exactIosFailureLogCommand}\n    xcrun simctl io "$simulator_udid" screenshot /tmp/extra-ios-diagnostic.png`,
  );
  assert.notEqual(extraIosDiagnostic, iosSmoke.run);
  assert.throws(
    () => assertIosFailureDiagnosticsPolicy(extraIosDiagnostic, iosWorkflow),
    /executable simctl io\/spawn command inventory must exactly match/,
  );
});

test("Metro monitor-mode teardown terminates a wrapper and its child on host Bash", () => {
  const result = spawnSync("bash", ["-c", `set -euo pipefail
directory=$(mktemp -d)
child_file="$directory/child"
cleanup_harness() {
  set +e
  [ -z "\${metro_pid:-}" ] || kill -- "-$metro_pid" 2>/dev/null
  rm -rf "$directory"
}
trap cleanup_harness EXIT
set -m
bash -c 'sleep 30 & echo $! > "$1"; wait' _ "$child_file" &
metro_pid=$!
set +m
for _ in $(seq 1 100); do [ -s "$child_file" ] && break; sleep 0.01; done
child_pid=$(cat "$child_file")
test "$(jobs -p)" = "$metro_pid"
kill -0 -- "-$metro_pid"
kill -- "-$metro_pid"
set +e
wait "$metro_pid"
metro_status=$?
set -e
case "$metro_status" in
  0|143) ;;
  *) exit 1 ;;
esac
for _ in $(seq 1 100); do ! kill -0 "$child_pid" 2>/dev/null && break; sleep 0.01; done
! kill -0 "$child_pid" 2>/dev/null
metro_pid=
printf '%s\n' group-teardown-pass
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "group-teardown-pass\n");
});

test("native workflows enforce the parsed Intel runner, exact SHA boundaries, and frozen tool preflight", async () => {
  const workflows = await loadNativeWorkflows();
  assertNativeWorkflowPolicy(workflows);
  const syntax = spawnSync("bash", ["-n"], { encoding: "utf8", input: exactIosPreflightScript });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("parsed workflow policy rejects hostile structural counterexamples", async () => {
  const workflows = await loadNativeWorkflows();

  for (const [workflowKey, hostileJobName, hostileUses] of [
    ["ci", "hostile-upload", "actions/upload-artifact@main"],
    ["android", "hostile-emulator", "rEaCtIvEcIrCuS/AnDrOiD-EmUlAtOr-RuNnEr@main"],
    ["ios", "hostile-upload", "AcTiOnS/UpLoAd-ArTiFaCt@main"],
  ] as const) {
    const extraJob = structuredClone(workflows);
    extraJob[workflowKey].jobs[hostileJobName] = {
      "runs-on": "ubuntu-latest",
      steps: [{ uses: hostileUses }],
    };
    assert.throws(
      () => assertNativeWorkflowPolicy(extraJob),
      /workflow jobs must contain only the approved exact keys/,
    );
  }

  for (const run of originalStaticGateRuns) {
    for (const field of ["if", "continue-on-error"] as const) {
      const hostileGate = structuredClone(workflows);
      const gate = requiredSteps(requiredJob(hostileGate.ci, "static"), "static").find((step) => step.run === run);
      assert.ok(gate);
      gate[field] = field === "if" ? "${{ false }}" : true;
      assert.throws(() => assertNativeWorkflowPolicy(hostileGate), /must not be conditional|must fail closed/);
    }
  }

  const androidSource = await readFile(".github/workflows/e2e-android.yml", "utf8");
  const exactAndroidActionLine = `      - uses: ${androidEmulatorAction}`;
  const hostileAndroidActionLine = "      - uses: ReactiveCircus/android-emulator-runner@main";
  const commentDecoy = `# ${exactAndroidActionLine.trim()}\n${androidSource.replace(exactAndroidActionLine, hostileAndroidActionLine)}`;
  assert.doesNotThrow(() => parseWorkflow(commentDecoy, "comment-decoy Android"));
  assert.throws(
    () => pinnedAndroidActionScript(parseWorkflow(commentDecoy, "comment-decoy Android")),
    /must remain pinned to the reviewed SHA/,
  );

  const androidSteps = requiredSteps(requiredJob(workflows.android, "android"), "android");
  const androidKvmIndex = androidSteps.findIndex((step) => step.name === androidKvmStepName);
  assert.notEqual(androidKvmIndex, -1);

  const hostileKvmMutations: [string, (candidate: NativeWorkflows) => void][] = [
    ["removed", (candidate) => {
      requiredSteps(requiredJob(candidate.android, "android"), "android").splice(androidKvmIndex, 1);
    }],
    ["mode-0660", (candidate) => {
      const step = requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmIndex];
      assert.ok(typeof step.run === "string");
      step.run = step.run.replace("sudo chmod 0666 /dev/kvm", "sudo chmod 0660 /dev/kvm");
    }],
    ["missing-character-probe", (candidate) => {
      const step = requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmIndex];
      assert.ok(typeof step.run === "string");
      step.run = step.run.replace("test -c /dev/kvm\n", "");
    }],
    ["missing-read-probe", (candidate) => {
      const step = requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmIndex];
      assert.ok(typeof step.run === "string");
      step.run = step.run.replace("test -r /dev/kvm\n", "");
    }],
    ["missing-write-probe", (candidate) => {
      const step = requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmIndex];
      assert.ok(typeof step.run === "string");
      step.run = step.run.replace("test -w /dev/kvm\n", "");
    }],
    ["conditional", (candidate) => {
      requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmIndex].if = "${{ false }}";
    }],
    ["continue-on-error", (candidate) => {
      requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmIndex]["continue-on-error"] = true;
    }],
    ["reordered", (candidate) => {
      const steps = requiredSteps(requiredJob(candidate.android, "android"), "android");
      const [step] = steps.splice(androidKvmIndex, 1);
      steps.unshift(step);
    }],
  ];
  for (const [label, mutate] of hostileKvmMutations) {
    const candidate = structuredClone(workflows);
    mutate(candidate);
    assert.throws(
      () => assertNativeWorkflowPolicy(candidate),
      /KVM hardware acceleration|KVM setup must immediately follow/,
      `hostile KVM ${label} mutation must be rejected`,
    );
  }

  const androidKvmLaunchProbeIndex = androidSteps.findIndex((step) => step.name === androidKvmLaunchProbeStepName);
  assert.notEqual(androidKvmLaunchProbeIndex, -1);
  const hostileKvmLaunchProbeMutations: [string, (candidate: NativeWorkflows) => void][] = [
    ["removed", (candidate) => {
      requiredSteps(requiredJob(candidate.android, "android"), "android").splice(androidKvmLaunchProbeIndex, 1);
    }],
    ["missing-character-probe", (candidate) => {
      const step = requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmLaunchProbeIndex];
      assert.ok(typeof step.run === "string");
      step.run = step.run.replace("test -c /dev/kvm\n", "");
    }],
    ["missing-read-probe", (candidate) => {
      const step = requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmLaunchProbeIndex];
      assert.ok(typeof step.run === "string");
      step.run = step.run.replace("test -r /dev/kvm\n", "");
    }],
    ["missing-write-probe", (candidate) => {
      const step = requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmLaunchProbeIndex];
      assert.ok(typeof step.run === "string");
      step.run = step.run.replace("test -w /dev/kvm\n", "");
    }],
    ["conditional", (candidate) => {
      requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmLaunchProbeIndex].if = "${{ false }}";
    }],
    ["continue-on-error", (candidate) => {
      requiredSteps(requiredJob(candidate.android, "android"), "android")[androidKvmLaunchProbeIndex]["continue-on-error"] = true;
    }],
    ["reordered", (candidate) => {
      const steps = requiredSteps(requiredJob(candidate.android, "android"), "android");
      const [step] = steps.splice(androidKvmLaunchProbeIndex, 1);
      steps.unshift(step);
    }],
  ];
  for (const [label, mutate] of hostileKvmLaunchProbeMutations) {
    const candidate = structuredClone(workflows);
    mutate(candidate);
    assert.throws(
      () => assertNativeWorkflowPolicy(candidate),
      /launch-adjacent KVM verification|KVM verification must immediately precede/,
      `hostile launch-adjacent KVM ${label} mutation must be rejected`,
    );
  }

  const wrongAndroidRunner = structuredClone(workflows);
  requiredJob(wrongAndroidRunner.android, "android")["runs-on"] = "ubuntu-24.04";
  assert.throws(() => assertNativeWorkflowPolicy(wrongAndroidRunner), /Android runner must remain ubuntu-latest/);

  for (const fallback of [undefined, "auto", true] as const) {
    const unsafeAccelerationFallback = structuredClone(workflows);
    const emulator = requiredSteps(requiredJob(unsafeAccelerationFallback.android, "android"), "android")
      .find((step) => step.uses === androidEmulatorAction);
    assert.ok(emulator?.with);
    if (fallback === undefined) delete emulator.with["disable-linux-hw-accel"];
    else emulator.with["disable-linux-hw-accel"] = fallback;
    assert.throws(
      () => assertNativeWorkflowPolicy(unsafeAccelerationFallback),
      /Android emulator action inputs must remain exact/,
      `Android emulator must reject disable-linux-hw-accel fallback ${String(fallback)}`,
    );
  }

  for (const hostileOptions of [undefined, "-gpu swiftshader_indirect -accel on", "-accel auto", "-accel off"] as const) {
    const unsafeAccelerationOptions = structuredClone(workflows);
    const emulator = requiredSteps(requiredJob(unsafeAccelerationOptions.android, "android"), "android")
      .find((step) => step.uses === androidEmulatorAction);
    assert.ok(emulator?.with);
    if (hostileOptions === undefined) delete emulator.with["emulator-options"];
    else emulator.with["emulator-options"] = hostileOptions;
    assert.throws(
      () => assertNativeWorkflowPolicy(unsafeAccelerationOptions),
      /Android emulator action inputs must remain exact/,
      `Android emulator must reject acceleration options ${String(hostileOptions)}`,
    );
  }

  for (const hostileProfile of [undefined, "pixel_6", "pixel_7", 2] as const) {
    const wrongProfile = structuredClone(workflows);
    const emulatorWithProfile = requiredSteps(requiredJob(wrongProfile.android, "android"), "android")
      .find((step) => step.uses === androidEmulatorAction);
    assert.ok(emulatorWithProfile?.with);
    if (hostileProfile === undefined) delete emulatorWithProfile.with.profile;
    else emulatorWithProfile.with.profile = hostileProfile;
    assert.throws(
      () => assertNativeWorkflowPolicy(wrongProfile),
      /Android emulator action inputs must remain exact/,
      `Android emulator must reject profile ${String(hostileProfile)}`,
    );
  }

  for (const hostileCores of [undefined, 2, 8, "4"] as const) {
    const wrongCores = structuredClone(workflows);
    const emulatorWithCores = requiredSteps(requiredJob(wrongCores.android, "android"), "android")
      .find((step) => step.uses === androidEmulatorAction);
    assert.ok(emulatorWithCores?.with);
    if (hostileCores === undefined) delete emulatorWithCores.with.cores;
    else emulatorWithCores.with.cores = hostileCores;
    assert.throws(
      () => assertNativeWorkflowPolicy(wrongCores),
      /Android emulator action inputs must remain exact/,
      `Android emulator must reject cores ${String(hostileCores)}`,
    );
  }

  const extraUnpinnedFamilyAction = structuredClone(workflows);
  requiredSteps(requiredJob(extraUnpinnedFamilyAction.android, "android"), "android").push({
    uses: "ReactiveCircus/android-emulator-runner@main",
    with: { script: "echo hostile" },
  });
  assert.throws(
    () => assertNativeWorkflowPolicy(extraUnpinnedFamilyAction),
    /exactly one emulator action family step/,
  );

  for (const hostileUses of [
    "reactivecircus/android-emulator-runner@main",
    "rEaCtIvEcIrCuS/AnDrOiD-EmUlAtOr-RuNnEr@main",
  ]) {
    const caseVariantFamilyAction = structuredClone(workflows);
    requiredSteps(requiredJob(caseVariantFamilyAction.android, "android"), "android").push({
      uses: hostileUses,
      with: { script: "echo hostile" },
    });
    assert.throws(
      () => assertNativeWorkflowPolicy(caseVariantFamilyAction),
      /exactly one emulator action family step/,
    );
  }

  const heredocDecoyStep = `      - run: |\n          cat <<'YAML'\n          - uses: ${androidEmulatorAction}\n            with:\n              script: bash scripts/e2e/run-android-emulator.sh\n          YAML\n`;
  const heredocDecoy = androidSource
    .replace("          script: bash scripts/e2e/run-android-emulator.sh", "          script: echo hostile")
    .replace(exactAndroidActionLine, `${heredocDecoyStep}${exactAndroidActionLine}`);
  assert.doesNotThrow(() => parseWorkflow(heredocDecoy, "heredoc-decoy Android"));
  assert.throws(
    () => pinnedAndroidActionScript(parseWorkflow(heredocDecoy, "heredoc-decoy Android")),
    /inputs must remain exact/,
  );

  const ciSource = await readFile(".github/workflows/ci.yml", "utf8");
  const commentedUbuntuSource = `# runs-on: macos-15-intel\n${ciSource.replace("runs-on: macos-15-intel", "runs-on: ubuntu-latest")}`;
  const ubuntuDespiteMatchingComment = structuredClone(workflows);
  ubuntuDespiteMatchingComment.ci = parseWorkflow(commentedUbuntuSource, "comment-camouflaged CI");
  assert.equal(requiredJob(ubuntuDespiteMatchingComment.ci, "static")["runs-on"], "ubuntu-latest");
  assert.throws(() => assertNativeWorkflowPolicy(ubuntuDespiteMatchingComment), /Static runner/);

  const disabledPreflight = structuredClone(workflows);
  const disabledStep = requiredSteps(requiredJob(disabledPreflight.ci, "static"), "static")
    .find((step) => step.name === "Preflight frozen native tooling");
  assert.ok(disabledStep);
  disabledStep.if = "${{ false }}";
  assert.throws(() => assertNativeWorkflowPolicy(disabledPreflight), /conditionally disabled/);

  const missingOfflineVerification = structuredClone(workflows);
  const missingOfflineStep = requiredSteps(requiredJob(missingOfflineVerification.ci, "static"), "static")
    .find((step) => step.name === whoProvisionStepName);
  assert.ok(missingOfflineStep && typeof missingOfflineStep.run === "string");
  missingOfflineStep.run = missingOfflineStep.run.replace(`${whoOfflineVerificationCommand}\n`, "");
  assert.throws(() => assertNativeWorkflowPolicy(missingOfflineVerification), /WHO cache provision script must remain exact/);

  const disabledWhoProvision = structuredClone(workflows);
  const disabledWhoStep = requiredSteps(requiredJob(disabledWhoProvision.ci, "static"), "static")
    .find((step) => step.name === whoProvisionStepName);
  assert.ok(disabledWhoStep);
  disabledWhoStep.if = "${{ false }}";
  assert.throws(() => assertNativeWorkflowPolicy(disabledWhoProvision), /WHO cache provision step must not be conditionally disabled/);

  const rawWhoUpload = structuredClone(workflows);
  const rawWhoUploadStep = requiredSteps(requiredJob(rawWhoUpload.ci, "static"), "static")
    .find((step) => step.uses === uploadArtifactAction && step.with?.name === `static-evidence-${exactHeadSha}`);
  assert.ok(rawWhoUploadStep?.with && typeof rawWhoUploadStep.with.path === "string");
  rawWhoUploadStep.with.path += "knowledge/sources/who-growth/**\n";
  assert.throws(() => assertNativeWorkflowPolicy(rawWhoUpload), /must not include raw or generated WHO data/);

  const missingStaticJson = structuredClone(workflows);
  const missingStaticJsonUpload = requiredSteps(requiredJob(missingStaticJson.ci, "static"), "static")
    .find((step) => step.uses === uploadArtifactAction && step.with?.name === `static-evidence-${exactHeadSha}`);
  assert.ok(missingStaticJsonUpload?.with && typeof missingStaticJsonUpload.with.path === "string");
  missingStaticJsonUpload.with.path = missingStaticJsonUpload.with.path.replace(".artifacts/static.json\n", "");
  assert.throws(() => assertNativeWorkflowPolicy(missingStaticJson), /must retain static.json/);

  const missingStaticUploadError = structuredClone(workflows);
  const staticUploadWithoutError = requiredSteps(requiredJob(missingStaticUploadError.ci, "static"), "static")
    .find((step) => step.uses === uploadArtifactAction);
  assert.ok(staticUploadWithoutError?.with);
  delete staticUploadWithoutError.with["if-no-files-found"];
  assert.throws(
    () => assertNativeWorkflowPolicy(missingStaticUploadError),
    /Static evidence upload inputs must remain exact/,
  );

  const hostileStaticPath = structuredClone(workflows);
  const staticUploadWithHostilePath = requiredSteps(requiredJob(hostileStaticPath.ci, "static"), "static")
    .find((step) => step.uses === uploadArtifactAction);
  assert.ok(staticUploadWithHostilePath?.with);
  staticUploadWithHostilePath.with.path = `${exactStaticUploadPath}.artifacts/hostile/**\n`;
  assert.throws(
    () => assertNativeWorkflowPolicy(hostileStaticPath),
    /Static evidence upload path must retain only the approved evidence and text bundles/,
  );

  const reorderedStaticUpload = structuredClone(workflows);
  const reorderedStaticSteps = requiredSteps(requiredJob(reorderedStaticUpload.ci, "static"), "static");
  const reorderedStaticUploadIndex = reorderedStaticSteps.findIndex((step) => step.uses === uploadArtifactAction);
  const reorderedStaticCollectorIndex = reorderedStaticSteps.findIndex((step) => step.run === exactStaticCollector);
  assert.ok(reorderedStaticUploadIndex > reorderedStaticCollectorIndex);
  const [movedStaticUpload] = reorderedStaticSteps.splice(reorderedStaticUploadIndex, 1);
  reorderedStaticSteps.splice(reorderedStaticCollectorIndex, 0, movedStaticUpload);
  assert.throws(
    () => assertNativeWorkflowPolicy(reorderedStaticUpload),
    /Static evidence upload must follow the static evidence collector/,
  );

  for (const hostileUses of [
    "actions/upload-artifact@main",
    "AcTiOnS/UpLoAd-ArTiFaCt@main",
  ]) {
    const deniedStaticUpload = structuredClone(workflows);
    requiredSteps(requiredJob(deniedStaticUpload.ci, "static"), "static").push({
      uses: hostileUses,
      with: {
        name: "hostile-static-WHO-data",
        path: "knowledge/sources/who-growth/**\n",
      },
    });
    assert.throws(
      () => assertNativeWorkflowPolicy(deniedStaticUpload),
      /Static job must contain exactly one artifact upload/,
    );
  }

  for (const [label, select] of [
    ["Static job", (candidate: NativeWorkflows) => requiredJob(candidate.ci, "static")],
    ["android job", (candidate: NativeWorkflows) => requiredJob(candidate.android, "android")],
    ["ios job", (candidate: NativeWorkflows) => requiredJob(candidate.ios, "ios")],
    ["android-e2e reusable CI job", (candidate: NativeWorkflows) => requiredJob(candidate.ci, "android-e2e")],
    ["ios-e2e reusable CI job", (candidate: NativeWorkflows) => requiredJob(candidate.ci, "ios-e2e")],
  ] as const) {
    for (const field of ["if", "continue-on-error"] as const) {
      const hostileJob = structuredClone(workflows);
      select(hostileJob)[field] = field === "if" ? "${{ false }}" : true;
      assert.throws(() => assertNativeWorkflowPolicy(hostileJob), new RegExp(`${label} must`));
    }
  }

  for (const [label, select] of [
    ["Static evidence collector", (candidate: NativeWorkflows) => requiredSteps(requiredJob(candidate.ci, "static"), "static").find((step) => step.run === exactStaticCollector)],
    ["Static evidence upload", (candidate: NativeWorkflows) => requiredSteps(requiredJob(candidate.ci, "static"), "static").find((step) => step.uses === uploadArtifactAction)],
  ] as const) {
    for (const field of ["if", "continue-on-error"] as const) {
      const hostileStep = structuredClone(workflows);
      const selected = select(hostileStep);
      assert.ok(selected);
      selected[field] = field === "if" ? "${{ false }}" : true;
      assert.throws(() => assertNativeWorkflowPolicy(hostileStep), new RegExp(`${label} must`));
    }
  }

  const camouflagedNdkSelector = structuredClone(workflows);
  const camouflagedPreflight = requiredSteps(requiredJob(camouflagedNdkSelector.ci, "static"), "static")
    .find((step) => step.name === "Preflight frozen native tooling");
  assert.ok(camouflagedPreflight && typeof camouflagedPreflight.run === "string");
  const divergentNdkSelector = 'const ndk = readdirSync(join(sdk, "ndk")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];';
  camouflagedPreflight.run = camouflagedPreflight.run
    .replace(exactNdkSelector, divergentNdkSelector)
    .replace("\nNODE\n", `\n// ${exactNdkSelector}\nNODE\n`);
  assert.ok(camouflagedPreflight.run.includes(divergentNdkSelector));
  assert.ok(camouflagedPreflight.run.includes(`// ${exactNdkSelector}`));
  assert.throws(() => assertNativeWorkflowPolicy(camouflagedNdkSelector), /Embedded Android preflight Node program/);

  const unpinnedIos = structuredClone(workflows);
  const unpinnedIosJob = requiredJob(unpinnedIos.ios, "ios");
  assert.ok(unpinnedIosJob.env);
  delete unpinnedIosJob.env.DEVELOPER_DIR;
  assert.throws(() => assertNativeWorkflowPolicy(unpinnedIos), /iOS job environment must remain exactly pinned/);

  const disabledIosPreflight = structuredClone(workflows);
  const disabledIosPreflightStep = requiredSteps(requiredJob(disabledIosPreflight.ios, "ios"), "ios")
    .find((step) => step.name === iosPreflightStepName);
  assert.ok(disabledIosPreflightStep);
  disabledIosPreflightStep.if = "${{ false }}";
  assert.throws(() => assertNativeWorkflowPolicy(disabledIosPreflight), /iOS toolchain preflight must not be conditional/);

  const weakenedSwiftFloor = structuredClone(workflows);
  const weakenedSwiftFloorStep = requiredSteps(requiredJob(weakenedSwiftFloor.ios, "ios"), "ios")
    .find((step) => step.name === iosPreflightStepName);
  assert.ok(weakenedSwiftFloorStep && typeof weakenedSwiftFloorStep.run === "string");
  weakenedSwiftFloorStep.run = weakenedSwiftFloorStep.run.replace("major < 6", "major < 5");
  assert.throws(() => assertNativeWorkflowPolicy(weakenedSwiftFloor), /iOS Xcode and Swift preflight must remain exact/);

  for (const [child, jobName] of [["android", "android"], ["ios", "ios"]] as const) {
    const wrongChildRef = structuredClone(workflows);
    const checkout = requiredSteps(requiredJob(wrongChildRef[child], jobName), jobName)
      .find((step) => step.uses === checkoutAction);
    assert.ok(checkout?.with);
    checkout.with.ref = "${{ github.sha }}";
    assert.throws(() => assertNativeWorkflowPolicy(wrongChildRef), new RegExp(`${jobName} checkout`));

    const wrongCollectorSha = structuredClone(workflows);
    const collector = requiredSteps(requiredJob(wrongCollectorSha[child], jobName), jobName)
      .find((step) => step.name === "Collect same-SHA evidence");
    assert.ok(collector && typeof collector.run === "string");
    collector.run = collector.run.replace(expectedShaInput, "${{ github.sha }}");
    assert.throws(() => assertNativeWorkflowPolicy(wrongCollectorSha), new RegExp(`${jobName} evidence collector command`));

    for (const [field, value] of [["if", "${{ false }}"], ["continue-on-error", true]] as const) {
      const disabledPrimaryUpload = structuredClone(workflows);
      const primaryUpload = requiredSteps(requiredJob(disabledPrimaryUpload[child], jobName), jobName)
        .find((step) => step.with?.name === `${jobName}-e2e-evidence-${expectedShaInput}`);
      assert.ok(primaryUpload);
      primaryUpload[field] = value;
      assert.throws(
        () => assertNativeWorkflowPolicy(disabledPrimaryUpload),
        new RegExp(`${jobName} primary evidence upload must`),
      );
    }

    const missingPlatformJson = structuredClone(workflows);
    const uploadWithoutPlatformJson = requiredSteps(requiredJob(missingPlatformJson[child], jobName), jobName)
      .find((step) => step.with?.name === `${jobName}-e2e-evidence-${expectedShaInput}`);
    assert.ok(uploadWithoutPlatformJson?.with && typeof uploadWithoutPlatformJson.with.path === "string");
    uploadWithoutPlatformJson.with.path = uploadWithoutPlatformJson.with.path.replace(`.artifacts/${jobName}-e2e.json\n`, "");
    assert.throws(
      () => assertNativeWorkflowPolicy(missingPlatformJson),
      new RegExp(`${jobName} primary evidence upload inputs must remain exact`),
    );

    const diagnosticsBeforeExecution = structuredClone(workflows);
    const reorderedChildSteps = requiredSteps(requiredJob(diagnosticsBeforeExecution[child], jobName), jobName);
    const diagnosticsIndex = reorderedChildSteps.findIndex(
      (step) => step.with?.name === `${jobName}-e2e-diagnostics-${expectedShaInput}`,
    );
    assert.ok(diagnosticsIndex > 0);
    const [movedDiagnostics] = reorderedChildSteps.splice(diagnosticsIndex, 1);
    reorderedChildSteps.unshift(movedDiagnostics);
    assert.throws(
      () => assertNativeWorkflowPolicy(diagnosticsBeforeExecution),
      new RegExp(`${jobName} diagnostics upload must follow the primary evidence upload`),
    );

    for (const hostileUses of ["actions/upload-artifact@main", "AcTiOnS/UpLoAd-ArTiFaCt@main"]) {
      const extraChildUpload = structuredClone(workflows);
      requiredSteps(requiredJob(extraChildUpload[child], jobName), jobName).push({
        uses: hostileUses,
        with: { name: `hostile-${jobName}-upload`, path: ".artifacts/**\n" },
      });
      assert.throws(
        () => assertNativeWorkflowPolicy(extraChildUpload),
        new RegExp(`${jobName} must contain exactly the approved primary and diagnostics artifact uploads`),
      );
    }
  }
});

test("static evidence is recorded only after all gates and requires explicit hashed result provenance", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  ordered(workflow,
    "deviceEvidenceValidator.mjs --fingerprint",
    "Record completed static gates",
    "> .artifacts/test-results/static-gates.log",
    "collect-ci-evidence.mjs",
    "--test-result pass --test-result-file .artifacts/test-results/static-gates.log",
    ".artifacts/static.json",
    ".artifacts/test-results/static-gates.log",
  );
});


const exactIosPersistenceStopHelper = 'stop() { xcrun simctl terminate "$udid" "$app_id"; }';
const exactIosPersistencePushHelper = `push_db() {
  test ! -s "$local_db-wal"
  sqlite3 "$device_db" ".restore '$local_db'"
  sqlite3 "$device_db" "PRAGMA wal_checkpoint(TRUNCATE);"
}`;

function assertIosPersistenceTerminatePolicy(wrapper: string): string {
  const terminateLines = wrapper
    .split(/\r\n|\n|\r/)
    .filter((line) => line.includes("simctl terminate"));
  assert.deepEqual(
    terminateLines,
    [exactIosPersistenceStopHelper],
    "iOS persistence stop helper must remain the exact fail-closed terminate command",
  );
  return terminateLines[0];
}

function assertIosPersistencePushPolicy(wrapper: string): void {
  const start = wrapper.indexOf("push_db() {");
  const end = wrapper.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, "iOS persistence push helper is absent");
  assert.equal(
    wrapper.slice(start, end + 2),
    exactIosPersistencePushHelper,
    "iOS persistence push must restore through SQLite and checkpoint without deleting live sidecars",
  );
}

function assertPersistenceWrapper(wrapper: string, platform: "android" | "ios") {
  assert.match(wrapper, /set -euo pipefail/);
  assert.match(wrapper, /-wal/);
  assert.match(wrapper, /-shm/);
  assert.match(wrapper, /recovered-noop\.json/);
  assert.match(wrapper, /bootstrap-retry\.yaml/);
  if (platform === "ios") {
    assertIosPersistenceTerminatePolicy(wrapper);
    assertIosPersistencePushPolicy(wrapper);
  }
  ordered(
    wrapper,
    'node tools/persistence-evidence.mjs --action corrupt-hash --database "$local_db"',
    "push_db; launch; error_screen",
    'node tools/persistence-evidence.mjs --action repair-hash --database "$local_db"',
    "push_db; retry; stop; pull_db",
    'node tools/persistence-evidence.mjs --action snapshot --database "$local_db" --output "$artifacts/retried.json"',
    'cp "$local_db" "$artifacts/canonical.db"',
    'rm -f "$local_db"',
    'node tools/persistence-evidence.mjs --action create-poison --database "$local_db"',
    'node tools/persistence-evidence.mjs --action poison-snapshot --database "$local_db" --output "$artifacts/poison-before.json"',
    "push_db; launch; error_screen; pull_db",
    'node tools/persistence-evidence.mjs --action poison-snapshot --database "$local_db" --output "$artifacts/poison-after.json"',
    'cp "$artifacts/canonical.db" "$local_db"',
    "push_db; retry; stop",
    `node tools/persistence-evidence.mjs --action report --platform ${platform}`,
    '--poison-before "$artifacts/poison-before.json" --poison-after "$artifacts/poison-after.json"',
    'rm -f "$artifacts"/*.db "$artifacts"/*.db-wal "$artifacts"/*.db-shm',
  );
}

const exactBootstrapErrorFlow = `appId: com.luyao618.formobile
---
- extendedWaitUntil:
    visible: "重试打开本机数据"
    timeout: 120000
`;

function assertBootstrapErrorFlow(flow: string) {
  assert.equal(flow, exactBootstrapErrorFlow, "bootstrap error flow bytes must remain exact");
}

test("Android persistence push preserves the nested shell payload as one adb argument", async () => {
  const wrapper = await readFile("scripts/e2e/run-persistence-android.sh", "utf8");
  const pushCommands = wrapper
    .split(/\r\n|\n|\r/)
    .filter((line) => line.includes("adb -s") && line.includes("cat /data/local/tmp/for-mobile-user.db"));
  assert.equal(pushCommands.length, 1, "Android persistence must contain exactly one database push command");

  const cwd = await mkdtemp(join(tmpdir(), "android-persistence-command-"));
  try {
    const result = spawnSync("bash", ["-c", `set -euo pipefail
adb() { printf '<%s>\\n' "$@"; }
serial=emulator-5554
app_id=com.luyao618.formobile
${pushCommands[0]}
`], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [
      "<-s>",
      "<emulator-5554>",
      "<shell>",
      "<run-as com.luyao618.formobile sh -c 'cat /data/local/tmp/for-mobile-user.db > files/SQLite/user.db && rm -f files/SQLite/user.db-wal files/SQLite/user.db-shm'>",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("iOS persistence termination is exact, fail closed, and rejects swallowed failures", async () => {
  const wrapper = await readFile("scripts/e2e/run-persistence-ios.sh", "utf8");
  const stopHelper = assertIosPersistenceTerminatePolicy(wrapper);
  const result = spawnSync("bash", ["-c", `set -euo pipefail
xcrun() {
  printf '<%s>\\n' "$@" >&2
  return 73
}
udid=simulator-udid
app_id=com.luyao618.formobile
${stopHelper}
stop
printf '%s\\n' evidence-collected
`], { encoding: "utf8" });
  assert.equal(result.status, 73, "a failed iOS termination must abort evidence collection");
  assert.equal(result.stdout, "", "no evidence step may run after a failed iOS termination");
  assert.deepEqual(result.stderr.trimEnd().split("\n"), [
    "<simctl>",
    "<terminate>",
    "<simulator-udid>",
    "<com.luyao618.formobile>",
  ], "iOS termination stderr must remain visible");

  for (const [label, hostileHelper] of [
    ["stderr suppression", 'stop() { xcrun simctl terminate "$udid" "$app_id" 2>/dev/null; }'],
    ["true swallow", 'stop() { xcrun simctl terminate "$udid" "$app_id" || true; }'],
    ["no-op swallow", 'stop() { xcrun simctl terminate "$udid" "$app_id" || :; }'],
    ["suppressed true swallow", 'stop() { xcrun simctl terminate "$udid" "$app_id" 2>/dev/null || true; }'],
  ] as const) {
    const mutation = wrapper.replace(exactIosPersistenceStopHelper, hostileHelper);
    assert.notEqual(mutation, wrapper, `${label} fixture must change the iOS persistence wrapper`);
    assert.throws(
      () => assertIosPersistenceTerminatePolicy(mutation),
      /exact fail-closed terminate command/,
      `${label} must be rejected`,
    );
  }
});

test("iOS persistence replacement uses SQLite restore and rejects live sidecar deletion", async () => {
  const wrapper = await readFile("scripts/e2e/run-persistence-ios.sh", "utf8");
  assertIosPersistencePushPolicy(wrapper);
  for (const [label, mutation] of [
    ["raw overwrite", wrapper.replace(exactIosPersistencePushHelper, 'push_db() { cp "$local_db" "$device_db"; }')],
    ["sidecar deletion", wrapper.replace("  sqlite3 \"$device_db\" \"PRAGMA wal_checkpoint(TRUNCATE);\"", '  rm -f "$device_db-wal" "$device_db-shm"')],
    ["missing checkpoint", wrapper.replace('  sqlite3 "$device_db" "PRAGMA wal_checkpoint(TRUNCATE);"\n', "")],
  ] as const) {
    assert.notEqual(mutation, wrapper, `${label} fixture must change the iOS persistence wrapper`);
    assert.throws(
      () => assertIosPersistencePushPolicy(mutation),
      /push helper is absent|restore through SQLite and checkpoint/,
      `${label} must be rejected`,
    );
  }

  const result = spawnSync("bash", ["-c", `set -euo pipefail
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
local_db="$directory/local.db"
device_db="$directory/device.db"
: > "$local_db"
sqlite3() { printf '<%s>\\n' "$@"; }
${exactIosPersistencePushHelper}
push_db
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const calls = result.stdout.trimEnd().split("\n");
  assert.equal(calls.length, 4);
  assert.match(calls[0]!, /^<.*\/device\.db>$/);
  const devicePath = calls[0]!.slice(1, -1);
  assert.deepEqual(calls, [
    `<${devicePath}>`,
    `<.restore '${devicePath.replace("device.db", "local.db")}'>`,
    `<${devicePath}>`,
    "<PRAGMA wal_checkpoint(TRUNCATE);>",
  ]);
});

test("persistence wrappers lock WAL-safe retry and rollback order with JSON-only uploads", async () => {
  const [android, ios, androidWorkflow, iosWorkflow, errorFlow] = await Promise.all([
    readFile("scripts/e2e/run-persistence-android.sh", "utf8"),
    readFile("scripts/e2e/run-persistence-ios.sh", "utf8"),
    readFile(".github/workflows/e2e-android.yml", "utf8"),
    readFile(".github/workflows/e2e-ios.yml", "utf8"),
    readFile("e2e/maestro/bootstrap-error.yaml", "utf8"),
  ]);
  assertBootstrapErrorFlow(errorFlow);
  for (const [label, mutation] of [
    ["grouped alert title", errorFlow.replace("重试打开本机数据", "无法打开本机数据")],
    ["generic fallback", errorFlow.replace("重试打开本机数据", "页面暂时无法显示")],
    ["optional wait", errorFlow.replace("    timeout: 120000", "    timeout: 120000\n    optional: true")],
  ]) {
    assert.notEqual(mutation, errorFlow, `${label} fixture must change the bootstrap error flow`);
    assert.throws(
      () => assertBootstrapErrorFlow(mutation),
      /bootstrap error flow bytes must remain exact/,
      `${label} must be rejected`,
    );
  }
  for (const [platform, wrapper] of [["android", android], ["ios", ios]] as const) {
    assertPersistenceWrapper(wrapper, platform);
    const mutations = [
      wrapper.replace("push_db; retry; stop; pull_db", "push_db; launch; ready; stop; pull_db"),
      wrapper.replace("push_db; retry; stop", "push_db; launch; ready; stop"),
      wrapper.replace("push_db; launch; error_screen; pull_db", "push_db; launch; error_screen; stop; pull_db"),
      wrapper.replace('node tools/persistence-evidence.mjs --action poison-snapshot --database "$local_db" --output "$artifacts/poison-before.json"\n', ""),
      wrapper.replace('poison-after.json"', 'poison-before.json"'),
      wrapper.replace('rm -f "$artifacts"/*.db "$artifacts"/*.db-wal "$artifacts"/*.db-shm', "true"),
    ];
    for (const mutation of mutations) assert.throws(() => assertPersistenceWrapper(mutation, platform));
  }
  for (const [platform, workflow] of [["android", androidWorkflow], ["ios", iosWorkflow]] as const) {
    assert(workflow.includes(`.artifacts/persistence/${platform}/*.json`));
    assert(!workflow.includes(`.artifacts/persistence/${platform}/**`));
    assert.doesNotMatch(workflow, /\.artifacts\/persistence\/.*\.db/);
    assert.match(workflow, new RegExp(`--persistence-report \\.artifacts/${platform}-persistence\\.json`));
  }
});

const exactProfileReadinessCommands = {
  android: 'maestro --device "$serial" test --debug-output .artifacts/launch/maestro/android-profile-pre-save-readiness e2e/maestro/shell-readiness.yaml 2>&1 | tee .artifacts/test-results/android-profile-pre-save-readiness.log',
  ios: 'maestro --device "$udid" test --debug-output .artifacts/launch/maestro/ios-profile-pre-save-readiness e2e/maestro/shell-readiness.yaml 2>&1 | tee .artifacts/test-results/ios-profile-pre-save-readiness.log',
} as const;

const exactAndroidProfilePidofHelper = `pidof_app() {
  local observation adb_status remote_status
  set +e
  observation=$(adb -s "$serial" shell "pidof -s '$app_id'; remote_status=\\$?; printf '__PIDOF_STATUS__=%s\\\\n' \\"\\$remote_status\\"" 2>&1)
  adb_status=$?
  set -e
  if [ "$adb_status" -ne 0 ]; then
    printf '%s\\n' "$observation" >&2
    return "$adb_status"
  fi
  observation=\${observation//$'\\r'/}
  if [ "$observation" = '__PIDOF_STATUS__=1' ]; then
    return 0
  fi
  if [[ "$observation" =~ ^([0-9]+)$'\\n'__PIDOF_STATUS__=0$ ]]; then
    printf '%s' "\${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$observation" =~ (^|$'\\n')__PIDOF_STATUS__=([0-9]+)$ ]]; then
    remote_status=\${BASH_REMATCH[2]}
    if [ "$remote_status" -gt 0 ] && [ "$remote_status" -lt 256 ]; then
      printf '%s\\n' "$observation" >&2
      return "$remote_status"
    fi
  fi
  printf 'Malformed remote pidof observation: %s\\n' "$observation" >&2
  return 1
}`;

const exactIosDeviceCalendarSource = `import Foundation

@main
struct IOSDeviceCalendar {
  static func main() {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd"
    print("\\(formatter.string(from: Date()))\\t\\(TimeZone.current.identifier)")
  }
}
`;

function assertIosDeviceCalendarPolicy(profile: string, query: string, source: string) {
  assert.equal(source, exactIosDeviceCalendarSource, "iOS calendar probe must use device-local Foundation date and time zone");
  assert.doesNotMatch(profile, /simctl spawn[^\n]*\bdate\b/);
  assert.doesNotMatch(query, /simctl spawn[^\n]*\bdate\b/);
  assert.match(query, /simulator_arch=\$\(uname -m\)\ncase "\$simulator_arch" in\n  arm64\|x86_64\)/);
  assert.match(query, /-target "\$\{simulator_arch\}-apple-ios13\.0-simulator"/);
  assert.match(query, /xcrun simctl spawn "\$udid" "\$probe"/);
  assert.match(query, /\[0-9\]\[0-9\]\[0-9\]\[0-9\]-\[0-9\]\[0-9\]-\[0-9\]\[0-9\]\) ;;/);
  assert.match(query, /Simulator calendar probe returned multiple lines/);
  assert.equal((profile.match(/device_calendar\)/g) ?? []).length, 3, "All iOS profile calendar reads must use the probe");
  ordered(
    profile,
    "save_pid=$(launch)",
    "read -r before_save_date time_zone < <(device_calendar)",
    "profile-save.yaml",
    "read -r after_save_date _ < <(device_calendar)",
    'terminate "$save_pid"',
    "relaunch_pid=$(launch)",
    "read -r after_relaunch_date _ < <(device_calendar)",
    "profile-restart.yaml",
  );
}

function assertProfileBootstrapReadiness(script: string, platform: "android" | "ios") {
  const readiness = exactProfileReadinessCommands[platform];
  assert.deepEqual(
    script.split(/\r\n|\n|\r/).filter((line) => line.includes("profile-pre-save-readiness")),
    [readiness],
    `${platform} profile bootstrap readiness must run exactly once`,
  );
  ordered(
    script,
    "pre_save_pid=$(launch)",
    readiness,
    'terminate "$pre_save_pid"',
    'pull_db "$artifacts/pre-save.db"',
    'profile-snapshot --database "$artifacts/pre-save.db"',
  );
}

function assertAndroidProfilePackageReadiness(script: string) {
  const lines = script.split(/\r\n|\n|\r/);
  assert.deepEqual(
    lines.filter((line) => line.includes("service check package")),
    [
      "  for _ in $(seq 1 60); do adb -s \"$serial\" shell service check package 2>/dev/null | tr -d '\\r' | grep -Fxq 'Service package: found' && break; sleep 2; done",
      "  adb -s \"$serial\" shell service check package 2>/dev/null | tr -d '\\r' | grep -Fxq 'Service package: found'",
    ],
    "Release install package-service readiness must be bounded and fail closed",
  );
  assert.deepEqual(
    lines.filter((line) => line.trim() === "wait_for_package_service"),
    ["wait_for_package_service", "    wait_for_package_service"],
    "Release install must wait after adb root and again before its sole transient retry",
  );
  ordered(
    script,
    'adb -s "$serial" root',
    'adb -s "$serial" wait-for-device',
    "wait_for_package_service\nadb",
    'uninstall "$app_id"',
    "if ! install_apk; then",
    "    wait_for_package_service",
    "    install_apk",
  );
}

function assertAndroidProfilePidofPolicy(script: string) {
  assert.equal(
    script.split(exactAndroidProfilePidofHelper).length - 1,
    1,
    "Android profile PID lookup must use the exact status-aware helper once",
  );
  assert.deepEqual(
    script.split(/\r\n|\n|\r/).filter((line) => line.includes("pidof -s")),
    ['  observation=$(adb -s "$serial" shell "pidof -s \'$app_id\'; remote_status=\\$?; printf \'__PIDOF_STATUS__=%s\\\\n\' \\"\\$remote_status\\"" 2>&1)'],
    "Android profile PID lookup must capture one status-marked remote observation without a pipefail-sensitive pipeline",
  );
  assert.equal((script.match(/\$\(pidof_app\)/g) ?? []).length, 3, "All Android profile PID probes must use the helper");
  assert.match(
    script,
    /stopped_pid=\$\(pidof_app\)\ntest -z "\$stopped_pid"/,
    "Android profile PID absence must preserve helper failure before checking for empty output",
  );
}

function assertNonPipelinedApkInspection(androidWorkflow: string, androidProfile: string) {
  assert.doesNotMatch(androidWorkflow, /unzip[^\n]*\|/);
  assert.doesNotMatch(androidProfile, /unzip[^\n]*\|/);
  ordered(
    androidWorkflow,
    "unzip -Z1 android/app/build/outputs/apk/release/app-release.apk > /tmp/g031-release-apk.entries",
    "grep -Eq '^assets/(index\\.android\\.bundle|index\\.bundle)$' /tmp/g031-release-apk.entries",
  );
  ordered(
    androidProfile,
    'apk_entries=$(unzip -Z1 "$release_apk")',
    "grep -Eq '^assets/(index\\.android\\.bundle|index\\.bundle)$' <<< \"$apk_entries\"",
  );
}

const exactProfileTabNavigation = `- runFlow:
    when:
      platform: iOS
    commands:
      - tapOn:
          id: "tab-MeTab"
          retryTapIfNoChange: true
- runFlow:
    when:
      platform: Android
    commands:
      - tapOn:
          id: "tab-MeTab"
- extendedWaitUntil:
    visible: "宝宝姓名"
    timeout: 120000`;

function assertProfileTabNavigation(flow: string) {
  assert.equal(
    flow.split(exactProfileTabNavigation).length - 1,
    1,
    "Profile navigation must use the exact tab identifier, the iOS no-change compatibility retry, and unique ready-form evidence",
  );
  assert.equal(flow.includes('- tapOn: "我的"'), false, "Profile navigation must not use the ambiguous tab text");
  assert.equal(flow.includes('visible: "宝宝资料"'), false, "Profile readiness must not accept the StewardScreen label");
  assert.equal((flow.match(/retryTapIfNoChange/g) ?? []).length, 1, "Only the first iOS profile-tab tap may retry on no UI change");
}

function assertProfileRestartFlowOrder(flow: string) {
  assert.equal((flow.match(/G031LeapBaby/g) ?? []).length, 1, "Restart must require the synthetic name exactly once");
  ordered(
    flow,
    'visible: "宝宝资料已保存在本机"',
    exactProfileTabNavigation,
    'assertNotVisible: "宝宝资料已保存"',
    'assertVisible: "G031LeapBaby"',
    'assertVisible: "${AGE_DISPLAY}"',
  );
}

const exactProfileTextInputs = [
  { label: "宝宝姓名", placeholder: "可暂不填", value: "G031LeapBaby" },
  { label: "出生日期", placeholder: "例如 2024-02-29", value: "2024-02-29" },
] as const;

const exactProfileNumericInputs = [
  { label: "出生体重（克）", placeholder: "100–10000", value: "3200" },
  { label: "出生身长（厘米）", placeholder: "10–100", value: "50.5" },
  { label: "出生头围（厘米）", placeholder: "10–80", value: "34.2" },
  { label: "出生孕周（周）", placeholder: "20–45，可暂不填", value: "36" },
] as const;

function exactProfileKeyboardDismissal(label: string): string {
  return `- runFlow:
    when:
      platform: Android
    commands:
      - hideKeyboard
- runFlow:
    when:
      platform: iOS
    commands:
      - tapOn: "${label}"`;
}

function assertProfileKeyboardDismissalPolicy(flow: string): void {
  assert.doesNotMatch(flow, /^- hideKeyboard(?:\s*:.*)?\s*$/m, "Profile save must not use universal hideKeyboard");
  assert.doesNotMatch(flow, /\b(?:optional|retry|sleep)\b/i, "Profile save must not mask dismissal failures");
  assert.doesNotMatch(flow, /^\s*(?:point|coordinates):/m, "Profile save must not use coordinate taps");
  for (const { label } of [...exactProfileTextInputs, ...exactProfileNumericInputs]) {
    assert.equal(
      flow.split(exactProfileKeyboardDismissal(label)).length - 1,
      1,
      `${label} must use one exact Android hideKeyboard then iOS static-label dismissal block`,
    );
    assert.equal(
      flow.split(`- tapOn: "${label}"`).length - 1,
      1,
      `${label} static label must be tapped only by its iOS dismissal branch`,
    );
  }
}

function assertProfileNameToBirthDateTransition(flow: string) {
  const [name, birthDate] = exactProfileTextInputs;
  const nameSelector = `^${name.placeholder}$`;
  const birthDateSelector = `^${birthDate.placeholder}$`;
  const transition = `- tapOn: "${nameSelector}"
- inputText: "${name.value}"
- assertVisible: "${name.value}"
${exactProfileKeyboardDismissal(name.label)}
- tapOn: "${birthDateSelector}"
- inputText: "${birthDate.value}"
${exactProfileKeyboardDismissal(birthDate.label)}
- assertVisible: "${birthDate.value}"`;
  assert.equal(
    flow.split(transition).length - 1,
    1,
    "Profile save must preserve anchored name-before-date entry with exact platform keyboard dismissal",
  );
  for (const { label, placeholder } of exactProfileTextInputs) {
    const selector = `^${placeholder}$`;
    assert.equal(flow.split(`- tapOn: "${selector}"`).length - 1, 1, `${label} exact placeholder must be tapped once`);
    assert.equal(flow.includes(`- tapOn: "${placeholder}"`), false, `${label} placeholder selector must stay anchored`);
  }
}

function assertProfileNumericInputTargeting(flow: string) {
  for (const { label, placeholder, value } of exactProfileNumericInputs) {
    const selector = `^${placeholder}$`;
    const exactInputSequence = `- scrollUntilVisible:
    element:
      text: "${selector}"
    direction: DOWN
- tapOn: "${selector}"
- inputText: "${value}"
${exactProfileKeyboardDismissal(label)}
- assertVisible: "${value}"`;
    assert.equal(
      flow.split(exactInputSequence).length - 1,
      1,
      `${label} must preserve anchored entry, platform dismissal, and value assertion order`,
    );
    assert.equal(
      flow.split(selector).length - 1,
      2,
      `${label} anchored placeholder must appear only in its scroll and tap selectors`,
    );
    assert.equal(flow.includes(`- tapOn: "${placeholder}"`), false, `${label} tap selector must stay anchored`);
    assert.equal(flow.includes(`      text: "${placeholder}"`), false, `${label} scroll selector must stay anchored`);
    assert.equal(flow.includes(`      text: "${label}"`), false, `${label} must not be used as the scroll target`);
  }
}

const exactProfileSaveVisibilitySequence = `- tapOn: "保存宝宝资料"
- scrollUntilVisible:
    element:
      text: "^宝宝资料已保存$"
    direction: DOWN
- assertVisible: "^宝宝资料已保存$"
- scrollUntilVisible:
    element:
      text: "G031LeapBaby"
    direction: UP`;

function assertProfileSaveVisibilityPolicy(flow: string): void {
  assert.equal(
    flow.split(exactProfileSaveVisibilitySequence).length - 1,
    1,
    "Profile save must scroll DOWN to the exact success message, assert it, then scroll UP to the saved name",
  );
  assert.equal(
    (flow.match(/\^宝宝资料已保存\$/g) ?? []).length,
    2,
    "Profile save must use the exact anchored success message only for its scroll and visible assertion",
  );
  assert.doesNotMatch(flow, /\boptional\s*:/i, "Profile save visibility commands must remain mandatory");
  assert.doesNotMatch(flow, /^\s*(?:point|coordinates):/m, "Profile save visibility must not use coordinates");
  assert.doesNotMatch(flow, /\bsleep\s*(?:\(|:|\d)/i, "Profile save visibility must not use sleeps");
  assert.doesNotMatch(flow, /^- retry\s*:/m, "Profile save visibility must not use broad retries");
}

test("G031 native policy preserves Debug evidence before one-way offline Release profile proof", async () => {
  const [androidWorkflow, iosWorkflow, androidRunner, androidProfile, iosProfile, iosCalendarQuery, iosCalendarSource, saveFlow, restartFlow] = await Promise.all([
    readFile(".github/workflows/e2e-android.yml", "utf8"),
    readFile(".github/workflows/e2e-ios.yml", "utf8"),
    readFile("scripts/e2e/run-android-emulator.sh", "utf8"),
    readFile("scripts/e2e/run-profile-restart-android.sh", "utf8"),
    readFile("scripts/e2e/run-profile-restart-ios.sh", "utf8"),
    readFile("scripts/e2e/query-ios-device-calendar.sh", "utf8"),
    readFile("scripts/e2e/ios-device-calendar.swift", "utf8"),
    readFile("e2e/maestro/profile-save.yaml", "utf8"),
    readFile("e2e/maestro/profile-restart.yaml", "utf8"),
  ]);
  for (const script of ["scripts/e2e/run-android-emulator.sh", "scripts/e2e/run-profile-restart-android.sh", "scripts/e2e/run-profile-restart-ios.sh", "scripts/e2e/query-ios-device-calendar.sh"]) {
    assert.equal(spawnSync("bash", ["-n", script]).status, 0, `${script} must be valid Bash`);
  }
  assert.equal((androidWorkflow.match(/:app:assembleRelease/g) ?? []).length, 1, "Android Release must build exactly once");
  assert.equal((iosWorkflow.match(/-configuration Release/g) ?? []).length, 1, "iOS Release must build exactly once");
  ordered(androidRunner,
    "bash scripts/e2e/run-persistence-android.sh",
    'kill -- "-$metro_pid"', 'wait "$metro_pid"', "metro_pid=",
    'adb -s "$emulator_serial" reverse --remove tcp:8081',
    "curl --silent --fail http://127.0.0.1:8081/status",
    "bash scripts/e2e/run-profile-restart-android.sh",
  );
  ordered(iosWorkflow,
    "bash scripts/e2e/run-persistence-ios.sh",
    'kill -- "-$metro_pid"', 'wait "$metro_pid"', "metro_pid=",
    "curl --silent --fail http://127.0.0.1:8081/status",
    "bash scripts/e2e/run-profile-restart-ios.sh",
  );
  for (const [platform, script] of [["android", androidProfile], ["ios", iosProfile]] as const) {
    assert.match(script, /profile-snapshot/);
    assert.match(script, /age-oracle/);
    assert.match(script, /profile-report/);
    assert.match(script, /profile-save\.yaml/);
    assert.match(script, /profile-restart\.yaml/);
    assert.doesNotMatch(script, /run-persistence|seed-recovery|push_db|openurl|android\.intent\.action\.VIEW|expo start/);
    assert.match(script, new RegExp(`\\.artifacts/${platform}-profile-restart\\.json`));
  }
  assert.equal((androidProfile.match(/shell am start -a android\.intent\.action\.MAIN -c android\.intent\.category\.LAUNCHER/g) ?? []).length, 1);
  assert.equal((androidProfile.match(/ install --no-streaming /g) ?? []).length, 1);
  assert.equal((androidProfile.match(/ uninstall /g) ?? []).length, 1);
  assert.equal((iosProfile.match(/xcrun simctl launch /g) ?? []).length, 1);
  assert.equal((iosProfile.match(/xcrun simctl install /g) ?? []).length, 1);
  assert.equal((iosProfile.match(/xcrun simctl uninstall /g) ?? []).length, 1);
  assertAndroidProfilePackageReadiness(androidProfile);
  assertAndroidProfilePidofPolicy(androidProfile);
  assertNonPipelinedApkInspection(androidWorkflow, androidProfile);
  assertProfileBootstrapReadiness(androidProfile, "android");
  assertProfileBootstrapReadiness(iosProfile, "ios");
  assertIosDeviceCalendarPolicy(iosProfile, iosCalendarQuery, iosCalendarSource);
  assertProfileTabNavigation(saveFlow);
  assertProfileTabNavigation(restartFlow);
  assertProfileKeyboardDismissalPolicy(saveFlow);
  assertProfileNameToBirthDateTransition(saveFlow);
  assertProfileNumericInputTargeting(saveFlow);
  assertProfileSaveVisibilityPolicy(saveFlow);
  assertProfileRestartFlowOrder(restartFlow);
  for (const flow of [saveFlow, restartFlow]) {
    for (const value of ["G031LeapBaby", "2024-02-29", "3200", "50.5", "34.2", "36", "${AGE_DISPLAY}"]) assert.match(flow, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(flow, /性别女孩/);
    assert.match(flow, /早产/);
  }
  assert.match(saveFlow, /宝宝资料已保存/);
  assert.match(restartFlow, /assertNotVisible: "宝宝资料已保存"/);
});

test("G031 hostile policy rejects Release readiness, pipefail, APK inspection, keyboard, save visibility, and restart-order regressions", async () => {
  const [androidWorkflow, androidProfile, iosProfile, iosCalendarQuery, iosCalendarSource, saveFlow, restartFlow] = await Promise.all([
    readFile(".github/workflows/e2e-android.yml", "utf8"),
    readFile("scripts/e2e/run-profile-restart-android.sh", "utf8"),
    readFile("scripts/e2e/run-profile-restart-ios.sh", "utf8"),
    readFile("scripts/e2e/query-ios-device-calendar.sh", "utf8"),
    readFile("scripts/e2e/ios-device-calendar.swift", "utf8"),
    readFile("e2e/maestro/profile-save.yaml", "utf8"),
    readFile("e2e/maestro/profile-restart.yaml", "utf8"),
  ]);

  const packageMutations = [
    androidProfile.replace("wait_for_package_service\nadb", "adb"),
    androidProfile.replace('adb -s "$serial" uninstall "$app_id" >/dev/null\nif ! install_apk; then', 'if ! install_apk; then\nadb -s "$serial" uninstall "$app_id" >/dev/null'),
    androidProfile.replace("    wait_for_package_service\n    install_apk", "    install_apk"),
  ];
  for (const mutation of packageMutations) {
    assert.notEqual(mutation, androidProfile, "package readiness mutation must change the wrapper");
    assert.throws(() => assertAndroidProfilePackageReadiness(mutation));
  }

  for (const [platform, script] of [["android", androidProfile], ["ios", iosProfile]] as const) {
    const readiness = exactProfileReadinessCommands[platform];
    const mutation = script.replace(`${readiness}\nterminate "$pre_save_pid"`, `terminate "$pre_save_pid"\n${readiness}`);
    assert.notEqual(mutation, script, `${platform} bootstrap mutation must change the wrapper`);
    assert.throws(() => assertProfileBootstrapReadiness(mutation, platform));
  }

  for (const [label, profile, query, source] of [
    ["bare date", iosProfile.replace("bash scripts/e2e/query-ios-device-calendar.sh \"$udid\"", 'xcrun simctl spawn "$udid" date +%Y-%m-%d'), iosCalendarQuery, iosCalendarSource],
    ["host target", iosProfile, iosCalendarQuery.replace('-target "${simulator_arch}-apple-ios13.0-simulator"', '-target "arm64-apple-macos15.0"'), iosCalendarSource],
    ["missing multiline guard", iosProfile, iosCalendarQuery.replace('case "$output" in *$\'\\n\'*) echo "Simulator calendar probe returned multiple lines" >&2; exit 1 ;; esac\n', ""), iosCalendarSource],
    ["host time zone", iosProfile, iosCalendarQuery, iosCalendarSource.replace("TimeZone.current.identifier", "ProcessInfo.processInfo.environment[\"TZ\"] ?? \"UTC\"")],
  ] as const) {
    assert.throws(() => assertIosDeviceCalendarPolicy(profile, query, source), label);
  }

  const calendarHarness = async (output: string, architecture = "arm64") => {
    const root = await mkdtemp(join(tmpdir(), "g031-ios-calendar-"));
    const bin = join(root, "bin");
    const log = join(root, "calls.log");
    await mkdir(bin);
    await writeFile(join(bin, "uname"), `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(architecture)}\n`);
    await writeFile(join(bin, "xcrun"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "--sdk" ]; then
  probe=; previous=
  for argument in "$@"; do [ "$previous" != "-o" ] || probe=$argument; previous=$argument; done
  : > "$probe"
  exit 0
fi
printf '%b' ${JSON.stringify(output)}
`);
    await chmod(join(bin, "uname"), 0o755);
    await chmod(join(bin, "xcrun"), 0o755);
    const result = spawnSync("bash", ["scripts/e2e/query-ios-device-calendar.sh", "simulator-udid"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: root },
    });
    const calls = await readFile(log, "utf8").catch(() => "");
    await rm(root, { recursive: true, force: true });
    return { ...result, calls };
  };
  const validCalendar = await calendarHarness("2026-07-18\\tAsia/Shanghai\\r\\n");
  assert.equal(validCalendar.status, 0, validCalendar.stderr);
  assert.equal(validCalendar.stdout, "2026-07-18\tAsia/Shanghai\n");
  assert.match(validCalendar.calls, /--sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios13\.0-simulator/);
  assert.match(validCalendar.calls, /simctl spawn simulator-udid .*\/device-calendar/);
  for (const hostile of [
    await calendarHarness("2026-7-18\\tAsia/Shanghai\\n"),
    await calendarHarness("2026-07-18\\tAsia/Shanghai\\textra\\n"),
    await calendarHarness("2026-07-18\\tAsia/Shanghai\\n2026-07-19\\tUTC\\n"),
    await calendarHarness("2026-07-18\\t\\n"),
    await calendarHarness("2026-07-18\\tUTC\\n", "riscv64"),
  ]) assert.notEqual(hostile.status, 0, `hostile calendar output survived: ${hostile.stdout}`);

  const pidPipelineMutation = androidProfile.replace(
    exactAndroidProfilePidofHelper,
    'pidof_app() { adb -s "$serial" shell pidof -s "$app_id" 2>/dev/null | tr -d \'\\r\'; }',
  );
  assert.notEqual(pidPipelineMutation, androidProfile);
  assert.throws(() => assertAndroidProfilePidofPolicy(pidPipelineMutation));

  const pidTransportFailure = spawnSync("bash", ["-c", `set -euo pipefail
adb() { printf '%s\\n' 'adb transport unavailable' >&2; return 1; }
serial=emulator-5554
app_id=com.luyao618.formobile
${exactAndroidProfilePidofHelper}
pid=$(pidof_app)
test -z "$pid"
`], { encoding: "utf8" });
  assert.equal(pidTransportFailure.status, 1);
  assert.match(pidTransportFailure.stderr, /adb transport unavailable/);

  const pidRemoteNoProcess = spawnSync("bash", ["-c", `set -euo pipefail
adb() { printf '%s\\n' '__PIDOF_STATUS__=1'; return 0; }
serial=emulator-5554
app_id=com.luyao618.formobile
${exactAndroidProfilePidofHelper}
pid=$(pidof_app)
test -z "$pid"
printf '%s\\n' accepted-remote-no-process
`], { encoding: "utf8" });
  assert.equal(pidRemoteNoProcess.status, 0, pidRemoteNoProcess.stderr);
  assert.equal(pidRemoteNoProcess.stdout, "accepted-remote-no-process\n");

  for (const output of ["", "123", "abc\\n__PIDOF_STATUS__=0", "123\\n__PIDOF_STATUS__=1", "123\\n__PIDOF_STATUS__=999"]) {
    const malformedPid = spawnSync("bash", ["-c", `set -euo pipefail
adb() { printf '%b' ${JSON.stringify(output)}; return 0; }
serial=emulator-5554
app_id=com.luyao618.formobile
${exactAndroidProfilePidofHelper}
pid=$(pidof_app)
`], { encoding: "utf8" });
    assert.notEqual(malformedPid.status, 0, `malformed pidof observation survived: ${JSON.stringify(output)}`);
  }

  const workflowPipelineMutation = androidWorkflow.replace(
    "unzip -Z1 android/app/build/outputs/apk/release/app-release.apk > /tmp/g031-release-apk.entries\n          grep -Eq '^assets/(index\\.android\\.bundle|index\\.bundle)$' /tmp/g031-release-apk.entries",
    "unzip -l android/app/build/outputs/apk/release/app-release.apk | grep -Eq 'assets/(index\\.android\\.bundle|index\\.bundle)'",
  );
  const profilePipelineMutation = androidProfile.replace(
    'apk_entries=$(unzip -Z1 "$release_apk")\ngrep -Eq \'^assets/(index\\.android\\.bundle|index\\.bundle)$\' <<< "$apk_entries"',
    'unzip -l "$release_apk" | grep -Eq \'assets/(index\\.android\\.bundle|index\\.bundle)\'',
  );
  assert.notEqual(workflowPipelineMutation, androidWorkflow);
  assert.notEqual(profilePipelineMutation, androidProfile);
  assert.throws(() => assertNonPipelinedApkInspection(workflowPipelineMutation, androidProfile));
  assert.throws(() => assertNonPipelinedApkInspection(androidWorkflow, profilePipelineMutation));

  const nameDismissal = exactProfileKeyboardDismissal("宝宝姓名");
  const androidDismissal = `- runFlow:
    when:
      platform: Android
    commands:
      - hideKeyboard`;
  const iosDismissal = `- runFlow:
    when:
      platform: iOS
    commands:
      - tapOn: "宝宝姓名"`;
  const keyboardMutations = [
    ["missing Android branch", saveFlow.replace(nameDismissal, iosDismissal)],
    ["missing iOS branch", saveFlow.replace(nameDismissal, androidDismissal)],
    ["wrong Android platform", saveFlow.replace(nameDismissal, nameDismissal.replace("platform: Android", "platform: Web"))],
    ["wrong iOS platform", saveFlow.replace(nameDismissal, nameDismissal.replace("platform: iOS", "platform: Web"))],
    ["reordered platform branches", saveFlow.replace(nameDismissal, `${iosDismissal}\n${androidDismissal}`)],
    ["universal hideKeyboard", saveFlow.replace(nameDismissal, "- hideKeyboard")],
    ["wrong iOS label", saveFlow.replace(nameDismissal, nameDismissal.replace('tapOn: "宝宝姓名"', 'tapOn: "出生日期"'))],
    ["retry", `${saveFlow}\n- retry: 2\n`],
    ["sleep", `${saveFlow}\n- evalScript: "sleep(1000)"\n`],
    ["optional command", `${saveFlow}\n- tapOn:\n    text: "宝宝姓名"\n    optional: true\n`],
    ["coordinate tap", `${saveFlow}\n- tapOn:\n    point: "50%,50%"\n`],
  ] as const;
  for (const [label, mutation] of keyboardMutations) {
    assert.notEqual(mutation, saveFlow, `${label} mutation must change the flow`);
    assert.throws(() => assertProfileKeyboardDismissalPolicy(mutation), label);
  }

  for (const { label, placeholder } of exactProfileTextInputs) {
    const selector = `^${placeholder}$`;
    const labelTapMutation = saveFlow.replace(`- tapOn: "${selector}"`, `- tapOn: "${label}"`);
    assert.notEqual(labelTapMutation, saveFlow, `${label} label-tap mutation must change the flow`);
    assert.throws(() => assertProfileNameToBirthDateTransition(labelTapMutation));

    const unanchoredTapMutation = saveFlow.replace(`- tapOn: "${selector}"`, `- tapOn: "${placeholder}"`);
    assert.notEqual(unanchoredTapMutation, saveFlow, `${label} unanchored-tap mutation must change the flow`);
    assert.throws(() => assertProfileNameToBirthDateTransition(unanchoredTapMutation));
  }

  for (const { label, placeholder } of exactProfileNumericInputs) {
    const selector = `^${placeholder}$`;
    const labelTapMutation = saveFlow.replace(`- tapOn: "${selector}"`, `- tapOn: "${label}"`);
    assert.notEqual(labelTapMutation, saveFlow, `${label} label-tap mutation must change the flow`);
    assert.throws(() => assertProfileNumericInputTargeting(labelTapMutation));

    const labelScrollMutation = saveFlow.replace(`      text: "${selector}"`, `      text: "${label}"`);
    assert.notEqual(labelScrollMutation, saveFlow, `${label} label-scroll mutation must change the flow`);
    assert.throws(() => assertProfileNumericInputTargeting(labelScrollMutation));

    const unanchoredTapMutation = saveFlow.replace(`- tapOn: "${selector}"`, `- tapOn: "${placeholder}"`);
    assert.notEqual(unanchoredTapMutation, saveFlow, `${label} unanchored-tap mutation must change the flow`);
    assert.throws(() => assertProfileNumericInputTargeting(unanchoredTapMutation));

    const unanchoredScrollMutation = saveFlow.replace(`      text: "${selector}"`, `      text: "${placeholder}"`);
    assert.notEqual(unanchoredScrollMutation, saveFlow, `${label} unanchored-scroll mutation must change the flow`);
    assert.throws(() => assertProfileNumericInputTargeting(unanchoredScrollMutation));
  }

  const exactSuccessScroll = `- scrollUntilVisible:
    element:
      text: "^宝宝资料已保存$"
    direction: DOWN`;
  const exactSuccessAssertion = '- assertVisible: "^宝宝资料已保存$"';
  const saveVisibilityMutations = [
    ["direct off-screen wait", saveFlow.replace(
      `${exactSuccessScroll}\n${exactSuccessAssertion}`,
      `- extendedWaitUntil:\n    visible: "^宝宝资料已保存$"\n    timeout: 30000`,
    )],
    ["missing success scroll", saveFlow.replace(`${exactSuccessScroll}\n`, "")],
    ["ambiguous success message", saveFlow.replaceAll("^宝宝资料已保存$", "宝宝资料已保存")],
    ["wrong success scroll direction", saveFlow.replace(exactSuccessScroll, exactSuccessScroll.replace("direction: DOWN", "direction: UP"))],
    ["optional success assertion", saveFlow.replace(exactSuccessAssertion, '- assertVisible:\n    text: "^宝宝资料已保存$"\n    optional: true')],
    ["coordinate fallback", saveFlow.replace('- tapOn: "保存宝宝资料"', '- tapOn: "保存宝宝资料"\n- tapOn:\n    point: "50%,90%"')],
    ["sleep fallback", saveFlow.replace('- tapOn: "保存宝宝资料"', '- tapOn: "保存宝宝资料"\n- evalScript: "sleep(1000)"')],
    ["broad retry fallback", saveFlow.replace('- tapOn: "保存宝宝资料"', '- tapOn: "保存宝宝资料"\n- retry: 2')],
  ] as const;
  for (const [label, mutation] of saveVisibilityMutations) {
    assert.notEqual(mutation, saveFlow, `${label} mutation must change the flow`);
    assert.throws(() => assertProfileSaveVisibilityPolicy(mutation), label);
  }

  for (const [label, flow] of [["save", saveFlow], ["restart", restartFlow]] as const) {
    const navigationMutations = [
      flow.replace('id: "tab-MeTab"', 'text: "我的"'),
      flow.replace("          retryTapIfNoChange: true\n", ""),
      flow.replace('visible: "宝宝姓名"', 'visible: "宝宝资料"'),
      flow.replace("      platform: iOS", "      platform: Android"),
    ];
    for (const mutation of navigationMutations) {
      assert.notEqual(mutation, flow, `${label} navigation mutation must change the flow`);
      assert.throws(() => assertProfileTabNavigation(mutation), `${label} hostile navigation mutation`);
    }
  }

  const restartOrderMutation = restartFlow.replace(exactProfileTabNavigation, `- assertVisible: "G031LeapBaby"\n${exactProfileTabNavigation}`);
  assert.notEqual(restartOrderMutation, restartFlow);
  assert.throws(() => assertProfileRestartFlowOrder(restartOrderMutation));
});
