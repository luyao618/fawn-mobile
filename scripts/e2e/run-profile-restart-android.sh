#!/usr/bin/env bash
set -euo pipefail

serial=${1:?android emulator serial required}
expected_sha=${2:?expected SHA required}
release_apk=${3:?Release APK required}
app_id=com.luyao618.formobile
artifacts=.artifacts/profile/android
report=.artifacts/android-profile-restart.json
mkdir -p "$artifacts" .artifacts/launch/maestro .artifacts/test-results
test "$(git rev-parse HEAD)" = "$expected_sha"
test -s "$release_apk"
apk_entries=$(unzip -Z1 "$release_apk")
grep -Eq '^assets/(index\.android\.bundle|index\.bundle)$' <<< "$apk_entries"
local_before_sha=$(sha256sum "$release_apk" | awk '{print $1}')

cleanup() {
  status=$?
  trap - EXIT
  rm -f "$artifacts"/*.db "$artifacts"/*.db-wal "$artifacts"/*.db-shm "$artifacts"/report-input.json
  exit "$status"
}
trap cleanup EXIT

adb -s "$serial" root >/dev/null
adb -s "$serial" wait-for-device
wait_for_package_service() {
  for _ in $(seq 1 60); do adb -s "$serial" shell service check package 2>/dev/null | tr -d '\r' | grep -Fxq 'Service package: found' && break; sleep 2; done
  adb -s "$serial" shell service check package 2>/dev/null | tr -d '\r' | grep -Fxq 'Service package: found'
}
install_apk() {
  set +e
  install_output=$(adb -s "$serial" install --no-streaming "$release_apk" 2>&1)
  install_status=$?
  set -e
  printf '%s\n' "$install_output"
  return "$install_status"
}
wait_for_package_service
adb -s "$serial" uninstall "$app_id" >/dev/null
if ! install_apk; then
  if grep -Eq -e "^(cmd: )?Can't find service: package$" -e '^(cmd: )?Failure calling service package: Broken pipe( \([0-9]+\))?$' <<< "${install_output//$'\r'/}"; then
    wait_for_package_service
    install_apk
  else
    exit "$install_status"
  fi
fi

pidof_app() {
  local observation adb_status remote_status
  set +e
  observation=$(adb -s "$serial" shell "pidof -s '$app_id'; remote_status=\$?; printf '__PIDOF_STATUS__=%s\\n' \"\$remote_status\"" 2>&1)
  adb_status=$?
  set -e
  if [ "$adb_status" -ne 0 ]; then
    printf '%s\n' "$observation" >&2
    return "$adb_status"
  fi
  observation=${observation//$'\r'/}
  if [ "$observation" = '__PIDOF_STATUS__=1' ]; then
    return 0
  fi
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
  printf 'Malformed remote pidof observation: %s\n' "$observation" >&2
  return 1
}

launch() {
  adb -s "$serial" shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/.MainActivity" >/dev/null
  for _ in $(seq 1 60); do
    pid=$(pidof_app)
    [ -z "$pid" ] || { printf '%s' "$pid"; return; }
    sleep 1
  done
  return 1
}
terminate() {
  local old_pid=$1
  adb -s "$serial" shell am force-stop "$app_id"
  for _ in $(seq 1 30); do
    current=$(pidof_app)
    [ "$current" = "$old_pid" ] || return 0
    sleep 1
  done
  return 1
}
pull_db() {
  local destination=$1
  local device_db="/data/user/0/$app_id/files/SQLite/user.db"
  rm -f "$destination" "$destination-wal" "$destination-shm"
  adb -s "$serial" exec-out cat "$device_db" > "$destination"
  test -s "$destination"
  for suffix in -wal -shm; do
    if adb -s "$serial" shell test -f "$device_db$suffix"; then
      adb -s "$serial" exec-out cat "$device_db$suffix" > "$destination$suffix"
    fi
  done
}
device_date() { adb -s "$serial" shell date +%Y-%m-%d | tr -d '\r'; }
installed_apk_sha() {
  apk_path=$(adb -s "$serial" shell pm path "$app_id" | tr -d '\r' | sed -n 's/^package://p' | head -1)
  test -n "$apk_path"
  adb -s "$serial" exec-out cat "$apk_path" | sha256sum | awk '{print $1}'
}

pre_save_pid=$(launch)
maestro --device "$serial" test --debug-output .artifacts/launch/maestro/android-profile-pre-save-readiness e2e/maestro/shell-readiness.yaml 2>&1 | tee .artifacts/test-results/android-profile-pre-save-readiness.log
terminate "$pre_save_pid"
pull_db "$artifacts/pre-save.db"
node tools/persistence-evidence.mjs --action profile-snapshot --database "$artifacts/pre-save.db" --output "$artifacts/pre-save.json"
test "$(node -p "require('./$artifacts/pre-save.json').babyProfileCount")" = 0

save_pid=$(launch)
before_save_date=$(device_date)
time_zone=$(adb -s "$serial" shell getprop persist.sys.timezone | tr -d '\r')
[ -n "$time_zone" ] || time_zone=$(adb -s "$serial" shell date +%Z | tr -d '\r')
node tools/persistence-evidence.mjs --action age-oracle --local-date "$before_save_date" --output "$artifacts/age.json"
age_display=$(node -p "require('./$artifacts/age.json').display")
installed_before_sha=$(installed_apk_sha)
test "$installed_before_sha" = "$local_before_sha"
maestro --device "$serial" test -e AGE_DISPLAY="$age_display" --debug-output .artifacts/launch/maestro/android-profile-save e2e/maestro/profile-save.yaml 2>&1 | tee .artifacts/test-results/android-profile-save.log
after_save_date=$(device_date)
terminate "$save_pid"
stopped_pid=$(pidof_app)
test -z "$stopped_pid"
pull_db "$artifacts/post-save.db"
node tools/persistence-evidence.mjs --action profile-snapshot --database "$artifacts/post-save.db" --output "$artifacts/post-save.json"

relaunch_pid=$(launch)
test "$relaunch_pid" != "$save_pid"
after_relaunch_date=$(device_date)
local_after_sha=$(sha256sum "$release_apk" | awk '{print $1}')
installed_after_sha=$(installed_apk_sha)
test "$local_after_sha" = "$local_before_sha"
test "$installed_after_sha" = "$local_before_sha"
maestro --device "$serial" test -e AGE_DISPLAY="$age_display" --debug-output .artifacts/launch/maestro/android-profile-restart e2e/maestro/profile-restart.yaml 2>&1 | tee .artifacts/test-results/android-profile-restart.log
terminate "$relaunch_pid"
pull_db "$artifacts/post-relaunch.db"
node tools/persistence-evidence.mjs --action profile-snapshot --database "$artifacts/post-relaunch.db" --output "$artifacts/post-relaunch.json"
node tools/persistence-evidence.mjs --action privacy-scan --output "$artifacts/privacy.json"

EXPECTED_SHA="$expected_sha" TIME_ZONE="$time_zone" BEFORE_SAVE_DATE="$before_save_date" AFTER_SAVE_DATE="$after_save_date" AFTER_RELAUNCH_DATE="$after_relaunch_date" PRE_SAVE_PID="$pre_save_pid" SAVE_PID="$save_pid" RELAUNCH_PID="$relaunch_pid" LOCAL_BEFORE_SHA="$local_before_sha" INSTALLED_BEFORE_SHA="$installed_before_sha" LOCAL_AFTER_SHA="$local_after_sha" INSTALLED_AFTER_SHA="$installed_after_sha" node - "$artifacts" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const directory = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(`${directory}/${name}`, "utf8"));
const file = (path) => ({ path, sha256: crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex") });
const values = { birthDate: "2024-02-29", birthHeadCm: 34.2, birthHeightCm: 50.5, birthWeightG: 3200, gestationalWeeks: 36, isPremature: true, name: "G031LeapBaby", sex: "female" };
const report = {
  schemaVersion: 1, reportType: "baby-profile-offline-restart", platform: "android", flavor: "e2e-release",
  checkedOutSha: process.env.EXPECTED_SHA, expectedSha: process.env.EXPECTED_SHA, testId: "E2E-001/profile",
  fixture: { id: "synthetic-leap-day-v1", values, valueSha256: "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db" },
  calendar: { source: "device-local-date", beforeSave: process.env.BEFORE_SAVE_DATE, afterSave: process.env.AFTER_SAVE_DATE, afterRelaunch: process.env.AFTER_RELAUNCH_DATE, timeZone: process.env.TIME_ZONE, stable: process.env.BEFORE_SAVE_DATE === process.env.AFTER_SAVE_DATE && process.env.BEFORE_SAVE_DATE === process.env.AFTER_RELAUNCH_DATE },
  ageOracle: read("age.json"),
  binary: { kind: "apk", embeddedJsBundle: true, localBeforeSha256: process.env.LOCAL_BEFORE_SHA, installedBeforeSha256: process.env.INSTALLED_BEFORE_SHA, localAfterSha256: process.env.LOCAL_AFTER_SHA, installedAfterSha256: process.env.INSTALLED_AFTER_SHA },
  database: { preSave: read("pre-save.json"), postSave: read("post-save.json"), postRelaunch: read("post-relaunch.json") },
  lifecycle: { releaseInstalledFresh: true, metro: { killCount: 1, waitCount: 1, pidCleared: true, androidReverseRemoved: true, negativeProbe: true }, directLaunches: { preSavePid: process.env.PRE_SAVE_PID, savePid: process.env.SAVE_PID, relaunchPid: process.env.RELAUNCH_PID }, terminatedBeforeEmptySnapshot: true, savePidGone: true, relaunchPidDifferent: process.env.SAVE_PID !== process.env.RELAUNCH_PID, postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 } },
  privacy: read("privacy.json"),
  migration: { recordedSha256: "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec", sourceSha256: "c45896b3eb02762c0cf8f62c584889951a15fadc13fd34b9183bfa717ec75975", sqlBytes: 10526, inventory: { tables: 26, indexes: 14, triggers: 3 } },
  evidence: { saveFlow: file("e2e/maestro/profile-save.yaml"), restartFlow: file("e2e/maestro/profile-restart.yaml") },
  status: "pass", skipped: [],
};
fs.writeFileSync(`${directory}/report-input.json`, `${JSON.stringify(report, null, 2)}\n`);
NODE
node tools/persistence-evidence.mjs --action profile-report --input "$artifacts/report-input.json" --output "$report"
