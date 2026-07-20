# G034 Five-Domain Manual Tracker Editors — Approved Design

**Status:** approved, implementation-ready design for G034

**Date:** 2026-07-20

**Delivery:** PR 1 of two sequential PRs; G035 follows only after G034 is merged

**Data authority:** merged G032 `TrackerDomain`, DTO, validation, confirmation-policy, `ManualTrackerServicePort`, and optimistic revision contracts

## 1. Outcome

G034 turns the existing `记录` destination into a Chinese-first, accessible, device-local manual CRUD workspace for five tracker domains. A caregiver can switch domain, read that domain’s recent active records, create a record, edit an existing record, or request its removal without leaving the Records tab. The work uses the merged G032 service contract, adds one narrow application-owned conflict-classifier/error boundary with an infrastructure composition adapter, and never requires a baby profile.

Success means:

- all five domains have usable, domain-correct forms and active lists;
- device-local date/time text is converted without guessing to canonical UTC instants;
- confirmations, validation, conflicts, busy states, and retries cannot cause premature or silent writes;
- growth percentile values remain hidden and are not destroyed by an unrelated edit;
- every completed mutation returns to the selected domain list with truthful text feedback;
- component coverage owns `G025-UI-001..009`;
- existing native workflows remain regression-green, while tracker-specific restart proof remains G035.

## 2. Scope boundaries

### 2.1 G034 includes

- One Records-tab screen with five-domain switching.
- Domain-scoped active reads using `list(domain, 100)`.
- Same-screen list, create, edit, inline confirmation, discard, loading, empty, error, stale, not-found, and success states.
- Manual create/update/delete through `ManualTrackerServicePort`.
- Strict Chinese device-local date/time entry and presentation.
- Health-create confirmation and update/delete confirmation for every domain.
- Optimistic revision-token handling using the loaded record’s `updatedAt`.
- One application-owned conflict classifier port/error/guard extension to `ManualTrackerService`, plus its infrastructure composition adapter, solely to translate repository `stale_write`/`not_found` conflicts without reversing dependencies.
- Component tests mapped to `G025-UI-001..009`.
- Regression execution of existing exact-head native gates only.

This boundary changes no persistence, schema, repository, migration, or transaction semantics.

### 2.2 G035 includes later

- `G025-E2E-001` and report type `manual-tracker-offline-restart`.
- New tracker Maestro flows, Android/iOS embedded-bundle Release restart scripts, database/lifecycle evidence, JSON artifact schemas, and associated native workflow policy changes.
- UI creation of all five domains, representative feeding edit, diaper soft-delete, termination/relaunch, and persisted fact comparison at the exact PR head.

G035 is sequential: branch after G034 is merged and local `main` is fast-forwarded. G034 must not pre-claim G035 evidence.

### 2.3 Non-goals

G034 adds none of the following:

- cross-domain timeline, dashboard, latest-metric card, total, trend, aggregate, insight, or chart;
- WHO data, percentile calculation, percentile display, reference bands, or growth interpretation;
- Agent, pending task, chat/message mapping, natural-language record correction, or canonical `E2E-002`;
- provider/model configuration, network request, telemetry, account, cloud sync, or server API;
- baby-profile prerequisite, before-birth validation, or profile-derived default;
- new “future date” rejection beyond G032’s existing strict date/instant validation;
- database schema or persistence behavior, repository/migration/transaction semantics, tombstone browser, or raw revision UI beyond the narrowly scoped conflict-classifier composition adapter above;
- new dependency, date picker, native module, platform permission, font, asset, or native-evidence implementation.

## 3. Reviewable assumptions chosen for this design

These are deliberate conservative defaults, not open questions or blockers:

1. The domain order is **生长、喂养、睡眠、大小便、健康** and first entry defaults to 生长. It follows the G032 contract order.
2. The Records screen has no internal navigation stack. List, create, edit, confirmation, and discard are modes of the same screen.
3. Each domain reads at most the newest 100 active records. There is no pagination or claim that older records do not exist.
4. New date-only fields default to the current device-local date. New feeding/diaper time and sleep start default to the current device-local date and minute. Sleep end starts blank. Defaults are ordinary editable draft text, not persisted until save.
5. Enum fields have no preselected value. The caregiver must explicitly choose a type. `夜醒次数` starts at `0`.
6. Local instants use two minute-precision text fields, `YYYY-MM-DD` and `HH:mm`; no picker or dependency is introduced. Manual instant entry supports local dates from `2000-01-01` through `9999-12-31` and uses the finite whole-minute candidate contract in §6. It makes no claim about pre-2000 historical second offsets.
7. Both DST gaps and DST folds are rejected. The UI never chooses an offset on the caregiver’s behalf.
8. Low-risk creates for growth, feeding, sleep, and diaper commit directly after local parsing and service validation. Health create and every update/delete use inline confirmation.
9. A dirty draft is memory-only. Leaving to another bottom tab preserves it while the screen remains mounted; switching Records domain or returning to its list requires explicit discard. Process death discards it, and no copy is written to storage.
10. G034 remains single-column at tablet widths. No 768 pt split view is introduced.
11. Optional text with exactly zero characters maps to `null`; non-empty text, including intentional leading/trailing whitespace, is passed unchanged except health title, which the G032 service trims.
12. Notes and description receive no UI-only length limit because G032 defines none. The UI must remain scrollable and stable for long input.

## 4. Information architecture

### 4.1 Records screen anatomy

Visual order is stable:

1. `TopBar`: title `记录`, badge `仅本机`.
2. Introductory text: `按类型查看和整理本机记录。`
3. Domain switcher labeled `记录类型`.
4. Mode heading and mode-specific content.
5. Inline notice or status, when relevant.

The switcher is one independently horizontally scrollable accessibility `tablist` labeled `记录类型`, containing five control-shaped `tab` elements—not buttons, pills, or five squeezed equal columns. Each tab has a minimum 44 pt height, 12 pt control radius, full untruncated Chinese text, selected styling plus `accessibilityState.selected`, and visible focus. Exact order:

| Order | Domain | Label | First-entry default |
|---:|---|---|---|
| 1 | `growth` | 生长 | Yes |
| 2 | `feeding` | 喂养 | No |
| 3 | `sleep` | 睡眠 | No |
| 4 | `diaper` | 大小便 | No |
| 5 | `health` | 健康 | No |

Switching domain in list mode immediately starts that domain’s list read. Returning to Records during the same mounted session restores the last selected domain. A fresh mount starts on 生长.

### 4.2 List-first behavior

The initial and post-success mode is `list`. Its heading is `{域}记录`, followed by `新增{域}记录`. The button appears before the record rows in reading order.

The list calls `service.list(domain, 100)` and accepts only its active results. Repository order is authoritative: descending domain business time, then descending ID. The UI does not resort, merge domains, infer missing dates, or append tombstones.

Below a non-empty list, show `显示最近最多 100 条{域}记录。` This copy states the read bound without claiming completeness. An empty list instead shows:

- heading: `还没有{域}记录`
- description: `新增后会保存在本机，并显示在这里。`

Each row is one pressable, bordered flat row with at least 48 pt minimum height; do not wrap a row in another card. The row exposes button role and the same structured Chinese summary as its accessibility label. Selecting it calls `getById(domain, id)` before entering edit mode so the form starts from the latest readable revision.

### 4.3 Same-screen editor behavior

Create heading: `新增{域}记录`

Edit heading: `编辑{域}记录`

Both show a top secondary action `返回{域}列表`. Edit also shows the destructive secondary action `删除这条记录` after the save action. There is no separate detail page.

The primary action labels are:

- create: `保存{域}记录`
- edit: `保存修改`

Form actions scroll with the form. They are not fixed above the bottom tab bar or keyboard.

## 5. Field and validation contract

### 5.1 Shared parsing rules

- Date text must be exactly `YYYY-MM-DD`, use ASCII digits, and be a real proleptic Gregorian date accepted by G032. Input hint: `例如 2026-07-20`.
- For instant fields only, the local date must be `2000-01-01` through `9999-12-31`. Earlier valid calendar dates are rejected with `本机时间仅支持 2000-01-01 及之后的日期。` Date-only growth/health fields retain G032’s `0001-01-01` through `9999-12-31` contract.
- Time text must be exactly `HH:mm`, ASCII digits, 24-hour clock, `00:00` through `23:59`. Input hint: `例如 08:10`.
- Integer text accepts ASCII digits only: no sign, decimal point, exponent, grouping comma, or surrounding whitespace.
- Decimal text accepts ASCII digits with at most one `.` and at least one digit on both sides when a dot exists: no sign, exponent, grouping comma, or surrounding whitespace.
- Empty optional numeric/text fields map to `null`. The value `0` is not empty.
- UI parsing catches obvious syntax and required-field errors. The service remains final authority; `TrackerValidationError.field` is privately mapped to a Chinese field error.
- There is no future-date or before-birth rejection. No form reads baby-profile state.
- All user-visible units are in the label and repeated in confirmation summaries.

### 5.2 Growth / 生长

| DTO field | Chinese field | Required | Input and range |
|---|---|---:|---|
| `measurementDate` | 测量日期 | Yes | strict date text |
| `weightG` | 体重（克） | Conditional | integer `100–50000` |
| `heightCm` | 身长（厘米） | Conditional | decimal `10–150` |
| `headCm` | 头围（厘米） | Conditional | decimal `10–100` |
| `notes` | 备注 | No | multiline text; empty maps null |

At least one of 体重、身长、头围 is required. Group error: `体重、身长、头围请至少填写一项。`

The DTO also contains `weightPercentile`, `heightPercentile`, and `headPercentile`. G034 never renders them as fields, list content, read-only facts, or confirmation content:

- create always sends all three as `null`;
- edit stores all three loaded values in non-editable draft metadata;
- update sends those exact loaded values unchanged, including `0` or any valid decimal;
- changing visible fields must not recompute, clear, round, or normalize them.

### 5.3 Feeding / 喂养

| DTO field | Chinese field | Required | Input and range |
|---|---|---:|---|
| `feedTime` | 喂养日期 + 喂养时间 | Yes | strict local date and time converted to one UTC instant |
| `feedType` | 喂养类型 | Yes | `breast` = 母乳; `formula` = 配方奶; `solid` = 辅食 |
| `amountMl` | 量（毫升） | Conditional | integer `0–2000`; required for 配方奶 |
| `durationMin` | 时长（分钟） | Conditional | integer `0–1440`; required for 母乳 |
| `notes` | 备注 | No | multiline text; empty maps null |

Cross-field messages:

- no type: `请选择母乳、配方奶或辅食。`
- 配方奶 without amount: `配方奶需要填写量。`
- 母乳 without duration: `母乳需要填写时长。`

Amount and duration remain available for every type because G032 permits both. The conditional requirement copy changes with the selected type; the UI does not silently erase an entered optional value when type changes.

### 5.4 Sleep / 睡眠

| DTO field | Chinese field | Required | Input and range |
|---|---|---:|---|
| `sleepStart` | 开始日期 + 开始时间 | Yes | strict local date/time converted to UTC |
| `sleepEnd` | 结束日期 + 结束时间 | No, paired | both blank = null; otherwise both required and converted to UTC |
| `sleepType` | 睡眠类型 | Yes | `nap` = 小睡; `night` = 夜间睡眠 |
| `nightWakings` | 夜醒次数 | Yes | integer `0–100` |
| `notes` | 备注 | No | multiline text; empty maps null |

Rules:

- If only one end field is filled: `结束日期和结束时间需要一起填写。`
- Converted end must be later than converted start: `结束时间需要晚于开始时间。`
- When 小睡 is selected, the draft sets 夜醒次数 to `0`, disables that input, and shows `小睡的夜醒次数固定为 0。`
- Switching from 夜间睡眠 to 小睡 intentionally replaces a nonzero draft count with `0`; it is a visible draft edit and is included in an update confirmation.

### 5.5 Diaper / 大小便

