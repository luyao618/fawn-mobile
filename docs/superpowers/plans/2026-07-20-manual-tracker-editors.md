# G034 Five-Domain Manual Tracker Editors — Implementation Plan

**Status:** execution-ready plan for the approved G034 design
**Date:** 2026-07-20
**Delivery unit:** one implementation PR after the documentation checkpoint is merged
**Acceptance ownership:** `G025-UI-001..009` plus regression-only execution of the existing exact-head native workflows

## 1. Outcome and fixed boundaries

Implement the approved Records-tab manual CRUD workspace for growth, feeding, sleep, diaper, and health. The UI must use only `ManualTrackerServicePort`, preserve G032 validation/confirmation/revision semantics, convert device-local minute text to canonical UTC without guessing, and reconcile reads and mutations correctly across bottom-tab blur/refocus.

The executor must preserve these non-negotiable boundaries throughout every task:

- no new dependency, lockfile change, migration, repository/schema/transaction behavior change, permission, asset, font, or native module;
- no tracker-specific Maestro flow, restart script, evidence schema, generated native artifact, `G025-E2E-001`, `E2E-002`, or full `E2E-006` claim; G035 owns tracker-native persistence evidence;
- no WHO rows, percentile calculation/display/editing, growth interpretation, timeline, aggregate, chart, profile gate/default/validation, pending task, model, network, telemetry, account, or cloud behavior;
- no direct feature import of infrastructure, SQLite, migrations, `DataMutationCoordinator`, exclusive transactions, repositories, pending tasks, provider/model code, or `BabyProfileServiceContext`;
- no user-permission pauses during clear local edit/test/verify work; agents continue through red-green-refactor and verification automatically, stopping only for an actual destructive/credential/authority blocker;
- do not weaken an existing gate to make G034 pass.

Authoritative inputs are `AGENTS.md`, `DESIGN.md`, `docs/superpowers/specs/2026-07-20-manual-tracker-editors-design.md`, merged G032 commit `c49ae20e077daf6d4cd104fe9fcd9860b282418f` and its tracker service/repository/tests, current package scripts, and the design’s recorded final architect/critic resolutions. If implementation pressure conflicts with the approved design, the design wins and scope is reduced rather than improvised.

## 2. Delivery topology and ownership rules

### 2.1 Start from the merged documentation checkpoint

Do not implement on top of an unmerged docs worktree. After the documentation PR is squash-merged and shows **Verified**, run this linked-worktree-safe sequence from the primary checkout; retire only the clean documentation worktree, and after the squash merge retain `codex/g034-manual-editor-ui` as a local audit branch while synchronizing the already-checked-out primary `main` and creating a distinct implementation branch/worktree directly from the verified `origin/main` SHA:

```bash
cd /Users/yao/work/code/personal/fawn-mobile
git fetch origin
test "$(git branch --show-current)" = main
git pull --ff-only origin main
git status --short --branch
git log -1 --show-signature --format=fuller
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git worktree remove /private/tmp/fawn-mobile-g034-editor-ui
git worktree add -b codex/g034-manual-editor-ui-impl \
  /private/tmp/fawn-mobile-g034-editor-ui-impl "$(git rev-parse origin/main)"
cd /private/tmp/fawn-mobile-g034-editor-ui-impl
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git status --short --branch
```

Required facts before Task 1:

1. `origin/main` contains the approved `DESIGN.md`, the approved G034 spec, and this plan.
2. The merged documentation commit/PR shows **Verified** on GitHub.
3. The worktree is clean and the implementation branch points exactly at that merged `origin/main` SHA.
4. `git config user.name`, `git config user.email`, and `git config user.signingkey` resolve to the `luyao618` GitHub identity and its SSH signing key.

### 2.2 Delegation model

Use one leader and bounded delegated agents with disjoint write ownership. Dependent tasks remain sequential. An agent may read adjacent files but edits only its listed ownership set. Shared-file changes (`manualTrackerService.ts`, composition, navigation, `ManualTrackerScreen.tsx`) are assigned to exactly one agent at a time. Agents must not revert concurrent work and must hand off test evidence plus changed paths.

Recommended lanes:

- **Lane A — application boundary:** Task 1 only.
- **Lane B — pure model utilities:** Task 2 only, after Task 1 is green.
- **Lane C — runtime/context/navigation:** Task 3 only, after Task 1.
- **Lane D — presentation/forms:** Tasks 4–5, after Task 2 and Task 3 contracts are green.
- **Lane E — state machine:** Task 6, after Tasks 4–5; this lane owns the screen reducer/orchestrator files exclusively.
- **Lane F — verification/review:** Tasks 7–9; no feature edits unless a failing check produces a bounded fix handoff.

### 2.3 Test-first rule

For every behavior-bearing task below:

1. add the named focused test and run it to observe the intended red failure;
2. implement the smallest production change that makes that test pass;
3. rerun the focused test and adjacent regression tests;
4. refactor only while the focused suite remains green;
5. record the exact command/result in the commit body or PR evidence.

Tests that inspect static styles/import boundaries may begin red against an absent file. Do not create empty production placeholders merely to manufacture green.

## 3. Task sequence

### Task 1 — Application-owned conflict contract and infrastructure adapter

**Depends on:** merged documentation checkpoint only.
**Acceptance contribution:** `G025-UI-007`, `G025-UI-008`, `G025-UI-009`.
**Agent ownership:**

