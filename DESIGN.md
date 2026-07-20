# For Mobile — Current Design Contract

## Status and source of truth

This document is the active cross-slice design contract for **For Mobile**. It replaces the obsolete Slice-1-only scope while preserving the visual, navigation, privacy, and accessibility decisions that remain valid.

- Implemented baseline: the Expo application shell, five bottom destinations, local bootstrap/error handling, baby-profile editing, and the G032 five-domain tracker service and persistence contracts.
- Approved next product boundary: **G034**, the Records-tab five-domain manual editor UI plus one narrow application-boundary conflict adapter described in [`docs/superpowers/specs/2026-07-20-manual-tracker-editors-design.md`](docs/superpowers/specs/2026-07-20-manual-tracker-editors-design.md).
- Sequential follow-up boundary: **G035**, tracker-specific exact-head Android/iOS offline Release restart evidence. G034 receives only native-regression coverage and makes no tracker-native persistence claim.
- Later work remains out of this design: cross-domain timeline and aggregates, growth insights or charts, WHO data or percentiles, Agent/pending-task and natural-language correction flows, model connection, photo import, cloud/account behavior, and new native evidence implementation.

When this document and the G034 detailed specification differ on the Records-tab editor experience, the detailed G034 specification controls. Implemented domain, validation, confirmation, and service types remain authoritative for data semantics.

## Product intent

For Mobile is a private, calm, Chinese-first caregiver tool for one caregiver and one baby aged 0–1. It favors truthful local state, direct manual entry, and reversible user choices over promotional or automated behavior.

The application identity is **For Mobile**, with Android and iOS identifier `com.luyao618.formobile`. The app remains light-mode only for the current approved scope and enters 管家 directly without a marketing screen.

## Experience principles

- **Private by default:** local features use the restrained `仅本机` marker. Do not promise absolute security or imply cloud sync.
- **Truthful:** never fabricate baby names, records, statistics, percentiles, connection status, or health claims.
- **Calm and precise:** concise Chinese; no exclamation marks, guilt, cuteness, diagnosis, anthropomorphic claims, or “AI magic” language.
- **List before action:** Records opens on the selected domain’s real active records, not an empty editor or synthetic dashboard.
- **Explicit consequences:** risky mutations use inline confirmation with a structured summary; status is always expressed in text, not color alone.
- **Restrained composition:** no gradients, glass effects, nested cards, promotional illustration, dead controls, emoji icons, or scale-based press animation.
- **Service boundaries:** screens consume application service ports only. Product UI never imports SQLite repositories, migrations, pending-task APIs, provider/model clients, or `spikes/**`.

Preferred content vocabulary includes `宝宝`, `记录`, `仅本机`, `未设置`, `暂无`, `重新读取`, and `本机时间`. Health copy describes caregiver-entered observations and never diagnoses.

## Information architecture

The root remains one React Navigation bottom-tab navigator. The exact order and route identities are stable:

| Order | Label | Route | Lucide static icon |
|---:|---|---|---|
| 1 | 管家 | `StewardTab` | `message-circle` |
| 2 | 记录 | `RecordsTab` | `clipboard-list` |
| 3 | 成长 | `GrowthTab` | `chart-line` |
| 4 | 相册 | `AlbumTab` | `images` |
| 5 | 我的 | `MeTab` | `circle-user-round` |

`StewardTab` remains initial. G034 adds no navigator route or internal stack. `RecordsTab` owns one same-screen workspace with these states: domain list, create editor, edit editor, inline confirmation, and discard decision. Successful create, update, or delete returns to that domain’s list.

Within Records, domain switching uses this exact order and default:

1. 生长 (`growth`) — default on first entry
2. 喂养 (`feeding`)
3. 睡眠 (`sleep`)
4. 大小便 (`diaper`)
5. 健康 (`health`)

Each domain shows only its own most recent active records. A cross-domain timeline, cards for latest metrics, totals, trends, and derived summaries are not part of G034.

## Current destination contracts

### 管家

管家 truthfully reports local baby-profile readiness and that model connection is not set. It may show exact local age only from the committed profile service snapshot. It does not send baby data or expose setup actions without a valid destination.

### 记录 — G034 approved design

