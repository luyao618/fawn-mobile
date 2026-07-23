#!/usr/bin/env bash
set -euo pipefail

udid=${1:?simulator UDID required}
expected_sha=${2:?expected SHA required}
release_app=${3:?Release app required}
metro_pid=${4:?owned Metro PID required}
app_id=com.luyao618.formobile
report=.artifacts/ios-tracker-restart.json
private_tmp=$(mktemp -d "${TMPDIR:-/tmp}/g035-tracker-ios.XXXXXX")

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

launch() {
  local output pid
  output=$(SIMCTL_CHILD_TZ=Asia/Shanghai xcrun simctl launch "$udid" "$app_id")
  printf '%s\n' "$output" >&2
  pid=$(printf '%s\n' "$output" | sed -n 's/.*: \([0-9][0-9]*\)$/\1/p')
  validate_positive_safe_integer "$pid" "application PID"
  printf '%s' "$pid"
}

terminate() { xcrun simctl terminate "$udid" "$app_id"; }

assert_app_pid_absent() {
  local prior_pid=$1 phase=$2
  if kill -0 "$prior_pid" 2>/dev/null; then fail "$phase process remains alive after terminate: $prior_pid"; fi
}

device_time_zone() {
  local date zone extra
  IFS=$'\t' read -r date zone extra < <(SIMCTL_CHILD_TZ=Asia/Shanghai bash scripts/e2e/query-ios-device-calendar.sh "$udid")
  test -z "$extra"
  [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]
  test "$zone" = Asia/Shanghai
  printf '%s' "$zone"
}

data_container() { xcrun simctl get_app_container "$udid" "$app_id" data; }

copy_device_database() {
  local destination=$1 container device_db
  container=$(data_container)
  device_db="$container/Documents/SQLite/user.db"
  rm -f "$destination" "$destination-wal" "$destination-shm"
  cp "$device_db" "$destination"
  test -s "$destination"
  if [ -f "$device_db-wal" ]; then cp "$device_db-wal" "$destination-wal"; fi
  if [ -f "$device_db-shm" ]; then cp "$device_db-shm" "$destination-shm"; fi
}

snapshot() {
  local phase=$1 database
  database="$private_tmp/$phase.db"
  copy_device_database "$database"
  node --no-warnings tools/tracker-evidence.mjs --action tracker-snapshot --database "$database" --output "$private_tmp/$phase.json"
}

app_identity() {
  local app=$1 label=$2 plist_json plist_canonical
  plist_json="$private_tmp/$label.plist.json"
  plist_canonical="$private_tmp/$label.plist.canonical.json"
  test -x "$app/ForMobile"
  test -s "$app/main.jsbundle"
  test -s "$app/Info.plist"
  plutil -convert json -o "$plist_json" "$app/Info.plist"
  node --no-warnings --input-type=module - "$plist_json" "$plist_canonical" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson } from "./tools/tracker-evidence.mjs";
writeFileSync(process.argv[3], canonicalJson(JSON.parse(readFileSync(process.argv[2], "utf8"))));
NODE
  executable_sha=$(shasum -a 256 "$app/ForMobile" | awk '{print $1}')
  bundle_sha=$(shasum -a 256 "$app/main.jsbundle" | awk '{print $1}')
  plist_sha=$(shasum -a 256 "$plist_canonical" | awk '{print $1}')
  printf '{"executableSha256":"%s","mainJsBundleSha256":"%s","infoPlistCanonicalSha256":"%s"}' "$executable_sha" "$bundle_sha" "$plist_sha"
}

installed_identity() {
  local label=${1:?installed identity label required} installed_app
  installed_app=$(xcrun simctl get_app_container "$udid" "$app_id" app)
  app_identity "$installed_app" "$label"
}

validate_positive_safe_integer "$metro_pid" "owned Metro PID"
test "$(git rev-parse HEAD)" = "$expected_sha"
test -x "$release_app/ForMobile"
test -s "$release_app/main.jsbundle"
test "$(maestro --version | tr -d '\r')" = 2.6.1
mkdir -p .artifacts
rm -f "$report"
assert_pid_absent "$metro_pid" "owned Metro PID"
assert_metro_unreachable "before tracker operations"
source_identity=$(app_identity "$release_app" source)

xcrun simctl uninstall "$udid" "$app_id"
xcrun simctl install "$udid" "$release_app"

