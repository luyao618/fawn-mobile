#!/usr/bin/env bash
set -euo pipefail

serial=${1:?android emulator serial required}
expected_sha=${2:?expected SHA required}
release_apk=${3:?Release APK required}
metro_pid=${4:?owned Metro PID required}
app_id=com.luyao618.formobile
report=.artifacts/android-tracker-restart.json
private_tmp=$(mktemp -d "${TMPDIR:-/tmp}/g035-tracker-android.XXXXXX")

cleanup() {
  status=$?
  trap - EXIT
  rm -rf "$private_tmp"
  exit "$status"
}
trap cleanup EXIT

fail() { printf '%s\n' "$1" >&2; return 1; }

validate_positive_safe_integer() {
  local value=$1 label=$2
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$label must be canonical positive decimal"
  [ "${#value}" -le 16 ] || fail "$label exceeds JavaScript safe integer range"
  if [ "${#value}" -eq 16 ]; then
    [[ "$value" < 9007199254740992 ]] || fail "$label exceeds JavaScript safe integer range"
  fi
}

assert_pid_absent() {
  local pid=$1 label=$2
  if kill -0 "$pid" 2>/dev/null; then fail "$label remains alive: $pid"; fi
}

assert_metro_unreachable() {
  local phase=$1
  if curl --silent --fail http://127.0.0.1:8081/status >/dev/null; then
    fail "Metro remained reachable $phase"
  fi
}

assert_reverse_absent() {
  local phase=$1 reverse_list
  reverse_list=$(adb -s "$serial" reverse --list)
  if grep -Eq '(^|[[:space:]])tcp:8081([[:space:]]|$)' <<< "$reverse_list"; then
    fail "Android tcp:8081 reverse remained present $phase"
  fi
}

ensure_adb_root() {
  local output status uid
  if output=$(adb -s "$serial" root 2>&1); then status=0; else status=$?; fi
  output=${output%$'\r'}
  case "$status:$output" in
    '0:'|'0:restarting adbd as root'|'0:adbd is already running as root'|'1:adb: unable to connect for root: closed') ;;
    *) fail "Unexpected adb root result (status $status): $output" ;;
  esac
  adb -s "$serial" wait-for-device
  uid=$(adb -s "$serial" shell id -u | tr -d '\r')
  test "$uid" = 0
}