- Top bar: `记录` and `仅本机`.
- A horizontally scrollable, non-pill domain selector exposes one `tablist` labeled `记录类型`; its five controls use the exact `tab` role, full Chinese labels, selected state, and at least 44 pt targets without squeezing at 320 pt or 200% text.
- The default content is a domain-scoped list loaded with `list(domain, 100)`, ordered by the service/repository contract. No pagination or “all records” claim is made.
- `新增{域}记录` enters create mode on the same screen. Selecting a row loads it with `getById` and enters edit mode on the same screen.
- Manual create always sends `sourceMessageId: null`.
- Health create, every update, and every delete require inline confirmation. Low-risk growth, feeding, sleep, and diaper creates commit directly after validation.
- Every confirmation, including discard, is an interlocked decision state rendered in place of the editor/workspace. Only its decision actions remain operable; the service summary and prior editor/navigation state are frozen until confirm or cancel. Cancel restores that exact prior state.
- Growth percentile values are never displayed or editable in G034. Creates send null values; updates carry the loaded hidden values unchanged.
- Records can be created and managed when no baby profile exists. The Records screen must not read or gate on the baby-profile service.
- Date-only values use strict `YYYY-MM-DD` entry. Instant values use separate strict `YYYY-MM-DD` and `HH:mm` device-local text fields, accept local dates from `2000-01-01` through `9999-12-31` without a “future date” rule, and use the detailed finite IANA round-trip contract. They fail closed for invalid zones, unrepresentable instants, DST gaps, and DST folds.
- Successful mutations return to the selected domain list and announce a Chinese text result only after the service returns `completed`.

The complete fields, state machine, summaries, errors, time conversion, revision handling, test IDs, and review assumptions are specified in the linked G034 document.

### 成长

成长 remains a truthful unavailable/empty destination until separately approved growth presentation work exists. It must not mirror manual growth entries into charts, calculate percentiles, import WHO rows, or show synthetic measurements under G034/G035.

### 相册

相册 remains unavailable and requests no photo permission until a separately approved import boundary exists.

### 我的

我的 owns the current baby-profile editor. Profile absence does not block Records. Profile validation, local-age refresh, and optimistic revision behavior remain independent from tracker editor state.

## Component and data ownership

- `App`: one `SafeAreaProvider` and one local `AppErrorBoundary` around the navigator.
- `BootstrapHost`: exposes ready application services only after local bootstrap succeeds and owns retry/cleanup surfaces.
- `RootNavigator`: exactly five bottom tabs and ready-service providers; it does not expose database handles.
- `AppFrame`: canvas, top inset, responsive content width, scrolling, keyboard behavior, and screen content ownership.
- `TopBar`, `EmptyState`, `InlineNotice`, `StatusBadge`, and `BootstrapError`: shared visual and semantic primitives.
- Baby-profile features consume only `BabyProfileServicePort`.
- G034 tracker features consume only `ManualTrackerServicePort` through a dedicated provider/context. They do not call repositories, transaction objects, clocks, ID generators, or migration APIs.
- The tracker application boundary owns `ManualTrackerConflictClassifierPort`, `ManualTrackerConflictError`, its `stale_write | not_found` code, and its type guard. Infrastructure composition injects a classifier adapter into `ManualTrackerService`; that adapter may recognize `RepositoryConflictError` and returns only `stale_write`, `not_found`, or no match. `ManualTrackerService` wraps a matched code as `ManualTrackerConflictError` before the error crosses `ManualTrackerServicePort`. Application and feature code never import or duck-type infrastructure errors.

Ordinary list/get ownership is focus- and domain-session scoped, so obsolete read completions are ignored. A mutation operation is instead component-mount scoped from its first unconfirmed/direct call through any confirmation decision, confirmed call, and post-completion `list(domain, 100)` refresh. Blur/refocus never invalidates that operation or its refresh, and refocus must not launch a competing ordinary read while the operation-owned refresh is pending. Health-create and every update/delete confirmation probe therefore reconcile confirmation, error, or conflict state while blurred without replay; confirmation state is frozen immediately, while its heading focus/announcement and all other mutation accessibility effects wait for relevant refocus. Unmount discards UI ownership and the next mount reads authoritative state. A confirmed service summary—not an independently reconstructed DTO—is the source for the final confirmed call; an update summary that normalizes to the loaded visible baseline is a semantic no-op and receives no confirmed call or revision.

## Visual system

### Color

| Token | Value | Use |
|---|---|---|
| `canvas` | `#FBF8EF` | Main background |
| `surface` | `#FFFFFF` | Single surfaced region |
| `surfaceSubtle` | `#F5F8F3` | Secondary region |
| `textPrimary` | `#0D1C2E` | Primary text |
| `textSecondary` | `#5F665F` | Secondary text |
| `border` | `#DCE4D8` | Dividers and outlines |
| `brand` | `#7C4A20` | Selection and primary action |
| `brandStrong` | `#5A3415` | Pressed/high contrast |
| `brandSoft` | `#F4E4D0` | Selected background |
| `sage` | `#3F7A14` | Local status |
| `sky` | `#567B9C` | Informational icon |
| `butter` | `#FFFBEB` | Notice background |
| `danger` | `#BA1A1A` | Errors and destructive emphasis |
| `focus` | `#B45309` | Keyboard focus |

Primary text on canvas, brand on white, and sage on white meet WCAG AA contrast. Destructive actions use text plus tone and never rely on red alone.

### Typography

Use the native system font with native CJK fallback and no runtime font fetch:

- Screen title: 24 pt, weight 700.
- Section title: 18 pt, weight 600.
- Body and control: 16 pt, weight 400–600.
- Secondary: 14 pt, weight 400.
- Caption and tab: 12 pt, weight 600.

Do not set fixed line heights on user-facing scalable text. Every user-facing `Text` and `TextInput` allows font scaling.

### Spacing and shape

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 48.
- Radius: 8 small, 12 control, 16 surface, 20 modal; pills only for badges.
- Prefer borders and tonal contrast over shadows. The tab bar is the only persistent level-1 surface.
- Use at most one surfaced container per section and never nest cards.
- Form actions scroll with content; do not add a fixed footer above the keyboard and tab bar.

## Accessibility and interaction

- Touch targets are at least 44×44 pt, preferably 48×48.
- Bottom navigation uses the stock navigator’s tab semantics. The Records domain switcher separately exposes `tablist`/`tab`, Chinese labels, selected state, and disabled/busy state where applicable; it does not alternate between tab and button roles.
- Screen and section headings expose the header role. Field groups have programmatic labels.
- Field errors use an assertive alert/live-region prop and remain adjacent to the field. Component tests prove those semantics and ref wiring; actual native announcement and focus behavior are manual/native-regression evidence.
- Mutation progress and success expose polite live-region props; confirmation panels expose a header target and decision-only accessibility tree. Actual spoken output remains manual/native-regression evidence.
- Text scales to 200%; content scrolls rather than clipping. Horizontal domain switching remains independently scrollable and never truncates a label.
- Reading and focus order follow visual order. Focusable headings/controls retain refs; after render, guarded `findNodeHandle(ref.current)` must return a non-null native tag before `AccessibilityInfo.setAccessibilityFocus(tag)` is called. Confirmation/discard open targets the panel heading, cancel targets the initiating control, and focused success targets the list heading; blurred success queues only the focus/announcement until Records refocuses. Missing refs/tags fail safely without retry loops.
- Press feedback changes tone, not scale. No decorative or entrance animation is introduced; reduced motion therefore requires no alternate animation.
- The stock navigator owns the bottom inset exactly once. `SafeAreaProvider` owns platform insets, and `AppFrame` consumes only the top inset for custom content.
- Android retains `softwareKeyboardLayoutMode: resize`. Editor content uses `keyboardDismissMode="on-drag"` and keyboard-safe scrolling.

## Responsive behavior

- 320–430 pt: 16 pt horizontal padding.
- 431–767 pt: 24 pt horizontal padding.
- 768 pt and wider: centered content, maximum width 640 pt, 32 pt horizontal padding.
- Bottom tabs remain the model on tablets.
- Records stays a single column through 768 pt and at 200% text. G034 does not add a list/detail split view.
- Avoid absolute phone-height positioning, fixed-width segmented controls, clipped labels, and modal sheets that cannot scroll with the keyboard.

## Assets and iconography

Tab icons use the modular `@react-native-vector-icons/lucide/static` entry and the exact names in the navigation table at 24 pt. The package CNG plugin registers `Lucide.ttf`. Current approved work adds no deer mark, raster asset, splash art, custom font, emoji icon, or separately licensed asset.

## Fault, privacy, and release boundaries

- Production config has no `formobile-test` scheme; explicit E2E config owns test fault entry points.
- Render/bootstrap failure stays local, offers retry where safe, shows no stack trace, and uploads nothing.
- Tracker UI errors never expose SQL, table names, record IDs, revision tokens, IANA implementation details, or raw exception messages.
- G034 adds product UI/component contracts plus the narrow application-owned conflict classifier/error boundary and its infrastructure composition adapter. It changes no persistence, schema, repository, migration, or transaction semantics. Existing Android/iOS exact-head workflows are native regressions, not proof of `G025-E2E-001`.
- G035 later owns the separate `manual-tracker-offline-restart` evidence and `G025-E2E-001`. Neither G034 nor this design claims natural-language `E2E-002`, full accessibility `E2E-006`, timeline behavior, packet capture, or physical-device proof.

## Validation contract

Component tests prove roles, labels, selected/disabled/busy props, live-region props, ref/guarded-focus calls, minimum styles, scalable-text configuration, scroll/keyboard props, and state transitions. Manual/native regression at 320×568, 360×800, 390×844, 430×932, and 768×1024 inspects every Records domain and create/edit/confirmation/discard/list state, then repeats critical flows with actual 200% text, screen-reader announcement/traversal, keyboard visibility, focus movement, and reduced motion. This evidence is G034 regression evidence only and does not claim `E2E-006`.

Reject clipped Chinese text, inaccessible horizontal switching, safe-area or keyboard overlap, fake data, dead controls, nested cards, hidden errors, guessed revision retries, ambiguous local-time conversion, profile gating, editable/displayed percentiles, or behavior outside the explicit G034/G035 boundaries.
