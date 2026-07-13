#!/usr/bin/env bash
set -euo pipefail

mkdir -p .artifacts/launch .artifacts/test-results
mapfile -t emulator_serials < <(adb devices | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1 }')
test "${#emulator_serials[@]}" -eq 1
emulator_serial="${emulator_serials[0]}"
cd android && ./gradlew :app:assembleDebug --no-daemon && cd ..
adb -s "$emulator_serial" install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$emulator_serial" reverse tcp:8081 tcp:8081
CI=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 EXPO_UNSTABLE_BONJOUR=0 NODE_OPTIONS=--dns-result-order=ipv4first REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR=e2e npx --no-install expo start --dev-client --localhost --port 8081 > /tmp/metro.log 2>&1 &
metro_pid=$!
trap 'kill "$metro_pid" 2>/dev/null || true; cat /tmp/metro.log' EXIT
for attempt in $(seq 1 60); do curl --silent --fail http://127.0.0.1:8081/status >/dev/null && break; sleep 2; done
curl --silent --fail http://127.0.0.1:8081/status
dev_client_url='formobile-test://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'
printf 'device=%s\nurl=%s\n' "$emulator_serial" "$dev_client_url" | tee .artifacts/launch/android-dev-client.log
adb -s "$emulator_serial" shell am start -W -a android.intent.action.VIEW -d "$dev_client_url" -p com.luyao618.formobile 2>&1 | tee -a .artifacts/launch/android-dev-client.log
grep -q '^Status: ok' .artifacts/launch/android-dev-client.log
maestro --device "$emulator_serial" test e2e/maestro/shell-readiness.yaml 2>&1 | tee .artifacts/launch/android-readiness.log
maestro --device "$emulator_serial" test e2e/maestro/shell-smoke.yaml 2>&1 | tee .artifacts/test-results/android-maestro.attempt.log
mv .artifacts/test-results/android-maestro.attempt.log .artifacts/test-results/android-maestro.log