- modify `src/application/tracker/manualTrackerService.ts`;
- add `src/infrastructure/db/repositories/trackerConflictClassifier.ts`;
- modify `src/infrastructure/bootstrap/createProductionBootstrap.ts`;
- modify `tests/support/trackerTestHarness.ts` to inject `RepositoryTrackerConflictClassifier` for real SQLite service tests;
- modify `tests/unit/tracker/tracker-domain.test.ts` to inject an explicit application classifier test double at its direct `ManualTrackerService` construction site;
- modify `tests/unit/tooling/eslint-boundaries.test.ts` for the claimed application/feature-to-infrastructure import boundary;
- add `tests/unit/tracker/manual-tracker-conflicts.test.ts`;
- modify `tests/integration/tracker/manual-tracker-persistence.test.ts` only for real SQLite conflict translation coverage;
- modify `tests/app/createProductionBootstrap.test.ts` only for composition-constructor coverage.

**Symbols/contracts:**

- add exported `ManualTrackerConflictCode = "stale_write" | "not_found"`;
- add exported `ManualTrackerConflictClassifierPort.classify(error: unknown)`;
- add exported `ManualTrackerConflictError` with only typed `code` and no repository row/entity/SQL detail;
- add exported `isManualTrackerConflictError(value)` that recognizes the application class/contract without duck-typing arbitrary `code` values;
- extend `ManualTrackerService` constructor with the classifier and route only persistence exceptions from confirmed `update`/`delete` writes through one private wrapper such as `translateConflict(error: unknown): never`;
- add `RepositoryTrackerConflictClassifier` as the only new code allowed to inspect `RepositoryConflictError`, mapping only `stale_write` and `not_found`, returning `null` for `duplicate`, `illegal_transition`, and unknown values;
- inject that adapter in `createProductionBootstrap` and `tests/support/trackerTestHarness.ts`; inject an explicit application-layer classifier test double in `tests/unit/tracker/tracker-domain.test.ts`; do not change `ManualTrackerServicePort` operation signatures.

**Red tests first:**

1. table-test classifier mapping for both allowed codes and rejection of every other repository/unknown error;
2. test the guard against the application error, plain `{code: "stale_write"}`, `RepositoryConflictError`, and generic errors;
3. test confirmed service update/delete wrapping while unmatched failures retain object identity and generic behavior;
4. integration-test stale and missing SQLite mutations crossing `ManualTrackerServicePort` as `ManualTrackerConflictError` without exposing `currentState` or entity data;
5. static import assertions prove application/feature code does not import `src/infrastructure/**` and feature code does not inspect error names/shapes.

**Commands:**

```bash
npx tsx --test tests/unit/tracker/manual-tracker-conflicts.test.ts
npx tsx --test tests/unit/tracker/tracker-domain.test.ts
npx tsx --test tests/integration/tracker/manual-tracker-persistence.test.ts
npx tsx --test tests/unit/tooling/eslint-boundaries.test.ts
npm run test:app -- --runTestsByPath tests/app/createProductionBootstrap.test.ts
npm run typecheck
npm run lint
```

**Done when:** only the adapter knows `RepositoryConflictError`; application callers receive the narrow error; unmatched errors are unchanged; no schema/repository behavior changed.

**Backup commit boundary C1 and PR checkpoint:** SSH-sign a Lore commit whose intent is to keep persistence conflicts behind the application service boundary. After its targeted suites, typecheck, and lint are green, push it and immediately open the single G034 PR as a draft using the `luyao618` identity. Update that same draft PR through C2–C6; do not open parallel G034 PRs or merge C1 independently.

---

### Task 2 — Pure strict parsers, local-time resolver, draft conversion, and summaries

**Depends on:** Task 1 green; no UI dependency.
**Acceptance contribution:** `G025-UI-001..005`, normalized comparison portion of `G025-UI-007`, and formatting/list facts in `G025-UI-009`.
**Agent ownership:**

- add `src/features/tracker/trackerLocalTime.ts`;
- add `src/features/tracker/trackerEditorModel.ts`;
- add `src/features/tracker/trackerPresentation.ts`;
- add `tests/unit/tracker/tracker-local-time.test.ts`;
- add `tests/unit/tracker/tracker-editor-model.test.ts`;
- add `tests/unit/tracker/tracker-presentation.test.ts`.

These files remain pure TypeScript: no React, React Native, navigation, repositories, profile state, locale-dependent parsing, or implicit local `Date` construction.

**Required symbols:**

- `parseStrictTrackerDate`, `parseStrictIntegerText`, `parseStrictDecimalText`;
- `captureDeviceTimeZone`, `isUsableIanaZone`, `resolveLocalMinute`, `formatInstantForDeviceZone`, and `instantToLocalMinuteDraft`;
- `createInitialDraft(domain, now, zone)`, `recordToEditorDraft(domain, record, zone)`, `parseDraftToCreateInput`, `parseDraftToUpdateInput`, `isDraftDirty`, and exact visible-value comparison helpers;
- `formatTrackerRecordSummary`, `formatTrackerConfirmationFields`, and update-diff construction using stable Chinese field order.

Names may be tightened during implementation, but each responsibility must remain explicit and unit-testable. Use discriminated results rather than exceptions for expected user input failures.

**Red tests first — local time:**

- strict ASCII date/time syntax, real leap dates, overflow rejection, and instant lower bound `2000-01-01` while date-only fields retain G032’s earlier-date support;
- valid `UTC` as a real zone, invalid-zone rejection with no fallback, ordinary unique minute, `Asia/Kathmandu` non-hour offset, known DST gap, known DST fold, and an unrepresentable/out-of-range instant;
- exact numeric Gregorian `formatToParts` comparison and second `00` requirement;
- enumerate raw offsets inclusively from `-1440` through `+1440`, prove endpoints, exactly 2,881 maximum candidates, numeric dedupe before cardinality, and finite termination;
- construct years without `Date.UTC` remapping and require G032 canonical four-digit millisecond UTC output/round-trip;
- assert the implementation never calls `Date.parse(localText)`, never uses an open-ended zone search, never falls back to host local time/UTC, and makes no pre-2000 historical-second-offset claim.