| DTO field | Chinese field | Required | Input and range |
|---|---|---:|---|
| `diaperTime` | 记录日期 + 记录时间 | Yes | strict local date/time converted to UTC |
| `diaperType` | 类型 | Yes | `poop` = 大便; `pee` = 小便; `mixed` = 混合 |
| `notes` | 备注 | No | multiline text; empty maps null |

No type is preselected. Error: `请选择大便、小便或混合。`

### 5.6 Health / 健康

| DTO field | Chinese field | Required | Input and range |
|---|---|---:|---|
| `recordDate` | 记录日期 | Yes | strict date text; no time-zone conversion |
| `recordType` | 健康记录类型 | Yes | `vaccination` = 疫苗接种; `illness` = 身体不适; `checkup` = 常规检查 |
| `title` | 标题 | Yes | after service trim, `1–200` Unicode code points |
| `description` | 说明 | No | multiline text; empty maps null |

Health title error: `标题需要填写，且最多 200 个字符。`

Health type error: `请选择疫苗接种、身体不适或常规检查。`

Show the passive notice above the action: `健康记录用于整理照护信息，不提供诊断。`

## 6. Device-local date/time semantics

### 6.1 Date-only values

`measurementDate` and `recordDate` are calendar dates, not instants. They are submitted exactly as validated `YYYY-MM-DD` text. They are displayed as `YYYY年M月D日`. They never shift when the device time zone changes.

### 6.2 Instant values

`feedTime`, `sleepStart`, `sleepEnd`, and `diaperTime` are canonical millisecond UTC instants in G032. The editor presents two device-local text fields and resolves them only at validation/save time.

The editor captures `Intl.DateTimeFormat().resolvedOptions().timeZone` when create/edit mode opens. The captured value must be a usable IANA zone accepted by `Intl.DateTimeFormat` and must remain unchanged until the draft closes. Before submission, resolve the current device zone again:

- if it differs from the captured zone, block save with `本机时区已变化，请重新打开记录后再保存。` and retain the draft;
- if no valid IANA zone is available, block display/edit/save for instant-based domains with `无法确认本机时区，暂不能显示或编辑这类记录。` and offer `重新读取本机时区`;
- never fall back to `UTC`, a numeric current offset, locale parsing, `Date.parse` of local text, or the JavaScript host’s implicit local constructor. A device that genuinely resolves to the valid zone `UTC` is accepted; the forbidden behavior is substituting UTC after zone resolution fails.

### 6.3 Finite fail-closed conversion

The implementation owns one pure local-time utility with these results:

```text
resolveLocalMinute(dateText, timeText, ianaZone)
  -> { status: "unique", instant: canonicalUtc }
   | { status: "gap" }
   | { status: "fold" }
   | { status: "invalid_date" | "invalid_time" | "invalid_zone" | "out_of_range" }
```

Resolution semantics are complete and finite:

1. Parse strict ASCII Gregorian date components and strict `HH:mm`; reject overflow rather than normalizing it. A valid instant-entry local date before `2000-01-01` returns `out_of_range`. No current-date comparison exists, so dates through `9999-12-31` are not rejected merely for being in the future.
2. Validate `ianaZone` by constructing `Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone: ianaZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })`. Construction failure returns `invalid_zone`.
3. Compute `wallMinuteUtc` from the parsed numeric components as if they were UTC, with seconds/milliseconds `00.000`. The implementation must construct the year without JavaScript’s `Date.UTC` 0–99 remapping; the instant-entry lower bound also keeps all accepted local years four-digit.
4. Enumerate every integer `offsetMinutes` from `-1440` through `+1440`, inclusive. For each, compute `candidateMs = wallMinuteUtc - offsetMinutes * 60_000`. This examines exactly 2,881 raw candidates, covering all whole-minute offsets without assuming whole hours or a 24-hour day.
5. For each finite candidate, use the formatter’s `formatToParts`, read only `year`, `month`, `day`, `hour`, `minute`, and `second` numeric parts, and require exact equality with the requested local components and second `00`. Never compare localized display strings.
6. Dedupe successful `candidateMs` values in a numeric set before cardinality classification. The resolver therefore considers at most 2,881 candidates and produces no duplicate fold count.
7. Separately require `new Date(candidateMs).toISOString()` to match G032’s four-digit canonical `YYYY-MM-DDTHH:mm:ss.sssZ` form and to round-trip through `Date` unchanged. If local round-trip matches exist but none is representable by that G032 canonical form, return `out_of_range` with `这个本机时间超出可保存范围，请换一个时间。`
8. Exactly one representable candidate returns `unique` with that canonical ISO instant. Zero local round-trip candidates returns `gap` with `这个本机时间不存在（夏令时调整），请换一个时间。` More than one representable candidate returns `fold` with `这个本机时间对应两个时刻，请换一个时间以避免歧义。`

This contract intentionally resolves minute-precision civil times only. It supports all enumerated whole-minute offsets, including non-hour offsets, but makes no claim that it can represent historical zones whose applicable offset included seconds; the conservative `2000-01-01` lower bound excludes that historical requirement. No sampling window, transition discovery, implicit host zone, or new dependency is permitted.

Sleep ordering compares resolved UTC instants, not local strings. Therefore an apparently later wall time that resolves earlier cannot pass.

### 6.4 Display and editing existing instants

- Display format: `YYYY年M月D日 HH:mm（本机时间）` using the current valid IANA device zone.
- Do not display raw UTC, `Z`, locale-dependent numeric dates, or a guessed offset.
- Opening edit captures the current zone and converts the stored instant to strict `YYYY-MM-DD` and `HH:mm` draft fields in that zone.
- A later device-zone change legitimately changes list presentation of the same stored instant after a reload; it does not mutate the record.
- If instant formatting fails, do not show partial or UTC time. Show the domain-level invalid-zone state and keep mutations unavailable until a valid zone is re-read.

## 7. List row and structured summary content

Values are formatted without invented precision. Decimal values use the canonical numeric value and no trailing decorative zero. Optional notes/descriptions are never previewed in the list; show `有备注` or `有说明` to keep rows scannable and reduce casual disclosure.

