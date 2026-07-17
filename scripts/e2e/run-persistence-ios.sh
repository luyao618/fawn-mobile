#!/usr/bin/env bash
set -euo pipefail
udid=${1:?simulator UDID required}
expected_sha=${2:?expected SHA required}
app_id=com.luyao618.formobile
artifacts=.artifacts/persistence/ios
mkdir -p "$artifacts"
data_container=$(xcrun simctl get_app_container "$udid" "$app_id" data)
device_db="$data_container/Documents/SQLite/user.db"
local_db="$artifacts/user.db"
stop() { xcrun simctl terminate "$udid" "$app_id" 2>/dev/null || true; }
pull_db() {
  rm -f "$local_db" "$local_db-wal" "$local_db-shm"
  cp "$device_db" "$local_db"; test -s "$local_db"
  for suffix in -wal -shm; do [ ! -f "$device_db$suffix" ] || cp "$device_db$suffix" "$local_db$suffix"; done
}
push_db() { test ! -s "$local_db-wal"; cp "$local_db" "$device_db"; rm -f "$device_db-wal" "$device_db-shm"; }
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
push_db; retry; stop; pull_db
node tools/persistence-evidence.mjs --action snapshot --database "$local_db" --output "$artifacts/retried.json"
cp "$local_db" "$artifacts/canonical.db"
rm -f "$local_db"
node tools/persistence-evidence.mjs --action create-poison --database "$local_db"
push_db; launch; error_screen; pull_db
node tools/persistence-evidence.mjs --action poison-snapshot --database "$local_db" --output "$artifacts/poison.json"
cp "$artifacts/canonical.db" "$local_db"
push_db; retry; stop
node tools/persistence-evidence.mjs --action report --platform ios --expected-sha "$expected_sha" --first "$artifacts/first.json" --recovered "$artifacts/recovered.json" --recovered-noop "$artifacts/recovered-noop.json" --retried "$artifacts/retried.json" --poison "$artifacts/poison.json" --output .artifacts/ios-persistence.json
rm -f "$artifacts"/*.db "$artifacts"/*.db-wal "$artifacts"/*.db-shm