**Red tests first — parsers/drafts:**

- all G032 numeric boundaries and exact enums; `0` remains a value, empty optional text/numeric becomes `null`, malformed/sign/exponent/grouped/whitespace numeric text fails;
- growth requires one measurement, create percentiles/source are `null`, edit stores loaded percentiles as hidden metadata, and update returns those exact values including `0`;
- formula amount and breast duration requirements; optional values survive type changes;
- paired sleep end, resolved UTC ordering, and nap forcing/disabling zero wakings;
- health Unicode title behavior delegates final trim/range normalization to G032 while local syntax errors map to Chinese fields;
- every create DTO contains `sourceMessageId: null`; no ID/revision/time is generated in feature code;
- local visible no-op and normalized semantic no-op comparisons keep `null` distinct from `0`, ignore hidden percentiles, and catch whitespace-only health-title edits after summary normalization.

**Red tests first — presentation:**

- date-only and local-instant Chinese formats exactly match the approved spec and never expose raw ISO/UTC;
- all five row summaries, enum wording, units, optional `有备注`/`有说明`, sleep-end wording, and absence of IDs/timestamps/source/percentiles;
- stable confirmation field order, `未填写`, full wrapping text values, and update diffs containing only changed visible fields.

**Commands:**

```bash
npx tsx --test tests/unit/tracker/tracker-local-time.test.ts
npx tsx --test tests/unit/tracker/tracker-editor-model.test.ts
npx tsx --test tests/unit/tracker/tracker-presentation.test.ts
npx tsx --test tests/unit/tracker/tracker-domain.test.ts
npm run typecheck
npm run lint
```

**Done when:** all conversions are deterministic/fail-closed, the 2,881-candidate bound is proven, DTOs exactly match G032, hidden percentiles survive edit, and summaries contain no technical/private fields.

**Backup commit boundary C2:** SSH-sign a Lore commit whose intent is deterministic, dependency-free tracker input and presentation semantics. Push as backup only after all Task 2 commands pass; do not merge.

---

### Task 3 — Tracker service context, runtime composition, and Records navigation wiring

**Depends on:** Task 1. May run parallel to Task 2 because write sets are disjoint.
**Acceptance contribution:** service-only/no-profile and navigation portions of `G025-UI-009`.
**Agent ownership:**

- add `src/features/tracker/ManualTrackerServiceContext.tsx`;
- add a temporary minimal exported `ManualTrackerScreen` shell in `src/features/tracker/ManualTrackerScreen.tsx` only if needed to complete wiring; Task 6 becomes its exclusive owner afterward;
- modify `src/navigation/RootNavigator.tsx`;
- modify `src/features/shell/ShellScreens.tsx` to remove the placeholder `RecordsScreen` export only;
- modify `tests/app/navigation/RootNavigator.test.tsx`;
- modify `tests/app/AppComposition.test.tsx` only if the ready runtime fixture needs its existing `tracker` service typed explicitly.

Do not change routes or add a stack. `RecordsTab` remains the same tab identity/order and `StewardTab` remains initial.

**Red tests first:**

1. `ManualTrackerServiceProvider` returns exactly the ready runtime’s `tracker` port and throws only when genuinely outside readiness/provider scope;
2. `RootNavigator` wraps Records with tracker service while preserving the existing baby-profile provider for its current consumers;
3. Records renders and starts a tracker list read with no profile/context/profile snapshot prerequisite;
4. tabs remain exactly five in the approved order and no internal tracker route is introduced.

**Commands:**

```bash
npm run test:app -- --runTestsByPath tests/app/navigation/RootNavigator.test.tsx tests/app/AppComposition.test.tsx
npm run typecheck
npm run lint
```

**Done when:** the feature sees only `ManualTrackerServicePort`, the placeholder shell destination is gone, no route identity changed, and no profile service is called to render Records.

**Backup commit boundary C3:** SSH-sign a Lore commit whose intent is to expose the merged tracker service to Records without widening navigation or data boundaries. Push as backup; do not merge.

---

### Task 4 — Accessible list/editor primitives and five domain forms

**Depends on:** Tasks 2 and 3 green.
**Acceptance contribution:** field/form/list foundations for `G025-UI-001..005` and semantics/layout portions of `G025-UI-009`.
**Agent ownership:**

- add `src/features/tracker/TrackerDomainSwitcher.tsx`;
- add `src/features/tracker/TrackerRecordList.tsx`;
- add `src/features/tracker/TrackerFormPrimitives.tsx`;
- add `src/features/tracker/TrackerEditor.tsx`;
- add `src/features/tracker/forms/GrowthTrackerForm.tsx`;
- add `src/features/tracker/forms/FeedingTrackerForm.tsx`;
- add `src/features/tracker/forms/SleepTrackerForm.tsx`;
- add `src/features/tracker/forms/DiaperTrackerForm.tsx`;
- add `src/features/tracker/forms/HealthTrackerForm.tsx`;
- add `tests/app/features/tracker/TrackerDomainSwitcher.test.tsx`;
- add `tests/app/features/tracker/TrackerRecordList.test.tsx`;
- add `tests/app/features/tracker/TrackerEditor.test.tsx`.

