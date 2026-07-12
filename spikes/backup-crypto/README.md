# G016 FMBK Quick Crypto proof

This independently installable Expo SDK 57 package proves the frozen `FMBK` v1 crypto contract with the approved Quick Crypto native stack. It does **not** implement staging, SQLite snapshots, restore journals, G017/model transport, or recovery UI. The in-app proof is intentionally non-final; only the tracked composite validator may emit final G016 device `PASS`.

## Frozen boundary and selected backend

`BackupCryptoPort` remains implementation-free and production FMBK code reaches native crypto only through `nativeCryptoPort.ts`. The adapter uses named imports from the public `react-native-quick-crypto` package root and fixes:

- scrypt: `N=32768`, `r=8`, `p=1`, `dkLen=32`, `maxmem=64 MiB`;
- AES-256-GCM: 32-byte key, 12-byte nonce, exact AAD, 16-byte `ciphertext || tag` framing;
- SHA-256 through Quick Crypto;
- randomness injected only from `expo-crypto@57.0.0 getRandomBytes`.

There is no Noble or JavaScript fallback. The adapter never calls `install()`, Metro remains alias-free, and G016 never assigns `global.crypto` or `global.Buffer`. `app.json` explicitly records the Expo build contract as `extra.g016BuildContract.jsEngine: "hermes"` and `newArchEnabled: true`, and sets `expo-build-properties.useHermesV1: true`; iOS deployment target remains 16.4. SDK 57 removed the deprecated direct `jsEngine`/`newArchEnabled` schema fields, so terminal success additionally requires actual `HermesInternal` plus Fabric/Bridgeless New Architecture runtime evidence.

### Input ownership and cleanup

Every native input rejects `SharedArrayBuffer`-backed views. Scrypt passphrase/salt and all three scalar parameters are copied synchronously before the call can enter the serialized queue, preserving exact non-zero-offset byte views and preventing caller mutation from changing queued work. The queue owns and wipes byte snapshots on partial allocation, enqueue, success, and failure paths. Each owned exact snapshot is exposed to Quick Crypto through a zero-copy `Buffer.from(arrayBuffer, byteOffset, byteLength)` view, avoiding a second 4 MiB plaintext/ciphertext copy.

All AES/SHA native allocations begin inside cleanup coverage. Decryption retains `decipher.update()` output internally, returns nothing until `final()` authenticates, and wipes unauthenticated plaintext on every path. Genuine tag rejection is a typed `CryptoAuthenticationError` retaining the native error as `cause`; FMBK maps only that type to secret-safe `FmbkError` code `AUTHENTICATION_FAILED`, with the typed error retained as its cause. `INVALID_FORMAT`, `UNSUPPORTED_VERSION`, and `RESOURCE_LIMIT` cover the other stable domain categories. KDF, bridge, and programming errors remain unchanged and cannot satisfy the wrong-passphrase proof. Wiping is best-effort: VM, JSI, OpenSSL, and garbage-collected internal copies cannot be guaranteed erased.

Production `writeFmbk` calls must pass `undefined` for the header. The writer itself requests a fresh 8-byte nonce prefix and 16-byte salt for every archive and rejects caller-provided production headers, eliminating accidental nonce/key reuse. Caller headers are accepted only with explicit `{ mode: "normative-vector" }`, where the frozen header and exact 790-byte archive remain mandatory.

FMBK is a strict V1 contract, not a forward-extension surface. Readers reject every envelope or authenticated manifest version other than `1`, unknown algorithms, extra/missing header or manifest keys, and noncanonical JSON before interpreting the archive as V1. A future format requires an explicit revised contract/ADR and dispatch implementation; unknown versions never fall through to V1 parsing.

The writer validates entry semantics and the complete plaintext framing/resource limit before calling scrypt. The reader performs a bounded metadata scan before scrypt or AES: magic, version, canonical header, record types, contiguous indexes, payload lengths, non-final chunk sizing, aggregate plaintext bounds, terminator counts/length, truncation, and trailing bytes must all pass first. Tests spy on both `deriveKey` and `decrypt` and require zero calls for those failures. Manifest/file/path/hash limits, authenticated manifest totals, and available-storage checks necessarily run after decryption because the manifest and entry framing are encrypted; they still fail closed before extraction or restore.

The sole approved package-import mutation is a `global.process.nextTick` fallback. Release proof requires either an existing function preserved by identity or an absent value replaced by the function-valued `setImmediate`, with all other process properties unchanged. Numeric/string `nextTick`, non-function `setImmediate`, or any other transition fails closed.

