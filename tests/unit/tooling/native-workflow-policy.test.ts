import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  needs?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
  steps?: WorkflowStep[];
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
const exactHeadSha = "${{ github.event.pull_request.head.sha || github.sha }}";
const expectedShaInput = "${{ inputs.expected_sha }}";
const exactStaticShaAssertion = `test "$(git rev-parse HEAD)" = "${exactHeadSha}"`;
const exactChildShaAssertion = `test "$(git rev-parse HEAD)" = "${expectedShaInput}"`;
const exactStaticCollector = `node tools/collect-ci-evidence.mjs --expected-sha "${exactHeadSha}" --platform host --flavor static --test-result pass --test-result-file .artifacts/test-results/static-gates.log --output .artifacts/static.json`;
const whoProvisionStepName = "Populate hash-pinned WHO cache";
const whoDownloadCommand = "PYTHONDONTWRITEBYTECODE=1 python3 tools/knowledge/download_who_sources.py";
const whoOfflineVerificationCommand = `${whoDownloadCommand} --offline`;
const exactWhoProvisionScript = `${whoDownloadCommand}\n${whoOfflineVerificationCommand}\n`;
const exactStaticUploadPath = ".artifacts/static.json\n.artifacts/test-results/static-gates.log\n";
const forbiddenStaticUploadPath = /knowledge\/sources|knowledge\/generated|\.xlsx|fawn-slice0-who-reference\.csv|who-growth-reference\.csv/i;
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

function requiredSteps(job: WorkflowJob, name: string): WorkflowStep[] {
  assert.ok(Array.isArray(job.steps), `Workflow job ${name} has no parsed steps`);
  return job.steps;
}

function stepIndex(steps: WorkflowStep[], predicate: (step: WorkflowStep) => boolean, label: string): number {
  const index = steps.findIndex(predicate);
  assert.notEqual(index, -1, `${label} step is absent`);
  return index;
}

function assertArtifactName(steps: WorkflowStep[], name: string): void {
  const index = stepIndex(
    steps,
    (step) => step.uses === uploadArtifactAction && step.with?.name === name,
    `${name} artifact upload`,
  );
  assert.equal(steps[index].with?.name, name);
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
  const job = requiredJob(workflow, jobName);
  const steps = requiredSteps(job, jobName);
  const checkoutIndex = stepIndex(steps, (step) => step.uses === checkoutAction, `${jobName} checkout`);
  assert.equal(steps[checkoutIndex].with?.ref, expectedShaInput, `${jobName} checkout must use inputs.expected_sha`);
  const assertionIndex = stepIndex(steps, (step) => step.run === exactChildShaAssertion, `${jobName} SHA assertion`);
  const installIndex = stepIndex(steps, (step) => step.run === "npm ci --workspaces --include-workspace-root", `${jobName} npm install`);
  assert.ok(checkoutIndex < assertionIndex && assertionIndex < installIndex, `${jobName} must assert the checked-out SHA before install`);

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
  assertArtifactName(steps, `${jobName}-e2e-evidence-${expectedShaInput}`);
}

function assertNativeWorkflowPolicy(workflows: NativeWorkflows): void {
  const staticJob = requiredJob(workflows.ci, "static");
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
    const gateIndex = stepIndex(steps, (step) => step.run === run, run);
    assert.ok(gateIndex > previousGateIndex, `${run} is out of its original static-gate order`);
    previousGateIndex = gateIndex;
  }
  assert.ok(preflightIndex < stepIndex(steps, (step) => step.run === originalStaticGateRuns[0], "First install"));

  const collectorIndex = stepIndex(steps, (step) => step.run === exactStaticCollector, "Static evidence collector");
  assert.ok(collectorIndex > previousGateIndex, "Static evidence must be collected after all original gates");
  assertArtifactName(steps, `static-evidence-${exactHeadSha}`);
  const staticUploadIndexes = steps.flatMap((step, index) =>
    typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@") ? [index] : []
  );
  assert.equal(staticUploadIndexes.length, 1, "Static job must contain exactly one artifact upload");
  const staticUpload = steps[staticUploadIndexes[0]];
  assert.equal(staticUpload.uses, uploadArtifactAction, "Static evidence upload action must remain pinned");
  assert.equal(staticUpload.with?.name, `static-evidence-${exactHeadSha}`, "Static evidence upload name must remain exact");
  const staticUploadPath = staticUpload.with?.path;
  assert.ok(typeof staticUploadPath === "string", "Static evidence upload path must be a string");
  assert.doesNotMatch(staticUploadPath, forbiddenStaticUploadPath, "Static evidence upload must not include raw or generated WHO data");
  assert.equal(staticUploadPath, exactStaticUploadPath, "Static evidence upload path must remain exactly the two approved files");

  for (const [jobName, workflowPath] of [["android-e2e", "./.github/workflows/e2e-android.yml"], ["ios-e2e", "./.github/workflows/e2e-ios.yml"]] as const) {
    const reusableJob = requiredJob(workflows.ci, jobName);
    assert.equal(reusableJob.needs, "static");
    assert.equal(reusableJob.uses, workflowPath);
    assert.equal(reusableJob.with?.expected_sha, exactHeadSha);
  }

  assertChildWorkflowPolicy(workflows.android, "android");
  assertChildWorkflowPolicy(workflows.ios, "ios");
}