### 7.1 List rows

| Domain | Primary line | Secondary line |
|---|---|---|
| 生长 | formatted measurement date | joined available values, e.g. `体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米`; append `· 有备注` when present |
| 喂养 | formatted local feed time | `{type}` plus present `量 {n} 毫升`, `时长 {n} 分钟`, and `有备注` |
| 睡眠 | formatted local start | `{type} · 至 {formatted end}` or `{type} · 尚未填写结束时间`; for 夜间睡眠 append `· 夜醒 {n} 次`; append `· 有备注` |
| 大小便 | formatted local diaper time | `{type}` and optional `· 有备注` |
| 健康 | formatted record date | `{type} · {title}` and optional `· 有说明` |

Percentiles, source message IDs, record IDs, created times, updated times, and revision tokens are absent from rows.

### 7.2 Confirmation value format

Confirmation uses a definition-list-like sequence of label/value rows. Every visible business field appears in stable form order. Empty optional values say `未填写`; notes and description show their full entered content and wrap. Hidden percentile fields do not appear.

- Health create shows normalized values returned by `confirmation_required.summary.input`, title `确认新增健康记录`, consequence `确认后会保存在本机。`, and buttons `返回修改` / `确认保存`.
- Update shows title `确认保存修改`. It shows identifying date/time plus `修改内容`, containing only semantically changed visible fields as `原内容` and `新内容`. A local exact visible no-op is blocked before any service call. After the required unconfirmed update call normalizes input, compare `confirmation_required.summary.input` field-by-field with the loaded baseline’s visible business values; if equal—especially when a health-title edit differs only by trimmed surrounding whitespace—show `内容没有更改。`, make no confirmed call, and create no revision. Hidden preserved percentiles never count as a change.
- Delete shows title `确认删除这条{域}记录`, the domain’s identifying list summary, and `删除后不会出现在记录列表中；当前版本没有恢复入口。` Buttons are `取消` / `确认删除`. Do not say “永久删除”, because G032 performs a soft delete.
- Health create confirmation repeats `健康记录用于整理照护信息，不提供诊断。`

When an update changes an instant, both old and new values are formatted in the editor’s captured zone. Confirmations never reveal raw DTO keys or UTC strings.

### 7.3 Interlocked decision rendering

`confirm.healthCreate`, `confirm.update`, `confirm.delete`, and `confirm.discard` are interlocked decision states, not overlays on an operable editor:

- on entry, freeze an immutable decision snapshot containing the exact service summary when applicable, the exact prior editor/draft/baseline state, the initiating control ref, and for discard the requested destination/domain;
- render the inline decision panel **in place of** the editor and mode actions. The underlying editor, domain switcher, back, save, delete, row, and create actions are not mounted in the accessible/interactive subtree;
- only the decision’s confirm and cancel/return actions are rendered and operable. Bottom-tab navigation may blur Records but does not alter the frozen decision;
- accept uses only the frozen service summary or frozen discard destination. It never rereads mutable draft state;
- cancel/return atomically restores the exact frozen prior editor state and baseline, then returns accessibility focus to the initiating control when Records is focused. It performs zero confirmed service calls;
- while an accepted mutation is submitting, both decision actions are disabled/busy until resolution.

## 8. State machine

### 8.1 States

```text
list.loading
list.ready.empty
list.ready.rows
list.error
create.editing
edit.loading
edit.error
edit.editing
confirm.healthCreate
confirm.update
confirm.delete
confirm.discard
mutation.submitting
conflict.stale
conflict.notFound
mutation.error
```

Success is a transition back to `list.ready.*` with a one-shot live status, not a separate editor screen.

### 8.2 Principal transitions

- Screen mount or domain switch in list mode → `list.loading` → empty/rows or error.
- `新增{域}记录` → create draft with conservative defaults → `create.editing`.
- Row press → `edit.loading` via `getById` → `edit.editing`; null result returns to list with `这条记录已不存在，列表已重新读取。`; a rejected read enters `edit.error` without opening a stale draft.
- Low-risk create submit → local parse → service create → `completed` → list success.
- Health create submit → service create without confirmation → `confirmation_required` → health confirmation.
- Edit submit with a local visible change → service update without confirmation using loaded token → compare normalized `confirmation_required.summary.input` with the loaded visible baseline → semantic no-op back to `edit.editing` with no confirmed call/revision, otherwise update confirmation.
- Delete action → service delete without confirmation using loaded token → delete confirmation.
- Confirmation cancel → atomically restore the frozen prior editor state, same draft/baseline, zero confirmed service call.
- Confirmation accept → call the same operation with `"confirmed"` and the exact returned summary values/token → completed list success or safe error/conflict.
- Back-to-list or domain switch with clean draft → list/domain immediately.
- Back-to-list or domain switch with dirty draft → discard confirmation; `继续编辑` returns to draft, `放弃更改` performs the requested navigation with no write.

### 8.3 Read ownership, mutation reconciliation, and blur

