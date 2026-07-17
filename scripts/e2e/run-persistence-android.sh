#!/usr/bin/env bash
set -euo pipefail
serial=${1:?android emulator serial required}
expected_sha=${2:?expected SHA required}
app_id=com.luyao618.formobile
artifacts=.artifacts/persistence/android
mkdir -p "$artifacts"
local_db="$artifacts/user.db"
pull_db() {
  rm -f "$local_db" "$local_db-wal" "$local_db-shm"
  adb -s "$serial" exec-out run-as "$app_id" cat files/SQLite/user.db > "$local_db"
  test -s "$local_db"
  for suffix in -wal -shm; do
    if adb -s "$serial" shell run-as "$app_id" test -f "files/SQLite/user.db$suffix"; then
      adb -s "$serial" exec-out run-as "$app_id" cat "files/SQLite/user.db$suffix" > "$local_db$suffix"
    fi
  done
}
push_db() {
  test ! -s "$local_db-wal"
  adb -s "$serial" push "$local_db" /data/local/tmp/for-mobile-user.db >/dev/null
  adb -s "$serial" shell run-as "$app_id" sh -c 'cat /data/local/tmp/for-mobile-user.db > files/SQLite/user.db && rm -f files/SQLite/user.db-wal files/SQLite/user.db-shm'
  adb -s "$serial" shell rm -f /data/local/tmp/for-mobile-user.db
}
launch() {
  adb -s "$serial" shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/.MainActivity" >/dev/null
}
stop() { adb -s "$serial" shell am force-stop "$app_id"; }
ready() { maestro --device "$serial" test e2e/maestro/persistence-readiness.yaml; }
error_screen() { maestro --device "$serial" test e2e/maestro/bootstrap-error.yaml; }
retry() { maestro --device "$serial" test e2e/maestro/bootstrap-retry.yaml; }

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
node tools/persistence-evidence.mjs --action report --platform android --expected-sha "$expected_sha" --first "$artifacts/first.json" --recovered "$artifacts/recovered.json" --recovered-noop "$artifacts/recovered-noop.json" --retried "$artifacts/retried.json" --poison "$artifacts/poison.json" --output .artifacts/android-persistence.json
rm -f "$artifacts"/*.db "$artifacts"/*.db-wal "$artifacts"/*.db-shm
