# G016 Tool Timeout and Diagnostic Retention - Direction Approved Design

**Status:** direction approved; written design pending user review

**Date:** 2026-07-28

**Delivery:** narrow repair to PR 28 before its existing dependent PR sequence continues

## 1. Outcome and stop condition

This repair bounds every external command used by the G016 evidence validator and its test fixture helper, preserves actionable timeout diagnostics, and adds a static-job containment limit. It prevents a single external tool from holding CI indefinitely while keeping the validator fail-closed.

Success means:

- production `runTool` uses `MAX_TOOL_DURATION_MS = 120_000` for every G016 external invocation;
- timed-out commands return `ok: false` with command identity, `ETIMEDOUT`, the terminating signal, and the configured duration;
- the G016 fixture helper uses the same duration and `SIGKILL` behavior;
- executable regression coverage proves bounded return and direct-child reaping for a child that ignores `SIGTERM`;
- the production/public default cannot be weakened through the test-only duration override;
- the `static` job has a 90-minute containment timeout; and
- PR 28 is merged only from a new exact head after all required gates and independent reviews are clean.

The work stops at this timeout, diagnostic, regression, and CI-containment repair. It does not redesign process execution or the later PRs.

## 2. Incident evidence

1. PR 28 head `26270fde15182dadb6ed17f0ad765ca2394dbaac` is GitHub Verified.
2. Actions run `30304566601`, static job `90105510214`, ran from `2026-07-27T20:54:18Z` through `2026-07-28T02:54:43Z`. GitHub cancelled it at the six-hour limit.
3. The Node test log reported test 81, which starts at `tests/unit/backup/g016-proof-and-validator.test.ts:725`, as passing. No result for the next subtest appeared.
4. The next test starts at `tests/unit/backup/g016-proof-and-validator.test.ts:756` and exercises implementation symbols. This localizes the missing progress to work after test 81 without claiming which external command stalled.
5. Production `runTool` at `spikes/backup-crypto/deviceEvidenceValidator.mjs:654` calls `spawnSync` without a timeout. All G016 external invocations through that function inherit the unbounded behavior, including the `plutil` calls at lines 930-933.
6. The fixture helper at `tests/unit/backup/g016-proof-and-validator.test.ts:105` also calls `spawnSync` without a timeout.
7. The `static` job declaration at `.github/workflows/ci.yml:12-20` has no job timeout.

## 3. Scope and non-goals

### 3.1 In scope

- Bound production G016 external commands at the shared `runTool` boundary.
- Retain timeout attribution in the `runTool` result and existing caller failure messages.
- Bound external commands launched by the G016 test fixture helper.
- Add a narrow test-only duration override and executable timeout regressions.
- Add `timeout-minutes: 90` to the `static` job.
- Preserve existing `cwd`, encoding, input, and `maxBuffer` behavior.

### 3.2 Non-goals

- No process-group or descendant-cleanup guarantee.
- No asynchronous process-runner or full process-group rewrite.
- No broad CI workflow redesign or test serialization project.
- No design work for PR 29, PR 24, or PR 19.
- No weakening of G016 validation, exact-head checks, review gates, or merge safety.

## 4. Execution contract

1. Production defines `MAX_TOOL_DURATION_MS = 120_000`.
2. Every G016 external invocation through `runTool` passes `timeout: MAX_TOOL_DURATION_MS` and `killSignal: "SIGKILL"` to `spawnSync`.
3. `runTool` retains its current `cwd`, binary or UTF-8 encoding, input, and `MAX_TOOL_BUFFER` behavior.
4. A timeout is a validation failure. `runTool` remains fail-closed and returns `ok: false` rather than retrying, continuing as if the tool succeeded, or suppressing the error.
5. The G016 test fixture helper applies the same production duration and `SIGKILL` behavior to its external commands.
6. This contract covers direct children launched through these two synchronous boundaries. It does not claim that killing the direct child also kills descendants.

## 5. Diagnostics contract

For a timed-out command, the `runTool` result retains enough attribution to identify:

- the command identity;
- error code `ETIMEDOUT`;
- the terminating signal;
- the configured duration; and
- the existing captured stdout and stderr behavior.

Existing caller failure messages gain this bounded attribution instead of hanging without a result. The diagnostic contract must remain fail-closed: missing, malformed, or timed-out external-tool output cannot become a successful validation.

The contract does not require a new general logging system, a new error hierarchy, or speculative classification beyond the timeout facts returned by `spawnSync`.