- List/get requests carry a monotonically increasing read generation plus domain and focus-session identity. Ignore a read completion after unmount, after a newer read applies, or when its domain/focus session no longer owns the visible Records read state.
- Every mutation begins a unique operation ID plus component mount epoch at its first service call. That same mount-scoped operation owns a direct low-risk create or the full health-create/update/delete chain: unconfirmed confirmation probe, frozen decision, confirmed call, and any post-completion refresh. Focus-session changes do **not** invalidate any stage. Only unmount or replacement by an explicitly newer owned mutation can end UI ownership; the interlock prevents two owned mutation operations from running concurrently.
- If Records blurs through bottom-tab navigation while any mutation stage is pending, keep its mounted operation state. A `confirmation_required` probe result immediately freezes and renders the returned decision state while blurred; an error or conflict immediately reconciles its safe state without replay; a completed result immediately clears the completed draft/confirmation, records returned mutation facts, returns the workspace to list mode, and starts its authoritative list refresh even while blurred.
- The post-completion `list(domain, 100)` refresh is owned by the originating mount epoch and mutation operation ID, not by a focus session. Blur or refocus cannot invalidate it. If Records refocuses before that refresh resolves, keep the operation-owned refresh as the sole authoritative list read and do not launch a competing ordinary focus-triggered list/get request. Apply its success or refresh-failure state whenever that mount operation still owns it.
- After blur, defer **only** accessibility focus movement and one-shot announcements. This includes confirmation-heading focus/announcement when a probe resolves to `confirmation_required`, plus mutation success/error/conflict focus/announcement. Queue each relevant effect once and deliver only if its state is still relevant when Records regains focus; do not replay a probe/mutation or preserve a committed draft. If the component unmounts, apply no UI completion and let the next mount read the authoritative list.
- Only one list/get/mutation request of its kind may own visible busy state. While mutation submission is pending, all decision actions expose busy/disabled state; editor/domain/back/destructive controls are already absent under the interlocked decision rendering.
- Do not clear the draft or show success until `status: "completed"` is received.
- After `completed`, request `list(domain, 100)`. If that refresh succeeds, replace the list with its service-ordered rows. If it fails after create or update, retain the exact prior service-ordered committed rows unchanged: do not insert, replace, move, trim, sort, or synthesize a next row from `result.record`. If it fails after delete, remove only the completed deletion’s known ID from those prior rows; do not otherwise reorder or synthesize the next eligible row. In every case keep the mutation success, show `记录已处理，但列表暂时无法刷新。`, and offer `重新读取记录`.

## 9. Draft, discard, and focus behavior

### 9.1 Dirty definition

A create draft is dirty after any caregiver edit from its initial defaults. An edit draft is dirty when any visible field differs from the loaded baseline. Hidden percentiles and revision metadata do not participate.

### 9.2 Discard decisions

Inline discard panel:

- title: `放弃未保存的更改？`
- body: `当前填写的内容还没有保存。`
- actions: `继续编辑` and `放弃更改`

It is shown for:

- `返回{域}列表` with a dirty draft;
- selecting a different domain with a dirty draft;
- conflict actions that would replace or close a dirty draft.

It is not shown for:

- a clean draft;
- switching to another bottom tab, because that does not discard the mounted Records state;
- successful completion, because the committed result replaces the draft.

No draft is stored in SQLite, AsyncStorage, secure storage, files, pending tasks, or messages. A fresh app process always opens the list.

### 9.3 Conflicts while a draft exists

On `stale_write`:

- retain and freeze the draft and confirmation summary;
- show `这条记录已在其他位置更新。为避免覆盖，请重新读取后再修改。`;
- offer `重新读取记录` and `返回列表`;
- either action first uses the discard panel when the draft is dirty;
- reload uses `getById`; if found, replace baseline/draft with the new record and its `updatedAt`; if absent, transition to not-found/list reload;
- never substitute `currentState`, guess a token, merge automatically, or retry the confirmed write.

On `not_found`:

- retain the draft until explicit discard;
- show `这条记录已不存在，不能继续保存或删除。`;
- offer `返回列表`; after discard, reload the active domain list.

## 10. Confirmation and revision-token protocol

### 10.1 Create

Every manual create constructs the exact domain input plus `sourceMessageId: null`. No record ID, message ID, clock value, or revision is generated by UI code.

- Growth, feeding, sleep, diaper: call `create(domain, input)` once. Expected service result is `completed`.
- Health: call `create("health", input)` without confirmation. Render the returned `confirmation_required.summary`. On accept call `create(summary.domain, summary.input, "confirmed")` without rebuilding or reparsing the DTO. Cancel makes no second call.

The health-create call is a mount-scoped confirmation probe. If it resolves after Records blurs, freeze/render its returned confirmation state immediately but defer confirmation-heading focus/announcement until that same state is relevant on Records refocus. Reconcile probe error/conflict results while blurred without automatically replaying the call.

### 10.2 Update

The latest successful `getById` record is the edit baseline. Its `updatedAt` is an opaque revision token.

1. Build a full domain update input. For growth, insert the baseline hidden percentiles unchanged.
2. Call `update(domain, id, input, baseline.updatedAt)` without confirmation.
3. Treat the returned `confirmation_required.summary.input` as authoritative normalized input. Compare its visible business fields with the loaded baseline using exact domain values (`null` distinct from `0`, canonical instants/dates, enum strings, numeric values, and exact normalized text). Hidden percentiles are excluded from change detection but must remain equal to the preserved baseline values in the full input.
4. If all visible normalized fields equal the baseline, apply the normalized visible values back to the editor draft, show `内容没有更改。`, and stop. Do not render confirmation, make a confirmed call, or create a revision.
5. Otherwise render only that returned summary as the frozen pending mutation. On accept, call `update(summary.domain, summary.id, summary.input, summary.expectedUpdatedAt, "confirmed")`.
6. On completed result, retain `result.record` as the completed mutation/token fact, clear the draft, return to list mode, and refresh. Do not use it to synthesize create/update list ordering if refresh fails.

The unconfirmed update is a mount-scoped confirmation probe. Its confirmation/error/conflict result reconciles across blur under the same rules as health create. Cancel performs no confirmed call and leaves the draft/baseline token unchanged. No UI path calls confirmed update without first receiving its summary.

### 10.3 Delete

1. Call `delete(domain, id, baseline.updatedAt)` without confirmation.
2. Render the returned `confirmation_required.summary` plus a structured identifying summary from the baseline record.
3. On accept, call `delete(summary.domain, summary.id, summary.expectedUpdatedAt, "confirmed")`.
4. On completed result, clear the draft, return to list mode, and refresh. Remove the known ID locally only if that refresh fails; a successful refresh remains authoritative.

The unconfirmed delete is a mount-scoped confirmation probe. Its confirmation/error/conflict result reconciles across blur under the same rules as health create. Cancel performs no confirmed call. UI copy describes disappearance from the active list and no current restore entry; it never describes a physical delete.

## 11. Loading, empty, error, retry, and success content

### 11.1 Read states