## On-device native self-tests

`nativeCryptoSelfTests.ts` is proof-only. Its direct package-root access is isolated to RFC 7914 vector 1 because that vector intentionally uses non-production parameters; production FMBK operations still use `BackupCryptoPort`.

Before an in-process pass, Release/Hermes Android or iOS must prove:

1. RFC 7914 scrypt vector 1 through Quick Crypto;
2. the fixed production `N=32768/r=8/p=1/dkLen=32` Node-derived vector;
3. AES-256-GCM empty-plaintext/tag known-answer;
4. an AES known-answer using actual non-zero-offset key, nonce, plaintext, AAD, and framed-ciphertext views;
5. wrong AAD, tag, and ciphertext rejection with retained native causes;
6. production-archive tamper reaching native chunk authentication (not normative SHA rejection);
7. two queued scrypt calls retaining invocation-time inputs after caller mutation;
8. exact 4 MiB plaintext to 4 MiB + 16-byte-tag framing.

Test secrets, snapshots, native views, derived keys, plaintext, ciphertext, tags, and benchmark buffers are wiped in `finally` blocks. The pure queue regression deterministically proves concurrent operations start one at a time and that snapshots are taken synchronously.

## Timing and heartbeat

The unchanged in-process budgets are:

- scrypt p95 ≤ 2,000 ms and max ≤ 3,000 ms;
- 4 MiB AES-GCM encrypt/decrypt p95 ≤ 200 ms each;
- heartbeat max gap ≤ 250 ms.

The proof still runs one warm-up plus ten measured scrypt and AES runs. AES now yields between warm-up encrypt/decrypt and between measured operations. It retains only one measured 4 MiB frame at a time instead of ten, without excluding work from timing or changing any threshold.

The prior Quick Crypto rerun passed Android but failed iOS simulator heartbeat at 297.71 ms. That result remains a failure; this change requires a fresh device rerun and claims no device pass.

## Compact terminal record

Exactly one line with prefix `G016_CRYPTO_PROOF ` is emitted. Success uses `IN_PROCESS_PASS`, never `PASS`; failures use `IN_PROCESS_FAIL`. Pure tests bound both success and the all-failure case below **900 UTF-8 bytes**, so standard iOS logging is sufficient and no core/process-memory recovery is allowed. The detailed report remains in memory/UI only.

Compact schema v2:

- `st/f/p/rel/h/na`: in-process status, numeric failure codes, platform, Release, Hermes, New Architecture runtime;
- `i.s/i.r`: full source-manifest and native-resolution SHA-256 values injected into the release bundle;
- `be`: closed exact adapter/backend/RNG codes plus package-root/import/install facts, global identities, and function-valued nextTick transition (`I` installed, `P` preserved, `X` invalid);
- `vec`: closed RFC/fixed-Node/AES/FMBK codes plus exact 790-byte archive SHA;
- `self`: eight native self-test flags;
- `runs`: one warm-up and ten measured scrypt/AES runs;
- `sc/ag/hb`: scrypt p95/max, AES p95s and exact framing, heartbeat max/limit.

Failure-code meanings are defined once in `compactProof.ts` (`1` platform through `26` uncaught, plus `27` build provenance). Automation must treat unknown schema, missing/non-finite fields, any failure code, or anything except `IN_PROCESS_PASS` as failure.

## Final device-evidence owner

`deviceEvidenceValidator.mjs` is dependency-free and is the **only** component allowed to emit final G016 device `PASS`. It accepts one aggregate schema-v2 document with exactly one Android set and one iOS set. `candidate.rootPath` must canonicalize to the repository containing the executing validator; a copied 49-file source tree is rejected.

This is a **local evidence trust boundary**. The validator detects inconsistency, stale inputs, post-sign mutation, detached linkage, and local evidence tampering. It is not hardware-backed build provenance, remote CI attestation, device attestation, or proof that the collector host was uncompromised. Physical iOS production approval therefore remains `OPEN`.

Before each platform build, compute the canonical 49-path source-manifest digest and the complete native-resolution file digest, then inject both before Metro bundles JavaScript:

```bash
EXPO_PUBLIC_G016_SOURCE_SHA256="$SOURCE_FINGERPRINT" \
EXPO_PUBLIC_G016_RESOLUTION_SHA256="$RESOLUTION_SHA256" <release-build-command>
```

