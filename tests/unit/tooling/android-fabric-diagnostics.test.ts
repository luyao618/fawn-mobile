import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const COLLECTOR = resolve("tools/android-fabric-diagnostics.mjs");
const SERIAL = "emulator-5554";
const PACKAGE = "com.luyao618.formobile";
const EXPECTED_SHA = "abb0a141a73a3992ea86a47ab342034dddab1850";
const BUILD_ID = "5326419ed5d724034268b85e3b74ee5d5fd66613";
const OTHER_BUILD_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const REMOTE_APK = "/data/app/~~aBcD==/com.luyao618.formobile-1/base.apk";
const REMOTE_SPLIT_APK = "/data/app/~~aBcD==/com.luyao618.formobile-1/split_config.x86_64.apk";
/**
 * The one version the repo actually declares. It is read from the root package.json rather than
 * restated here, so a test asserting the collector reads that declaration can never pass by
 * agreeing with a duplicate constant this file kept in sync by hand.
 */
const REACT_NATIVE_VERSION: string = (() => {
  const declared = JSON.parse(readFileSync(resolve("package.json"), "utf8")).dependencies?.["react-native"];
  assert.equal(typeof declared, "string", "the root package.json must declare a react-native dependency version");
  return declared;
})();

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileIdentity(path: string) {
  return { sha256: sha256(path), size: statSync(path).size };
}

/**
 * Minimal ELF64 little-endian shared object carrying exactly one
 * SHT_NOTE section holding an NT_GNU_BUILD_ID note, so Build-ID
 * recovery is exercised without shipping a binary fixture.
 *
 * `corruption` rewrites one attacker-influenced length field after the
 * well-formed image is laid out, so each bounds check is exercised
 * against an image that is otherwise exactly the valid one.
 */
type NoteCorruption = "descriptor-overrun" | "empty-descriptor" | "undersized-section-entry";