Task 4 components are controlled/presentational. They receive state and callbacks; they do not call services or own async request generations.

**Red tests first:**

- one horizontal `tablist` labeled `记录类型`; exact five `tab` controls/order/full labels/selected state, minimum 44 pt, no pill/equal squeezed columns/truncation;
- list reads are represented in service order without local sorting; create action precedes rows; rows have button role, minimum 48 pt, structured accessibility labels, no nested cards, and exact empty/bound-copy wording;
- shared inputs/radios/actions expose unique Chinese labels, units, radio group/check/disabled state, errors, busy/disabled props, font scaling, wrapping, and minimum targets;
- all five forms render exact approved field order/copy/enums; growth never mounts percentile controls; sleep nap shows zero/disabled message; health shows neutral non-diagnostic notice;
- no `numberOfLines`, ellipsis, fixed line height, fixed form/footer height, absolute bottom action, hidden text scaling, or forced single-row destructive/primary actions;
- `AppFrame` usage requests `keyboardDismissMode="on-drag"`; current `keyboardShouldPersistTaps="handled"`, responsive 16/24/32 pt padding, centered 640 pt max width, and Android resize config remain intact.

**Commands:**

```bash
npm run test:app -- --runTestsByPath \
  tests/app/features/tracker/TrackerDomainSwitcher.test.tsx \
  tests/app/features/tracker/TrackerRecordList.test.tsx \
  tests/app/features/tracker/TrackerEditor.test.tsx
npm run typecheck
npm run lint
```

**Done when:** all five controlled forms can render parsed errors and exact values at 200% scaling-compatible tree/style level without any service or profile import.

---

### Task 5 — Interlocked confirmation and guarded accessibility focus primitives

**Depends on:** Task 4.
**Acceptance contribution:** `G025-UI-006`, confirmation portions of `G025-UI-007..008`, and accessibility portions of `G025-UI-009`.
**Agent ownership:**

- add `src/features/tracker/InlineTrackerConfirmation.tsx`;
- add `src/features/tracker/trackerAccessibility.ts`;
- add `tests/app/features/tracker/InlineTrackerConfirmation.test.tsx`;
- add `tests/app/features/tracker/trackerAccessibility.test.ts`.

**Required contracts:**

- immutable decision variants `healthCreate`, `update`, `delete`, and `discard`, each carrying the exact frozen service summary/prior editor state/initiating ref and discard destination where applicable;
- decision UI renders in place of the editor/workspace actions, never as an OS alert or overlay over operable controls;
- `focusRefIfAvailable(ref)` performs `findNodeHandle(ref.current)` followed by `AccessibilityInfo.setAccessibilityFocus(tag)` only for a current ref and non-null numeric tag, with no timer or retry loop.

**Red tests first:**

- health confirmation exact title/consequence/buttons/full normalized values/neutral notice;
- update confirmation exact changed-field old/new content and no hidden percentile/UTC/DTO key;
- delete wording says disappearance/no restore entry, never physical/permanent deletion;
- discard exact title/body/actions/destination snapshot;
- only decision actions remain in the interactive/accessibility tree, both become busy/disabled during accepted submission, and cancel restores the byte-for-byte prior controlled state with no confirm callback;
- focus helper calls and safe no-call cases for missing/unmounted refs and null/non-numeric native tags;
- headers, assertive error/alert props, polite loading/success live regions, and initiating-control/list-heading stable refs are component-provable.

**Commands:**

```bash
npm run test:app -- --runTestsByPath \
  tests/app/features/tracker/InlineTrackerConfirmation.test.tsx \
  tests/app/features/tracker/trackerAccessibility.test.ts
npm run typecheck
npm run lint
```

**Done when:** confirmations are immutable interlocks, cancel cannot write, and native focus is guarded exactly as approved.

**Backup commit boundary C4:** combine Tasks 4–5 in one SSH-signed Lore commit only after both focused suites pass. The intent should be to make every domain editable with accessible, non-overlaid decisions. Push as backup; do not merge.

---

### Task 6 — Records state machine, all CRUD semantics, conflicts, and blur/refocus ownership

**Depends on:** Tasks 1–5.
**Acceptance contribution:** completes `G025-UI-001..009`.
**Exclusive agent ownership:**

- replace/complete `src/features/tracker/ManualTrackerScreen.tsx`;
- add `src/features/tracker/trackerScreenState.ts`;
- add `tests/app/features/tracker/ManualTrackerScreen.domains.test.tsx`;
- add `tests/app/features/tracker/ManualTrackerScreen.confirmation.test.tsx`;
- add `tests/app/features/tracker/ManualTrackerScreen.concurrency.test.tsx`;
- modify `tests/app/features/ShellScreens.test.tsx` only for regression assertions affected by removing the placeholder Records export;
- modify `tests/app/navigation/RootNavigator.test.tsx` only for final integrated Records focus behavior.

Keep pure transition decisions in `trackerScreenState.ts`; keep refs/effects/service calls in `ManualTrackerScreen.tsx`. Do not add a general state-management dependency.

**Red-green tranche 6A — list, domain, create/edit forms (`G025-UI-001..005`, `009`):**

1. fresh mount defaults to growth; mounted return preserves selected domain; exact order/labels; list calls use exactly `service.list(domain, 100)`;
2. domain switch in list starts only that domain read; late list/get results are ignored after newer generation/domain/focus session/unmount;
3. row press calls `getById`; null safely returns/reloads with exact message; rejected get enters edit error without stale draft;
4. table-drive all five list/create/edit/delete entry paths and exact form DTOs, including growth hidden percentiles, feeding `0`, sleep gap/fold/order/nap, diaper enums, health date/title/notice;
5. no-profile fixture renders and operates Records;
6. low-risk growth/feeding/sleep/diaper create calls once and treats only `completed` as success; unexpected `confirmation_required` is a safe form failure.