Compact proof schema v2 carries those full digests in `i.s` and `i.r`. Exact backend/vector identities use closed codes (`B1`, `Q1`, `E57`, `R1`, `S1`, `A1`, `F1`) to keep both success and worst-case records below 900 bytes without weakening identity checks.

There is no post-build `g016-build-manifest.json`, `G016NativeMembers`, copied archive, or caller-declared native-member list. The same two full digests must occur in the pre-sign Metro bundle and compact runtime proof. Native identities, dependencies, load commands, and packaged executable/bundle hashes are derived directly from the final signed artifact.

Each platform also supplies exact `runtimeIdentity` evidence captured from the installed app under that platform's evidence root. Android retains the installed APK only at `runtime/installed-base.apk` and requires both its SHA-256 and bytes to equal the inspected signed APK. iOS retains the installed app executable only at `runtime/installed-G016FMBKCryptoProof` and `main.jsbundle` only at `runtime/installed-main.jsbundle`, with each SHA-256 and byte sequence equal to the corresponding member inspected from the signed ZIP. These paths are exact: artifact, resolution, log, alternate-name, and other caller-selected paths are rejected before snapshotting. Every retained runtime file must be an independent file with a different device/inode identity from the signed artifact snapshot and from every other runtime member; byte-equal copies are valid, while direct aliases, symlinks, and hardlinks are not. Every runtime identity repeats the inspected `artifactSha256`; cross-artifact descriptors or files fail closed. This is local consistency/tamper detection only, not remote build provenance or device attestation, and all earlier evidence predating these runtime snapshots must be recollected.

The validator pins the root and every ancestor directory with `O_DIRECTORY | O_NOFOLLOW` descriptors, snapshots the leaf before opening it, and requires the opened leaf identity to match that anchored chain. It then rechecks every descriptor and pathname after reading captured bytes. Node does not expose `openat(2)`; this is the strongest dependency-free Node standard-library design available. Leaf/ancestor symlinks, swap-before-open/restore races, escapes, replacements, and stale hashes fail closed.

### Artifact and resolution requirements

- Android artifact: final `.apk` passes `apksigner verify --verbose --print-certs`, `aapt`, `apkanalyzer`, and `unzip`; manifest app ID is exact/non-debuggable; ABI is only `arm64-v8a`. The validator extracts real `libQuickCrypto.so`, `libNitroModules.so`, `libcrypto.so`, `libssl.so`, `libhermesvm.so`, and `libappmodules.so`, requires the exported `HybridScrypt::deriveKey` and `HybridCipher::setAAD` implementations from QuickCrypto, inspects every `DT_NEEDED` edge, requires QuickBase64 plus QuickCrypto/Nitro autolink symbols from `libappmodules.so`, and closes every native dependency against APK members or the Android system allowlist. Package names and dummy/name-only symbols do not satisfy implementation linkage.
- iOS artifact: final ZIP contains exactly one signed/ad-hoc-signed `Payload/*.app`; `codesign --verify --deep --strict`, `plutil`, `lipo`, `nm`, and `otool` must pass. The exactly-arm64 executable must contain actual `HybridScrypt::deriveKey`, `HybridCipher::setAAD`, `margelo::nitro::install`, and `QuickBase64Impl::base64*ArrayBuffer` implementation symbols. Package names, pod dummy symbols, and autolink-only symbols do not satisfy linkage. Its actual `LC_LOAD_DYLIB` entries must load signed-app `Frameworks/OpenSSL.framework/OpenSSL` and `Frameworks/hermesvm.framework/hermesvm`; the validator checks their identities, platform, and hashes.
- Android resolution: one retained, bounded five-section transcript containing authentic `:app:dependencies --configuration releaseRuntimeClasspath` plus `:app:dependencyInsight` for QuickCrypto, NitroModules, QuickBase64, and `io.github.ronickg:openssl`. The exact QuickCrypto-to-Nitro/OpenSSL edges and `3.6.2-1` exported-AAR selection are mandatory. QuickBase64 must record its actual absence from the Java runtime graph; its native identity is proved from the APK. Synthetic `G016_NPM_PACKAGE` footers and minimal summaries are rejected; exact npm versions already come from the candidate `package-lock.json`.
- iOS resolution: complete generated `Podfile.lock`, parsed by unique top-level section; duplicate top-level section names are rejected. QuickCrypto, NitroModules, and QuickBase64 are direct declarations with exact external-source paths. `OpenSSL-Universal` must appear exactly once in `PODS`/checksums/spec repo and transitively inside the QuickCrypto pod block, not as a top-level `DEPENDENCIES` entry. The four selected pod checksums, Podfile checksum, and CocoaPods `1.16.2` are exact.

