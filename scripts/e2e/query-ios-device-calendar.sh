#!/usr/bin/env bash
set -euo pipefail

udid=${1:?simulator UDID required}
simulator_arch=$(uname -m)
case "$simulator_arch" in
  arm64|x86_64) ;;
  *) echo "Unsupported simulator host architecture: $simulator_arch" >&2; exit 1 ;;
esac

probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/g031-ios-device-calendar.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
probe="$probe_dir/device-calendar"
xcrun --sdk iphonesimulator swiftc \
  -parse-as-library \
  -target "${simulator_arch}-apple-ios13.0-simulator" \
  scripts/e2e/ios-device-calendar.swift \
  -o "$probe"

output=$(xcrun simctl spawn "$udid" "$probe" | tr -d '\r')
case "$output" in *$'\n'*) echo "Simulator calendar probe returned multiple lines" >&2; exit 1 ;; esac
IFS=$'\t' read -r local_date time_zone extra <<< "$output"
case "$local_date" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "Simulator calendar probe returned an invalid local date" >&2; exit 1 ;;
esac
test -n "$time_zone"
test -z "${extra:-}"
printf '%s\t%s\n' "$local_date" "$time_zone"
