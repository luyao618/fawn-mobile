import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function ordered(text: string, ...needles: string[]) {
  let offset = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, offset + 1);
    assert(next > offset, `${needle} is absent or out of order`);
    offset = next;
  }
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