`nativeResolution` contains only `resolutionPath` and `resolutionSha256`. Android `runtimeIdentity` contains `artifactSha256`, exact `installedBaseApkPath: "runtime/installed-base.apk"`, and `installedBaseApkSha256`. iOS `runtimeIdentity` contains `artifactSha256`, exact `installedExecutablePath: "runtime/installed-G016FMBKCryptoProof"`, exact `installedBundlePath: "runtime/installed-main.jsbundle"`, and their SHA-256 values. The aggregate result reports derived `nativeMembers`, packaged member hashes, and validated installed-runtime hashes; pinned device/inode metadata remains validator-internal and is never serialized.

### Hashed raw runtime logs

Caller-declared `proofRecords`, adverse `matches`, and inline memory `samples` are invalid schema. Each platform retains and hashes:

- `logs/process.txt`: exactly one `G016_CRYPTO_PROOF`, one canonical `G016_PROOF_OBSERVED_AT`, and one bounded `G016_NATIVE_COMMAND_BEGIN`/`END` liveness transcript. Android retains exact `adb shell ps -A -o PID,NAME,ARGS` output containing one PID/package row. Both installed iOS simulator runtimes require and retain exact `xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=` output containing one PID/app-executable row. Favorable `alive` JSON is not accepted.
- `logs/adverse.txt`: one `G016_ADVERSE_LOG` capture header covering proof through liveness plus raw runtime lines. It must contain exactly one native platform-shaped, PID-scoped `G016_CRYPTO_PROOF` line from that same live PID, byte-equal to the canonical proof in `logs/process.txt`; its raw platform timestamp must normalize uniquely inside the capture window and no more than 60 seconds before the canonical observation timestamp. A different PID, proof, timestamp, or detached raw log fails closed. Android parsing recognizes PID/app-scoped `AndroidRuntime`, ANR, OOM, signal, tombstone, and process-death events. ActivityManager/lmk kill events are adverse only when their target PID is the exact live proof PID, so a prior retry PID for the same package does not poison the current run. iOS parsing recognizes PID/app-scoped crash/termination/unhandled and real memorystatus/jetsam kill events. Benign `OomAdjuster`, lmkd statistics, `jetsamPriority`, CrashReporter initialization, and `aborting flush` lines are accepted.
- `logs/memory.txt`: at least five bounded native command transcripts with one leading `baseline`, at least one `run`, and at least three trailing `post-first-run` phases. Android values come only from PID/app-bound `adb shell dumpsys meminfo <pid>` `TOTAL PSS`; iOS values come only from PID/app-bound `footprint -f bytes -p <pid>` output containing exactly one integer-byte `phys_footprint: <bytes> B` line. Formatted default KB/MB output is rejected. The command-block `startedAt`/`endedAt` markers are the observation window; native footprint output has no `Time:` requirement. Command windows must be canonical, ordered, non-overlapping, finish before the normalized raw platform proof timestamp, and use the same PID/target later confirmed by liveness. Caller-authored memory JSON is not accepted.

Memory budgets remain unchanged: Android peak-baseline ≤96 MiB and peak ≤256 MiB; iOS peak-baseline ≤128 MiB; both retained baseline-to-final growth ≤16 MiB; no trailing nondecreasing segment may grow by more than 16 MiB. Every in-process timing/vector/runtime invariant is reapplied to the parsed proof.

Each native command block uses exact one-line JSON markers around unmodified stdout:

```text
G016_NATIVE_COMMAND_BEGIN {"id":"android-memory-1","platform":"android","kind":"memory","phase":"baseline","pid":4186,"startedAt":"2026-07-12T00:00:00.000Z","target":"emulator","command":"adb shell dumpsys meminfo 4186"}
<verbatim dumpsys stdout>
G016_NATIVE_COMMAND_END {"id":"android-memory-1","endedAt":"2026-07-12T00:00:00.100Z","exitCode":0}
```

The collector writes the begin marker immediately before executing the exact command, streams stdout without rewriting it, then writes the end marker with the command exit status and observation time. IDs are unique within each file and duplicate IDs fail validation. The same format applies to liveness and iOS `footprint`; only the listed platform commands, phases, and targets are accepted. The executable iOS collection commands and corresponding `command` marker values are exactly:

```bash
xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=
footprint -f bytes -p "$PID"
```

