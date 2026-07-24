#!/usr/bin/env bash
set -euo pipefail
udid=${1:?simulator UDID required}
expected_sha=${2:?expected SHA required}
app_id=com.luyao618.formobile
artifacts=.artifacts/persistence/ios
diagnostics=.artifacts/launch/persistence/ios
mkdir -p "$artifacts" "$diagnostics"
data_container=$(xcrun simctl get_app_container "$udid" "$app_id" data)
device_db="$data_container/Documents/SQLite/user.db"
local_db="$artifacts/user.db"
stop() { xcrun simctl terminate "$udid" "$app_id"; }
pull_db() {
  rm -f "$local_db" "$local_db-wal" "$local_db-shm"
  cp "$device_db" "$local_db"; test -s "$local_db"
  for suffix in -wal -shm; do [ ! -f "$device_db$suffix" ] || cp "$device_db$suffix" "$local_db$suffix"; done
}
push_db() {
  test ! -s "$local_db-wal"
  sqlite3 "$device_db" ".restore '$local_db'"
  destination_checkpoint=
  destination_checkpoint_status=0
  destination_checkpoint=$(sqlite3 "$device_db" "PRAGMA wal_checkpoint(TRUNCATE);") || destination_checkpoint_status=$?
  if [ "$destination_checkpoint_status" -ne 0 ]; then
    [ "${1-}" = destination-readback ] || return "$destination_checkpoint_status"
  fi
}
launch() { xcrun simctl launch "$udid" "$app_id" >/dev/null; }
ready() { maestro --device "$udid" test e2e/maestro/persistence-readiness.yaml; }
error_screen() { maestro --device "$udid" test e2e/maestro/bootstrap-error.yaml; }
retry() { maestro --device "$udid" test e2e/maestro/bootstrap-retry.yaml; }

stop; pull_db
node tools/persistence-evidence.mjs --action snapshot --database "$local_db" --output "$artifacts/first.json"
node tools/persistence-evidence.mjs --action seed-recovery --database "$local_db"
push_db; launch; ready; stop; pull_db
node tools/persistence-evidence.mjs --action snapshot --database "$local_db" --output "$artifacts/recovered.json"
rm -f "$local_db-wal" "$local_db-shm"
push_db; launch; ready; stop; pull_db
node tools/persistence-evidence.mjs --action snapshot --database "$local_db" --output "$artifacts/recovered-noop.json"
node tools/persistence-evidence.mjs --action corrupt-hash --database "$local_db"
push_db; launch; error_screen
node tools/persistence-evidence.mjs --action repair-hash --database "$local_db"
push_db destination-readback
NODE_NO_WARNINGS=1 node tools/persistence-evidence.mjs --action destination-readback --platform ios --scenario migrationHashRetry --expected-sha "$expected_sha" --source "$local_db" --destination "$device_db" --destination-checkpoint-status "$destination_checkpoint_status" --destination-checkpoint "$destination_checkpoint" --output "$diagnostics/migrationHashRetry.json"
retry; stop; pull_db
node tools/persistence-evidence.mjs --action snapshot --database "$local_db" --output "$artifacts/retried.json"
cp "$local_db" "$artifacts/canonical.db"
rm -f "$local_db"
node tools/persistence-evidence.mjs --action create-poison --database "$local_db"
node tools/persistence-evidence.mjs --action poison-snapshot --database "$local_db" --output "$artifacts/poison-before.json"
push_db; launch; error_screen; pull_db
node tools/persistence-evidence.mjs --action poison-snapshot --database "$local_db" --output "$artifacts/poison-after.json"
cp "$artifacts/canonical.db" "$local_db"
push_db destination-readback
NODE_NO_WARNINGS=1 node tools/persistence-evidence.mjs --action destination-readback --platform ios --scenario failedMigrationRollback --expected-sha "$expected_sha" --source "$local_db" --destination "$device_db" --destination-checkpoint-status "$destination_checkpoint_status" --destination-checkpoint "$destination_checkpoint" --output "$diagnostics/failedMigrationRollback.json"
retry; stop
node tools/persistence-evidence.mjs --action report --platform ios --expected-sha "$expected_sha" --first "$artifacts/first.json" --recovered "$artifacts/recovered.json" --recovered-noop "$artifacts/recovered-noop.json" --retried "$artifacts/retried.json" --poison-before "$artifacts/poison-before.json" --poison-after "$artifacts/poison-after.json" --output .artifacts/ios-persistence.json
rm -f "$artifacts"/*.db "$artifacts"/*.db-wal "$artifacts"/*.db-shm
