#!/usr/bin/env bash
set -euo pipefail

mkdir -p .artifacts/launch/device .artifacts/launch/maestro .artifacts/launch/metro .artifacts/test-results
mapfile -t emulator_serials < <(adb devices | awk '$1 ~ /^emulator-/ && $2 == "device" { print $1 }')
test "${#emulator_serials[@]}" -eq 1
emulator_serial="${emulator_serials[0]}"
metro_log=.artifacts/launch/metro/android-metro.log
metro_pid=
cleanup() {
  status=$?
  trap - EXIT
  set +e
  if [ "$status" -ne 0 ]; then
    adb -s "$emulator_serial" exec-out screencap -p > .artifacts/launch/device/android-failure.png
    adb -s "$emulator_serial" exec-out uiautomator dump /dev/tty > .artifacts/launch/device/android-ui-hierarchy.xml 2>&1
    app_pid=$(adb -s "$emulator_serial" shell pidof -s com.luyao618.formobile 2>/dev/null | tr -d "\r")
    if [ -n "$app_pid" ]; then
      adb -s "$emulator_serial" logcat -d --pid="$app_pid" > .artifacts/launch/device/android-app.log 2>&1
    else
      adb -s "$emulator_serial" logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V '*:S' > .artifacts/launch/device/android-app.log 2>&1
    fi
  fi
  if [ -n "$metro_pid" ]; then
    kill "$metro_pid" 2>/dev/null
    wait "$metro_pid" 2>/dev/null
  fi
  if [ -f "$metro_log" ]; then
    cat "$metro_log"
  fi
  exit "$status"
}
trap cleanup EXIT
wait_for_package_service() {
  for attempt in $(seq 1 60); do adb -s "$emulator_serial" shell service check package 2>/dev/null | tr -d '\r' | grep -Fxq 'Service package: found' && break; sleep 2; done
  adb -s "$emulator_serial" shell service check package 2>/dev/null | tr -d '\r' | grep -Fxq 'Service package: found'
}
install_apk() {
  set +e
  install_output=$(adb -s "$emulator_serial" install --no-streaming -r android/app/build/outputs/apk/debug/app-debug.apk 2>&1)
  install_status=$?
  set -e
  printf '%s\n' "$install_output"
  return "$install_status"
}
wait_for_package_service
if ! install_apk; then
  if grep -Eq -e "^(cmd: )?Can't find service: package$" -e '^(cmd: )?Failure calling service package: Broken pipe( \([0-9]+\))?$' <<< "${install_output//$'\r'/}"; then
    wait_for_package_service
    install_apk
  else
    exit "$install_status"
  fi
fi
adb -s "$emulator_serial" reverse tcp:8081 tcp:8081
CI=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 EXPO_UNSTABLE_BONJOUR=0 NODE_OPTIONS=--dns-result-order=ipv4first REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR=e2e npx --no-install expo start --dev-client --localhost --port 8081 > "$metro_log" 2>&1 &
metro_pid=$!
for attempt in $(seq 1 60); do curl --silent --fail http://127.0.0.1:8081/status >/dev/null && break; sleep 2; done
curl --silent --fail http://127.0.0.1:8081/status
dev_client_url='formobile-test://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'
printf 'device=%s\nurl=%s\n' "$emulator_serial" "$dev_client_url" | tee .artifacts/launch/android-dev-client.log
adb -s "$emulator_serial" shell am start -W -a android.intent.action.VIEW -d "$dev_client_url" -p com.luyao618.formobile 2>&1 | tee -a .artifacts/launch/android-dev-client.log
grep -q '^Status: ok' .artifacts/launch/android-dev-client.log
maestro --device "$emulator_serial" test --debug-output .artifacts/launch/maestro/android-readiness e2e/maestro/shell-readiness.yaml 2>&1 | tee .artifacts/launch/android-readiness.log
maestro --device "$emulator_serial" test --debug-output .artifacts/launch/maestro/android-smoke e2e/maestro/shell-smoke.yaml 2>&1 | tee .artifacts/test-results/android-maestro.attempt.log
mv .artifacts/test-results/android-maestro.attempt.log .artifacts/test-results/android-maestro.log
