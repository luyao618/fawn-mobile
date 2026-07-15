#!/usr/bin/env bash
set -euo pipefail

point=${1:?fault point is required}
mode=${2:-}
uri="formobile-test://fault?point=${point}&mode=crash_once"
if [[ "$mode" == "--dry-run" ]]; then
  printf 'ios\t%s\txcrun simctl openurl booted %q\n' "$point" "$uri"
  exit 0
fi
printf 'iOS live fault execution is unavailable in Slice 1; persisted fault boundaries are not implemented.\n' >&2
exit 2
