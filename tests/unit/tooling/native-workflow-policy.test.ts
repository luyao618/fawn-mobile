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
  android: ".artifacts/android-e2e.json\n.artifacts/config/android-*.json\n.artifacts/schemes/android-*.json\n.artifacts/native/android/**\n.artifacts/launch/android-dev-client.log\n.artifacts/test-results/android-maestro.log\n",
  ios: ".artifacts/ios-e2e.json\n.artifacts/config/ios-*.json\n.artifacts/schemes/ios-*.json\n.artifacts/native/ios/**\n.artifacts/launch/ios-dev-client.log\n.artifacts/test-results/ios-maestro.log\n",
} as const;
const forbiddenStaticUploadPath = /knowledge\/sources|knowledge\/generated|\.xlsx|fawn-slice0-who-reference\.csv|who-growth-reference\.csv/i;
const exactAndroidRunnerSha256 = "e272007ff603cc226494cf21f1f0707205b8de43430c1dc7721e0ae662440449";
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
  --output .artifacts/android-e2e.json` + "\n",
  ios: String.raw`node tools/collect-ci-evidence.mjs \
  --expected-sha "${expectedShaInput}" --platform ios --flavor e2e \
  --test-result pass --test-result-file .artifacts/test-results/ios-maestro.log \
  --config-report-production .artifacts/config/ios-production.json \
  --config-report-e2e .artifacts/config/ios-e2e.json \
  --scheme-report-production .artifacts/schemes/ios-production.json \
  --scheme-report-e2e .artifacts/schemes/ios-e2e.json \
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
    profile: "pixel_6",
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
    const e2ePrebuildIndex = stepIndex(steps, (step) => step.name === "Clean-prebuild, inspect, and build E2E", "Android E2E prebuild");
    const emulatorIndex = stepIndex(steps, (step) => usesActionRepository(step, androidEmulatorRepository), "Android emulator");
    const e2ePrebuild = steps[e2ePrebuildIndex];
    assert.ok(typeof e2ePrebuild.run === "string", "Android E2E prebuild must have an enabled run script");
    assert.deepEqual(
      e2ePrebuild.run.split(/\r\n|\n|\r/).filter((line) => line.trim().includes("gradlew")),
      [exactAndroidBuildCommand],
      "Android E2E prebuild must contain only the exact x86_64 build command",
    );
    assert.ok(e2ePrebuildIndex < emulatorIndex, "Android x86_64 E2E build must complete before the emulator action");
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
const exactDevClientUrlAssignment = `dev_client_url='${encodedDevClientUrl}'`;
const exactAndroidBuildCommand = "(cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --no-daemon)";
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
const exactAndroidFailurePidCommand = String.raw`    app_pid=$(adb -s "$emulator_serial" shell pidof -s com.luyao618.formobile 2>/dev/null | tr -d "\r")`;
const exactAndroidFailureLogCommand = '      adb -s "$emulator_serial" logcat -d --pid="$app_pid" > .artifacts/launch/device/android-app.log 2>&1';
const exactAndroidFallbackLogCommand = "      adb -s \"$emulator_serial\" logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V '*:S' > .artifacts/launch/device/android-app.log 2>&1";
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
- assertVisible: "本机设置尚未启用"
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
    exactMetroStatusLines,
    `${platform} Metro status probes must remain exactly the bounded retry loop and final IPv4 probe in order`,
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
  const maestroLines = lines.filter((line) => /^maestro /.test(line));
  assert.deepEqual(
    maestroLines,
    [exactReadinessCommands.Android, exactAndroidSmokeCommand],
    "Android Maestro commands must retain distinct exact debug-output directories",
  );
  const cleanupStart = lines.indexOf("cleanup() {");
  const cleanupEnd = lines.indexOf("trap cleanup EXIT", cleanupStart + 1);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "Android cleanup function and EXIT trap must remain exact");
  const cleanupLines = [
    "cleanup() {",
    "  status=$?",
    "  trap - EXIT",
    "  set +e",
    '  if [ "$status" -ne 0 ]; then',
    exactAndroidFailureScreenshotCommand,
    exactAndroidFailureHierarchyCommand,
    exactAndroidFailurePidCommand,
    '    if [ -n "$app_pid" ]; then',
    exactAndroidFailureLogCommand,
    "    else",
    exactAndroidFallbackLogCommand,
    "    fi",
    "  fi",
    '  if [ -n "$metro_pid" ]; then',
    '    kill "$metro_pid" 2>/dev/null',
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
    '  kill "$metro_pid" 2>/dev/null',
    "  cat /tmp/metro.log",
    '  exit "$status"',
    "}",
    "trap cleanup EXIT",
  ];
  const cleanupIndexes = cleanupLines.map((line) => lines.indexOf(line));
  assert.ok(
    cleanupIndexes.every((index, position) => index >= 0 && (position === 0 || index > cleanupIndexes[position - 1])),
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
      options: { metroPid?: string; metroLogPresent?: boolean } = {},
    ) => {
      const { metroPid = "424242", metroLogPresent = true } = options;
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
adb() {
  printf '%s\\n' "$*" >> "$HARNESS_ADB_LOG"
  case "$*" in
    *"screencap -p") printf 'png-sentinel' ;;
    *"uiautomator dump /dev/tty") printf 'hierarchy-sentinel' ;;
    *"pidof -s com.luyao618.formobile") printf '%s' "$HARNESS_APP_PID" ;;
    *"logcat -d --pid="*) printf 'pid-logcat-sentinel' ;;
    *"logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V *:S") printf 'logcat-sentinel' ;;
  esac
}
kill() { printf 'kill %s\\n' "$*" >> "$HARNESS_ADB_LOG"; }
wait() { printf 'wait %s\\n' "$*" >> "$HARNESS_ADB_LOG"; }
${cleanup}
exit ${status}
`;
      return spawnSync("bash", { encoding: "utf8", input: harness, env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_ADB_LOG: adbLog,
        HARNESS_APP_PID: appPid,
        HARNESS_METRO_PID: metroPid,
        HARNESS_METRO_LOG: metroLog,
      } });
    };

    const emptyCleanup = await runCleanup(0, "", { metroPid: "", metroLogPresent: false });
    assert.equal(emptyCleanup.status, 0, emptyCleanup.stderr);
    assert.equal(emptyCleanup.stdout, "");
    assert.doesNotMatch(await readFile(adbLog, "utf8"), /^(?:kill|wait) /m);

    const success = await runCleanup(0);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, "metro-sentinel\n");
    assert.match(await readFile(adbLog, "utf8"), /^kill 424242$/m);
    assert.match(await readFile(adbLog, "utf8"), /^wait 424242$/m);
    await assert.rejects(readFile(join(root, ".artifacts/launch/device/android-failure.png")));
    await assert.rejects(readFile(join(root, ".artifacts/launch/device/android-ui-hierarchy.xml")));
    await assert.rejects(readFile(join(root, ".artifacts/launch/device/android-app.log")));

    const pidFailure = await runCleanup(37, "1234");
    assert.equal(pidFailure.status, 37, pidFailure.stderr);
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-failure.png"), "utf8"), "png-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-ui-hierarchy.xml"), "utf8"), "hierarchy-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-app.log"), "utf8"), "pid-logcat-sentinel");
    assert.match(await readFile(adbLog, "utf8"), /logcat -d --pid=1234/);
    assert.doesNotMatch(await readFile(adbLog, "utf8"), /logcat -d -s AndroidRuntime/);

    const fallbackFailure = await runCleanup(38);
    assert.equal(fallbackFailure.status, 38, fallbackFailure.stderr);
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-failure.png"), "utf8"), "png-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-ui-hierarchy.xml"), "utf8"), "hierarchy-sentinel");
    assert.equal(await readFile(join(root, ".artifacts/launch/device/android-app.log"), "utf8"), "logcat-sentinel");
    assert.match(await readFile(adbLog, "utf8"), /logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V \*:S/);
    assert.doesNotMatch(await readFile(adbLog, "utf8"), /logcat -d --pid=/);
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

    const localhostStatusProbes = script.replaceAll(
      "http://127.0.0.1:8081/status",
      "http://localhost:8081/status",
    );
    assert.notEqual(localhostStatusProbes, script);
    assert.throws(
      () => assertExactMetroStatusProbes(localhostStatusProbes, platform),
      /exactly the bounded retry loop and final IPv4 probe in order/,
    );

    const withoutFinalStatusProbe = script
      .split(/\r\n|\n|\r/)
      .filter((line) => line !== exactMetroStatusLines[1])
      .join("\n");
    assert.notEqual(withoutFinalStatusProbe, script);
    assert.throws(
      () => assertExactMetroStatusProbes(withoutFinalStatusProbe, platform),
      /exactly the bounded retry loop and final IPv4 probe in order/,
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

  const confirmationFlowMutations = [
    confirmation.replace("- runFlow:\n", ""),
    confirmation.replace("- runFlow:\n", "- runFlow:\n- runFlow:\n"),
    confirmation.replace(
      "      - tapOn:\n          point: '69%,54%'\n          label: 'Tap the right-side Open button in the iOS confirmation alert'\n      - assertNotVisible: '^Open in .For Mobile.\\?$'",
      "      - assertNotVisible: '^Open in .For Mobile.\\?$'\n      - tapOn:\n          point: '69%,54%'\n          label: 'Tap the right-side Open button in the iOS confirmation alert'",
    ),
    confirmation.replaceAll("^Open in .For Mobile.\\?$", "^Open in For Mobile\\?$"),
    confirmation.replace("point: '69%,54%'", "point: '50%,50%'"),
    confirmation.replace("      - assertNotVisible: '^Open in .For Mobile.\\?$'\n", ""),
    confirmation.replace(
      "          label: 'Tap the right-side Open button in the iOS confirmation alert'\n",
      "          label: 'Tap the right-side Open button in the iOS confirmation alert'\n          optional: true\n",
    ),
  ];
  for (const mutatedFlow of confirmationFlowMutations) {
    assert.notEqual(mutatedFlow, confirmation);
    assert.throws(() => assertIosOpenConfirmationFlow(mutatedFlow), /flow bytes must remain exact/);
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
    androidRunner.replace(`${exactAndroidFallbackLogCommand}\n`, ""),
    androidRunner.replace(".artifacts/launch/maestro/android-smoke", ".artifacts/launch/maestro/android-readiness"),
  ];
  for (const mutatedScript of androidPolicyMutations) {
    assert.notEqual(mutatedScript, androidRunner);
    assert.throws(
      () => assertAndroidDiagnosticsPolicy(mutatedScript, androidWorkflow),
      /Android cleanup must preserve|distinct exact debug-output directories/,
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
      /Android cleanup must preserve/,
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
      /Android cleanup must preserve/,
    );
  }

  const duplicatedAndroidDiagnostic = androidRunner.replace(
    exactAndroidFailureScreenshotCommand,
    `${exactAndroidFailureScreenshotCommand}\n${exactAndroidFailureScreenshotCommand}`,
  );
  assert.notEqual(duplicatedAndroidDiagnostic, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(duplicatedAndroidDiagnostic, androidWorkflow),
    /Android cleanup must preserve/,
  );

  const reorderedAndroidDiagnostics = androidRunner.replace(
    `${exactAndroidFailureScreenshotCommand}\n${exactAndroidFailureHierarchyCommand}`,
    `${exactAndroidFailureHierarchyCommand}\n${exactAndroidFailureScreenshotCommand}`,
  );
  assert.notEqual(reorderedAndroidDiagnostics, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(reorderedAndroidDiagnostics, androidWorkflow),
    /Android cleanup must preserve/,
  );

  const commentedExtraAndroidDiagnostic = androidRunner.replace(
    exactAndroidFailureScreenshotCommand,
    `${exactAndroidFailureScreenshotCommand}\n    # adb -s "$emulator_serial" logcat -d > .artifacts/launch/device/comment-only.log 2>&1`,
  );
  assert.notEqual(commentedExtraAndroidDiagnostic, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(commentedExtraAndroidDiagnostic, androidWorkflow),
    /Android cleanup must preserve/,
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
    /Android cleanup must preserve/,
  );

  const continuedCommentOnlyAndroidDiagnostic = androidRunner.replace(
    exactAndroidFailureScreenshotCommand,
    `${exactAndroidFailureScreenshotCommand}\n    # adb -s "$emulator_serial" \\\n    # logcat -d > .artifacts/launch/device/comment-only-continued.log 2>&1`,
  );
  assert.notEqual(continuedCommentOnlyAndroidDiagnostic, androidRunner);
  assert.throws(
    () => assertAndroidDiagnosticsPolicy(continuedCommentOnlyAndroidDiagnostic, androidWorkflow),
    /Android cleanup must preserve/,
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