| State | Content | Action |
|---|---|---|
| Initial/domain list loading | `正在读取{域}记录…` in polite live region; reserve heading/action geometry | none |
| Empty | `还没有{域}记录` + local-save description | `新增{域}记录` |
| List error with no committed rows | `暂时无法读取{域}记录。本机数据没有更改。` | `重新读取记录` |
| Refresh error with committed rows | keep rows; `记录可能不是最新内容。` | `重新读取记录` |
| Edit loading | `正在读取这条{域}记录…` | back disabled until read settles |
| Edit read error | `暂时无法读取这条记录。本机数据没有更改。` | `重新读取这条记录` and `返回{域}列表` |
| Invalid IANA zone for instant domain | `无法确认本机时区，暂不能显示或编辑这类记录。` | `重新读取本机时区` |

Retry repeats only the failed read/zone resolution. It does not replay a mutation.

### 11.2 Validation and mutation errors

G034 must minimally extend the G032 application service boundary alongside tracker UI implementation:

```text
type ManualTrackerConflictCode = "stale_write" | "not_found"

interface ManualTrackerConflictClassifierPort {
  classify(error: unknown): ManualTrackerConflictCode | null
}

class ManualTrackerConflictError extends Error {
  readonly code: ManualTrackerConflictCode
}

isManualTrackerConflictError(value: unknown): value is ManualTrackerConflictError
```

The application layer owns this classifier port, error, and guard. `ManualTrackerService` receives the classifier through constructor injection, catches an unknown persistence error, asks the classifier for an application code, and wraps only a matched `stale_write`/`not_found` code as `ManualTrackerConflictError` before it crosses `ManualTrackerServicePort`; every unmatched error keeps its existing generic path. Infrastructure composition supplies the classifier adapter. Only that infrastructure adapter may recognize `RepositoryConflictError`, and it maps only its `stale_write`/`not_found` variants to application codes. `ManualTrackerService` and all other application code never import infrastructure. The application error exposes no entity ID, current row, SQL detail, or repository class. Alternate `ManualTrackerServicePort` implementations must reject conflicts with this same application contract. Tracker UI imports and calls only `isManualTrackerConflictError`; it never imports `RepositoryConflictError`, checks an infrastructure `name`, or structurally guesses `code` on an unknown object.

- Field syntax/range error: adjacent Chinese assertive alert; preserve every draft field.
- Unknown `TrackerValidationError.field`: form-level `请检查标出的内容后再保存。`; log/upload nothing and show no raw field key.
- Generic create/update/delete failure before completion: `保存失败，本机记录没有更改。` or `删除失败，本机记录没有更改。`; retain editor/draft and offer the original action again.
- Runtime closing/unavailable: `本机记录服务暂不可用，请返回后重试。`; no automatic retry.
- `stale_write` and `not_found`: use the dedicated conflict states above.
- Classification occurs only through the application-owned `isManualTrackerConflictError` guard and its typed `code`.
- A `confirmation_required` result in a low-risk create is treated as a safe form-level failure, never auto-confirmed.
- A `completed` result is the only success signal.

### 11.3 Success

After completed result, return mounted state to the selected domain list and record exactly one success message:

- `{域}记录已保存`
- `{域}记录已更新`
- `{域}记录已删除`

Clear the completed draft and pending confirmation. Keep the same domain selected. If Records is focused, move accessibility focus to the list heading and announce the message; if blurred, queue only that focus/announcement until the next relevant Records focus. Do not navigate to 成长, a detail page, or another tab.

## 12. Component architecture and service-only flow

Expected ownership; exact filenames may be consolidated without changing boundaries:

- `ManualTrackerServiceContext`: provider and hook for `ManualTrackerServicePort` only.
- `ManualTrackerScreen`: domain selection, screen state machine, focus-scoped ordinary read generations, mount-operation-scoped probes/mutations/post-completion refresh, list ownership, deferred focus/announcement, success status.
- `TrackerDomainSwitcher`: accessible horizontal domain tabs.
- `TrackerRecordList` and `TrackerRecordRow`: domain-scoped active presentation.
- `TrackerEditor`: shared shell plus five domain field groups.
- Shared local form primitives: labeled text input, multiline input, radio group, field error, primary/secondary/destructive action.
- `InlineTrackerConfirmation`: health-create, update, delete, and discard variants.
- Pure formatting/parsing utilities for strict numeric/date text, IANA local-minute resolution, and structured summaries.
- Application-owned tracker conflict classifier port/error/guard at the `ManualTrackerServicePort` boundary, with an infrastructure-supplied classifier adapter injected at composition; no application or feature module imports an infrastructure conflict type.

Data flow is one-directional:

```text
runtime ManualTrackerServicePort with injected conflict classifier
  -> tracker context
  -> Records screen list/get/create/update/delete
  -> completed records/deletions or confirmation summaries
  -> local presentation state
```

Forbidden imports in tracker feature code include infrastructure repositories, SQLite APIs, migration modules, `DataMutationCoordinator`, exclusive transactions, pending tasks, model/provider clients, HTTP/request clients, and baby-profile context.

## 13. Accessibility, keyboard, and responsive contract

### 13.1 Semantics

- Domain switcher exposes one `tablist` labeled `记录类型`; every domain control uses the exact `tab` role, its Chinese domain label, and selected state. It never alternates between `tab` and `button`.
- Enum controls use a labeled radio group; each choice exposes radio role and checked/disabled state.
- Text inputs have unique Chinese accessibility labels that include units where relevant.
- Required status is in visible instruction/error text, not a color or asterisk alone.
- Every action has button role; busy/disabled state is exposed.
- Section titles and confirmation titles use header role.
- Errors expose assertive alert/live-region props. Loading/success expose polite live-region props.
- Confirmation headings, first-invalid fields, initiating controls, and the list heading own stable refs. After the target has rendered, call `findNodeHandle(ref.current)`; call `AccessibilityInfo.setAccessibilityFocus(nativeTag)` only when the ref is current and the returned tag is a non-null number. Missing/unmounted refs or null tags are a safe no-op with no timer/retry loop. Confirmation open targets its heading; cancel targets the initiating save/delete/domain/back control; focused success targets the list heading. A blurred mutation completion queues only the still-relevant list-heading focus and message until refocus.
- Row accessibility labels include domain, date/time, type, and structured values, not technical IDs.