**Red-green tranche 6B — frozen confirmation/revision semantics (`G025-UI-006..008`):**

1. health create probe returns confirmation; cancel makes zero confirmed calls/writes; accept calls `create(summary.domain, summary.input, "confirmed")` with the exact returned frozen input;
2. table-drive every domain update: local exact visible no-op makes no service call; unconfirmed update uses exact ID/full parsed input/loaded `updatedAt`; post-normalization semantic no-op applies normalized visible values, shows `内容没有更改。`, and makes no confirmed call/revision;
3. update cancel restores exact frozen draft/baseline/token; accept uses only `summary.domain/id/input/expectedUpdatedAt` plus `"confirmed"`; completed record becomes the mutation/token fact but does not synthesize list placement;
4. table-drive every domain delete: cancel retains row/editor; accept uses exact summary revision; only completed deletion removes the active row, with soft-delete-safe copy;
5. all decision panels remove editor/domain/back/delete/create/row controls from the tree; no mutable draft reread on accept.

**Red-green tranche 6C — dirty/discard/conflict/error semantics (`G025-UI-007..009`):**

1. create dirty means caregiver change from defaults; edit dirty uses visible fields only; bottom-tab blur preserves mounted draft without discard;
2. back/domain/conflict replacement with dirty draft enters frozen discard; continue restores exact draft; discard applies exact frozen destination with no write;
3. `ManualTrackerConflictError("stale_write")` freezes draft/summary, never overwrites/retries/guesses token/current row, and offers reload/list through discard when dirty;
4. stale reload uses `getById`, replaces baseline/token only when found, and safely handles null; `not_found` retains draft until explicit discard then reloads list;
5. validation maps known fields to adjacent Chinese alerts, unknown field to the generic form message without exposing raw keys; runtime unavailable/generic save/delete errors retain draft and never auto-retry;
6. retry actions repeat only the failed list/get/zone resolution, never a mutation.

**Red-green tranche 6C-zone — captured-zone/current-zone orchestration (`G025-UI-002..004`, `009`):**

1. named test `captures a valid device zone on instant-domain create/edit entry and keeps that zone fixed for the entire draft` asserts create and loaded-record formatting/parsing continue to receive the entry zone despite later device-zone reads;
2. named test `rechecks the current device zone immediately before save and submits once when it still matches` asserts one pre-submit zone read, one service mutation, and the DTO resolved with the fixed draft zone;
3. named test `blocks save after a device-zone change, retains every draft field, and performs zero service mutations` asserts exact alert `本机时区已变化，请重新打开记录后再保存。`, the original enabled editor controls after dismissal, retained values/focus context, and zero create/update calls;
4. named tests `blocks instant-domain list/create/edit when the entry zone is invalid` and `blocks an instant-domain save when the current-zone recheck becomes invalid` assert exact alert `无法确认本机时区，暂不能显示或编辑这类记录。`, only the `重新读取本机时区` recovery control where display/edit is blocked, retained draft where one exists, and zero service list/get/create/update/delete calls while blocked;
5. named test `zone retry repeats only zone resolution and re-enters the requested state when valid` asserts the retry control label, polite/assertive live-region transition as specified, exact zone-resolver call count, restored focus target, and zero mutation replay; changed/invalid-zone blocking never falls back to UTC or rewrites/closes the draft.

**Named read/error/success/focus cases required across the domain and concurrency suites (`G025-UI-009`):**

1. `initial and domain loading reserve heading/action geometry` asserts exact polite live-region copy `正在读取{域}记录…`, reserved heading/action geometry, no stale rows, and unavailable mutation controls;
2. `list read failure with no committed rows offers only read retry` asserts exact copy `暂时无法读取{域}记录。本机数据没有更改。`, `重新读取记录`, one failed `list(domain, 100)` call, and retry increments only that list call;
3. `refresh failure retains committed service rows and offers read retry` asserts exact prior row identity/order, copy `记录可能不是最新内容。`, `重新读取记录`, no mutation replay, and one additional list call per retry;
4. `edit loading disables back until get settles` asserts exact copy `正在读取这条{域}记录…`, polite live-region state, disabled back control, one `getById` call, and no editable fields;
5. `edit read failure exposes retry and return without a stale draft` asserts exact copy `暂时无法读取这条记录。本机数据没有更改。`, controls `重新读取这条记录` and `返回{域}列表`, one additional `getById` call only when retrying, no mutation calls, and list-heading focus on return;
6. table-driven `completed create/update/delete announces exact success once and focuses the list heading` asserts respectively `{域}记录已保存`, `{域}记录已更新`, and `{域}记录已删除` in the approved live region; exact approved service call counts (one direct low-risk create call, or one unconfirmed probe plus one confirmed call for health create/update/delete); one success emission/announcement; one operation-owned refresh; cleared draft/decision; and the list-heading focus target, including blur/refocus delivery exactly once;
7. `validation focuses the first invalid field` table-drives every form ordering and asserts exact adjacent Chinese alert copy, assertive live-region semantics, zero service calls, and the first invalid native input ref rather than the form heading or submit action;
8. every retry case above, plus zone retry, asserts it repeats only the failed read or zone operation, preserves the documented controls/copy/focus target, and leaves create/update/delete call counts unchanged.

**Red-green tranche 6D — mounted mutation versus focused read ownership (`G025-UI-009`):**