function writeElfWithBuildId(path: string, buildIdHex: string, padding = 0, corruption?: NoteCorruption): void {
  const descriptor = Buffer.from(buildIdHex, "hex");
  const note = Buffer.alloc(12 + 4 + descriptor.length);
  note.writeUInt32LE(4, 0);
  note.writeUInt32LE(descriptor.length, 4);
  note.writeUInt32LE(3, 8);
  note.write("GNU\0", 12, "ascii");
  descriptor.copy(note, 16);

  // A descriptor length the note section cannot hold, and an absent descriptor, are the two ways a
  // truncated or hostile image makes the Build-ID read run past the bytes the image actually holds.
  if (corruption === "descriptor-overrun") note.writeUInt32LE(note.length + 4096, 4);
  if (corruption === "empty-descriptor") note.writeUInt32LE(0, 4);

  const noteOffset = 64;
  const sectionOffset = noteOffset + note.length + ((8 - (note.length % 8)) % 8);
  const elf = Buffer.alloc(sectionOffset + 128 + padding);

  elf.write("\x7fELF", 0, "binary");
  elf.writeUInt8(2, 4);
  elf.writeUInt8(1, 5);
  elf.writeUInt8(1, 6);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(62, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(BigInt(sectionOffset), 40);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(corruption === "undersized-section-entry" ? 32 : 64, 58);
  elf.writeUInt16LE(2, 60);
  elf.writeUInt16LE(0, 62);

  note.copy(elf, noteOffset);

  const noteHeader = sectionOffset + 64;
  elf.writeUInt32LE(7, noteHeader + 4);
  elf.writeBigUInt64LE(BigInt(noteOffset), noteHeader + 24);
  elf.writeBigUInt64LE(BigInt(note.length), noteHeader + 32);

  writeFileSync(path, elf);
}

function zip(cwd: string, archive: string, member: string): void {
  const result = spawnSync("/usr/bin/zip", ["-q", "-r", "-X", archive, member], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

type Harness = {
  root: string;
  outputDir: string;
  hostApk: string;
  installedApk: string;
  gradleCache: string;
  adb: string;
  adbCallLog: string;
  tombstoneDir: string;
};

/** Stages an APK containing exactly the x86_64 libraries the collector looks for. */
function buildApk(root: string, stageName: string, apkPath: string, options: {
  reactNativeBuildId?: string;
  omitReactNative?: boolean;
  omitScreens?: boolean;
  padding?: number;
  corruption?: NoteCorruption;
}): void {
  const stage = join(root, stageName);
  mkdirSync(join(stage, "lib/x86_64"), { recursive: true });
  if (options.omitReactNative !== true) {
    writeElfWithBuildId(
      join(stage, "lib/x86_64/libreactnative.so"),
      options.reactNativeBuildId ?? BUILD_ID,
      options.padding ?? 32,
      options.corruption,
    );
  } else {
    writeFileSync(join(stage, "lib/x86_64/libother.so"), "not an ELF image\n");
  }
  if (options.omitScreens !== true) writeElfWithBuildId(join(stage, "lib/x86_64/librnscreens.so"), OTHER_BUILD_ID, 16);
  mkdirSync(join(apkPath, ".."), { recursive: true });
  zip(stage, apkPath, "lib");
}

/** Initializes a real repository so `git rev-parse HEAD` has an independently observable answer. */
function initGitRepo(root: string): string {
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(["init", "--quiet"]);
  run(["config", "user.email", "diagnostics@example.invalid"]);
  run(["config", "user.name", "Diagnostics Fixture"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "revision-marker.txt"), "fabric diagnostics fixture\n");
  run(["add", "revision-marker.txt"]);
  run(["commit", "--quiet", "--no-verify", "-m", "fixture revision"]);
  return run(["rev-parse", "HEAD"]);
}

/**
 * Builds a self-contained fixture: a stub adb exposing a device tombstone
 * inventory and installed APK, a host debug APK packaging x86_64 libraries,
 * and a Gradle-cached RN Debug AAR holding the unstripped library.
 */
function harness(options: {
  tombstones?: string[];
  tombstoneBuildId?: string;
  aarBuildId?: string;
  packagedBuildId?: string;
  installedBuildId?: string;
  omitInstalledReactNative?: boolean;
  omitAar?: boolean;
  omitPackagedScreens?: boolean;
  failPull?: boolean;
  corruptApkPull?: boolean;
  malformedDeviceDigest?: boolean;
  splitInstall?: boolean;
  omitBaseApkPath?: boolean;
  adbExitCode?: number;
  installedNoteCorruption?: NoteCorruption;
  aarNoteCorruption?: NoteCorruption;
  reactNativeVersion?: string;
  declaredReactNativeVersion?: string;
  omitReactNativeDependency?: boolean;
  omitPackageJson?: boolean;
} = {}): Harness {
  const {
    tombstones = ["tombstone_00", "tombstone_00.pb", "tombstone_01", "tombstone_01.pb"],
    tombstoneBuildId,
    aarBuildId = BUILD_ID,
    packagedBuildId = BUILD_ID,
    installedBuildId,
    omitInstalledReactNative = false,
    omitAar = false,
    omitPackagedScreens = false,
    failPull = false,
    corruptApkPull = false,
    malformedDeviceDigest = false,
    splitInstall = false,
    omitBaseApkPath = false,
    adbExitCode = 0,
    installedNoteCorruption,
    aarNoteCorruption,
    reactNativeVersion = REACT_NATIVE_VERSION,
    declaredReactNativeVersion = reactNativeVersion,
    omitReactNativeDependency = false,
    omitPackageJson = false,
  } = options;

  // realpath keeps the fixture root identical to the collector's own process.cwd(), so manifest
  // paths stay repo-relative instead of traversing a platform symlink such as macOS /var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fawn-fabric-diagnostics-")));
  const bin = join(root, "bin");
  const tombstoneDir = join(root, "device-tombstones");
  const outputDir = join(root, ".artifacts/launch/fabric-diagnostics");
  mkdirSync(bin, { recursive: true });
  mkdirSync(tombstoneDir, { recursive: true });

  // The collector resolves the react-native version from the repo it is run inside, so the fixture
  // root declares it exactly the way the real root package.json does.
  if (!omitPackageJson) {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({
      name: "fabric-diagnostics-fixture",
      private: true,
      dependencies: omitReactNativeDependency ? {} : { "react-native": declaredReactNativeVersion },
    }, null, 2)}\n`);
  }

  for (const name of tombstones) {
    // A real android frame for a library loaded out of the APK carries an offset group and a
    // demangled symbol group — whose own argument list nests parentheses — before the BuildId group.
    const frame = tombstoneBuildId === undefined || name.endsWith(".pb")
      ? ""
      : `      #01 pc 00000000002f1a4c  /data/app/~~aBcD==/com.luyao618.formobile-1/base.apk!libreactnative.so`
        + ` (offset 0x1a2b000) (facebook::react::Scheduler::renderTemplateToSurface(int, std::string const&)+128)`
        + ` (BuildId: ${tombstoneBuildId})\n`;
    writeFileSync(join(tombstoneDir, name), `${name} contents for ${BUILD_ID}\n${frame}`);
  }

  // Host debug APK packaging the two x86_64 libraries under test.
  const hostApk = join(root, "android/app/build/outputs/apk/debug/app-debug.apk");
  buildApk(root, "apk-stage", hostApk, { reactNativeBuildId: packagedBuildId, omitScreens: omitPackagedScreens });

  // The installed APK is a distinct artifact only when the fixture needs it to diverge from the host build.
  const needsDistinctInstalled = installedBuildId !== undefined || omitInstalledReactNative
    || installedNoteCorruption !== undefined;
  const installedApk = needsDistinctInstalled ? join(root, "device-install/base.apk") : hostApk;
  if (needsDistinctInstalled) {
    buildApk(root, "installed-stage", installedApk, {
      reactNativeBuildId: installedBuildId ?? packagedBuildId,
      omitReactNative: omitInstalledReactNative,
      omitScreens: omitPackagedScreens,
      padding: 64,
      corruption: installedNoteCorruption,
    });
  }

  // Gradle-cached react-android Debug AAR holding the unstripped library.
  const gradleCache = join(root, "gradle/react-android");
  const aarDir = join(gradleCache, `${reactNativeVersion}/8af60308e3dd4065fe58e0d724624439c16c031b`);
  mkdirSync(aarDir, { recursive: true });
  if (!omitAar) {
    const aarStage = join(root, "aar-stage");
    const prefab = "prefab/modules/reactnative/libs/android.x86_64";
    mkdirSync(join(aarStage, prefab), { recursive: true });
    writeElfWithBuildId(join(aarStage, prefab, "libreactnative.so"), aarBuildId, 512, aarNoteCorruption);
    zip(aarStage, join(aarDir, `react-android-${reactNativeVersion}-debug.aar`), "prefab");
  }

  const pmPathLines = [
    ...(omitBaseApkPath ? [] : [REMOTE_APK]),
    ...(splitInstall || omitBaseApkPath ? [REMOTE_SPLIT_APK] : []),
  ];

  const adb = join(bin, "adb");
  const adbCallLog = join(root, "adb-invocations.log");
  writeFileSync(adb, `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$*" >> "${adbCallLog}"
exit_code=${adbExitCode}
if [ "$exit_code" -ne 0 ]; then exit "$exit_code"; fi
serial="$2"
if [[ ! "$serial" =~ ^emulator-[0-9]+$ ]]; then echo "unexpected serial $serial" >&2; exit 64; fi
case "$3" in
  shell)
    case "$4 \${5:-}" in
      "ls -1")
        ls -1 "${tombstoneDir}"
        ;;
      "sha256sum "*)
        target="$5"
        if [ "${malformedDeviceDigest ? 1 : 0}" -eq 1 ]; then
          printf 'not-a-digest  %s\\n' "$target"
          exit 0
        fi
        case "$target" in
          "${REMOTE_APK}"|"${REMOTE_SPLIT_APK}") /usr/bin/shasum -a 256 "${installedApk}" | awk '{print $1"  '"$target"'"}' ;;
          /data/tombstones/*)
            /usr/bin/shasum -a 256 "${tombstoneDir}/\${target##*/}" | awk '{print $1"  '"$target"'"}'
            ;;
          *) echo "sha256sum: $target: No such file" >&2; exit 1 ;;
        esac
        ;;
      "pm path")
        ${pmPathLines.length === 0
          ? "true"
          : pmPathLines.map((path) => `printf 'package:%s\\n' "${path}"`).join("\n        ")}
        ;;
      *) echo "unsupported shell command: \${*}" >&2; exit 2 ;;
    esac
    ;;
  pull)
    remote="$4"
    local_path="$5"
    if [ "${failPull ? 1 : 0}" -eq 1 ]; then echo "adb: error: failed to stat remote object '$remote'" >&2; exit 1; fi
    case "$remote" in
      "${REMOTE_APK}"|"${REMOTE_SPLIT_APK}")
        cp "${installedApk}" "$local_path"
        if [ "${corruptApkPull ? 1 : 0}" -eq 1 ]; then printf 'truncated-transfer' >> "$local_path"; fi
        ;;
      *) cp "${tombstoneDir}/\${remote##*/}" "$local_path" ;;
    esac
    printf '1 file pulled.\\n'
    ;;
  *) echo "unsupported adb command: \${*}" >&2; exit 2 ;;
esac
`);
  chmodSync(adb, 0o755);

  return { root, outputDir, hostApk, installedApk, gradleCache, adb, adbCallLog, tombstoneDir };
}

function collect(fixture: Harness, extra: string[] = []) {
  const result = spawnSync(process.execPath, [
    COLLECTOR,
    "--serial", SERIAL,
    "--package", PACKAGE,
    "--expected-sha", EXPECTED_SHA,
    "--output-dir", fixture.outputDir,
    "--host-apk", fixture.hostApk,
    "--gradle-cache", fixture.gradleCache,
    "--adb", fixture.adb,
    ...extra,
  ], { cwd: fixture.root, encoding: "utf8" });
  return result;
}

/** Every argv the fake adb was invoked with, so a refusal can be proven to have run none. */
function adbInvocations(fixture: Harness): string[] {
  try {
    return readFileSync(fixture.adbCallLog, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function symbolPath(fixture: Harness): string {
  return join(fixture.outputDir, "symbols/libreactnative.so");
}

function assertNoRetainedSymbols(fixture: Harness, recovered: any): void {
  assert.equal(recovered.status, "unavailable");
  assert.equal(recovered.localPath, undefined, "unverified symbols must claim no admissible retained path");
  assert.throws(
    () => statSync(symbolPath(fixture)),
    "unverified symbols must leave no misleading final symbol file",
  );
}

function manifestOf(fixture: Harness): any {
  return JSON.parse(readFileSync(join(fixture.outputDir, "manifest.json"), "utf8"));
}

test("collector retains a structured manifest bound to EXPECTED_SHA without writing to stdout", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "collector must keep the failure-cleanup stdout stream clean");

  const manifest = manifestOf(fixture);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.type, "android-fabric-diagnostic-retention");
  assert.equal(manifest.expectedSha, EXPECTED_SHA);
  assert.equal(manifest.serial, SERIAL);
  assert.equal(manifest.package, PACKAGE);
  assert.deepEqual(Object.keys(manifest.sections).sort(), [
    "devClientBundle",
    "hostApk",
    "installedApk",
    "packagedLibraries",
    "tombstones",
    "unstrippedReactNative",
  ]);
});

test("collector inventories and pulls both tombstones and tombstone protos", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const tombstones = manifestOf(fixture).sections.tombstones;
  assert.equal(tombstones.status, "collected");
  assert.equal(tombstones.deviceDirectory, "/data/tombstones");
  assert.deepEqual(tombstones.entries.map((entry: any) => [entry.name, entry.kind]), [
    ["tombstone_00", "tombstone"],
    ["tombstone_00.pb", "tombstone-proto"],
    ["tombstone_01", "tombstone"],
    ["tombstone_01.pb", "tombstone-proto"],
  ]);
  assert.deepEqual(tombstones.counts, { tombstone: 2, "tombstone-proto": 2 });

  for (const entry of tombstones.entries) {
    assert.equal(entry.pulled, true, `${entry.name} must be pulled`);
    const localPath = join(fixture.root, entry.localPath);
    assert.equal(sha256(localPath), entry.sha256, `${entry.name} retained bytes must match the manifest`);
    assert.equal(statSync(localPath).size, entry.size);
    assert.equal(entry.deviceSha256, entry.sha256, `${entry.name} must prove the pull is byte-exact`);
  }
});

test("collector retains exact installed and host debug APK bytes and identities", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { installedApk, hostApk } = manifestOf(fixture).sections;
  const expected = fileIdentity(fixture.hostApk);

  assert.equal(installedApk.status, "collected");
  assert.equal(installedApk.remotePath, REMOTE_APK);
  const installedLocal = join(fixture.root, installedApk.localPath);
  assert.equal(sha256(installedLocal), installedApk.sha256, "installed APK manifest digest must describe the retained bytes");
  assert.equal(statSync(installedLocal).size, installedApk.size);
  assert.equal(installedApk.sha256, expected.sha256);
  assert.equal(installedApk.deviceSha256, expected.sha256);
  assert.equal(installedApk.pullIsByteExact, true, "the pull must be proven byte-exact against the device digest");

  assert.equal(hostApk.status, "collected");
  const hostLocal = join(fixture.root, hostApk.localPath);
  assert.equal(sha256(hostLocal), hostApk.sha256, "host APK manifest digest must describe the retained bytes");
  assert.equal(statSync(hostLocal).size, hostApk.size);
  assert.equal(hostApk.sha256, expected.sha256);

  assert.equal(installedApk.matchesHostApk, true, "identical installed and host bytes must be reported as matching");
});