function pinnedActionScriptInput(workflow: string) {
  const marker = "- uses: ReactiveCircus/android-emulator-runner@1dcd0090116d15e7c562f8db72807de5e036a4ed";
  const start = workflow.indexOf(marker);
  assert(start >= 0, "Pinned Android emulator action is absent");
  const tail = workflow.slice(start);
  const nextStep = tail.indexOf("\n      - ", marker.length);
  const step = nextStep >= 0 ? tail.slice(0, nextStep) : tail;
  const lines = step.split(/\r\n|\n|\r/);
  const scriptIndex = lines.findIndex((line) => /^\s{10}script:/.test(line));
  assert(scriptIndex >= 0, "Android emulator action script input is absent");
  const scalar = lines[scriptIndex].replace(/^\s{10}script:\s*/, "");
  if (!/^\|[-+]?$/.test(scalar)) return scalar;
  return lines.slice(scriptIndex + 1).map((line) => line.replace(/^\s{12}/, "")).join("\n");
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
const readinessFlow = "e2e/maestro/shell-readiness.yaml";
const smokeFlow = "e2e/maestro/shell-smoke.yaml";

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

test("pinned Android action receives exactly one Bash command and the runner is valid ordered Bash", async () => {
  const [workflow, runner] = await Promise.all([
    readFile(".github/workflows/e2e-android.yml", "utf8"),
    readFile("scripts/e2e/run-android-emulator.sh", "utf8"),
  ]);
  const commands = parsePinnedActionScript(pinnedActionScriptInput(workflow));
  assert.deepEqual(commands, ["bash scripts/e2e/run-android-emulator.sh"]);
  assert.equal(spawnSync("bash", ["-n", "scripts/e2e/run-android-emulator.sh"]).status, 0);
  assert.match(runner, /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
  ordered(runner,
    "mapfile -t emulator_serials",
    'emulator_serial="${emulator_serials[0]}"',
    ":app:assembleDebug",
    'adb -s "$emulator_serial" install -r',
    'adb -s "$emulator_serial" reverse tcp:8081 tcp:8081',
    "expo start --dev-client --localhost --port 8081",
    "curl --silent --fail http://127.0.0.1:8081/status",
    encodedDevClientUrl,
    'adb -s "$emulator_serial" shell am start -W -a android.intent.action.VIEW -d "$dev_client_url" -p com.luyao618.formobile',
    `maestro --device "$emulator_serial" test ${readinessFlow}`,
    `maestro --device "$emulator_serial" test ${smokeFlow}`,
    "mv .artifacts/test-results/android-maestro.attempt.log .artifacts/test-results/android-maestro.log",
  );
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
    "bash scripts/e2e/run-android-emulator.sh",
    "collect-ci-evidence.mjs",
    "--test-result pass --test-result-file .artifacts/test-results/android-maestro.log",
  );
  ordered(runner,
    'adb -s "$emulator_serial" shell am start -W',
    `maestro --device "$emulator_serial" test ${readinessFlow} 2>&1 | tee .artifacts/launch/android-readiness.log`,
    `maestro --device "$emulator_serial" test ${smokeFlow} 2>&1 | tee .artifacts/test-results/android-maestro.attempt.log`,
  );
  assert.match(runner, /grep -q '\^Status: ok'/);
  assert.match(workflow, /\.artifacts\/native\/android\/\*\*/);
  assert.match(workflow, /\.artifacts\/launch\/\*\.log/);
});

test("iOS opens on the exact UDID, requires readiness, then records unchanged smoke provenance", async () => {
  const workflow = await readFile(".github/workflows/e2e-ios.yml", "utf8");
  ordered(workflow,
    "simulator_udid=$(xcrun simctl list devices available -j",
    'simctl boot "$simulator_udid"',
    'simctl bootstatus "$simulator_udid" -b',
    "prebuild:ios:production",
    "cp ios/ForMobile/Info.plist .artifacts/native/ios/production/Info.plist",
    "--flavor production --input .artifacts/native/ios/production/Info.plist",
    'destination "platform=iOS Simulator,id=$simulator_udid"',
    "prebuild:ios:e2e",
    "cp ios/ForMobile/Info.plist .artifacts/native/ios/e2e/Info.plist",
    "--flavor e2e --input .artifacts/native/ios/e2e/Info.plist",
    'simctl install "$simulator_udid"',
    "expo start --dev-client --localhost --port 8081",
    encodedDevClientUrl,
    'simctl openurl "$simulator_udid" "$dev_client_url"',
    `maestro --device "$simulator_udid" test ${readinessFlow} 2>&1 | tee .artifacts/launch/ios-readiness.log`,
    `maestro --device "$simulator_udid" test ${smokeFlow} 2>&1 | tee .artifacts/test-results/ios-maestro.attempt.log`,
    "mv .artifacts/test-results/ios-maestro.attempt.log .artifacts/test-results/ios-maestro.log",
    "collect-ci-evidence.mjs",
    "--test-result pass --test-result-file .artifacts/test-results/ios-maestro.log",
  );
  assert.match(workflow, /set -euo pipefail/);
  assert.doesNotMatch(workflow, /simctl boot[^\n]*\|\| true/);
  assert.doesNotMatch(workflow, /simctl launch/);
  assert.match(workflow, /\.artifacts\/launch\/\*\.log/);
});

test("readiness never launches the app and the tracked smoke flow remains byte-unchanged", async () => {
  const [readiness, smoke] = await Promise.all([
    readFile(readinessFlow, "utf8"),
    readFile(smokeFlow, "utf8"),
  ]);
  assert.equal(readiness, exactReadinessFlow);
  assert.doesNotMatch(readiness, /launchApp|stopApp|openLink/);
  assert.equal(smoke, exactSmokeFlow);
});

test("native workflows enforce the parsed Intel runner, exact SHA boundaries, and frozen tool preflight", async () => {
  const workflows = await loadNativeWorkflows();
  assertNativeWorkflowPolicy(workflows);
});

test("parsed workflow policy rejects hostile structural counterexamples", async () => {
  const workflows = await loadNativeWorkflows();

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