Use controlled deferred promises and the real navigation focus lifecycle.

1. ordinary list/get requests carry read generation + domain + focus session and ignore late completions after blur/domain/newer read/unmount;
2. health-create, update, and delete probe each owns one mount epoch + operation ID from first call through confirmation/error/conflict/confirmed call/refresh; blur does not invalidate or replay it;
3. when each probe resolves blurred, confirmation/error/conflict reconciles immediately; confirmation is frozen/rendered but heading focus/announcement is queued exactly once until relevant refocus;
4. direct create and confirmed create/update/delete each resolve after blur: completed clears draft/decision, records the returned mutation fact, returns to list, starts one operation-owned `list(domain, 100)`, and never replays;
5. refocus before the operation-owned refresh resolves starts no competing ordinary list/get; the original refresh applies if its mount operation still owns state;
6. unmount suppresses all UI application; next mount performs an ordinary authoritative read;
7. refresh success replaces rows in service order; create/update refresh failure preserves the exact prior row array/order; delete refresh failure removes only the known completed ID; no local insert/replace/sort/trim/next-row synthesis occurs;
8. retry after refresh failure performs only `list(domain, 100)`;
9. blurred success/error/conflict queues only still-relevant focus/announcement; refocus delivers once to confirmation/list heading as applicable; irrelevant queued effects are dropped.

**Focused commands after each tranche:**

```bash
npm run test:app -- --runTestsByPath tests/app/features/tracker/ManualTrackerScreen.domains.test.tsx
npm run test:app -- --runTestsByPath tests/app/features/tracker/ManualTrackerScreen.confirmation.test.tsx
npm run test:app -- --runTestsByPath tests/app/features/tracker/ManualTrackerScreen.concurrency.test.tsx
npm run test:app -- --runTestsByPath \
  tests/app/features/ShellScreens.test.tsx \
  tests/app/navigation/RootNavigator.test.tsx
npm run typecheck
npm run lint
```

**Done when:** every accepted mutation path is completed-only, every confirmation uses its frozen summary/token, every blur/refocus race is deterministic, and all `G025-UI-001..009` component facts have a named test.

**Backup commit boundary C5:** SSH-sign a Lore commit whose intent is safe mounted-operation reconciliation without stale reads, replay, or guessed list truth. Push promptly as the final implementation backup; still do not merge.

---

### Task 7 — Accessibility, responsive, keyboard, and manual/native-regression evidence

**Depends on:** Task 6 green.
**Acceptance contribution:** final evidence for `G025-UI-009`; no `E2E-006` claim.
**Agent ownership:** tests and evidence review only unless a concrete failure is handed back to the owning implementation lane. Do not add tracker-specific native scripts/flows/artifact schemas.

**Component/static evidence scan:**

- exact roles/states/labels/live-region props and decision interlock;
- guarded focus call/no-call paths;
- all targets at least 44 pt (rows at least 48 pt), text scaling enabled, no clipping/truncation/fixed line height/footer;
- horizontal domain scroll, vertical form/confirmation reachability, `keyboardDismissMode="on-drag"`, taps handled, existing Android resize behavior, responsive 16/24/32 padding and 640 max width;
- 320 pt and 200% tree/style assertions do not force five columns or horizontal action rows.

**Manual checks on both existing native platforms at the exact candidate SHA:**

1. VoiceOver and TalkBack traversal/order for tabs, radio groups, fields, errors, decisions, and rows;
2. actual focus landing for first invalid field, confirmation heading, cancel initiator, and success list heading;
3. one-shot spoken loading/error/success while focused and deferred announcement after blur/refocus;
4. keyboard does not obscure focused field/error/action after scroll; domain switch and bottom tabs remain reachable after dismissal;
5. exercise the full `320x568`, `360x800`, `390x844`, `430x932`, and `768x1024` matrix for every domain and every list/create/edit/confirmation/discard state; labels, values, errors, decisions, and actions remain reachable and unclipped;
6. repeat every critical create/edit/confirmation/discard flow at actual 200% text and with reduced motion enabled on both platforms; record focus, announcement, scroll reachability, and absence of motion-dependent state changes;
7. touch targets are usable and domain controls scroll rather than compress.

Record manual results in the PR description/review checklist, not as a new native-evidence implementation. Explicitly label them manual/native regression observations and state that they do not prove `G025-E2E-001` or full `E2E-006`.

**Commands:**

```bash
npm run test:app -- tests/app/features/tracker
npm run test:config
npm run test:fault-scaffold
git diff --check
```

**Backup commit boundary C6:** only if Task 7 required code/test fixes, SSH-sign a focused Lore fix commit and rerun all affected focused suites. Pure PR evidence needs no repository commit.

---

### Task 8 — Full local static and regression gates

**Depends on:** Tasks 1–7 complete and clean diff review.
**Acceptance contribution:** regression requirement for `G025-UI-009` and merge safety.

Run from a clean dependency install matching CI where feasible; do not regenerate or commit native projects/artifacts:

```bash
npm ci --workspaces --include-workspace-root
npm --prefix spikes/sqlite-fts ci --ignore-scripts --workspaces=false
npm --prefix spikes/backup-crypto ci --ignore-scripts --workspaces=false
npm --prefix spikes/model-transport ci --ignore-scripts --workspaces=false
npm run test:dependencies
npm run typecheck
npm run lint
npm test -- --runInBand
npm run test:node
PYTHONDONTWRITEBYTECODE=1 python3 tools/knowledge/download_who_sources.py
PYTHONDONTWRITEBYTECODE=1 python3 tools/knowledge/download_who_sources.py --offline
npm run test:knowledge
npm run test:config
npm run test:licenses
npm run test:audit
npm audit signatures --workspaces=false
npx --no-install expo install --check
npm run expo:doctor
npm run test:fault-scaffold
npm run test:fault-bundles
npm run slice0
npm run test:g017
npm run expo:doctor:g017
npm run g017:export:android
npm run g017:export:ios
node spikes/model-transport/deviceEvidenceValidator.mjs --fingerprint
BASE_SHA="$(git merge-base HEAD origin/main)"
git diff --check "$BASE_SHA"..HEAD
git diff --check
git diff --cached --check
test -z "$(git status --porcelain)"
```

