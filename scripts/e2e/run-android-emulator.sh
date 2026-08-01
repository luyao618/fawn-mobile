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
    adb -s "$emulator_serial" logcat -b all -d > .artifacts/launch/device/android-system.log 2>&1
    adb -s "$emulator_serial" shell dumpsys activity lastanr > .artifacts/launch/device/android-lastanr.txt 2>&1
    adb -s "$emulator_serial" root
    timeout 30s adb -s "$emulator_serial" wait-for-device
    adb -s "$emulator_serial" shell 'ls -la /data/anr; cat /data/anr/*' > .artifacts/launch/device/android-anr-files.txt 2>&1
    app_pid=$(adb -s "$emulator_serial" shell pidof -s com.luyao618.formobile 2>/dev/null | tr -d "\r")
    if [ -n "$app_pid" ]; then
      adb -s "$emulator_serial" logcat -d --pid="$app_pid" > .artifacts/launch/device/android-app.log 2>&1
    else
      adb -s "$emulator_serial" logcat -d -s AndroidRuntime:E ActivityManager:I ReactNativeJS:V Expo:V '*:S' > .artifacts/launch/device/android-app.log 2>&1
    fi
  fi
  if [ -n "$metro_pid" ]; then
    kill -- "-$metro_pid" 2>/dev/null
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
android_system_readiness_log=.artifacts/launch/android-system-readiness.log
wait_for_android_system_ui() {
  : > "$android_system_readiness_log"
  probe_complete_pattern=$'^classification=(active-system-anr|healthy-launcher|transient-unhealthy-hierarchy)\npipeline-status=([0-9]{1,3}),([0-9]{1,3})$'
  probe_status_only_pattern='^pipeline-status=([0-9]{1,3}),([0-9]{1,3})$'
  for attempt in $(seq 1 12); do
    probe_envelope=$(
      set +e
      timeout --kill-after=1s 5s adb -s "$emulator_serial" exec-out uiautomator dump /dev/tty 2>&1 |
        python3 -c '
import re
import sys
import xml.etree.ElementTree as ET

MAX_HIERARCHY_BYTES = 1024 * 1024
KNOWN_TRAILERS = {
    "UI hierchary dumped to: /dev/tty",
    "UI hierarchy dumped to: /dev/tty",
}

payload = sys.stdin.buffer.read(MAX_HIERARCHY_BYTES + 1)
if len(payload) > MAX_HIERARCHY_BYTES:
    while sys.stdin.buffer.read(64 * 1024):
        pass
    raise ValueError("hierarchy payload too large")
if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", payload, re.IGNORECASE):
    raise ValueError("XML declarations are not allowed")
text = payload.decode("utf-8")
document = text.lstrip().rstrip()
for trailer in KNOWN_TRAILERS:
    if document.endswith(trailer):
        document = document[:-len(trailer)]
        if document != document.rstrip():
            raise ValueError("hierarchy trailer must be adjacent")
        break
root = ET.fromstring(document)
if root.tag != "hierarchy":
    raise ValueError("unexpected hierarchy root")
resource_ids = {element.get("resource-id") for element in root.iter()}
if resource_ids & {"android:id/aerr_close", "android:id/aerr_wait"}:
    classification = "active-system-anr"
elif len(root) == 1 and root[0].get("package") == "com.android.launcher3":
    classification = "healthy-launcher"
else:
    classification = "transient-unhealthy-hierarchy"
print(f"classification={classification}")
' 2>/dev/null
      probe_pipeline_status=("${PIPESTATUS[@]}")
      printf 'pipeline-status=%s,%s\n' "${probe_pipeline_status[0]}" "${probe_pipeline_status[1]}"
    )
    hierarchy_classification=
    probe_timeout_status=
    probe_parser_status=
    if [[ "$probe_envelope" =~ $probe_complete_pattern ]]; then
      hierarchy_classification="${BASH_REMATCH[1]}"
      probe_timeout_status="${BASH_REMATCH[2]}"
      probe_parser_status="${BASH_REMATCH[3]}"
    elif [[ "$probe_envelope" =~ $probe_status_only_pattern ]]; then
      probe_timeout_status="${BASH_REMATCH[1]}"
      probe_parser_status="${BASH_REMATCH[2]}"
    fi
    if [ -z "$probe_timeout_status" ] || [ -z "$probe_parser_status" ]; then
      printf 'attempt=%s/12 result=transient-unhealthy-hierarchy\n' "$attempt" | tee -a "$android_system_readiness_log"
    elif [ "$probe_timeout_status" -ne 0 ]; then
      printf 'attempt=%s/12 result=transient-unreadable exit=%s\n' "$attempt" "$probe_timeout_status" | tee -a "$android_system_readiness_log"
    elif [ "$probe_parser_status" -ne 0 ]; then
      printf 'attempt=%s/12 result=transient-unhealthy-hierarchy\n' "$attempt" | tee -a "$android_system_readiness_log"
    else
      case "$hierarchy_classification" in
        active-system-anr)
          printf 'attempt=%s/12 result=active-system-anr\n' "$attempt" | tee -a "$android_system_readiness_log"
          return 1
          ;;
        healthy-launcher)
          printf 'attempt=%s/12 result=healthy-launcher\n' "$attempt" | tee -a "$android_system_readiness_log"
          return 0
          ;;
        *)
          printf 'attempt=%s/12 result=transient-unhealthy-hierarchy\n' "$attempt" | tee -a "$android_system_readiness_log"
          ;;
      esac
    fi
    if [ "$attempt" -lt 12 ]; then
      sleep 2
    fi
  done
  printf 'result=exhausted probes=12\n' | tee -a "$android_system_readiness_log"
  return 1
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
set -m
CI=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 EXPO_UNSTABLE_BONJOUR=0 NODE_OPTIONS=--dns-result-order=ipv4first REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR=e2e npx --no-install expo start --dev-client --localhost --port 8081 > "$metro_log" 2>&1 &
metro_pid=$!
set +m
for attempt in $(seq 1 60); do curl --silent --fail http://127.0.0.1:8081/status >/dev/null && break; sleep 2; done
curl --silent --fail http://127.0.0.1:8081/status
wait_for_android_system_ui
dev_client_url='formobile-test://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'
printf 'device=%s\nurl=%s\n' "$emulator_serial" "$dev_client_url" | tee .artifacts/launch/android-dev-client.log
adb -s "$emulator_serial" shell am start -a android.intent.action.VIEW -d "$dev_client_url" -p com.luyao618.formobile 2>&1 | tee -a .artifacts/launch/android-dev-client.log
maestro --device "$emulator_serial" test --debug-output .artifacts/launch/maestro/android-readiness e2e/maestro/shell-readiness.yaml 2>&1 | tee .artifacts/launch/android-readiness.log
maestro --device "$emulator_serial" test --debug-output .artifacts/launch/maestro/android-smoke e2e/maestro/shell-smoke.yaml 2>&1 | tee .artifacts/test-results/android-maestro.attempt.log
mv .artifacts/test-results/android-maestro.attempt.log .artifacts/test-results/android-maestro.log
if [ -n "${EXPECTED_SHA:-}" ]; then
  bash scripts/e2e/run-persistence-android.sh "$emulator_serial" "$EXPECTED_SHA"
  kill -- "-$metro_pid"
  set +e
  wait "$metro_pid"
  metro_status=$?
  set -e
  test "$metro_status" -eq 0 -o "$metro_status" -eq 143
  metro_pid=
  adb -s "$emulator_serial" reverse --remove tcp:8081
  if curl --silent --fail http://127.0.0.1:8081/status >/dev/null; then
    echo "Metro remained reachable after teardown" >&2
    exit 1
  fi
  bash scripts/e2e/run-profile-restart-android.sh "$emulator_serial" "$EXPECTED_SHA" android/app/build/outputs/apk/release/app-release.apk
fi