pidof_app() {
  local observation adb_status remote_status
  set +e
  observation=$(adb -s "$serial" shell "pidof -s '$app_id'; remote_status=\$?; printf '__PIDOF_STATUS__=%s\\n' \"\$remote_status\"" 2>&1)
  adb_status=$?
  set -e
  if [ "$adb_status" -ne 0 ]; then printf '%s\n' "$observation" >&2; return "$adb_status"; fi
  observation=${observation//$'\r'/}
  if [ "$observation" = '__PIDOF_STATUS__=1' ]; then return 0; fi
  if [[ "$observation" =~ ^([0-9]+)$'\n'__PIDOF_STATUS__=0$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$observation" =~ (^|$'\n')__PIDOF_STATUS__=([0-9]+)$ ]]; then
    remote_status=${BASH_REMATCH[2]}
    if [ "$remote_status" -gt 0 ] && [ "$remote_status" -lt 256 ]; then
      printf '%s\n' "$observation" >&2
      return "$remote_status"
    fi
  fi
  fail "Malformed remote pidof observation: $observation"
}

launch() {
  local pid
  adb -s "$serial" shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/.MainActivity" >/dev/null
  pid=$(pidof_app)
  validate_positive_safe_integer "$pid" "application PID"
  printf '%s' "$pid"
}

terminate() { adb -s "$serial" shell am force-stop "$app_id" >/dev/null; }

assert_app_pid_absent() {
  local prior_pid=$1 phase=$2 current
  current=$(pidof_app)
  test -z "$current" || fail "$phase process remains alive after force-stop: $current (was $prior_pid)"
}

device_time_zone() {
  local zone
  zone=$(adb -s "$serial" shell getprop persist.sys.timezone | tr -d '\r')
  test "$zone" = Asia/Shanghai
  printf '%s' "$zone"
}

copy_device_database() {
  local destination=$1 device_db="/data/user/0/$app_id/files/SQLite/user.db"
  rm -f "$destination" "$destination-wal" "$destination-shm"
  adb -s "$serial" exec-out cat "$device_db" > "$destination"
  test -s "$destination"
  if adb -s "$serial" shell test -f "$device_db-wal"; then
    adb -s "$serial" exec-out cat "$device_db-wal" > "$destination-wal"
  fi
  if adb -s "$serial" shell test -f "$device_db-shm"; then
    adb -s "$serial" exec-out cat "$device_db-shm" > "$destination-shm"
  fi
}

snapshot() {
  local phase=$1 database
  database="$private_tmp/$phase.db"
  copy_device_database "$database"
  node --no-warnings tools/tracker-evidence.mjs --action tracker-snapshot --database "$database" --output "$private_tmp/$phase.json"
}

apk_identity() {
  local apk=$1 label=$2 entries bundles bundle
  entries="$private_tmp/$label.entries"
  bundles="$private_tmp/$label.bundles"
  bundle="$private_tmp/$label.bundle"
  unzip -Z1 "$apk" > "$entries"
  grep -E '^assets/(index\.android\.bundle|index\.bundle)$' "$entries" > "$bundles"
  test "$(wc -l < "$bundles" | tr -d ' ')" = 1
  bundle_entry=$(sed -n '1p' "$bundles")
  unzip -p "$apk" "$bundle_entry" > "$bundle"
  test -s "$bundle"
  apk_sha=$(sha256sum "$apk" | awk '{print $1}')
  bundle_sha=$(sha256sum "$bundle" | awk '{print $1}')
  printf '{"apkSha256":"%s","embeddedBundleSha256":"%s"}' "$apk_sha" "$bundle_sha"
}

installed_identity() {
  local label=${1:?installed identity label required} apk_path installed
  installed="$private_tmp/$label.apk"
  apk_path=$(adb -s "$serial" shell pm path "$app_id" | tr -d '\r' | sed -n 's/^package://p')
  test -n "$apk_path"
  test "$(printf '%s\n' "$apk_path" | wc -l | tr -d ' ')" = 1
  adb -s "$serial" exec-out cat "$apk_path" > "$installed"
  test -s "$installed"
  apk_identity "$installed" "$label"
}

validate_positive_safe_integer "$metro_pid" "owned Metro PID"
test "$(git rev-parse HEAD)" = "$expected_sha"
test -s "$release_apk"
test "$(maestro --version | tr -d '\r')" = 2.6.1
mkdir -p .artifacts
rm -f "$report"
assert_pid_absent "$metro_pid" "owned Metro PID"
assert_metro_unreachable "before tracker operations"
assert_reverse_absent "before tracker operations"
source_identity=$(apk_identity "$release_apk" source)

ensure_adb_root
adb -s "$serial" shell setprop persist.sys.timezone Asia/Shanghai
test "$(device_time_zone)" = Asia/Shanghai
adb -s "$serial" shell service check package | tr -d '\r' | grep -Fxq 'Service package: found'
adb -s "$serial" uninstall "$app_id" >/dev/null
adb -s "$serial" install --no-streaming "$release_apk" >/dev/null

pre_save_pid=$(launch)
pre_save_zone=$(device_time_zone)
node --no-warnings tools/tracker-evidence.mjs --action fixture-oracle --time-zone "$pre_save_zone" --output "$private_tmp/fixture.json"
maestro --device "$serial" test --debug-output "$private_tmp/pre-save-readiness" e2e/maestro/shell-readiness.yaml
terminate "$pre_save_pid"
assert_app_pid_absent "$pre_save_pid" "pre-save"
snapshot pre-save
node --no-warnings --input-type=module - "$private_tmp/pre-save.json" <<'NODE'
import { readFileSync } from "node:fs";
const snapshot = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (snapshot.counts.total !== 0) throw new Error("pre-save tracker database is not empty");
NODE

save_pid=$(launch)
installed_before_identity=$(installed_identity installed-before)
test "$source_identity" = "$installed_before_identity"
maestro --device "$serial" test --debug-output "$private_tmp/save-edit-delete" e2e/maestro/tracker-save-edit-delete.yaml
post_save_zone=$(device_time_zone)
terminate "$save_pid"
assert_app_pid_absent "$save_pid" "save"
snapshot post-save

relaunch_pid=$(launch)
test "$relaunch_pid" != "$save_pid"
post_relaunch_zone=$(device_time_zone)
installed_after_identity=$(installed_identity installed-after)
test "$source_identity" = "$installed_after_identity"
maestro --device "$serial" test --debug-output "$private_tmp/restart" e2e/maestro/tracker-restart.yaml
terminate "$relaunch_pid"
assert_app_pid_absent "$relaunch_pid" "relaunch"
snapshot post-relaunch

test "$pre_save_zone" = Asia/Shanghai
test "$post_save_zone" = "$pre_save_zone"
test "$post_relaunch_zone" = "$pre_save_zone"
node --no-warnings tools/tracker-evidence.mjs --action privacy-proof --pre-save "$private_tmp/pre-save.json" --post-save "$private_tmp/post-save.json" --post-relaunch "$private_tmp/post-relaunch.json" --output "$private_tmp/privacy.json"
assert_metro_unreachable "before report emission"
assert_reverse_absent "before report emission"

EXPECTED_SHA="$expected_sha" METRO_PID="$metro_pid" PRE_SAVE_PID="$pre_save_pid" SAVE_PID="$save_pid" RELAUNCH_PID="$relaunch_pid" PRE_SAVE_ZONE="$pre_save_zone" POST_SAVE_ZONE="$post_save_zone" POST_RELAUNCH_ZONE="$post_relaunch_zone" SOURCE_IDENTITY="$source_identity" INSTALLED_BEFORE_IDENTITY="$installed_before_identity" INSTALLED_AFTER_IDENTITY="$installed_after_identity" PRIVATE_TMP="$private_tmp" node --no-warnings --input-type=module - <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, migrationIdentity } from "./tools/tracker-evidence.mjs";

const directory = process.env.PRIVATE_TMP;
const read = (name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
const identity = (path) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
const flows = ["e2e/maestro/tracker-save-edit-delete.yaml", "e2e/maestro/tracker-restart.yaml"];
const anchoredSelectorCount = flows.reduce((count, path) => count + (readFileSync(path, "utf8").match(/text: ['"]\^/g) ?? []).length, 0);
const observations = {
  healthConfirmationEntered: true, healthCancelReturnedToEditor: true, healthEditorFieldsUnchanged: true,
  healthCheckupConfirmationFieldObservedWithoutRetap: true, healthSecondSubmitObserved: true, healthFinalConfirmationObserved: true,
  feedingFormulaCreatedRowObserved: true, feedingNinetyToHundredDiffObserved: true, feedingUpdateFinalConfirmationObserved: true,
  sleepNightCreatedRowObserved: true, diaperMixedCreatedRowObserved: true, diaperDeleteIdentifyingSummaryObserved: true,
  diaperConsequenceObserved: true, diaperFinalConfirmationObserved: true, relaunchActiveRowsObserved: true, relaunchDiaperAbsentObserved: true,
};
const report = {
  schemaVersion: 1, reportType: "manual-tracker-offline-restart", platform: "android", flavor: "e2e-release",
  checkedOutSha: process.env.EXPECTED_SHA, expectedSha: process.env.EXPECTED_SHA, testId: "G025-E2E-001",
  fixture: read("fixture.json"),
  accessibility: {
    selectorPolicy: { allowedKinds: ["id", "textBelowText", "exactText"], anchoredSelectorCount, coordinateTapCount: 0, indexSelectorCount: 0, ambiguousSelectorCount: 0, optionalCommandCount: 0, retryCommandCount: 0, sleepCommandCount: 0 },
    keyboardDismissal: { strategy: "maestro-hideKeyboard-then-entered-value-below-field", mandatory: true },
    nativeObservations: observations,
    claims: { physicalDevice: false, screenReader: false, e2e006: false },
  },
  binary: { format: "apk", source: JSON.parse(process.env.SOURCE_IDENTITY), installedBefore: JSON.parse(process.env.INSTALLED_BEFORE_IDENTITY), installedAfter: JSON.parse(process.env.INSTALLED_AFTER_IDENTITY) },
  database: { preSave: read("pre-save.json"), postSave: read("post-save.json"), postRelaunch: read("post-relaunch.json") },
  lifecycle: {
    metro: { ownedPid: Number(process.env.METRO_PID), terminatedBeforeTracker: true, probeBeforeTrackerFailed: true, probeBeforeReportFailed: true },
    androidReverse: { port: 8081, absentBeforeTracker: true, absentBeforeReport: true },
    directLaunches: {
      preSave: { pid: Number(process.env.PRE_SAVE_PID), terminated: true, absentBeforeSnapshot: true },
      save: { pid: Number(process.env.SAVE_PID), terminated: true, absentBeforeSnapshot: true },
      relaunch: { pid: Number(process.env.RELAUNCH_PID), terminated: true, absentBeforeSnapshot: true },
    },
    zoneObservations: { preSave: process.env.PRE_SAVE_ZONE, postSave: process.env.POST_SAVE_ZONE, postRelaunch: process.env.POST_RELAUNCH_ZONE },
    freshInstallCount: 1,
    postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 },
    saveRelaunchPidDifferent: process.env.SAVE_PID !== process.env.RELAUNCH_PID,
    restartProof: "terminated-snapshot-direct-relaunch-same-installed-apk",
  },
  privacy: read("privacy.json"), migration: migrationIdentity(),
  evidence: {
    flows: { saveEditDelete: identity(flows[0]), restart: identity(flows[1]) },
    fixture: identity("tests/fixtures/tracker/manual-tracker-v1.json"),
    tool: identity("tools/tracker-evidence.mjs"), runner: identity("scripts/e2e/run-tracker-restart-android.sh"),
  },
  status: "pass", skipped: [],
};
writeFileSync(`${directory}/report-input.json`, canonicalJson(report));
NODE
node --no-warnings tools/tracker-evidence.mjs --action validate-report --input "$private_tmp/report-input.json" --platform android --expected-sha "$expected_sha" --output "$report"