The leader reviews the final diff for forbidden changes:

```bash
BASE_SHA="$(git merge-base HEAD origin/main)"
git diff --name-only "$BASE_SHA"..HEAD
git diff "$BASE_SHA"..HEAD -- package.json package-lock.json app.json app.config.ts \
  src/infrastructure/db/migrations src/infrastructure/db/repositories/trackerRepository.ts \
  .github/workflows e2e scripts
rg -n 'RepositoryConflictError|currentState|\.name\s*===|\.code\s*===' src/application src/features/tracker
rg -n 'BabyProfile|DataMutationCoordinator|ExclusiveTransaction|sqlite|migration|pending|provider|fetch\(' src/features/tracker
rg -n 'percentile|Percentile|sourceMessageId|updatedAt|createdAt|\.id\b' src/features/tracker
```

Interpret the last scan; permitted hidden DTO metadata/revision/source assignment in pure model/screen code must still not render. Any dependency, migration, workflow, e2e, or `src/infrastructure/db/repositories/trackerRepository.ts` diff is a release blocker. The sole exception is the already-reviewed C3 assertion-only pair at `ec2ca0e`: (1) the existing `e2e/maestro/shell-smoke.yaml` Records assertion changes from obsolete `还没有照护记录` to stable `生长记录`, and (2) only the exact matching assertion in `tests/unit/tooling/native-workflow-policy.test.ts` changes identically. This exception applies only when the policy fixture assertion is byte-identical to the e2e assertion and the existing exact-head Android and iOS native regressions succeed. It permits no tracker-specific step, flow, restart, evidence schema, artifact, or claim, establishes no future permission, and leaves every other e2e diff as a release blocker. Changes to `trackerRepository.ts` are forbidden without exception in G034; the approved Task 1 adapter is the separate `src/infrastructure/db/repositories/trackerConflictClassifier.ts` classifier/composition file and does not permit repository edits.

**Done when:** every local gate is green, no generated output is tracked, `git diff --check` passes, and no known error remains.

---

### Task 9 — Independent review, exact-head CI/native regression, signed PR, and merge checkpoint

**Depends on:** Task 8 green.
**Acceptance contribution:** final verification of `G025-UI-001..009` and existing native regression only.

1. Request an independent code review against the exact branch head. The reviewer must inspect application-layer dependency direction, 2,881-candidate termination/correctness, frozen confirmation/revision semantics, read-versus-mutation ownership, refresh-failure truth, accessibility tree, and all scope prohibitions.
2. Request an independent verifier to map every `G025-UI-001..009` row below to fresh test evidence and to reject unsupported native/persistence/accessibility claims.
3. Fix findings in narrow SSH-signed Lore commits; after each push, discard prior CI conclusions because the head SHA changed.
4. Confirm every commit is SSH-signed locally, push it, and update the single draft G034 PR opened after green C1 using the `luyao618` identity. Mark it ready only when Task 8 is green. The PR body includes the acceptance matrix, focused/full command results, scope exclusions, the `G035` follow-up boundary, and the full manual matrix: `320x568`, `360x800`, `390x844`, `430x932`, and `768x1024`; every domain and list/create/edit/confirmation/discard state; critical flows at actual 200% text and with reduced motion enabled on both platforms.
5. Capture the candidate SHA:

   ```bash
   HEAD_SHA="$(git rev-parse HEAD)"
   git status --short --branch
   git log --show-signature --format=fuller "origin/main..HEAD"
   gh pr view --json headRefOid,statusCheckRollup,reviews,mergeStateStatus
   test "$(gh pr view --json headRefOid --jq .headRefOid)" = "$HEAD_SHA"
   ```

6. Wait for the PR-triggered `CI` workflow at that exact SHA. Its `static`, reusable `android-e2e`, and reusable `ios-e2e` jobs already check out/assert the PR head SHA and exercise existing shell/profile native regressions. Do not add tracker flows to those workflows in G034.
7. Do not merge while any exact-head check is pending/red, review is unresolved, the PR head differs from reviewed/tested SHA, signatures are unverified, or manual evidence reports a blocker. Backup pushes and an open PR are allowed; they are not delivery completion.
8. When exact-head CI, Android, iOS, independent review, verifier mapping, and manual checks are clean, merge the PR. Confirm GitHub shows every delivered commit as **Verified**.
9. Fast-forward local `main` and verify the durable checkpoint before any G035 branch starts:

   ```bash
   cd /Users/yao/work/code/personal/fawn-mobile
   git fetch origin
   test "$(git branch --show-current)" = main
   git pull --ff-only origin main
   git status --short --branch
   git log -1 --show-signature --format=fuller
   ```

Only the merged, Verified `main` commit is G034 completion. G035 must branch from that checkpoint, never from the G034 feature branch or an open PR.

## 4. Acceptance-to-test traceability