### 13.2 Target sizes and text

- All pressables and radio choices are at least 44×44 pt; primary actions prefer 48 pt height.
- All user-facing text and inputs scale to 200%.
- Do not set fixed line heights, `numberOfLines`, ellipsis, fixed form heights, or absolute bottom actions.
- Long health titles, notes, descriptions, errors, and confirmation values wrap and remain reachable by scrolling.
- Color is never the only state indicator. Focus ring uses the existing focus token.

### 13.3 Keyboard

- Use `AppFrame` with `keyboardDismissMode="on-drag"`, `keyboardShouldPersistTaps="handled"`, and Android resize behavior.
- Numeric fields request an appropriate numeric/decimal keyboard but still validate text independently; keyboard type is not validation.
- Next/submit focus order follows visual field order.
- Opening the keyboard must not cover the focused input, field error, or current action after scrolling.
- Domain switch and bottom tab remain operable after keyboard dismissal; do not place a fixed editor footer over the tab bar.

### 13.4 Widths

- 320–430 pt: 16 pt horizontal padding.
- 431–767 pt: 24 pt.
- 768 pt and wider: centered 640 pt maximum content, 32 pt padding.
- Same single-column structure from 320 through 768 pt.
- Domain controls horizontally scroll instead of truncating or compressing.
- At 200% text, radio choices and action rows wrap vertically; destructive and primary actions never share a forced single row.

### 13.5 Evidence split

Component/integration-facing tests can prove only properties and deterministic state behavior available in the React tree:

- exact `tablist`/`tab`, radio, button, header, label, selected/checked/disabled/busy, alert, and live-region props;
- interlocked decision rendering leaves only decision actions in the interactive/accessibility tree and restores the frozen prior state on cancel;
- stable refs plus guarded `findNodeHandle`/`AccessibilityInfo.setAccessibilityFocus` call/no-call behavior;
- no `numberOfLines` or fixed line-height/height constraints, minimum 44 pt target styles, font-scaling props, horizontal/vertical scroll props, keyboard-dismiss/persist props, responsive padding/max-width styles, and wrap-capable action layouts;
- mounted mutation reconciliation and deferred focus/announcement when create/update/delete resolves after tab blur.

Manual/native regression evidence is required for actual spoken announcements, real screen-reader traversal/order, native focus landing, keyboard non-obscuration after scroll, touch target usability, and unclipped/reachable layout at 200% text across the required widths. These checks preserve G034 quality but do not constitute or claim full accessibility `E2E-006`.

## 14. Privacy and content voice

- `仅本机` means current behavior, not an absolute security guarantee.
- Errors do not expose raw exception messages, stack traces, SQL/table details, IDs, UTC revision tokens, or source message IDs.
- No telemetry, upload, network, model, or provider copy appears.
- Manual create uses `sourceMessageId: null`; the UI never asks for or fabricates a source.
- List rows avoid note/description previews. Full content appears only while editing or confirming that record.
- Health terms are `身体不适`, not `疾病` or a diagnosis. Use `健康记录用于整理照护信息，不提供诊断。`
- Avoid exclamation marks, urgency, blame, “异常”, “风险”, “智能”, and claims that deletion is permanent or recoverable.
- No screen claims that baby-profile data is needed. Records works when profile load fails, profile is absent, or birth date is unknown.

## 15. Test ownership and acceptance IDs

G034 component and integration-facing UI tests use these exact goal-scoped IDs:

| ID | Required proof |
|---|---|
| `G025-UI-001` | Growth list/create/edit/delete UI; at-least-one measurement; numeric bounds; null create percentiles; exact hidden percentile preservation on update. |
| `G025-UI-002` | Feeding list/create/edit/delete UI; enum wording; formula amount and breast duration requirements; `0` preserved; local-to-UTC conversion. |
| `G025-UI-003` | Sleep list/create/edit/delete UI; paired optional end; UTC ordering; nap forces zero wakings; gap/fold rejection. |
| `G025-UI-004` | Diaper list/create/edit/delete UI; exact enum wording and local-time conversion. |
| `G025-UI-005` | Health list/create/edit/delete UI; strict date, enum wording, Unicode title trim/range, neutral health notice. |
| `G025-UI-006` | Health create first returns inline confirmation; cancel makes zero confirmed calls/writes; confirm reuses exact returned summary/input with `"confirmed"`; success returns to list. |
| `G025-UI-007` | Table-driven all-domain update confirmation; local and post-normalization semantic no-op blocks, including whitespace-only health-title change, with no confirmed call/revision; cancel restores frozen draft/token; confirm uses exact ID/full normalized input/loaded `updatedAt`; completed record replaces mutation token fact; stale/not-found never overwrite or auto-retry. |
| `G025-UI-008` | Table-driven all-domain delete confirmation; cancel retains row; confirm uses exact revision; only completed deletion removes active row; copy does not claim physical/permanent deletion. |
| `G025-UI-009` | Domain order/default/switching, list limit 100, loading/empty/read/mutation/retry/success states, focus-scoped late ordinary-read suppression, mount-operation-scoped health-create/update/delete probe reconciliation across blur, frozen blurred confirmation with deferred heading focus/announcement, blurred error/conflict reconciliation without replay, mount-operation-scoped post-completion refresh across blur/refocus with no competing ordinary read, refresh-failure list truth, no-profile operation, exact Chinese semantics/live-region props, guarded focus calls, target/scale/scroll/responsive style contracts, plus separately recorded manual/native behavior evidence without an `E2E-006` claim. |

Additional required test facts:

- Strict local date/time parser rejects malformed values and accepts leap dates.
- IANA resolver tests: ordinary unique time; non-hour whole-minute offset (for example `Asia/Kathmandu`); DST gap; DST fold; invalid zone; pre-`2000-01-01` `out_of_range`; exact numeric Gregorian round-trip; offset enumeration endpoints and at-most-2,881/dedupe bound; G032 canonical-output check; no implicit/UTC fallback. No historical-second-offset acceptance claim or test is required.
- Manual create DTOs always contain `sourceMessageId: null`.
- List calls never exceed G032’s `1–100` bound and use exactly `100`.
- Selecting a list row uses `getById`; null handling reloads safely.
- Read generations ignore late ordinary list/get results after domain/focus changes. Separate tests switch to another bottom tab before the health-create probe and each update/delete probe resolves, then prove `confirmation_required` freezes/renders the decision state while blurred and defers its heading focus/announcement until relevant refocus; probe errors/conflicts reconcile while blurred without replay.
- Separate tests switch to another bottom tab before each create, update, and delete completes, then prove mounted reconciliation clears committed drafts, prevents replay, and starts the mount-operation-scoped authoritative refresh. The exact refocus race test refocuses Records before that refresh resolves, proves refocus launches no competing ordinary list/get read, then resolves the original refresh and proves its rows or refresh-failure state applies to the still-current mount operation.
- Refresh-failure tests prove create/update retain the exact prior service-ordered rows, delete removes only the known completed ID, no path locally sorts/inserts/replaces/trims/synthesizes a next row, and retry performs only `list(domain, 100)`.
- Application-boundary tests prove the infrastructure-composed classifier recognizes `RepositoryConflictError` only for `stale_write`/`not_found`, `ManualTrackerService` wraps those classifications as `ManualTrackerConflictError`, unmatched errors retain the generic path, the guard recognizes only the application contract, and application/feature code neither imports nor inspects infrastructure error names/shapes.
- Profile service/context is absent from tracker UI dependencies and tests prove records render with no profile.
- Existing navigation, shell, profile, bootstrap, typecheck, lint, dependency, and full Node/Jest gates remain green.

## 16. G034 native verification status

G034 is **native-regression-only**:

- run the repository’s existing exact-head Android and iOS native workflows as applicable to keep current shell/profile contracts green;
- do not add tracker Maestro flows, tracker restart scripts, tracker evidence schemas, or tracker-specific native artifacts in G034;
- do not mark `G025-E2E-001`, `manual-tracker-offline-restart`, natural-language `E2E-002`, or full accessibility `E2E-006` complete;
- do not infer offline restart persistence from component tests or existing profile evidence.

Tracker-specific native Release proof belongs only to G035.

## 17. Design review rejection checklist

Reject an implementation that introduces any of these:

- profile gating or profile-derived validation/defaults;
- cross-domain timeline, dashboard, aggregate, insight, chart, WHO, or visible/editable percentile;
- OS alert confirmation, unscrollable modal, nested cards, pills for domain navigation, squeezed five-column switcher, or a fixed keyboard-obscuring footer;
- raw ISO/UTC entry, locale-dependent date parsing, guessed numeric-offset conversion, open-ended IANA search, silent DST gap/fold choice, invalid-zone fallback, or a historical-second-offset support claim;
- direct repository/SQLite/migration/transaction/pending-task/model/network access;
- infrastructure-error imports or duck-typing in UI instead of the application-owned tracker conflict contract;
- automatic conflict retry, guessed revision, overwrite after stale write, or clearing draft before completed result;
- an operable editor/workspace behind any confirmation/discard decision, mutable confirmation input, or cancel that does not restore the frozen prior state;
- invalidating a mounted mutation merely because Records blurred, replaying it on refocus, or applying deferred focus/announcement while blurred;
- locally inserting/replacing/reordering/trimming create/update rows after refresh failure, or synthesizing the next row after delete;
- confirmed call after cancel, mutation replay from a read retry, or success before `completed`;
- a confirmed semantic no-op update after service normalization;
- physical/permanent deletion claims or a restore promise;
- `numberOfLines` truncation, fixed line height, targets under 44 pt, color-only state, clipped 200% text, or 320 pt overflow;
- domain controls without exact `tablist`/`tab` roles, unguarded native focus calls, or component-test claims of actual native announcement/traversal/keyboard/200% behavior;
- a new dependency, migration, native evidence implementation, `G025-E2E-001` claim, or `E2E-002` claim.

## 18. Self-review record for this design

The design was checked against the current root design, G032 types/validation/confirmation/service/repository contracts, current profile/shell/navigation/shared UI, G033 repository/planner/test/designer handoffs, the updated G034/G035 goals, and the independent G034 architect and critic reviews dated 2026-07-20.

Confirmed decisions:

- all five DTO field sets, enum values, numeric ranges, date/instant formats, list bound, confirmation policy, soft-delete language, and `updatedAt` usage match G032;
- percentile fields are hidden yet preserved; manual create source is null;
- no future/before-birth rule, baby-profile gate, pending task, model, network, WHO, timeline, aggregate, migration, dependency, or native tracker evidence was added;
- tracker conflicts are translated into an application-owned typed error/guard, so UI never imports or duck-types infrastructure errors;
- every confirmation/discard state renders decision actions only from a frozen summary/prior-state snapshot, and cancel restores that prior state;
- focus-scoped read ownership is separate from mounted mutation reconciliation; create/update/delete completions after tab blur reconcile immediately while only focus/announcement is deferred;
- failed post-mutation refresh retains prior service-ordered rows for create/update and removes only a known deleted ID, without synthetic ordering or next-row claims;
- normalized update summaries receive a second semantic no-op check, including trimmed health titles, with no confirmed call or revision;
- time semantics use a finite 2,881-candidate whole-minute IANA round-trip over local dates `2000-01-01` through `9999-12-31`, reject invalid zones/gaps/folds/unrepresentable instants, and make no historical-second-offset claim;
- accessibility fixes `tablist`/`tab`, guarded native-focus protocol, and a component-provable versus manual/native evidence split without claiming `E2E-006`;
- G034 owns only `G025-UI-001..009` and native regression; G035 alone owns `G025-E2E-001`;
- the specification contains no blocking design decision.