test("collector recovers the Build-ID-matched unstripped RN 0.86 Debug library from the exact cached AAR", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const recovered = manifestOf(fixture).sections.unstrippedReactNative;

  assert.equal(recovered.status, "collected");
  assert.equal(
    recovered.aarPath,
    `react-android-${REACT_NATIVE_VERSION}-debug.aar`,
    "the manifest must not publish absolute host cache paths",
  );
  assert.equal(recovered.memberPath, "prefab/modules/reactnative/libs/android.x86_64/libreactnative.so");
  assert.equal(recovered.buildId, BUILD_ID);
  assert.equal(recovered.buildIdMatchesPackaged, true);

  const localPath = join(fixture.root, recovered.localPath);
  assert.equal(sha256(localPath), recovered.sha256);
  assert.equal(statSync(localPath).size, recovered.size);
});

test("collector retains packaged x86_64 libreactnative and librnscreens bytes and identities", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const packaged = manifestOf(fixture).sections.packagedLibraries;

  assert.equal(packaged.status, "collected");
  assert.deepEqual(packaged.entries.map((entry: any) => entry.member), [
    "lib/x86_64/libreactnative.so",
    "lib/x86_64/librnscreens.so",
  ]);
  assert.equal(packaged.entries[0].buildId, BUILD_ID);
  assert.equal(packaged.entries[1].buildId, OTHER_BUILD_ID);
  for (const entry of packaged.entries) {
    const localPath = join(fixture.root, entry.localPath);
    assert.equal(sha256(localPath), entry.sha256, `${entry.member} manifest digest must describe the retained bytes`);
    assert.equal(statSync(localPath).size, entry.size);
    assert.ok(entry.size > 0);
  }
  assert.notEqual(
    packaged.entries[0].localPath,
    packaged.entries[1].localPath,
    "each packaged library must be retained at its own path",
  );
});