| Acceptance ID | Required executable evidence |
|---|---|
| `G025-UI-001` | `tracker-editor-model.test.ts`, `tracker-presentation.test.ts`, `TrackerEditor.test.tsx`, and `ManualTrackerScreen.domains.test.tsx`: growth CRUD; one measurement; numeric bounds; create null percentiles; exact hidden percentile preservation. |
| `G025-UI-002` | Same four suites: feeding wording/CRUD; formula amount; breast duration; `0`; local-to-UTC unique conversion. |
| `G025-UI-003` | Local-time/model/editor/screen suites: sleep CRUD; paired end; resolved UTC ordering; nap zero; gap/fold rejection. |
| `G025-UI-004` | Model/presentation/editor/screen suites: diaper wording/CRUD and local-to-UTC conversion. |
| `G025-UI-005` | Model/presentation/editor/screen suites: health strict date/enums/Unicode title and neutral notice. |
| `G025-UI-006` | `InlineTrackerConfirmation.test.tsx` and `ManualTrackerScreen.confirmation.test.tsx`: returned health summary, cancel zero confirmed calls/writes, exact confirmed reuse, completed-only success/list return. |
| `G025-UI-007` | Conflict unit/integration tests plus model/confirmation/concurrency suites: table-driven update, both no-op layers, frozen cancel/token, exact confirmed summary, completed token fact, no conflict overwrite/retry. |
| `G025-UI-008` | Confirmation/concurrency suites: all-domain delete, cancel retains row, exact revision, completed-only active-row removal, soft-delete-safe copy. |
| `G025-UI-009` | Domain/list/editor/accessibility/navigation/concurrency suites plus manual checklist and existing exact-head CI Android/iOS jobs: order/default/100 bound/read states/no-profile/races/refresh truth/semantics/focus/target/scale/scroll/responsive behavior without an `E2E-006` or tracker restart claim. |

No acceptance row is complete from a snapshot alone. Each row requires fresh green commands at the final candidate SHA.

## 5. Commit and PR sequence

Use the Lore commit protocol and `git commit -S` for every commit. Recommended backup boundaries are:

1. **C1:** application conflict classifier/error/guard + infrastructure adapter + tests;
2. **C2:** pure local-time/parser/draft/formatter/summary utilities + bounded tests;
3. **C3:** tracker context/runtime/navigation wiring + tests;
4. **C4:** accessible list/editor/form/confirmation/focus primitives + tests;
5. **C5:** complete state machine, five-domain CRUD, conflicts, blur/refocus, refresh truth + tests;
6. **C6 (only if needed):** accessibility/manual-review or independent-review fixes.

Each boundary must keep all previously green targeted suites green. Open one draft G034 PR after signed, green C1, then push C2–C6 into and update that same PR promptly. The default is one final G034 merge: do not merge, cherry-pick to `main`, or start G035 before final exact-head checks and review are complete.

At every green backup boundary, the leader records an explicit checkpoint/extraction decision. If independently useful, reviewable green contract work would otherwise be stranded solely behind an unrelated slow external/native delay, the leader must explicitly steer Ultragoal before creating or merging any extra extraction PR, document the reduced acceptance boundary, and rerun all checks for that extraction’s exact head. Never extract coupled/incomplete work, weaken G034/G035 exclusions, or merge any PR while its exact-head checks are pending or red; absent a documented Ultragoal steering decision, continue updating the single draft G034 PR.

## 6. Residual execution risks and mitigations

1. **Intl/IANA variability in Jest or devices.** Pin tests to zones available in the supported Node 22/Expo runtime, fail closed when a zone is unavailable, and separately exercise real devices during manual regression. Never add a timezone dependency or fallback.
2. **2,881-candidate cost on repeated rendering.** Resolve only during draft conversion/save/explicit zone retry, not on every render or keystroke; keep the finite exhaustive algorithm unchanged and measure component responsiveness manually. Optimization may cache a formatter per captured zone but may not prune candidates or alter classification.
3. **React Navigation focus races are easy to test incorrectly.** Use actual focus/blur lifecycle in integrated tests plus deferred service promises; do not substitute a single boolean unit test for the mount-operation/focus-session distinction.
4. **Large state-machine surface can invite over-abstraction.** Keep pure discriminated state/transitions separate from effectful orchestration, reuse existing utilities/components, add no dependency, and require independent review before merge.
5. **React Native accessibility mocks do not prove native behavior.** Keep component claims limited to props/tree/calls/styles and record real VoiceOver/TalkBack/keyboard/200% observations without claiming `E2E-006`.
6. **Refresh failure can tempt optimistic list synthesis.** Preserve the exact prior service-ordered rows for create/update and remove only a known deleted ID after completed delete; enforce with referential/order assertions and reviewer inspection.
7. **Final review artifacts may not be present in an execution worktree.** The approved spec records their resolved decisions and has no blocker; if standalone artifacts are later supplied, the leader performs a read-only delta check before Task 1 and stops only for a genuine contradiction to the approved spec.
8. **Native workflows are long and head-sensitive.** Push only signed candidate commits, treat every push as invalidating old results, and merge only when PR head, reviewed SHA, static SHA, Android SHA, and iOS SHA are identical.

## 7. Completion definition

G034 is complete only when:

- the PR head implements and freshly proves every `G025-UI-001..009` row;
- no profile gate, dependency, migration, repository behavior, WHO data, tracker-native evidence, or G035 scope entered the diff;
- targeted tests, full Jest/Node/static gates, existing exact-head Android/iOS regressions, manual accessibility/responsive checks, independent review, and verifier mapping are clean for one identical SHA;
- all Lore commits show **Verified** on GitHub;
- the PR is merged and local `main` is fast-forwarded to the merged `origin/main` checkpoint.
