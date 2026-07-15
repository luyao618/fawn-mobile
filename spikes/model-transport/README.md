# G017 Model Transport Proof

This independently installable Expo 57.0.4 package proves only the bounded Chat Completions
transport. It intentionally has no dependency on the earlier SQLite/FTS or FMBK spikes.

```bash
npm ci --workspaces=false
npm run mock:provider                # from the repository root
npm run spike:ios                    # Release device lane is verified separately
npm run spike:android
```

Cleartext transport is restricted in code to `127.0.0.1`, `localhost`, and Android emulator host
`10.0.2.2`. Production-like provider URLs require HTTPS. The iOS local-network ATS exception and
Android cleartext setting exist solely for this disposable simulator/emulator mock harness.

Release runs must set `EXPO_PUBLIC_G017_SOURCE_FINGERPRINT` to the output of:

```bash
node spikes/model-transport/deviceEvidenceValidator.mjs --fingerprint
```

The fingerprint owns the G017 spike runtime, provider fixtures, shared redaction and Slice 0 policy
files used by that runtime, its verifier/export tooling, and the tests that lock those contracts. It
deliberately excludes mutable root-app and generic orchestration files (`.gitignore`, root
`package.json`, `package-lock.json`, and `tsconfig.json`, plus `tools/run-slice0.mjs`,
`tools/run-typecheck.mjs`, and `tools/run-expo-doctor-isolated.mjs`). Those files can evolve for the
production app without invalidating retained G017 proof; changes to G017-owned spike inputs still
change the fingerprint.

The app emits exactly one bounded `G017_TRANSPORT_PROOF` terminal JSON record. PASS requires Release,
Hermes, New Architecture, both mock profiles, cancellation, exact dependency identity, and the source
fingerprint. The record explicitly reports only an emulator/simulator local mock; it does not claim
physical-device or production-provider validation.

Final validation accepts only regular, non-symlink raw OS capture files. Each capture retains the
platform-shaped `logcat` or `simctl log` line (including its timestamp and app PID), exactly one
`G017_TARGET_UTC_OFFSET ±HH:MM` line containing the UTC offset reported by the target emulator or
simulator, a canonical `G017_PROOF_OBSERVED_AT` timestamp, and a post-proof native `ps` transcript proving that the same PID
was still live. Bare copied JSON records are rejected. Android collection retains
`adb shell ps -A -o PID,NAME,ARGS`; iOS collection retains
`xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=` inside the validator's bounded
`G017_NATIVE_COMMAND_BEGIN`/`G017_NATIVE_COMMAND_END` framing.

The artifact side accepts only fresh canonical exports under `.expo-export/android` and
`.expo-export/ios`, verifies their exact Expo metadata/manifest/hash/dependency/fingerprint identity,
and asks the installed Hermes compiler to parse the exported bytecode. This is a fail-closed local
consistency check: it rejects stale, malformed, internally inconsistent, and tampered inputs covered
by these validations. It does not establish capture origin; an internally consistent synthetic
capture can pass. It is not hardware-backed attestation and must not be represented as such.