test("collector degrades per-library when a packaged member cannot be extracted", (context) => {
  const fixture = harness({ omitPackagedScreens: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const packaged = manifestOf(fixture).sections.packagedLibraries;
  assert.equal(packaged.status, "collected");

  const [reactNative, screens] = packaged.entries;
  assert.equal(sha256(join(fixture.root, reactNative.localPath)), reactNative.sha256);
  assert.equal(screens.localPath, undefined, "an unextractable member must not claim a retained path");
  assert.equal(screens.sha256, undefined);
  assert.match(screens.reason, /librnscreens\.so/);
});

test("collector records a precise reason when the installed APK cannot be pulled", (context) => {
  const fixture = harness({ failPull: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { installedApk, tombstones } = manifestOf(fixture).sections;
  assert.equal(installedApk.status, "unavailable");
  assert.equal(installedApk.localPath, undefined, "a failed pull must not claim retained bytes");
  assert.match(installedApk.reason, /pull/i);
  for (const entry of tombstones.entries) {
    assert.equal(entry.pulled, false, "a failed pull must be recorded rather than silently retained");
    assert.ok(entry.reason.length > 0);
  }
});

test("collector records a precise reason when the host debug APK is absent", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = collect(fixture, ["--host-apk", join(fixture.root, "absent.apk")]);
  assert.equal(result.status, 0);
  const { hostApk, packagedLibraries } = manifestOf(fixture).sections;
  assert.equal(hostApk.status, "unavailable");
  assert.equal(hostApk.localPath, undefined);
  assert.match(hostApk.reason, /absent\.apk/);
  assert.equal(packagedLibraries.status, "unavailable");
  assert.match(packagedLibraries.reason, /absent\.apk/);
});

test("collector reports a Build-ID mismatch instead of silently retaining the wrong symbols", (context) => {
  const fixture = harness({ aarBuildId: OTHER_BUILD_ID });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const recovered = manifestOf(fixture).sections.unstrippedReactNative;
  assertNoRetainedSymbols(fixture, recovered);
  assert.equal(recovered.buildIdMatchesPackaged, false);
  assert.match(recovered.reason, /build id/i);
  assert.ok(recovered.reason.includes(BUILD_ID), "reason must name the packaged Build ID it failed to match");
});

test("collector records the dev-client JS bundle as unavailable with a precise reason", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const bundle = manifestOf(fixture).sections.devClientBundle;
  assert.equal(bundle.status, "unavailable");
  assert.match(bundle.reason, /no exact post-failure artifact/i);
  assert.match(bundle.reason, /Metro/);
  assert.equal(bundle.prefetched, false, "the collector must never warm or prefetch Metro");
});

test("collector exits zero and records precise reasons when every diagnostic action fails", (context) => {
  const fixture = harness({ adbExitCode: 77, omitAar: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const result = collect(fixture, ["--host-apk", join(fixture.root, "absent.apk")]);
  assert.equal(result.status, 0, "a fully failed collection must never change the caller's exit status");
  assert.equal(result.stdout, "");

  const manifest = manifestOf(fixture);
  for (const name of ["tombstones", "installedApk", "hostApk", "unstrippedReactNative", "packagedLibraries"]) {
    const section = manifest.sections[name];
    assert.equal(section.status, "unavailable", `${name} must degrade to unavailable`);
    assert.ok(
      typeof section.reason === "string" && section.reason.length > 0,
      `${name} must carry a precise reason`,
    );
  }
});

test("collector adds no dependency and uses only standard Node APIs", () => {
  const source = readFileSync(COLLECTOR, "utf8");
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(
    imports.filter((specifier) => !specifier.startsWith("node:")),
    [],
    "collector must use only standard Node APIs and add no dependency",
  );
  assert.doesNotMatch(source, /\brequire\s*\(/, "collector must remain an ES module without CommonJS loading");
});

test("collector verifies symbols against the installed APK, not the host build output", (context) => {
  const fixture = harness({ installedBuildId: OTHER_BUILD_ID });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { unstrippedReactNative, installedApk } = manifestOf(fixture).sections;

  // The host APK and cached AAR agree, so only the installed image can expose the divergence.
  assertNoRetainedSymbols(fixture, unstrippedReactNative);
  assert.equal(unstrippedReactNative.buildIdMatchesPackaged, false);
  assert.equal(unstrippedReactNative.packagedBuildId, OTHER_BUILD_ID, "the Build ID under test must come from the installed APK");
  assert.equal(
    unstrippedReactNative.packagedBuildIdSource,
    installedApk.localPath,
    "the manifest must name the retained installed APK the Build ID was read from",
  );
});

test("collector leaves no symbol file when the installed packaged Build ID is null", (context) => {
  const fixture = harness({ omitInstalledReactNative: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const recovered = manifestOf(fixture).sections.unstrippedReactNative;

  assertNoRetainedSymbols(fixture, recovered);
  assert.equal(recovered.packagedBuildId, null, "an unreadable faulting image must record an explicit null Build ID");
  assert.equal(recovered.buildIdMatchesPackaged, null, "no match may be claimed without a packaged Build ID");
  assert.match(recovered.packagedBuildIdReason, /libreactnative\.so/);
  assert.match(recovered.reason, /host-only symbols/i);
});

test("collector never leaves a stale symbol file behind from an earlier verified run", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  assert.equal(manifestOf(fixture).sections.unstrippedReactNative.status, "collected");
  assert.ok(statSync(symbolPath(fixture)).size > 0, "the verified run must retain symbols");

  // Re-collect against a device whose installed image no longer matches those symbols.
  const mismatched = harness({ installedBuildId: OTHER_BUILD_ID });
  context.after(() => rmSync(mismatched.root, { recursive: true, force: true }));
  const rerun = spawnSync(process.execPath, [
    COLLECTOR,
    "--serial", SERIAL,
    "--package", PACKAGE,
    "--expected-sha", EXPECTED_SHA,
    "--output-dir", fixture.outputDir,
    "--host-apk", mismatched.hostApk,
    "--gradle-cache", mismatched.gradleCache,
    "--adb", mismatched.adb,
  ], { cwd: mismatched.root, encoding: "utf8" });
  assert.equal(rerun.status, 0, rerun.stderr);

  assertNoRetainedSymbols(fixture, manifestOf(fixture).sections.unstrippedReactNative);
});

test("collector cross-checks the tombstone-recorded Build ID and refuses a mismatch", (context) => {
  const fixture = harness({ tombstoneBuildId: OTHER_BUILD_ID });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const recovered = manifestOf(fixture).sections.unstrippedReactNative;

  assertNoRetainedSymbols(fixture, recovered);
  assert.deepEqual(recovered.tombstoneBuildIds, [OTHER_BUILD_ID]);
  assert.equal(recovered.buildIdMatchesPackaged, true, "the installed image still agrees with the cached AAR");
  assert.equal(recovered.buildIdMatchesTombstones, false, "the device-recorded Build ID must veto the symbols");
  assert.ok(recovered.reason.includes(OTHER_BUILD_ID), "reason must name the tombstone Build ID it failed to match");
});

test("collector retains symbols when the tombstone-recorded Build ID agrees", (context) => {
  const fixture = harness({ tombstoneBuildId: BUILD_ID });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const recovered = manifestOf(fixture).sections.unstrippedReactNative;

  assert.equal(recovered.status, "collected");
  assert.deepEqual(recovered.tombstoneBuildIds, [BUILD_ID], "duplicate frames across tombstones must collapse to unique IDs");
  assert.equal(recovered.buildIdMatchesTombstones, true);
  assert.equal(sha256(join(fixture.root, recovered.localPath)), recovered.sha256);
});

test("collector records explicit unavailable evidence when no tombstone Build ID exists", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const recovered = manifestOf(fixture).sections.unstrippedReactNative;

  assert.equal(recovered.status, "collected", "an absent tombstone Build ID must not veto a verified match");
  assert.deepEqual(recovered.tombstoneBuildIds, []);
  assert.equal(recovered.buildIdMatchesTombstones, null, "no tombstone agreement may be claimed without evidence");
  assert.match(recovered.tombstoneBuildIdReason, /no libreactnative build id/i);
});

test("collector binds the manifest to the independently observed checked-out revision", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const head = initGitRepo(fixture.root);

  const result = spawnSync(process.execPath, [
    COLLECTOR,
    "--serial", SERIAL,
    "--package", PACKAGE,
    "--expected-sha", head,
    "--output-dir", fixture.outputDir,
    "--host-apk", fixture.hostApk,
    "--gradle-cache", fixture.gradleCache,
    "--adb", fixture.adb,
  ], { cwd: fixture.root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const manifest = manifestOf(fixture);
  assert.equal(manifest.checkedOutSha, head, "the collector must run git rev-parse HEAD itself");
  assert.equal(manifest.shaBinding.status, "verified");
  assert.equal(manifest.shaBinding.matchesExpectedSha, true);
  assert.equal(manifest.expectedSha, head);
});

test("collector records a mismatched expected SHA as unavailable instead of silently verified", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const head = initGitRepo(fixture.root);

  assert.equal(collect(fixture).status, 0, "a SHA mismatch must never change the caller's exit status");
  const manifest = manifestOf(fixture);

  assert.equal(manifest.shaBinding.status, "unavailable");
  assert.equal(manifest.shaBinding.matchesExpectedSha, false);
  assert.equal(manifest.checkedOutSha, head, "the observed revision must still be retained as evidence");
  assert.equal(manifest.expectedSha, EXPECTED_SHA);
  assert.ok(manifest.shaBinding.reason.includes(head) && manifest.shaBinding.reason.includes(EXPECTED_SHA));
});

test("collector records empty and malformed expected SHAs as unavailable without throwing", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  for (const [supplied, pattern] of [["", /no expected sha was supplied/i], ["not-a-sha", /not a 40-character/i]] as const) {
    const result = spawnSync(process.execPath, [
      COLLECTOR,
      "--serial", SERIAL,
      "--package", PACKAGE,
      "--expected-sha", supplied,
      "--output-dir", fixture.outputDir,
      "--host-apk", fixture.hostApk,
      "--gradle-cache", fixture.gradleCache,
      "--adb", fixture.adb,
    ], { cwd: fixture.root, encoding: "utf8" });

    assert.equal(result.status, 0, `expected SHA ${JSON.stringify(supplied)} must never throw out of cleanup`);
    assert.equal(result.stdout, "");
    const manifest = manifestOf(fixture);
    assert.equal(manifest.shaBinding.status, "unavailable");
    assert.equal(manifest.shaBinding.matchesExpectedSha, null, "no binding verdict may be claimed for an inadmissible SHA");
    assert.equal(manifest.expectedSha, null);
    assert.match(manifest.shaBinding.reason, pattern);
  }
});

test("collector records an unreadable revision as unavailable rather than verified", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  // The fixture root is a bare temp directory, so `git rev-parse HEAD` cannot resolve a revision.
  assert.equal(collect(fixture).status, 0);
  const manifest = manifestOf(fixture);

  assert.equal(manifest.shaBinding.status, "unavailable");
  assert.equal(manifest.checkedOutSha, null, "an unresolvable revision must be an explicit null");
  assert.equal(manifest.shaBinding.matchesExpectedSha, null);
  assert.ok(manifest.shaBinding.reason.length > 0);
});

test("collector selects base.apk and represents a split install without a false host mismatch", (context) => {
  const fixture = harness({ splitInstall: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const installed = manifestOf(fixture).sections.installedApk;

  assert.equal(installed.status, "collected");
  assert.equal(installed.remotePath, REMOTE_APK, "the collector must explicitly select base.apk from pm path");
  assert.deepEqual(installed.additionalRemotePaths, [REMOTE_SPLIT_APK]);
  assert.equal(installed.splitInstall, true);
  assert.equal(installed.matchesHostApk, null, "a split install must not claim a host APK mismatch");
  assert.match(installed.matchesHostApkReason, /split across 2 APKs/);
  assert.equal(sha256(join(fixture.root, installed.localPath)), installed.sha256);
});

test("collector records unavailable when pm path reports no base.apk", (context) => {
  const fixture = harness({ omitBaseApkPath: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { installedApk, unstrippedReactNative } = manifestOf(fixture).sections;

  assert.equal(installedApk.status, "unavailable");
  assert.equal(installedApk.localPath, undefined, "an unselectable base.apk must claim no retained bytes");
  assert.match(installedApk.reason, /no base\.apk/);
  assertNoRetainedSymbols(fixture, unstrippedReactNative);
});

test("collector proves a corrupt installed APK pull is not byte-exact and authorizes no symbols", (context) => {
  const fixture = harness({ corruptApkPull: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { installedApk: installed, unstrippedReactNative } = manifestOf(fixture).sections;

  assert.equal(installed.status, "collected", "the retained bytes are still evidence of what was transferred");
  assert.equal(installed.pullIsByteExact, false, "a truncated or padded transfer must be reported as not byte-exact");
  assert.notEqual(installed.sha256, installed.deviceSha256);
  assert.equal(
    sha256(join(fixture.root, installed.localPath)),
    installed.sha256,
    "the manifest digest must always describe the bytes actually retained",
  );

  // The corrupt pull still carries a parseable libreactnative Build ID, so only an explicit
  // byte-exactness refusal can stop it from authorizing symbols against bytes the device never loaded.
  assertNoRetainedSymbols(fixture, unstrippedReactNative);
  assert.equal(unstrippedReactNative.packagedBuildId, null, "a non-byte-exact pull must establish no provenance");
  assert.equal(unstrippedReactNative.buildIdMatchesPackaged, null, "no match may be claimed from an unverified pull");
  assert.match(unstrippedReactNative.packagedBuildIdReason, /not byte-exact/i);
});

test("collector reports a malformed device digest as unavailable and authorizes no symbols", (context) => {
  const fixture = harness({ malformedDeviceDigest: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { tombstones, installedApk, unstrippedReactNative } = manifestOf(fixture).sections;

  assert.equal(tombstones.status, "collected");
  for (const entry of tombstones.entries) {
    assert.equal(entry.pulled, true);
    assert.equal(entry.deviceSha256, undefined, "an unusable digest must not be published as a device digest");
    assert.equal(entry.pullIsByteExact, null, "byte-exactness must not be claimed without a usable device digest");
    assert.match(entry.deviceSha256Reason, /unusable digest/);
  }

  assert.equal(installedApk.deviceSha256, undefined, "an unusable digest must not be published for the installed APK");
  assert.equal(installedApk.pullIsByteExact, null, "an unverifiable pull must not claim byte-exactness");

  // The pulled APK is byte-identical here; only the missing proof distinguishes it, and unproven is not verified.
  assertNoRetainedSymbols(fixture, unstrippedReactNative);
  assert.equal(unstrippedReactNative.packagedBuildId, null, "an unverifiable pull must establish no provenance");
  assert.equal(unstrippedReactNative.buildIdMatchesPackaged, null, "no match may be claimed from an unverifiable pull");
  assert.match(unstrippedReactNative.packagedBuildIdReason, /never proven byte-exact/i);
});

test("collector proves each tombstone pull is byte-exact against the device digest", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  for (const entry of manifestOf(fixture).sections.tombstones.entries) {
    assert.equal(entry.pullIsByteExact, true, `${entry.name} must prove the pull is byte-exact`);
    assert.equal(entry.deviceSha256, entry.sha256);
  }
});

test("collector matches a real tombstone frame whose offset and demangled symbol precede the BuildId", () => {
  const source = readFileSync(COLLECTOR, "utf8");
  const declaration = source.match(/const TOMBSTONE_BUILD_ID_PATTERN = (\/.*\/[gimsuy]*);/);
  assert.ok(declaration, "the collector must declare TOMBSTONE_BUILD_ID_PATTERN as a literal regular expression");
  assert.doesNotMatch(
    declaration[1],
    /\[\^\\n\)\]/,
    "a [^)] span early-stops at the offset parenthesis and can never reach the BuildId group",
  );

  // Verbatim shape android emits for a library mapped out of the APK: an `(offset ...)` group and a
  // demangled symbol group whose own argument list nests parentheses, both before `(BuildId: ...)`.
  const frame = "      #01 pc 00000000002f1a4c  /data/app/~~aBcD==/com.luyao618.formobile-1/base.apk!libreactnative.so"
    + " (offset 0x1a2b000) (facebook::react::Scheduler::renderTemplateToSurface(int, std::string const&)+128)"
    + ` (BuildId: ${BUILD_ID})`;
  const pattern = new RegExp(declaration[1].slice(1, declaration[1].lastIndexOf("/")), "gi");
  assert.deepEqual(
    [...frame.matchAll(pattern)].map((match) => match[1]),
    [BUILD_ID],
    "the exact real-world frame shape must yield its Build ID",
  );

  // The span must stay newline-bounded so a later frame's BuildId is never attributed to this library.
  const unrelated = `      #02 pc 0000000000123456  /system/lib64/libc.so (abort+164) (BuildId: ${OTHER_BUILD_ID})`;
  assert.deepEqual(
    [...`${unrelated}\n`.matchAll(new RegExp(declaration[1].slice(1, declaration[1].lastIndexOf("/")), "gi"))].map((m) => m[1]),
    [],
    "a frame for another library must contribute no libreactnative Build ID",
  );
});

test("collector publishes no absolute host path when the host APK and cached AAR are both missing", (context) => {
  const fixture = harness({ omitAar: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture, ["--host-apk", join(fixture.root, "absent.apk")]).status, 0);
  const serialized = readFileSync(join(fixture.outputDir, "manifest.json"), "utf8");
  const { hostApk, packagedLibraries, unstrippedReactNative } = manifestOf(fixture).sections;

  for (const section of [hostApk, packagedLibraries, unstrippedReactNative]) {
    assert.equal(section.status, "unavailable");
  }
  // The reason must stay useful: it still names the artifact, just not the host root it lived under.
  assert.match(hostApk.reason, /absent\.apk/, "a missing host APK must still name the artifact it looked for");
  assert.match(packagedLibraries.reason, /absent\.apk/);
  assert.ok(!serialized.includes(fixture.root), "no failure reason may disclose the absolute fixture root");
  assert.ok(!serialized.includes(fixture.gradleCache), "the manifest must not publish the absolute Gradle cache path");
  assert.doesNotMatch(serialized, /"[^"]*\/(?:Users|home|tmp|var)\//, "the manifest must carry no absolute host paths");
});

test("collector publishes no absolute host path in any degraded or failed section", (context) => {
  const fixture = harness({ adbExitCode: 77, omitAar: true, omitPackagedScreens: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture, ["--host-apk", join(fixture.root, "absent.apk")]).status, 0);
  const serialized = readFileSync(join(fixture.outputDir, "manifest.json"), "utf8");

  for (const name of ["tombstones", "installedApk", "hostApk", "unstrippedReactNative", "packagedLibraries"]) {
    assert.equal(manifestOf(fixture).sections[name].status, "unavailable", `${name} must degrade to unavailable`);
  }
  assert.ok(!serialized.includes(fixture.root), "a fully failed collection must disclose no absolute host root");
  assert.doesNotMatch(serialized, /"[^"]*\/(?:Users|home|tmp|var)\//, "the manifest must carry no absolute host paths");
});

test("collector publishes no absolute host cache path anywhere in the manifest", (context) => {
  const fixture = harness({ omitAar: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const serialized = readFileSync(join(fixture.outputDir, "manifest.json"), "utf8");

  assert.equal(manifestOf(fixture).sections.unstrippedReactNative.status, "unavailable");
  assert.ok(!serialized.includes(fixture.gradleCache), "the manifest must not publish the absolute Gradle cache path");
  assert.doesNotMatch(serialized, /"[^"]*\/(?:Users|home|tmp|var)\//, "the manifest must carry no absolute host paths");
});

test("collector invokes the PATH unzip its comment claims the Android job provides", () => {
  const source = readFileSync(COLLECTOR, "utf8");
  assert.match(source, /spawnSync\("unzip",/, "the collector must invoke the same PATH unzip the job installs Maestro with");
  assert.doesNotMatch(source, /\/usr\/bin\/unzip/, "no hardcoded host unzip path may contradict the comment");
  assert.doesNotMatch(source, /native preflight/, "the comment must not claim a preflight that does not exist");
});

test("collector redacts the absolute host destination from a failed adb pull reason", (context) => {
  const fixture = harness({ failPull: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const serialized = readFileSync(join(fixture.outputDir, "manifest.json"), "utf8");
  const { installedApk, tombstones } = manifestOf(fixture).sections;

  // A pull failure is the one reason that necessarily embeds a host destination: adb is handed an
  // absolute local path, and both the echoed argv and adb's own stderr would otherwise publish it.
  assert.equal(installedApk.status, "unavailable");
  assert.match(installedApk.reason, /pull/i);
  assert.ok(
    !installedApk.reason.includes(fixture.root),
    `the failed pull reason must not disclose the host root: ${installedApk.reason}`,
  );
  assert.match(installedApk.reason, /installed-base\.apk/, "the reason must still name the destination artifact");
  assert.match(installedApk.reason, /base\.apk/, "the reason must still name the device-side artifact it failed on");

  for (const entry of tombstones.entries) {
    assert.equal(entry.pulled, false);
    assert.ok(!entry.reason.includes(fixture.root), `${entry.name} pull reason must not disclose the host root`);
    assert.ok(entry.reason.includes(entry.name), `${entry.name} pull reason must still name the artifact`);
  }

  // The whole serialization is the published artifact, so prove the root is absent from all of it.
  assert.ok(!serialized.includes(fixture.root), "no failed-pull reason may disclose the absolute fixture root");
  assert.doesNotMatch(serialized, /"[^"]*\/(?:Users|home|tmp|var)\//, "the manifest must carry no absolute host paths");
});

test("collector emits no matchesHostApk verdict unless the pull is proven byte-exact", (context) => {
  // The retained bytes differ from the host APK only because the transfer was corrupted, so an
  // ungated comparison would publish `matchesHostApk: false` and libel the install.
  const corrupt = harness({ corruptApkPull: true });
  context.after(() => rmSync(corrupt.root, { recursive: true, force: true }));
  assert.equal(collect(corrupt).status, 0);
  const corrupted = manifestOf(corrupt).sections.installedApk;

  assert.equal(corrupted.pullIsByteExact, false);
  assert.equal(corrupted.matchesHostApk, null, "a non-byte-exact pull must claim no host-APK verdict");
  assert.match(corrupted.matchesHostApkReason, /not byte-exact/i);

  // The device digest is unusable here while the pulled bytes are in fact identical to the host
  // APK — an ungated comparison would publish an unearned `true`.
  const unproven = harness({ malformedDeviceDigest: true });
  context.after(() => rmSync(unproven.root, { recursive: true, force: true }));
  assert.equal(collect(unproven).status, 0);
  const { installedApk, hostApk } = manifestOf(unproven).sections;

  assert.equal(installedApk.pullIsByteExact, null);
  assert.equal(installedApk.sha256, hostApk.sha256, "the retained bytes really are identical to the host APK here");
  assert.equal(installedApk.matchesHostApk, null, "an unproven pull must not be upgraded to a true match");
  assert.match(installedApk.matchesHostApkReason, /never proven byte-exact/i);
});

test("collector emits matchesHostApk only as an explicit boolean or null, never a bare absence", (context) => {
  for (const options of [{}, { corruptApkPull: true }, { malformedDeviceDigest: true }, { splitInstall: true }]) {
    const fixture = harness(options);
    context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    assert.equal(collect(fixture).status, 0);
    const installed = manifestOf(fixture).sections.installedApk;

    assert.equal(installed.status, "collected");
    assert.ok(
      installed.matchesHostApk === true || installed.matchesHostApk === false || installed.matchesHostApk === null,
      `matchesHostApk must be an explicit verdict for ${JSON.stringify(options)}`,
    );
    if (installed.matchesHostApk === null) {
      assert.ok(
        typeof installed.matchesHostApkReason === "string" && installed.matchesHostApkReason.length > 0,
        `a null verdict must carry a reason for ${JSON.stringify(options)}`,
      );
    } else {
      assert.equal(installed.pullIsByteExact, true, "only a byte-exact pull may carry a boolean verdict");
    }
  }
});

test("collector writes a collecting manifest skeleton before retention I/O and completes it after", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const manifest = manifestOf(fixture);
  assert.equal(manifest.status, "complete", "a finished run must end at status complete");
  for (const [name, section] of Object.entries<any>(manifest.sections)) {
    assert.notEqual(section.status, "pending", `${name} must not remain pending after a complete run`);
  }

  // Re-run against an adb that blocks forever, then kill it mid-retention the way the CI
  // `timeout 300s` does, and prove the surviving manifest never claims a section it did not collect.
  const stalled = harness();
  context.after(() => rmSync(stalled.root, { recursive: true, force: true }));
  writeFileSync(stalled.adb, "#!/usr/bin/env bash\nsleep 600\n");
  chmodSync(stalled.adb, 0o755);

  const child = spawn(process.execPath, [
    COLLECTOR,
    "--serial", SERIAL,
    "--package", PACKAGE,
    "--expected-sha", EXPECTED_SHA,
    "--output-dir", stalled.outputDir,
    "--host-apk", stalled.hostApk,
    "--gradle-cache", stalled.gradleCache,
    "--adb", stalled.adb,
  ], { cwd: stalled.root });

  const manifestPath = join(stalled.outputDir, "manifest.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(readFileSync(manifestPath, "utf8")).status === "collecting") break;
    } catch {
      // The manifest is not written or not yet complete JSON; keep waiting.
    }
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 50)"]);
  }
  child.kill("SIGKILL");

  const partial = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(partial.status, "collecting", "a killed run must leave a manifest that still says it was collecting");
  assert.notEqual(partial.status, "complete", "a partial run must never wear a complete status");

  const pendingNames = Object.entries<any>(partial.sections)
    .filter(([, section]) => section.status === "pending")
    .map(([name]) => name);
  assert.ok(pendingNames.length > 0, "a killed run must leave uncollected sections explicitly pending");
  for (const [name, section] of Object.entries<any>(partial.sections)) {
    assert.notEqual(section.status, "verified", `${name} must never be verified in a partial run`);
    assert.ok(
      ["pending", "collected", "unavailable"].includes(section.status),
      `${name} carried an unexpected partial status ${section.status}`,
    );
  }
  assert.equal(
    partial.sections.unstrippedReactNative.status,
    "pending",
    "symbol provenance runs last, so a mid-retention kill must leave it explicitly uncollected",
  );
});

test("collector refuses symbol provenance for a split install instead of probing base.apk alone", (context) => {
  const fixture = harness({ splitInstall: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { installedApk, unstrippedReactNative } = manifestOf(fixture).sections;

  // base.apk here carries a libreactnative whose Build ID matches the cached AAR exactly, so only an
  // explicit split refusal can stop the collector from certifying symbols it cannot account for.
  assert.equal(installedApk.splitInstall, true);
  assert.equal(installedApk.pullIsByteExact, true, "the base.apk pull itself is sound; only the split is disqualifying");

  assertNoRetainedSymbols(fixture, unstrippedReactNative);
  assert.equal(unstrippedReactNative.packagedBuildId, null, "a split install must establish no packaged Build ID");
  assert.equal(unstrippedReactNative.buildIdMatchesPackaged, null, "no match may be claimed for a split install");
  assert.match(unstrippedReactNative.packagedBuildIdReason, /unsupported for split installs/i);
  assert.match(unstrippedReactNative.packagedBuildIdReason, /split_config\.x86_64\.apk/, "the reason must name the split it saw");
  assert.match(unstrippedReactNative.packagedBuildIdReason, /spans 2 APKs/);
});

test("collector sets packagedBuildIdSource to null whenever no packaged Build ID was read", (context) => {
  // Each of these is a distinct route to a null Build ID; none may name a source it never read from.
  const cases = [
    { label: "split install", options: { splitInstall: true } },
    { label: "corrupt pull", options: { corruptApkPull: true } },
    { label: "unverifiable digest", options: { malformedDeviceDigest: true } },
    { label: "absent library", options: { omitInstalledReactNative: true } },
    { label: "unretained installed APK", options: { omitBaseApkPath: true } },
  ] as const;

  for (const { label, options } of cases) {
    const fixture = harness(options);
    context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    assert.equal(collect(fixture).status, 0);
    const recovered = manifestOf(fixture).sections.unstrippedReactNative;

    assert.equal(recovered.packagedBuildId, null, `${label} must record a null Build ID`);
    assert.equal(recovered.packagedBuildIdSource, null, `${label} must not name a source for a Build ID it never read`);
    assert.ok(
      typeof recovered.packagedBuildIdReason === "string" && recovered.packagedBuildIdReason.length > 0,
      `${label} must carry a precise reason`,
    );
    assertNoRetainedSymbols(fixture, recovered);
  }
});

test("collector names the retained installed APK as the source only when a Build ID was truly read", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const { installedApk, unstrippedReactNative } = manifestOf(fixture).sections;

  assert.equal(unstrippedReactNative.packagedBuildId, BUILD_ID);
  assert.equal(
    unstrippedReactNative.packagedBuildIdSource,
    installedApk.localPath,
    "a Build ID that was read must name the artifact it came from",
  );
});

test("collector bounds-checks ELF note descriptors instead of reading past the image", (context) => {
  // A descriptor length larger than the note section would, unchecked, hand `toString("hex", ...)`
  // an end offset past the buffer and manufacture a Build ID out of unrelated bytes.
  const overrun = harness({ aarNoteCorruption: "descriptor-overrun" });
  context.after(() => rmSync(overrun.root, { recursive: true, force: true }));
  assert.equal(collect(overrun).status, 0, "a malformed ELF must never throw out of the cleanup path");
  const overrunRecovered = manifestOf(overrun).sections.unstrippedReactNative;
  assertNoRetainedSymbols(overrun, overrunRecovered);
  assert.match(overrunRecovered.reason, /no usable build id|past the end/i);

  // A zero-length descriptor would otherwise yield an empty-string Build ID that compares unequal
  // to everything and reports as a mismatch rather than as the malformed note it is.
  const empty = harness({ aarNoteCorruption: "empty-descriptor" });
  context.after(() => rmSync(empty.root, { recursive: true, force: true }));
  assert.equal(collect(empty).status, 0);
  const emptyRecovered = manifestOf(empty).sections.unstrippedReactNative;
  assertNoRetainedSymbols(empty, emptyRecovered);
  assert.notEqual(emptyRecovered.buildId, "", "an empty descriptor must never become an empty-string Build ID");
  assert.match(emptyRecovered.reason, /no usable build id/i);

  // A section header entry size smaller than ELF64's fixed 64 bytes makes every subsequent header
  // offset meaningless; walking it would read section fields out of arbitrary bytes.
  const undersized = harness({ aarNoteCorruption: "undersized-section-entry" });
  context.after(() => rmSync(undersized.root, { recursive: true, force: true }));
  assert.equal(collect(undersized).status, 0);
  const undersizedRecovered = manifestOf(undersized).sections.unstrippedReactNative;
  assertNoRetainedSymbols(undersized, undersizedRecovered);
  assert.match(undersizedRecovered.reason, /no usable build id/i);
});

test("collector reports a malformed installed-APK ELF note as unavailable provenance", (context) => {
  const fixture = harness({ installedNoteCorruption: "descriptor-overrun" });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const recovered = manifestOf(fixture).sections.unstrippedReactNative;

  assertNoRetainedSymbols(fixture, recovered);
  assert.equal(recovered.packagedBuildId, null, "a malformed faulting image establishes no provenance");
  assert.equal(recovered.packagedBuildIdSource, null);
  assert.equal(recovered.buildIdMatchesPackaged, null);
  assert.match(recovered.packagedBuildIdReason, /libreactnative\.so/);
});

test("collector fails safely and publishes no relative cache guess when HOME is unavailable", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  // Without --gradle-cache the collector falls back to HOME. An unset HOME must become an explicit
  // reason, not a bare relative path that silently resolves against the repo and "finds" nothing.
  const environment = { ...process.env };
  delete environment.HOME;
  const result = spawnSync(process.execPath, [
    COLLECTOR,
    "--serial", SERIAL,
    "--package", PACKAGE,
    "--expected-sha", EXPECTED_SHA,
    "--output-dir", fixture.outputDir,
    "--host-apk", fixture.hostApk,
    "--adb", fixture.adb,
  ], { cwd: fixture.root, encoding: "utf8", env: environment });

  assert.equal(result.status, 0, `an unavailable HOME must never throw out of cleanup: ${result.stderr}`);
  assert.equal(result.stdout, "");

  const manifest = manifestOf(fixture);
  assert.equal(manifest.status, "complete", "the rest of the retention must still complete and be published");
  const recovered = manifest.sections.unstrippedReactNative;
  assertNoRetainedSymbols(fixture, recovered);
  assert.match(recovered.reason, /neither --gradle-cache nor HOME was set/i);
  assert.match(
    recovered.reason,
    new RegExp(`react-android-${REACT_NATIVE_VERSION.replace(/\./g, "\\.")}-debug\\.aar`),
    "the reason must still name the artifact it wanted",
  );

  // The tombstones and APKs do not depend on HOME, so their evidence must survive intact.
  assert.equal(manifest.sections.tombstones.status, "collected");
  assert.equal(manifest.sections.installedApk.status, "collected");
});

test("collector marks tombstones as raw synthetic dumps and claims no content redaction", (context) => {
  const fixture = harness();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const manifest = manifestOf(fixture);
  const { tombstones } = manifest.sections;

  assert.equal(tombstones.redacted, false, "the collector must not claim a redaction it does not perform");
  assert.match(tombstones.contentDisclosure, /raw native-crash/i);
  assert.match(tombstones.contentDisclosure, /NOT redacted/);
  assert.match(tombstones.contentDisclosure, /synthetic E2E/i);
  assert.match(tombstones.contentDisclosure, /no WHO/i, "the disclosure must state the no-WHO-content expectation");
  assert.doesNotMatch(
    tombstones.contentDisclosure,
    /\b(?:sanitiz|scrubb|redacted for|content is redacted)/i,
    "the disclosure must never read as a redaction claim",
  );

  // The retained bytes must stay byte-for-byte identical to the device's own dump.
  for (const entry of tombstones.entries) {
    assert.equal(entry.pulled, true);
    assert.equal(sha256(join(fixture.root, entry.localPath)), entry.deviceSha256, `${entry.name} must be retained verbatim`);
  }

  assert.match(manifest.publicArtifactRisk, /uploaded as a CI artifact/i, "the residual public-artifact risk must be stated");
  assert.match(manifest.publicArtifactRisk, /Nothing here is redacted for content/i);
  assert.match(manifest.publicArtifactRisk, /real user data/i);
});

test("collector resolves the AAR version from the declared react-native dependency, not a duplicated constant", (context) => {
  // A repo declaring a different react-native version must drive both the AAR lookup and the
  // published provenance. A collector carrying its own constant would look for the wrong artifact.
  const fixture = harness({ reactNativeVersion: "0.87.3" });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(collect(fixture).status, 0);
  const manifest = manifestOf(fixture);
  const recovered = manifest.sections.unstrippedReactNative;

  assert.equal(manifest.reactNativeVersion, "0.87.3", "the manifest must publish the version the repo declares");
  assert.equal(recovered.status, "collected", "the AAR for the declared version must be the one that is found");
  assert.equal(recovered.aarPath, "react-android-0.87.3-debug.aar");
  assert.equal(recovered.buildId, BUILD_ID);
  assert.equal(recovered.buildIdMatchesPackaged, true);
});

test("collector declares no duplicated react-native version constant of its own", () => {
  const source = readFileSync(COLLECTOR, "utf8");

  assert.doesNotMatch(
    source,
    /const\s+REACT_NATIVE_VERSION\s*=\s*["'][^"']+["']/,
    "the collector must not restate the react-native version it can read from the declared dependency",
  );
  assert.doesNotMatch(
    source,
    /\b0\.8[0-9]+\.[0-9]+\b/,
    "no hardcoded react-native version may survive in the collector",
  );
  assert.match(source, /"react-native"/, "the collector must resolve the version from the declared dependency");
});

test("collector reports an undeclared react-native dependency as unavailable provenance", (context) => {
  const missing = harness({ omitReactNativeDependency: true });
  context.after(() => rmSync(missing.root, { recursive: true, force: true }));

  assert.equal(collect(missing).status, 0, "an undeclared dependency must never throw out of cleanup");
  const missingManifest = manifestOf(missing);
  assert.equal(missingManifest.reactNativeVersion, null, "an unresolvable version must be an explicit null");
  assert.match(missingManifest.reactNativeVersionReason, /react-native/i);
  assertNoRetainedSymbols(missing, missingManifest.sections.unstrippedReactNative);
  assert.match(missingManifest.sections.unstrippedReactNative.reason, /react-native/i);

  // The rest of the retention does not depend on the version, so its evidence must survive intact.
  assert.equal(missingManifest.status, "complete");
  assert.equal(missingManifest.sections.tombstones.status, "collected");
  assert.equal(missingManifest.sections.installedApk.status, "collected");

  // An absent package.json is the same failure with a different cause, and must degrade identically.
  const absent = harness({ omitPackageJson: true });
  context.after(() => rmSync(absent.root, { recursive: true, force: true }));
  assert.equal(collect(absent).status, 0, "an unreadable package.json must never throw out of cleanup");
  const absentManifest = manifestOf(absent);
  assert.equal(absentManifest.reactNativeVersion, null);
  assert.ok(
    typeof absentManifest.reactNativeVersionReason === "string" && absentManifest.reactNativeVersionReason.length > 0,
    "an unreadable package.json must carry a precise reason",
  );
  assertNoRetainedSymbols(absent, absentManifest.sections.unstrippedReactNative);
});

test("collector rejects a malformed declared react-native version instead of searching for it", (context) => {
  // A range or tag is not an exact cached-artifact coordinate; resolving one would search a
  // directory that cannot exist and report an untrue "no cached AAR" reason.
  for (const declared of ["^0.86.0", "0.86", "latest", ""]) {
    const fixture = harness({ declaredReactNativeVersion: declared });
    context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

    assert.equal(collect(fixture).status, 0, `declared version ${JSON.stringify(declared)} must never throw`);
    const manifest = manifestOf(fixture);
    assert.equal(manifest.reactNativeVersion, null, `${JSON.stringify(declared)} is not an exact version`);
    assert.ok(
      typeof manifest.reactNativeVersionReason === "string" && manifest.reactNativeVersionReason.length > 0,
      `${JSON.stringify(declared)} must carry a precise reason`,
    );
    assertNoRetainedSymbols(fixture, manifest.sections.unstrippedReactNative);
  }
});

test("collector refuses a non-emulator serial before creating output or invoking adb", (context) => {
  // A serial that is not an emulator port is the one input that could point this collector at a
  // real device holding real user data, so it must be refused before any retention I/O begins.
  const rejected = [
    "1234567890abcdef",
    "192.168.1.5:5555",
    "emulator-",
    "emulator-abcd",
    "emulator-5554x",
    " emulator-5554",
    "emulator-5554 ",
    "emulator-5554\n",
    "Emulator-5554",
    "",
  ];

  for (const serial of rejected) {
    const fixture = harness();
    context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

    const result = collect(fixture, ["--serial", serial]);

    assert.equal(result.status, 0, `serial ${JSON.stringify(serial)} must stay diagnostics-only and exit zero`);
    assert.equal(result.stdout, "", "the collector must keep the failure-cleanup stdout stream clean");
    assert.deepEqual(
      adbInvocations(fixture),
      [],
      `serial ${JSON.stringify(serial)} must be refused before any adb invocation`,
    );
    assert.throws(
      () => statSync(fixture.outputDir),
      `serial ${JSON.stringify(serial)} must be refused before the output directory is created`,
    );
    assert.match(result.stderr, /serial/i, "the refusal must name the offending input on stderr");
    assert.ok(!result.stderr.includes(fixture.root), "the refusal must not disclose the absolute host root");
  }
});

test("collector accepts a well-formed emulator serial and still retains full evidence", (context) => {
  for (const serial of ["emulator-5554", "emulator-5556", "emulator-65534"]) {
    const fixture = harness();
    context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

    // The fake adb asserts the serial it is handed, so accepting a serial it does not expect would
    // surface as a failed collection rather than a silent pass.
    const result = collect(fixture, ["--serial", serial]);
    assert.equal(result.status, 0, `serial ${serial} must be accepted`);

    const manifest = manifestOf(fixture);
    assert.equal(manifest.serial, serial, "an accepted serial must be published as evidence");
    assert.equal(manifest.status, "complete");
    assert.ok(adbInvocations(fixture).length > 0, `serial ${serial} must reach adb collection`);
  }
});

test("collectFabricDiagnostics itself refuses a non-emulator serial, not only the CLI wrapper", async (context) => {
  // The CLI is not the only caller: `collectFabricDiagnostics` is exported, so a guard living in
  // `main` would leave every direct importer free to point this collector at a real device. The
  // refusal has to belong to the exported boundary, before mkdir and before any adb invocation.
  const { collectFabricDiagnostics } = await import(COLLECTOR);

  for (const serial of ["1234567890abcdef", "192.168.1.5:5555", "emulator-abcd", "", undefined]) {
    const fixture = harness();
    context.after(() => rmSync(fixture.root, { recursive: true, force: true }));

    await assert.rejects(
      async () => collectFabricDiagnostics({
        root: fixture.root,
        serial,
        packageName: PACKAGE,
        expectedSha: EXPECTED_SHA,
        outputDir: fixture.outputDir,
        hostApk: fixture.hostApk,
        gradleCache: fixture.gradleCache,
        adbPath: fixture.adb,
      }),
      /serial/i,
      `a direct call with serial ${JSON.stringify(serial ?? null)} must be refused by the collector itself`,
    );

    assert.deepEqual(
      adbInvocations(fixture),
      [],
      `a direct call with serial ${JSON.stringify(serial ?? null)} must invoke no adb`,
    );
    assert.throws(
      () => statSync(fixture.outputDir),
      `a direct call with serial ${JSON.stringify(serial ?? null)} must create no output directory`,
    );
  }

  // The same direct call succeeds for an emulator serial, so the refusal is the serial's doing and
  // not a direct-call path that never worked.
  const accepted = harness();
  context.after(() => rmSync(accepted.root, { recursive: true, force: true }));
  const manifest = await collectFabricDiagnostics({
    root: accepted.root,
    serial: SERIAL,
    packageName: PACKAGE,
    expectedSha: EXPECTED_SHA,
    outputDir: accepted.outputDir,
    hostApk: accepted.hostApk,
    gradleCache: accepted.gradleCache,
    adbPath: accepted.adb,
  });
  assert.equal(manifest.status, "complete", "a direct call with an emulator serial must still collect");
  assert.equal(manifest.serial, SERIAL);
  assert.ok(adbInvocations(accepted).length > 0, "an accepted direct call must reach adb collection");
});