pre_save_pid=$(launch)
pre_save_zone=$(device_time_zone)
node --no-warnings tools/tracker-evidence.mjs --action fixture-oracle --time-zone "$pre_save_zone" --output "$private_tmp/fixture.json"
maestro --device "$udid" test --debug-output "$private_tmp/pre-save-readiness" e2e/maestro/shell-readiness.yaml
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
maestro --device "$udid" test --debug-output "$private_tmp/save-edit-delete" e2e/maestro/tracker-save-edit-delete.yaml
post_save_zone=$(device_time_zone)
terminate "$save_pid"
assert_app_pid_absent "$save_pid" "save"
snapshot post-save

relaunch_pid=$(launch)
test "$relaunch_pid" != "$save_pid"
post_relaunch_zone=$(device_time_zone)
installed_after_identity=$(installed_identity installed-after)
test "$source_identity" = "$installed_after_identity"
maestro --device "$udid" test --debug-output "$private_tmp/restart" e2e/maestro/tracker-restart.yaml
terminate "$relaunch_pid"
assert_app_pid_absent "$relaunch_pid" "relaunch"
snapshot post-relaunch

test "$pre_save_zone" = Asia/Shanghai
test "$post_save_zone" = "$pre_save_zone"
test "$post_relaunch_zone" = "$pre_save_zone"
node --no-warnings tools/tracker-evidence.mjs --action privacy-proof --pre-save "$private_tmp/pre-save.json" --post-save "$private_tmp/post-save.json" --post-relaunch "$private_tmp/post-relaunch.json" --output "$private_tmp/privacy.json"
assert_metro_unreachable "before report emission"

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
  schemaVersion: 1, reportType: "manual-tracker-offline-restart", platform: "ios", flavor: "e2e-release",
  checkedOutSha: process.env.EXPECTED_SHA, expectedSha: process.env.EXPECTED_SHA, testId: "G025-E2E-001",
  fixture: read("fixture.json"),
  accessibility: {
    selectorPolicy: { allowedKinds: ["id", "textBelowText", "exactText"], anchoredSelectorCount, coordinateTapCount: 0, indexSelectorCount: 0, ambiguousSelectorCount: 0, optionalCommandCount: 0, retryCommandCount: 0, sleepCommandCount: 0 },
    keyboardDismissal: { strategy: "maestro-down-swipe-then-entered-value-below-field", mandatory: true },
    nativeObservations: observations,
    claims: { physicalDevice: false, screenReader: false, e2e006: false },
  },
  binary: { format: "ios-three-component-identity", source: JSON.parse(process.env.SOURCE_IDENTITY), installedBefore: JSON.parse(process.env.INSTALLED_BEFORE_IDENTITY), installedAfter: JSON.parse(process.env.INSTALLED_AFTER_IDENTITY) },
  database: { preSave: read("pre-save.json"), postSave: read("post-save.json"), postRelaunch: read("post-relaunch.json") },
  lifecycle: {
    metro: { ownedPid: Number(process.env.METRO_PID), terminatedBeforeTracker: true, probeBeforeTrackerFailed: true, probeBeforeReportFailed: true },
    androidReverse: null,
    directLaunches: {
      preSave: { pid: Number(process.env.PRE_SAVE_PID), terminated: true, absentBeforeSnapshot: true },
      save: { pid: Number(process.env.SAVE_PID), terminated: true, absentBeforeSnapshot: true },
      relaunch: { pid: Number(process.env.RELAUNCH_PID), terminated: true, absentBeforeSnapshot: true },
    },
    zoneObservations: { preSave: process.env.PRE_SAVE_ZONE, postSave: process.env.POST_SAVE_ZONE, postRelaunch: process.env.POST_RELAUNCH_ZONE },
    freshInstallCount: 1,
    postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 },
    saveRelaunchPidDifferent: process.env.SAVE_PID !== process.env.RELAUNCH_PID,
    restartProof: "terminated-snapshot-direct-relaunch-same-ios-three-component-identity",
  },
  privacy: read("privacy.json"), migration: migrationIdentity(),
  evidence: {
    flows: { saveEditDelete: identity(flows[0]), restart: identity(flows[1]) },
    fixture: identity("tests/fixtures/tracker/manual-tracker-v1.json"),
    tool: identity("tools/tracker-evidence.mjs"), runner: identity("scripts/e2e/run-tracker-restart-ios.sh"),
  },
  status: "pass", skipped: [],
};
writeFileSync(`${directory}/report-input.json`, canonicalJson(report));
NODE
node --no-warnings tools/tracker-evidence.mjs --action validate-report --input "$private_tmp/report-input.json" --platform ios --expected-sha "$expected_sha" --output "$report"