A physical-flavored string is never production attestation. The iOS target is derived from `LC_BUILD_VERSION` and contradictory physical declarations fail, but `physicalIosProductionGate` remains `OPEN` even after aggregate PASS until a separately approved physical-device attestation gate exists.

After installing and launching those exact signed artifacts, the device collector must create independent byte-for-byte copies at `<evidenceRoot>/android/runtime/installed-base.apk`, `<evidenceRoot>/ios/runtime/installed-G016FMBKCryptoProof`, and `<evidenceRoot>/ios/runtime/installed-main.jsbundle`, hash those exact files, and populate `runtimeIdentity`. Copy bytes into newly created files; do not reuse, rename, symlink, or hardlink the build artifact or another runtime member. The collector must retain the unedited platform raw log line containing the compact proof in `logs/adverse.txt` as well as the canonical extracted proof in `logs/process.txt`. A fresh collection using this schema is required; retained V7 evidence without these files cannot be upgraded or reported as device `PASS`.

### Executable pre-sign build and packaging flow

Run from the repository root. First create the canonical source manifest without adding it to the source boundary:

```bash
EVIDENCE=/absolute/path/g016-evidence
mkdir -p "$EVIDENCE/integrity"
node --input-type=module <<'NODE' > "$EVIDENCE/integrity/source-fingerprint-manifest.txt"
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { G016_SOURCE_PATHS } from "./spikes/backup-crypto/deviceEvidenceValidator.mjs";
for (const path of G016_SOURCE_PATHS) console.log(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path}`);
NODE
SOURCE_FINGERPRINT=$(shasum -a 256 "$EVIDENCE/integrity/source-fingerprint-manifest.txt" | awk '{print $1}')
```

Android generates authentic resolution evidence before Metro/Release assembly, injects both digests into Metro, then verifies the final signed APK:

```bash
cd spikes/backup-crypto
npx expo prebuild --platform android --clean
mkdir -p "$EVIDENCE/android/resolution" "$EVIDENCE/android/artifact"
RES="$EVIDENCE/android/resolution/gradle-release-runtime.txt"
printf '%s\n' '===== dependencies releaseRuntimeClasspath =====' > "$RES"
(cd android && ./gradlew :app:dependencies --configuration releaseRuntimeClasspath --console=plain) >> "$RES" 2>&1
for dep in react-native-quick-crypto react-native-nitro-modules react-native-quick-base64 io.github.ronickg:openssl; do
  printf '\n===== dependencyInsight %s =====\n' "$dep" >> "$RES"
  (cd android && ./gradlew :app:dependencyInsight --configuration releaseRuntimeClasspath --dependency "$dep" --console=plain) >> "$RES" 2>&1
done
RESOLUTION_SHA256=$(shasum -a 256 "$RES" | awk '{print $1}')
EXPO_PUBLIC_G016_SOURCE_SHA256="$SOURCE_FINGERPRINT" \
EXPO_PUBLIC_G016_RESOLUTION_SHA256="$RESOLUTION_SHA256" \
  ./android/gradlew -p android :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
cp android/app/build/outputs/apk/release/app-release.apk "$EVIDENCE/android/artifact/g016-release.apk"
"$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)/apksigner" verify --verbose --print-certs "$EVIDENCE/android/artifact/g016-release.apk"
```

The Release signing configuration used by Gradle must be the intended local/ad-hoc test signer or release signer. Do not mutate the APK after that verification.

iOS generates the full lock first, injects both digests into the Metro build, signs nested frameworks and the final app, packages `Payload`, then re-verifies the packaged app:

```bash
cd spikes/backup-crypto
npx expo prebuild --platform ios --clean
(cd ios && pod install)
DERIVED_DATA="/private/tmp/g016-ios-derived-$SOURCE_FINGERPRINT"
PACKAGE_ROOT="/private/tmp/g016-ios-package-$SOURCE_FINGERPRINT"
VERIFY_ROOT="/private/tmp/g016-ios-verify-$SOURCE_FINGERPRINT"
rm -rf "$DERIVED_DATA" "$PACKAGE_ROOT" "$VERIFY_ROOT"
mkdir -p "$EVIDENCE/ios/resolution" "$EVIDENCE/ios/artifact" "$PACKAGE_ROOT/Payload"
cp ios/Podfile.lock "$EVIDENCE/ios/resolution/Podfile.lock"
RESOLUTION_SHA256=$(shasum -a 256 "$EVIDENCE/ios/resolution/Podfile.lock" | awk '{print $1}')
EXPO_PUBLIC_G016_SOURCE_SHA256="$SOURCE_FINGERPRINT" \
EXPO_PUBLIC_G016_RESOLUTION_SHA256="$RESOLUTION_SHA256" \
  xcodebuild -workspace ios/G016FMBKCryptoProof.xcworkspace -scheme G016FMBKCryptoProof \
    -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$DERIVED_DATA" \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
