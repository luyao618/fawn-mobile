# G015 SQLite FTS5 proof

The desktop proof reads the tracked `knowledge/` manifests and fixtures in place. The Android harness generates an ignored local TypeScript module from the same canonical fixtures during installation; no corpus copy or embedding is committed.

Because [expo/expo#38168](https://github.com/expo/expo/issues/38168) reports Expo finalizing FTS5-owned statements before close, the harness disables `finalizeUnusedStatementsBeforeClosing` so SQLite can release them during FTS5 disconnect.

```bash
# Desktop policy, unit, and FTS5 proof
python3 -m unittest discover -s spikes/sqlite-fts -p 'test_*.py' -v
python3 spikes/sqlite-fts/benchmark.py --all

# Standalone Expo SDK 57 harness
cd spikes/sqlite-fts
npm ci
npm run fixtures:check
npm test
npm run typecheck
npm run doctor
npm run export

# Android (AVD name is part of the G015 evidence contract)
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
"$ANDROID_HOME/emulator/emulator" @fawn_pixel_api33

# In a second shell after the emulator is ready; clear logs before launch
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
adb wait-for-device
adb logcat -c
npm run android

# After both variants finish, capture the stable PASS/FAIL record with a finite dump
adb logcat -d '*:S' ReactNativeJS:I | grep 'G015_ANDROID_PROOF '
```
