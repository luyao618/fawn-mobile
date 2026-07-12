#!/usr/bin/env bash
set -euo pipefail

platform=${1:?platform must be android, ios, or all}
mode=${2:-}
script_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
registry=${FAULT_POINTS_FILE:-$repo_root/src/testing/faultPoints.json}
if [[ "$platform" != "android" && "$platform" != "ios" && "$platform" != "all" ]]; then
  printf 'platform must be android, ios, or all\n' >&2
  exit 64
fi
if [[ -n "$mode" && "$mode" != "--dry-run" ]]; then
  printf 'only --dry-run is supported as an optional argument\n' >&2
  exit 64
fi
points=(
  turn.after_user_commit
  turn.after_response_commit
  job.after_lease
  backup.after_db_snapshot
  backup.after_album_copy
  restore.after_journal_prepared
  restore.after_live_db_closed
  restore.after_live_move_before_phase
  restore.after_live_moved
  restore.after_promote_before_phase
  restore.after_staged_promoted
  restore.after_verified
  restore.after_committed_before_cleanup
)
node --input-type=module - "$registry" "${points[@]}" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const [registry, ...expected] = process.argv.slice(2);
const actual = JSON.parse(readFileSync(registry, "utf8"));
assert.deepEqual(actual, expected, "fault registry must exactly match the ordered normative 13-point contract");
NODE
platforms=("$platform")
[[ "$platform" == "all" ]] && platforms=(android ios)
for target in "${platforms[@]}"; do
  for point in "${points[@]}"; do
    "$script_dir/run-fault-${target}.sh" "$point" "$mode"
  done
done