## 6. Test seam and regressions

The implementation adds a narrow test-only duration override so the timeout regression completes quickly. The seam exists only to shorten the executable regression and must not weaken or replace the production/public `120_000` ms default.

Regression coverage must:

1. launch a child process that ignores `SIGTERM`;
2. invoke it through the production `runTool` boundary with the narrow test duration;
3. assert that control returns within a bounded test interval;
4. assert `ok: false`;
5. assert timeout code `ETIMEDOUT`;
6. assert signal `SIGKILL`;
7. assert the configured test duration is retained in the result; and
8. assert the direct child is reaped.

Additional coverage must prove that production/public callers cannot select a duration below the fixed production default through the test seam. The fixture-helper path must also remain covered with its production-equivalent timeout and signal contract.

These regressions prove direct-child behavior only. They must not assert process-group cleanup or descendant termination.

## 7. CI containment

The `static` job receives `timeout-minutes: 90` at the job level. This is a containment backstop for failures that escape per-process handling, including descendants that may survive their direct parent.

The job timeout is not a substitute for the 120-second `runTool` and fixture-helper bounds. Per-process limits provide prompt failure attribution; the job limit caps the remaining runner exposure.

## 8. Risks and mitigations

1. **A legitimate tool exceeds 120 seconds.** The validator fails closed with command, duration, error-code, signal, stdout, and stderr attribution so the failure can be investigated without an unbounded runner.
2. **The test override leaks into production behavior.** Keep the seam narrow and test-only, and add regression coverage that production/public callers cannot weaken the fixed default.
3. **A direct child ignores graceful termination.** Use `SIGKILL` and verify bounded return plus direct-child reaping.
4. **A grandchild survives after the direct child is killed.** Make no descendant-cleanup claim; use the 90-minute static-job timeout as containment.
5. **A timeout is mistaken for successful validation.** Preserve `ok: false` and existing fail-closed caller behavior while adding attribution.

## 9. Rejected alternatives

1. **Only serialize tests.** Serialization may change contention but does not bound a blocked external command or produce timeout attribution.
2. **Only add a job timeout.** A job-level limit contains runner cost but still withholds per-command diagnosis and can waste up to the full job duration.
3. **Force-merge cancelled CI.** The cancelled run did not establish a clean exact-head static gate and cannot support a safe merge.
4. **Perform a full async process-group rewrite.** That may support stronger descendant control, but it is disproportionate to this narrow repair and would expand behavior and review risk.

## 10. Implementation touchpoints

- `spikes/backup-crypto/deviceEvidenceValidator.mjs`: define the fixed production duration, apply timeout and `SIGKILL` in `runTool`, retain timeout attribution, and expose only the narrow test seam needed by the regression.
- `tests/unit/backup/g016-proof-and-validator.test.ts`: bound the fixture helper and add executable timeout, attribution, production-default, and direct-child-reaping regressions.
- `.github/workflows/ci.yml`: add the 90-minute timeout to `static`.

No other implementation surface is part of this design unless the exact regression fixture requires a narrowly scoped test asset.

## 11. Verification gates

Before delivery, verify:

- the timeout regression returns within its bounded interval for a child that ignores `SIGTERM`;
- the result is `ok: false` and attributes `ETIMEDOUT`, `SIGKILL`, command identity, and configured duration;
- the direct child is reaped;
- production/public callers cannot weaken `MAX_TOOL_DURATION_MS` through the test override;
- the fixture helper uses the same 120-second and `SIGKILL` contract;
- existing G016 proof and validator tests pass;
- the exact-head `static`, Android, and iOS checks pass; and
- fresh independent `code-reviewer`, `architect`, `test-engineer`, and `verifier` reviews are clean.

No verification result may claim process-group or descendant cleanup.

## 12. Rollout and merge sequence

1. Never rerun head `26270fde15182dadb6ed17f0ad765ca2394dbaac`.
2. Implement the repair as a substantive new SSH-signed Lore commit so PR 28 receives a new exact-head SHA.
3. Push once and allow automatic CI only. Do not manually rerun the obsolete head.
4. Keep PR 29 open until PR 28 merges.
5. Merge PR 28 only after `static`, Android, and iOS are green for the exact new head and fresh independent `code-reviewer`, `architect`, `test-engineer`, and `verifier` reviews are clean.
6. Confirm the merged commit is GitHub Verified and fast-forward local `main` before dependent work.
7. PR 24, then PR 19, remain sequential later follow-ups. This design does not define their implementation.