APP="$DERIVED_DATA/Build/Products/Release-iphonesimulator/G016FMBKCryptoProof.app"
test -d "$APP"
cp -R "$APP" "$PACKAGE_ROOT/Payload/G016FMBKCryptoProof.app"
APP="$PACKAGE_ROOT/Payload/G016FMBKCryptoProof.app"
EXECUTABLE="$APP/G016FMBKCryptoProof"
find "$APP" -type f -perm -111 -print0 | while IFS= read -r -d '' binary; do
  file "$binary" | grep -q 'Mach-O' || continue
  if test "$(lipo -archs "$binary")" != arm64; then
    lipo "$binary" -thin arm64 -output "$binary.arm64"
    mv "$binary.arm64" "$binary"
  fi
  test "$(lipo -archs "$binary")" = arm64
done
test "$(lipo -archs "$EXECUTABLE")" = arm64
for framework in OpenSSL hermesvm; do
  otool -L "$EXECUTABLE" | grep -Fq "@rpath/$framework.framework/$framework"
  test "$(lipo -archs "$APP/Frameworks/$framework.framework/$framework")" = arm64
done
find "$APP" -type d -name '*.framework' -depth -exec codesign --force --sign - --timestamp=none {} \;
codesign --force --sign - --timestamp=none "$APP"
(cd "$PACKAGE_ROOT" && zip -qry "$EVIDENCE/ios/artifact/G016.zip" Payload)
mkdir -p "$VERIFY_ROOT"
unzip -q "$EVIDENCE/ios/artifact/G016.zip" -d "$VERIFY_ROOT"
codesign --verify --deep --strict --verbose=2 "$VERIFY_ROOT/Payload/G016FMBKCryptoProof.app"
test "$(lipo -archs "$VERIFY_ROOT/Payload/G016FMBKCryptoProof.app/G016FMBKCryptoProof")" = arm64
```

Use an Apple identity instead of `-` when required, but always thin/verify before signing, sign before ZIP packaging, and verify the app extracted from the final ZIP. The app path is the exact dedicated DerivedData output; never search global DerivedData or select a previous build. These commands produce local consistency/tamper evidence only; they do not close physical iOS production.

## Third-party evidence

Pinned direct native/config dependencies are:

- `react-native-quick-crypto@1.1.6`
- `react-native-nitro-modules@0.36.1`
- `react-native-quick-base64@3.0.1`
- `expo-build-properties@57.0.3`
- `expo-crypto@57.0.0`

`THIRD_PARTY_NOTICES.md` inventories exact lock integrities and committed MIT/Apache-2.0/CC0 grants for these packages, Quick Crypto’s six runtime JS dependencies, OpenSSL, and bundled ncrypto/simdutf/BLAKE3/fast-pbkdf2/base64 material. The machine check binds each notice file to a known SHA-256 and installed/locked identity:

```bash
npm run check:licenses
```

Quick Crypto has no published independent audit. The broad native surface, native memory, JSI copies, OpenSSL binary provenance, and removal costs remain explicit risks.

## Local verification

Run from this directory without modifying root dependencies:

```bash
npm ci --cache /tmp/g016-npm-cache
npm test
npm run typecheck
npm run doctor
npm run export:android
rm -rf dist .expo android ios
npm run export:ios
rm -rf dist .expo android ios
npm audit --omit=dev
npm audit signatures
npm run check:licenses
```

The expected `npm audit --omit=dev` exception remains 11 moderate findings in the inherited Expo/config `uuid <11.1.1` chain. `npm audit fix --force` is prohibited because it proposes a breaking Expo replacement. Export success and `IN_PROCESS_PASS` are not device acceptance.

Removal remains narrow: delete the native adapter/validation/self-test/proof helpers, remove the four native/config dependencies plus Expo Crypto as applicable, remove both config plugins, regenerate only this package’s lock/native projects, and provide a separately approved `BackupCryptoPort`. Frozen FMBK framing, canonical JSON, vector source, fixtures, and the exact 790-byte archive remain unchanged.
