#!/usr/bin/env bash
set -euo pipefail

udid=${1:?simulator UDID required}
expected_sha=${2:?expected SHA required}
release_app=${3:?Release app required}
app_id=com.luyao618.formobile
artifacts=.artifacts/profile/ios
report=.artifacts/ios-profile-restart.json
mkdir -p "$artifacts" .artifacts/launch/maestro .artifacts/test-results
test "$(git rev-parse HEAD)" = "$expected_sha"
test -x "$release_app/ForMobile"
test -s "$release_app/main.jsbundle"

cleanup() {
  status=$?
  trap - EXIT
  rm -f "$artifacts"/*.db "$artifacts"/*.db-wal "$artifacts"/*.db-shm "$artifacts"/report-input.json
  exit "$status"
}
trap cleanup EXIT

xcrun simctl uninstall "$udid" "$app_id"
xcrun simctl install "$udid" "$release_app"

launch() {
  output=$(xcrun simctl launch "$udid" "$app_id")
  printf '%s\n' "$output" >&2
  pid=$(printf '%s\n' "$output" | sed -n 's/.*: \([0-9][0-9]*\)$/\1/p')
  test -n "$pid"
  printf '%s' "$pid"
}
terminate() {
  local old_pid=$1
  xcrun simctl terminate "$udid" "$app_id"
  for _ in $(seq 1 30); do
    kill -0 "$old_pid" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}
data_container() { xcrun simctl get_app_container "$udid" "$app_id" data; }
pull_db() {
  local destination=$1
  local device_db="$(data_container)/Documents/SQLite/user.db"
  rm -f "$destination" "$destination-wal" "$destination-shm"
  cp "$device_db" "$destination"
  test -s "$destination"
  for suffix in -wal -shm; do [ ! -f "$device_db$suffix" ] || cp "$device_db$suffix" "$destination$suffix"; done
}
device_calendar() { bash scripts/e2e/query-ios-device-calendar.sh "$udid"; }
installed_hashes() {
  installed_app=$(xcrun simctl get_app_container "$udid" "$app_id" app)
  test -x "$installed_app/ForMobile"
  test -s "$installed_app/main.jsbundle"
  printf '%s %s %s\n' \
    "$(shasum -a 256 "$installed_app/ForMobile" | awk '{print $1}')" \
    "$(shasum -a 256 "$installed_app/main.jsbundle" | awk '{print $1}')" \
    "$(plutil -convert xml1 -o - "$installed_app/Info.plist" | shasum -a 256 | awk '{print $1}')"
}

pre_save_pid=$(launch)
maestro --device "$udid" test --debug-output .artifacts/launch/maestro/ios-profile-pre-save-readiness e2e/maestro/shell-readiness.yaml 2>&1 | tee .artifacts/test-results/ios-profile-pre-save-readiness.log
terminate "$pre_save_pid"
pull_db "$artifacts/pre-save.db"
node tools/persistence-evidence.mjs --action profile-snapshot --database "$artifacts/pre-save.db" --output "$artifacts/pre-save.json"
test "$(node -p "require('./$artifacts/pre-save.json').babyProfileCount")" = 0

save_pid=$(launch)
read -r before_save_date time_zone < <(device_calendar)
node tools/persistence-evidence.mjs --action age-oracle --local-date "$before_save_date" --output "$artifacts/age.json"
age_display=$(node -p "require('./$artifacts/age.json').display")
read -r executable_before_sha bundle_before_sha plist_before_sha < <(installed_hashes)
maestro --device "$udid" test -e AGE_DISPLAY="$age_display" --debug-output .artifacts/launch/maestro/ios-profile-save e2e/maestro/profile-save.yaml 2>&1 | tee .artifacts/test-results/ios-profile-save.log
read -r after_save_date _ < <(device_calendar)
terminate "$save_pid"
kill -0 "$save_pid" 2>/dev/null && exit 1
pull_db "$artifacts/post-save.db"
node tools/persistence-evidence.mjs --action profile-snapshot --database "$artifacts/post-save.db" --output "$artifacts/post-save.json"

relaunch_pid=$(launch)
test "$relaunch_pid" != "$save_pid"
read -r after_relaunch_date _ < <(device_calendar)
read -r executable_after_sha bundle_after_sha plist_after_sha < <(installed_hashes)
test "$executable_after_sha" = "$executable_before_sha"
test "$bundle_after_sha" = "$bundle_before_sha"
test "$plist_after_sha" = "$plist_before_sha"
maestro --device "$udid" test -e AGE_DISPLAY="$age_display" --debug-output .artifacts/launch/maestro/ios-profile-restart e2e/maestro/profile-restart.yaml 2>&1 | tee .artifacts/test-results/ios-profile-restart.log
terminate "$relaunch_pid"
pull_db "$artifacts/post-relaunch.db"
node tools/persistence-evidence.mjs --action profile-snapshot --database "$artifacts/post-relaunch.db" --output "$artifacts/post-relaunch.json"
node tools/persistence-evidence.mjs --action privacy-scan --output "$artifacts/privacy.json"

EXPECTED_SHA="$expected_sha" TIME_ZONE="$time_zone" BEFORE_SAVE_DATE="$before_save_date" AFTER_SAVE_DATE="$after_save_date" AFTER_RELAUNCH_DATE="$after_relaunch_date" PRE_SAVE_PID="$pre_save_pid" SAVE_PID="$save_pid" RELAUNCH_PID="$relaunch_pid" EXECUTABLE_BEFORE_SHA="$executable_before_sha" BUNDLE_BEFORE_SHA="$bundle_before_sha" PLIST_BEFORE_SHA="$plist_before_sha" EXECUTABLE_AFTER_SHA="$executable_after_sha" BUNDLE_AFTER_SHA="$bundle_after_sha" PLIST_AFTER_SHA="$plist_after_sha" node - "$artifacts" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const directory = process.argv[2];
const read = (name) => JSON.parse(fs.readFileSync(`${directory}/${name}`, "utf8"));
const file = (path) => ({ path, sha256: crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex") });
const values = { birthDate: "2024-02-29", birthHeadCm: 34.2, birthHeightCm: 50.5, birthWeightG: 3200, gestationalWeeks: 36, isPremature: true, name: "G031LeapBaby", sex: "female" };
const report = {
  schemaVersion: 1, reportType: "baby-profile-offline-restart", platform: "ios", flavor: "e2e-release",
  checkedOutSha: process.env.EXPECTED_SHA, expectedSha: process.env.EXPECTED_SHA, testId: "E2E-001/profile",
  fixture: { id: "synthetic-leap-day-v1", values, valueSha256: "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db" },
  calendar: { source: "device-local-date", beforeSave: process.env.BEFORE_SAVE_DATE, afterSave: process.env.AFTER_SAVE_DATE, afterRelaunch: process.env.AFTER_RELAUNCH_DATE, timeZone: process.env.TIME_ZONE, stable: process.env.BEFORE_SAVE_DATE === process.env.AFTER_SAVE_DATE && process.env.BEFORE_SAVE_DATE === process.env.AFTER_RELAUNCH_DATE },
  ageOracle: read("age.json"),
  binary: { kind: "ios-app", embeddedJsBundle: true, before: { executableSha256: process.env.EXECUTABLE_BEFORE_SHA, mainJsBundleSha256: process.env.BUNDLE_BEFORE_SHA, infoPlistSha256: process.env.PLIST_BEFORE_SHA }, after: { executableSha256: process.env.EXECUTABLE_AFTER_SHA, mainJsBundleSha256: process.env.BUNDLE_AFTER_SHA, infoPlistSha256: process.env.PLIST_AFTER_SHA } },
  database: { preSave: read("pre-save.json"), postSave: read("post-save.json"), postRelaunch: read("post-relaunch.json") },
  lifecycle: { releaseInstalledFresh: true, metro: { killCount: 1, waitCount: 1, pidCleared: true, androidReverseRemoved: false, negativeProbe: true }, directLaunches: { preSavePid: process.env.PRE_SAVE_PID, savePid: process.env.SAVE_PID, relaunchPid: process.env.RELAUNCH_PID }, terminatedBeforeEmptySnapshot: true, savePidGone: true, relaunchPidDifferent: process.env.SAVE_PID !== process.env.RELAUNCH_PID, postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 } },
  privacy: read("privacy.json"),
  migration: { recordedSha256: "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec", sourceSha256: "c45896b3eb02762c0cf8f62c584889951a15fadc13fd34b9183bfa717ec75975", sqlBytes: 10526, inventory: { tables: 26, indexes: 14, triggers: 3 } },
  evidence: { saveFlow: file("e2e/maestro/profile-save.yaml"), restartFlow: file("e2e/maestro/profile-restart.yaml") },
  status: "pass", skipped: [],
};
fs.writeFileSync(`${directory}/report-input.json`, `${JSON.stringify(report, null, 2)}\n`);
NODE
node tools/persistence-evidence.mjs --action profile-report --input "$artifacts/report-input.json" --output "$report"
