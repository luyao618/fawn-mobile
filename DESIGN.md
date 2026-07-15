# For Mobile — Slice 1 Design Contract

## Product and scope

For Mobile is a private, calm, Chinese-first caregiver tool for one caregiver and one baby aged 0–1. Slice 1 establishes only the Expo 57 CNG application shell, five stable destinations, accessibility, truthful unavailable states, local render-error handling, and test infrastructure. It contains no onboarding, baby profile editing, records, charts, photo import, model connection, chat generation, persistence, backup, knowledge runtime, account, cloud sync, telemetry, or network behavior.

The application identity is **For Mobile**, with Android and iOS identifier `com.luyao618.formobile`. The shell is light-mode only in Slice 1 and enters 管家 directly without a marketing screen.

## Experience principles

- Personality: private, calm, attentive, and precise.
- Truthfulness: never fabricate baby names, records, statistics, connection status, or health claims.
- Local trust: a restrained `仅本机` marker describes current behavior without promising absolute security.
- Restraint: no gradients, glass effects, nested cards, promotional illustration, disabled composer, dead CTA, emoji icon, or “AI magic” language.
- Content voice: concise Chinese using `宝宝`, `记录`, `依据`, `仅本机`, `未设置`, and `暂无`; avoid exclamation marks, guilt, cuteness, diagnosis, and anthropomorphic claims.

## Information architecture

The root is one React Navigation bottom-tab navigator with no per-tab stacks and no placeholder routes. The exact order is:

| Order | Label | Route | Lucide static icon |
|---:|---|---|---|
| 1 | 管家 | `StewardTab` | `message-circle` |
| 2 | 记录 | `RecordsTab` | `clipboard-list` |
| 3 | 成长 | `GrowthTab` | `chart-line` |
| 4 | 相册 | `AlbumTab` | `images` |
| 5 | 我的 | `MeTab` | `circle-user-round` |

`StewardTab` is initial. History will later live under 管家; profile, memory, diagnostics, backup, and privacy will later live under 我的. Slice 1 creates none of those routes or directories.

## Screen content and states

### 管家

- Top bar: `管家` and `仅本机`.
- Heading: `照护空间尚未设置`.
- Copy: `完成宝宝资料和模型连接后，可在这里提问、记录并查看回答依据。`
- Flat readiness rows: `宝宝资料 — 未设置` and `模型连接 — 未设置`.
- Privacy notice: `当前页面不会读取、保存或发送宝宝数据。`

There is no setup CTA because its destination does not exist in Slice 1.

### Other destinations

- 记录: `还没有照护记录` — records become visible after later local record support is implemented.
- 成长: `还没有可展示的成长数据` — no chart or synthetic measurement is shown.
- 相册: `还没有照片` — no permission request or import control is shown.
- 我的: `本机设置尚未启用` — no profile, model, backup, privacy, or diagnostics control is shown.

Loading reserves final geometry and uses no arbitrary delay. Offline state requires no banner because the shell performs no network work. Recoverable section errors belong inline in later slices. A render failure shows the local BootstrapError surface with a retry action and never uploads diagnostics. Unavailable functionality is explained rather than represented by dead controls.

## Components and ownership

- `App`: one `SafeAreaProvider` and one local `AppErrorBoundary` around the navigator.
- `RootNavigator`: one `NavigationContainer`, exactly five bottom tabs, labels, selected state, and static Lucide icons.
- `AppFrame`: background, top inset, responsive width, scrolling, and screen content ownership.
- `TopBar`: flush title row with no card, rounded shell, or shadow.
- `EmptyState`: truthful heading and explanation.
- `StatusBadge`: compact text-backed status; color is never the only signal.
- `InlineNotice`: passive privacy/information message.
- `BootstrapError`: deterministic local failure and retry surface without stack traces or upload.

Production code never imports `spikes/**`. No empty domain, application, or infrastructure directories are created in this slice.

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
| `brand` | `#7C4A20` | Selection |
| `brandStrong` | `#5A3415` | Pressed/high contrast |
| `brandSoft` | `#F4E4D0` | Selected background |
| `sage` | `#3F7A14` | Local status |
| `sky` | `#567B9C` | Informational icon |
| `butter` | `#FFFBEB` | Notice background |
| `danger` | `#BA1A1A` | Errors |
| `focus` | `#B45309` | Keyboard focus |

Primary text on canvas, brand on white, and sage on white meet WCAG AA contrast.

### Typography

Slice 1 uses the native system font with native CJK fallback and no runtime font fetch. Sizes are fixed points while Dynamic Type remains enabled:

- Screen title: 24/30, weight 700.
- Section title: 18/24, weight 600.
- Body: 16/24, weight 400.
- Secondary: 14/20, weight 400.
- Caption and tab: 12/16, weight 600.

### Spacing and shape

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 48.
- Radius: 8 small, 12 control, 16 surface, 20 modal; pills only for badges.
- Prefer borders and tonal contrast over shadows. The tab bar is the only level-1 surface.
- Use at most one surfaced container per section and never nest cards.

## Accessibility and interaction

- Touch targets are at least 44×44 pt, preferably 48×48.
- Tabs expose button role, Chinese accessibility label, and selected state through React Navigation.
- Screen and section headings expose the header role.
- Text scales to 200%; content scrolls rather than clipping or hiding navigation.
- Reading order follows visual order; status is communicated with text as well as color.
- Press feedback changes tone, not scale. Slice 1 has no decorative or entrance animation and therefore already satisfies reduced-motion behavior.
- The stock navigator owns the bottom inset exactly once. `SafeAreaProvider` owns platform insets, and `AppFrame` consumes only the top inset for custom content.
- Android uses `softwareKeyboardLayoutMode: resize`; Slice 1 has no text-entry surface.

## Responsive behavior

- 320–430 pt: 16 pt horizontal padding.
- 431–767 pt: 24 pt horizontal padding.
- 768 pt and wider: centered content, maximum width 640 pt, 32 pt horizontal padding.
- Bottom tabs remain the model on tablets. Portrait is primary; landscape and tablet layouts scale without absolute phone-height positioning.

## Assets and iconography

Tab icons use the modular `@react-native-vector-icons/lucide/static` entry and exact names in the navigation table at 24 pt. The package CNG plugin registers `Lucide.ttf`. Slice 1 includes no deer mark, image, splash art, custom font, or separately licensed asset.

## Fault and release boundary

Production config has no `formobile-test` scheme and the production fault facade is a behavioral no-op. Explicit E2E config adds exactly that scheme and `extra.e2eFaults: true`. The E2E parser accepts only the canonical 13-point URI grammar documented in `src/testing/faultPoints.json`. Live crash/recovery matrices fail closed until persisted boundaries arrive in later slices; Slice 1 claims only contract parsing and deterministic dry-run coverage.

## Validation contract

Review at 320×568, 360×800, 390×844, 430×932, and 768×1024. At minimum inspect 管家 at every size and every tab at 390×844 on Android and iOS. Repeat with 200% text, reduced motion, and screen-reader navigation. Reject clipped Chinese text, safe-area overlap, unstable tab geometry, fake data, dead controls, nested cards, or behavior outside Slice 1.
