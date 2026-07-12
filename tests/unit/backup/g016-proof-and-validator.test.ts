import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  G016_ALL_FAILURE_CODES,
  G016_CRYPTO_PROOF_MAX_BYTES,
  compactProofByteLength,
  compactProofRecord,
  serializeCompactProof,
} from "../../../spikes/backup-crypto/compactProof.ts";
import {
  G016_SOURCE_PATHS,
  snapshotG016FileForTest,
  validateG016ResolutionForTest,
  validateG016FinalEvidence,
} from "../../../spikes/backup-crypto/deviceEvidenceValidator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const validatorPath = resolve(repoRoot, "spikes/backup-crypto/deviceEvidenceValidator.mjs");
const appId = "com.fawnmobile.g016backupcrypto";

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactInput(overrides: Record<string, unknown> = {}) {
  return {
    failures: [],
    platform: "android" as const,
    release: true,
    hermes: true,
    newArchitecture: true,
    integrity: { sourceSha256: "a".repeat(64), resolutionSha256: "b".repeat(64) },
    backend: {
      adapter: "BackupCryptoPort/nativeCryptoPort@1",
      native: "react-native-quick-crypto@1.1.6/OpenSSL",
      rootImports: true,
      installCalled: false,
      rng: "expo-crypto@57.0.0",
      cryptoGlobal: true,
      bufferGlobal: true,
      nextTick: true,
      transition: "I" as const,
    },
    vector: {
      bytes: 790,
      sha256: "231f64bf4045b430ca0de6c18b215f9a4414293683021528c411ae85d0010231",
    },
    selfTest: {
      ok: true,
      count: 8,
      rfc: true,
      node: true,
      aes: true,
      sliced: true,
      rejections: true,
      tamper: true,
      queue: true,
      framing: true,
    },
    runs: { warmup: 1, scrypt: 10, aes: 10 },
    scrypt: { p95: 61.67, max: 61.67 },
    aes: {
      encP95: 51.05,
      decP95: 50.81,
      plaintextBytes: 4 * 1024 * 1024,
      framedBytes: (4 * 1024 * 1024) + 16,
      tagBytes: 16,
    },
    heartbeat: { max: 182.6, limit: 250 },
    ...overrides,
  };
}

function writeEvidenceFile(root: string, path: string, content: string | Uint8Array): string {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return digest(readFileSync(fullPath));
}

function sourceManifest(): string {
  return G016_SOURCE_PATHS.map((path) => `${digest(readFileSync(resolve(repoRoot, path)))}  ${path}\n`).join("");
}

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
}

function androidTool(name: string): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
  const versions = readdirSync(join(sdk, "build-tools")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  assert.ok(versions.length > 0);
  return join(sdk, "build-tools", versions[0], name);
}

function androidJar(): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
  const versions = readdirSync(join(sdk, "platforms")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  assert.ok(versions.length > 0);
  return join(sdk, "platforms", versions[0], "android.jar");
}

let compiledAndroidFixtures: Record<string, Buffer> | undefined;
let nameOnlyAndroidQuickCryptoFixture: Buffer | undefined;
let undefinedAndroidQuickCryptoFixture: Buffer | undefined;
let unclosedAndroidFixture: Buffer | undefined;

function androidNativeFixtures() {
  if (compiledAndroidFixtures) return compiledAndroidFixtures;
  const directory = mkdtempSync(join(tmpdir(), "g016-native-fixtures-"));
  try {
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
    const ndk = readdirSync(join(sdk, "ndk")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    assert.ok(ndk, "Android NDK is required for the arm64 ELF fixture");
    const clang = join(sdk, "ndk", ndk, "toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android35-clang");
    const compile = (name: string, source: string, libraries: string[] = [], options: { cpp?: boolean; soname?: string } = {}) => {
      const sourcePath = join(directory, `${name}.${options.cpp ? "cpp" : "c"}`);
      const outputPath = join(directory, name);
      writeFileSync(sourcePath, source);
      const compiler = options.cpp ? `${clang}++` : clang;
      run(compiler, [...(options.cpp ? ["-std=c++17", "-nostdlib++"] : []), "-shared", "-fPIC", `-Wl,-soname,${options.soname ?? name}`, sourcePath, "-L", directory, "-Wl,--no-as-needed", ...libraries.map((library) => `-l${library}`), "-o", outputPath]);
      return readFileSync(outputPath);
    };
    const fixtures: Record<string, Buffer> = {};
    fixtures["libNitroModules.so"] = compile("libNitroModules.so", "int NitroModules_install(void) { return 1; }\n");
    fixtures["libcrypto.so"] = compile("libcrypto.so", "const char* OpenSSL_version(int value) { (void)value; return \"OpenSSL 3.6.2\"; }\n");
    fixtures["libssl.so"] = compile("libssl.so", "extern const char* OpenSSL_version(int); void* SSL_new(void) { return (void*)OpenSSL_version(0); }\n", ["crypto"]);
    fixtures["libhermesvm.so"] = compile("libhermesvm.so", "void* makeHermesRuntime(void) { return 0; } int _sh_init(void) { return 1; }\n");
    nameOnlyAndroidQuickCryptoFixture = compile("libQuickCrypto-name-only.so", "extern int NitroModules_install(void); extern const char* OpenSSL_version(int); extern void* SSL_new(void); int QuickCrypto_native(void) { return NitroModules_install() + (OpenSSL_version(0) != 0) + (SSL_new() != 0); }\n", ["NitroModules", "crypto", "ssl"], { soname: "libQuickCrypto.so" });
    undefinedAndroidQuickCryptoFixture = compile("libQuickCrypto-undefined.so", [
      'extern "C" int NitroModules_install(void);', 'extern "C" const char* OpenSSL_version(int);', 'extern "C" void* SSL_new(void);',
      "namespace margelo::nitro::crypto {",
      "class HybridScrypt { public: int deriveKey(int); };",
      "class HybridCipher { public: bool setAAD(int); };",
      "}",
      'extern "C" int QuickCrypto_native(void) { margelo::nitro::crypto::HybridScrypt scrypt; margelo::nitro::crypto::HybridCipher cipher; return scrypt.deriveKey(1) + cipher.setAAD(1) + NitroModules_install() + (OpenSSL_version(0) != nullptr) + (SSL_new() != nullptr); }',
      "",
    ].join("\n"), ["NitroModules", "crypto", "ssl"], { cpp: true, soname: "libQuickCrypto.so" });
    const undefinedSymbols = spawnSync(join(sdk, "ndk", ndk, "toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-nm"), ["-D", "-C", join(directory, "libQuickCrypto-undefined.so")], { encoding: "utf8" });
    assert.equal(undefinedSymbols.status, 0, undefinedSymbols.stderr);
    assert.match(undefinedSymbols.stdout, /^\s*U margelo::nitro::crypto::HybridScrypt::deriveKey\(/m);
    assert.match(undefinedSymbols.stdout, /^\s*U margelo::nitro::crypto::HybridCipher::setAAD\(/m);
    fixtures["libQuickCrypto.so"] = compile("libQuickCrypto.so", [
      'extern "C" int NitroModules_install(void);', 'extern "C" const char* OpenSSL_version(int);', 'extern "C" void* SSL_new(void);',
      "namespace margelo::nitro::crypto {",
      "class HybridScrypt { public: __attribute__((visibility(\"default\"))) int deriveKey(int); };",
      "int HybridScrypt::deriveKey(int value) { return value + NitroModules_install() + (OpenSSL_version(0) != nullptr); }",
      "class HybridCipher { public: __attribute__((visibility(\"default\"))) bool setAAD(int); };",
      "bool HybridCipher::setAAD(int value) { return value != 0 && SSL_new() != nullptr; }",
      "}",
      "",
    ].join("\n"), ["NitroModules", "crypto", "ssl"], { cpp: true });
    fixtures["libappmodules.so"] = compile("libappmodules.so", "int QuickBase64Impl(void) { return 1; } int QuickCrypto_ModuleProvider(void) { return 1; } int NitroModulesSpec_ModuleProvider(void) { return 1; }\n");
    compiledAndroidFixtures = fixtures;
    return fixtures;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function androidNameOnlyQuickCrypto(): Buffer {
  androidNativeFixtures();
  assert.ok(nameOnlyAndroidQuickCryptoFixture);
  return nameOnlyAndroidQuickCryptoFixture;
}

function androidUndefinedQuickCrypto(): Buffer {
  androidNativeFixtures();
  assert.ok(undefinedAndroidQuickCryptoFixture);
  return undefinedAndroidQuickCryptoFixture;
}

function androidUnclosedFixture(): Buffer {
  if (unclosedAndroidFixture) return unclosedAndroidFixture;
  const directory = mkdtempSync(join(tmpdir(), "g016-unclosed-elf-"));
  try {
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
    const ndk = readdirSync(join(sdk, "ndk")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    const clang = join(sdk, "ndk", ndk, "toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android35-clang");
    writeFileSync(join(directory, "missing.c"), "int g016_missing(void) { return 1; }\n");
    run(clang, ["-shared", "-fPIC", "-Wl,-soname,libg016-missing.so", join(directory, "missing.c"), "-o", join(directory, "libg016-missing.so")]);
    writeFileSync(join(directory, "extra.c"), "extern int g016_missing(void); int g016_extra(void) { return g016_missing(); }\n");
    run(clang, ["-shared", "-fPIC", "-Wl,-soname,libg016-extra.so", join(directory, "extra.c"), "-L", directory, "-Wl,--no-as-needed", "-lg016-missing", "-o", join(directory, "libg016-extra.so")]);
    unclosedAndroidFixture = readFileSync(join(directory, "libg016-extra.so"));
    return unclosedAndroidFixture;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function handcraftedAndroidResolution(): string {
  const tree = Array.from({ length: 180 }, (_, index) => `|    +--- com.example:transitive-${index}:1.0.0`).join("\n");
  const insights = ["react-native-quick-crypto", "react-native-nitro-modules", "react-native-quick-base64"].flatMap((name) => [
    `===== dependencyInsight ${name} =====`, "> Task :app:dependencyInsight", `project :${name}`, "  Variant releaseRuntimeElements:", "  Selection reasons:", "    - By constraint", `project :${name}`, "\\--- releaseRuntimeClasspath", "BUILD SUCCESSFUL in 1s",
  ]);
  return [
    "> Task :app:dependencies", "", "------------------------------------------------------------", "Project ':app'", "------------------------------------------------------------", "",
    "releaseRuntimeClasspath - Runtime classpath of /release.", "+--- project :react-native-quick-crypto", "|    +--- project :react-native-nitro-modules",
    "|    \\--- io.github.ronickg:openssl:3.6.2-1", "+--- project :react-native-nitro-modules", "+--- project :react-native-quick-base64", tree,
    "BUILD SUCCESSFUL in 2s", ...insights,
    "===== dependencyInsight io.github.ronickg:openssl =====", "> Task :app:dependencyInsight", "io.github.ronickg:openssl:3.6.2-1", "  Variant exportedAars:",
    "io.github.ronickg:openssl:3.6.2-1", "\\--- project :react-native-quick-crypto", "     \\--- releaseRuntimeClasspath", "BUILD SUCCESSFUL in 1s",
  ].join("\n");
}

function androidResolution(): string {
  const authentic = "/private/tmp/g016-gradle-release-runtime.txt";
  if (existsSync(authentic)) return readFileSync(authentic, "utf8");
  const dependencyNoise = Array.from({ length: 1400 }, (_, index) => `|    +--- com.example:retained-${index}:1.0.0`).join("\n");
  const section = (name: string, body: string) => `===== ${name} =====\n${body}\n${dependencyNoise}\nBUILD SUCCESSFUL in 1s\n`;
  return [
    section("dependencies releaseRuntimeClasspath", [
      "> Task :app:dependencies", "releaseRuntimeClasspath - Runtime classpath of '/release'.",
      "+--- project :react-native-nitro-modules", "+--- project :react-native-quick-crypto",
      "|    +--- project :react-native-nitro-modules (*)", "|    \\--- io.github.ronickg:openssl:3.6.2-1",
    ].join("\n")),
    section("dependencyInsight react-native-quick-crypto", "> Task :app:dependencyInsight\nproject :react-native-quick-crypto\n  Variant releaseRuntimeElements:\nproject :react-native-quick-crypto\n\\--- releaseRuntimeClasspath"),
    section("dependencyInsight react-native-nitro-modules", "> Task :app:dependencyInsight\nproject :react-native-nitro-modules\n  Variant releaseRuntimeElements:\nproject :react-native-nitro-modules\n+--- releaseRuntimeClasspath\n\\--- project :react-native-quick-crypto\n     \\--- releaseRuntimeClasspath"),
    section("dependencyInsight react-native-quick-base64", "> Task :app:dependencyInsight\nNo dependencies matching given input were found in configuration ':app:releaseRuntimeClasspath'"),
    section("dependencyInsight io.github.ronickg:openssl", "> Task :app:dependencyInsight\nio.github.ronickg:openssl:3.6.2-1\n  Variant exportedAars:\nio.github.ronickg:openssl:3.6.2-1\n\\--- project :react-native-quick-crypto\n     \\--- releaseRuntimeClasspath"),
  ].join("\n");
}

function handcraftedIosResolution(): string {
  return [
    "PODS:", "  - DoubleConversion (1.1.7)", "  - fmt (11.0.2)", "  - glog (0.3.5)",
    "  - NitroModules (0.36.1):", "    - React-Core", "  - OpenSSL-Universal (3.6.2000)",
    "  - QuickCrypto (1.1.6):", "    - NitroModules", "    - OpenSSL-Universal (~> 3.6.2000)",
    "  - react-native-quick-base64 (3.0.1):", "    - React-Core", "  - React-Core (0.86.0)", "",
    "DEPENDENCIES:", "  - NitroModules (from `../node_modules/react-native-nitro-modules`)", "  - QuickCrypto (from `../node_modules/react-native-quick-crypto`)", "  - react-native-quick-base64 (from `../node_modules/react-native-quick-base64`)", "",
    "SPEC REPOS:", "  trunk:", "    - OpenSSL-Universal", "", "EXTERNAL SOURCES:",
    "  NitroModules:", "    :path: ../../../node_modules/react-native-nitro-modules",
    "  QuickCrypto:", "    :path: ../../../node_modules/react-native-quick-crypto",
    "  react-native-quick-base64:", "    :path: ../../../node_modules/react-native-quick-base64", "",
    "SPEC CHECKSUMS:", "  DoubleConversion: 1111111111111111111111111111111111111111",
    "  fmt: 2222222222222222222222222222222222222222", "  glog: 3333333333333333333333333333333333333333",
    "  NitroModules: 5555555555555555555555555555555555555555", "  OpenSSL-Universal: 6666666666666666666666666666666666666666",
    "  QuickCrypto: 7777777777777777777777777777777777777777", "  react-native-quick-base64: 8888888888888888888888888888888888888888",
    "  React-Core: 9999999999999999999999999999999999999999", "", "PODFILE CHECKSUM: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "", "COCOAPODS: 1.16.2",
  ].join("\n");
}

function iosResolution(): string {
  const authentic = "/private/tmp/G016-POSTFIX/ios/Podfile.lock";
  if (existsSync(authentic)) return readFileSync(authentic, "utf8");
  const generated = Array.from({ length: 1800 }, (_, index) => `  - RetainedPod${index} (1.0.0)`).join("\n");
  const checksums = Array.from({ length: 1800 }, (_, index) => `  RetainedPod${index}: ${digest(`RetainedPod${index}`).slice(0, 40)}`).join("\n");
  return [
    "PODS:", generated, "  - NitroModules (0.36.1):", "    - React-Core", "  - OpenSSL-Universal (3.6.2000)",
    "  - QuickCrypto (1.1.6):", "    - NitroModules", "    - OpenSSL-Universal (~> 3.6.2000)",
    "  - react-native-quick-base64 (3.0.1):", "    - React-Core", "  - React-Core (0.86.0)", "",
    "DEPENDENCIES:", "  - NitroModules (from `../node_modules/react-native-nitro-modules`)", "  - QuickCrypto (from `../node_modules/react-native-quick-crypto`)", "  - react-native-quick-base64 (from `../node_modules/react-native-quick-base64`)", "",
    "SPEC REPOS:", "  trunk:", "    - OpenSSL-Universal", "", "EXTERNAL SOURCES:",
    "  NitroModules:", "    :path: ../node_modules/react-native-nitro-modules", "  QuickCrypto:", "    :path: ../node_modules/react-native-quick-crypto",
    "  react-native-quick-base64:", "    :path: ../node_modules/react-native-quick-base64", "", "SPEC CHECKSUMS:", checksums,
    "  NitroModules: b4174dd303728e16ad1afb79f64c1a5c69a3b373", "  OpenSSL-Universal: ecee7b138fa75a74ecf00d7ffd248fb584739b9e",
    "  QuickCrypto: 45cde9545e593271dc32418ecbe91b7ec920702f", "  react-native-quick-base64: 5c829c9016276132ac03c4d598c8d256b964e6ac",
    "  React-Core: 9999999999999999999999999999999999999999", "", "PODFILE CHECKSUM: a79be2349ed5c10606852f1ed74be7bfda291977", "", "COCOAPODS: 1.16.2",
  ].join("\n");
}

let signingKey: string | undefined;

function androidSigningKey(): string {
  if (signingKey) return signingKey;
  const directory = mkdtempSync(join(tmpdir(), "g016-apk-signing-"));
  signingKey = join(directory, "g016.keystore");
  run("/usr/bin/keytool", ["-genkeypair", "-keystore", signingKey, "-storepass", "changeit", "-keypass", "changeit", "-alias", "g016", "-dname", "CN=G016", "-keyalg", "RSA", "-validity", "3650", "-noprompt"]);
  return signingKey;
}

function makeArtifact(root: string, platform: "android" | "ios", fingerprint: string, resolutionSha256: string) {
  if (platform === "android") {
    const work = join(root, "apk-work"), stage = join(work, "stage"), unsigned = join(work, "unsigned.apk"), artifact = join(root, "android/artifact/g016-release.apk");
    mkdirSync(stage, { recursive: true }); mkdirSync(dirname(artifact), { recursive: true });
    const xml = join(work, "AndroidManifest.xml");
    writeFileSync(xml, `<?xml version="1.0" encoding="utf-8"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${appId}" android:versionCode="1" android:versionName="1.0"><uses-sdk android:minSdkVersion="23" android:targetSdkVersion="35"/><application android:label="G016"/></manifest>`);
    run(androidTool("aapt"), ["package", "-f", "-I", androidJar(), "-M", xml, "-F", unsigned]);
    const fixtures = androidNativeFixtures();
    for (const [name, bytes] of Object.entries(fixtures)) writeEvidenceFile(stage, `lib/arm64-v8a/${name}`, bytes);
    writeEvidenceFile(stage, "assets/index.android.bundle", `source=${fingerprint};resolution=${resolutionSha256}`);
    run("/usr/bin/zip", ["-q", unsigned, ...Object.keys(fixtures).map((name) => `lib/arm64-v8a/${name}`), "assets/index.android.bundle"], stage);
    run(androidTool("zipalign"), ["-f", "4", unsigned, artifact]);
    run(androidTool("apksigner"), ["sign", "--ks", androidSigningKey(), "--ks-key-alias", "g016", "--ks-pass", "pass:changeit", "--key-pass", "pass:changeit", artifact]);
    const artifactBytes = readFileSync(artifact);
    const artifactSha256 = digest(artifactBytes);
    return {
      artifactPath: "artifact/g016-release.apk",
      artifactSha256,
      runtimeFiles: { baseApk: artifactBytes, bundle: undefined, executable: undefined },
      target: "emulator",
    };
  }
  const stage = join(root, "ios-work"), app = join(stage, "Payload/G016.app"), artifact = join(root, "ios/artifact/G016.zip");
  const frameworks = join(app, "Frameworks");
  mkdirSync(frameworks, { recursive: true }); mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${appId}</string><key>CFBundleExecutable</key><string>G016</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>`);
  const buildFramework = (name: string, symbol: string) => {
    const framework = join(frameworks, `${name}.framework`);
    mkdirSync(framework, { recursive: true });
    const source = join(stage, `${name}.c`);
    writeFileSync(source, `int ${symbol}(void) { return 1; }\n`);
    run("/usr/bin/xcrun", ["--sdk", "iphonesimulator", "clang", "-arch", "arm64", "-mios-simulator-version-min=16.4", "-dynamiclib", source, `-Wl,-install_name,@rpath/${name}.framework/${name}`, "-o", join(framework, name)]);
    run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", framework]);
  };
  buildFramework("OpenSSL", "OpenSSL_version");
  buildFramework("hermesvm", "makeHermesRuntime");
  const source = join(stage, "main.cpp");
  writeFileSync(source, [
    'extern "C" int OpenSSL_version(void);', 'extern "C" int makeHermesRuntime(void);',
    "namespace facebook::jsi { class Runtime {}; class Object {}; }",
    "namespace facebook::react { class QuickBase64Impl { public: int base64FromArrayBuffer(jsi::Runtime&, jsi::Object, bool); }; int QuickBase64Impl::base64FromArrayBuffer(jsi::Runtime&, jsi::Object, bool) { return 1; } }",
    "namespace margelo::nitro { void install(facebook::jsi::Runtime&) {} namespace crypto { class HybridScrypt { public: int deriveKey(int); }; int HybridScrypt::deriveKey(int value) { return value; } class HybridCipher { public: bool setAAD(int); }; bool HybridCipher::setAAD(int value) { return value != 0; } } }",
    'extern "C" int QuickCrypto_dummy(void) { return 1; } extern "C" int NitroModules_dummy(void) { return 1; } extern "C" int QuickBase64_dummy(void) { return 1; }',
    "int main() { facebook::jsi::Runtime runtime; facebook::jsi::Object object; facebook::react::QuickBase64Impl base64; margelo::nitro::crypto::HybridScrypt scrypt; margelo::nitro::crypto::HybridCipher cipher; margelo::nitro::install(runtime); return base64.base64FromArrayBuffer(runtime, object, true) + scrypt.deriveKey(1) + cipher.setAAD(1) + QuickCrypto_dummy() + NitroModules_dummy() + QuickBase64_dummy() + OpenSSL_version() + makeHermesRuntime(); }",
    "",
  ].join("\n"));
  run("/usr/bin/xcrun", ["--sdk", "iphonesimulator", "clang++", "-std=c++17", "-arch", "arm64", "-mios-simulator-version-min=16.4", source, "-F", frameworks, "-framework", "OpenSSL", "-framework", "hermesvm", "-Wl,-rpath,@executable_path/Frameworks", "-o", join(app, "G016")]);
  writeFileSync(join(app, "main.jsbundle"), `source=${fingerprint};resolution=${resolutionSha256}`);
  run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  run("/usr/bin/zip", ["-qry", artifact, "Payload"], stage);
  const artifactSha256 = digest(readFileSync(artifact));
  return {
    artifactPath: "artifact/G016.zip",
    artifactSha256,
    runtimeFiles: {
      baseApk: undefined,
      bundle: readFileSync(join(app, "main.jsbundle")),
      executable: readFileSync(join(app, "G016")),
    },
    target: "simulator",
  };
}

function nativeCommandBlock(input: {
  id: string;
  platform: "android" | "ios";
  kind: "liveness" | "memory";
  phase: "baseline" | "run" | "post-first-run" | "post-proof";
  pid: number;
  startedAt: string;
  endedAt: string;
  target: "emulator" | "simulator";
  command: string;
  body: string;
}): string {
  const { endedAt, body, ...begin } = input;
  return `G016_NATIVE_COMMAND_BEGIN ${JSON.stringify(begin)}\n${body}\nG016_NATIVE_COMMAND_END ${JSON.stringify({ id: input.id, endedAt, exitCode: 0 })}\n`;
}

function makePlatform(root: string, platform: "android" | "ios", fingerprint: string) {
  const platformRoot = join(root, platform);
  const resolutionPath = platform === "android" ? "resolution/gradle-release-runtime.txt" : "resolution/Podfile.lock";
  const resolutionSha256 = writeEvidenceFile(platformRoot, resolutionPath, platform === "android" ? androidResolution() : iosResolution());
  const artifact = makeArtifact(root, platform, fingerprint, resolutionSha256);
  const pid = platform === "android" ? 1601 : 1602;
  const proof = serializeCompactProof(compactInput({ platform, integrity: { sourceSha256: fingerprint, resolutionSha256 } }));
  const livenessBody = platform === "android"
    ? `  PID NAME ARGS\n ${pid} ${appId} ${appId}`
    : ` ${pid} Ss /Users/test/Containers/Bundle/Application/fixture/G016FMBKCryptoProof.app/G016FMBKCryptoProof`;
  const livenessCommand = platform === "android" ? "adb shell ps -A -o PID,NAME,ARGS" : "xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=";
  const processText = `${proof}\nG016_PROOF_OBSERVED_AT 2026-07-12T00:00:05.000Z\n${nativeCommandBlock({ id: `${platform}-liveness`, platform, kind: "liveness", phase: "post-proof", pid, startedAt: "2026-07-12T00:00:06.000Z", endedAt: "2026-07-12T00:00:06.100Z", target: artifact.target as "emulator" | "simulator", command: livenessCommand, body: livenessBody })}`;
  const rawProof = platform === "android"
    ? `07-12 00:00:05.000  ${pid}  1701 I ReactNativeJS: ${proof}`
    : `2026-07-12 00:00:05.000 I  G016FMBKCryptoProof[${pid}:3e8] [com.facebook.react.log:javascript] ${proof}`;
  const adverseText = `G016_ADVERSE_LOG ${JSON.stringify({ pid, startedAt: "2026-07-11T23:59:59.000Z", endedAt: "2026-07-12T00:00:07.000Z" })}\n${rawProof}\nruntime remained healthy\n`;
  const base = platform === "android" ? 100 : 50, kind = platform === "android" ? "android-pss-mib" : "ios-physical-footprint-mib";
  const samples = [[0, base, "baseline"], [1, base + 60, "run"], [2, base + 10, "post-first-run"], [3, base + 12, "post-first-run"], [4, base + 14, "post-first-run"]] as const;
  const memoryText = samples.map(([second, valueMiB, phase], index) => {
    const startedAt = `2026-07-12T00:00:0${second}.000Z`;
    const endedAt = `2026-07-12T00:00:0${second}.100Z`;
    const command = platform === "android" ? `adb shell dumpsys meminfo ${pid}` : `footprint -f bytes -p ${pid}`;
    const body = platform === "android"
      ? `Applications Memory Usage (in Kilobytes):\n** MEMINFO in pid ${pid} [${appId}] **\n           TOTAL PSS:    ${valueMiB * 1024}            TOTAL RSS:   100000       TOTAL SWAP PSS:    0`
      : `G016FMBKCryptoProof [${pid}]: 64-bit    Footprint: ${valueMiB * 1024 * 1024} B (16384 bytes per page)\nAuxiliary data:\n    phys_footprint: ${valueMiB * 1024 * 1024} B`;
    return nativeCommandBlock({ id: `${platform}-memory-${index}`, platform, kind: "memory", phase, pid, startedAt, endedAt, target: artifact.target as "emulator" | "simulator", command, body });
  }).join("");
  const runtimeIdentity = platform === "android"
    ? {
      artifactSha256: artifact.artifactSha256,
      installedBaseApkPath: "runtime/installed-base.apk",
      installedBaseApkSha256: writeEvidenceFile(platformRoot, "runtime/installed-base.apk", artifact.runtimeFiles.baseApk!),
    }
    : {
      artifactSha256: artifact.artifactSha256,
      installedBundlePath: "runtime/installed-main.jsbundle",
      installedBundleSha256: writeEvidenceFile(platformRoot, "runtime/installed-main.jsbundle", artifact.runtimeFiles.bundle!),
      installedExecutablePath: "runtime/installed-G016FMBKCryptoProof",
      installedExecutableSha256: writeEvidenceFile(platformRoot, "runtime/installed-G016FMBKCryptoProof", artifact.runtimeFiles.executable!),
    };
  return {
    platform,
    build: { configuration: "Release", applicationId: appId, buildIdentity: `g016-${platform}-${artifact.artifactSha256.slice(0, 16)}`, architecture: platform === "android" ? "arm64-v8a" : "arm64", artifactPath: artifact.artifactPath, artifactSha256: artifact.artifactSha256, sourceFingerprintSha256: fingerprint, target: artifact.target },
    runtimeIdentity,
    process: { logPath: "logs/process.txt", logSha256: writeEvidenceFile(platformRoot, "logs/process.txt", processText) },
    adverseEvents: { logPath: "logs/adverse.txt", logSha256: writeEvidenceFile(platformRoot, "logs/adverse.txt", adverseText) },
    nativeResolution: { resolutionPath, resolutionSha256 },
    memory: { kind, logPath: "logs/memory.txt", logSha256: writeEvidenceFile(platformRoot, "logs/memory.txt", memoryText) },
  };
}

function makeFinalEvidence(t: { after(callback: () => void): void }) {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "g016-final-evidence-"));
  t.after(() => rmSync(evidenceRoot, { recursive: true, force: true }));
  const manifest = sourceManifest();
  const sourceManifestPath = "integrity/source-fingerprint-manifest.txt";
  const sourceManifestSha256 = writeEvidenceFile(evidenceRoot, sourceManifestPath, manifest);
  const fingerprint = digest(manifest);
  return {
    evidenceRoot,
    evidence: {
      schemaVersion: 2,
      evidenceRoot,
      candidate: { rootPath: repoRoot, sourceManifestPath, sourceManifestSha256 },
      platforms: [makePlatform(evidenceRoot, "android", fingerprint), makePlatform(evidenceRoot, "ios", fingerprint)],
    } as any,
  };
}

function platformEvidence(evidence: any, platform: "android" | "ios") {
  return evidence.platforms.find((entry: any) => entry.platform === platform);
}

function rewriteLog(root: string, evidence: any, platform: "android" | "ios", kind: "process" | "adverseEvents" | "memory", mutate: (text: string) => string) {
  const entry = platformEvidence(evidence, platform)[kind];
  const path = join(root, platform, entry.logPath);
  const changed = mutate(readFileSync(path, "utf8"));
  writeFileSync(path, changed);
  entry.logSha256 = digest(changed);
}

function shiftPlatformTiming(
  root: string,
  evidence: any,
  platform: "android" | "ios",
  observedAt: string,
  rawTimestamp: string,
): void {
  const delta = Date.parse(observedAt) - Date.parse("2026-07-12T00:00:05.000Z");
  for (const kind of ["process", "adverseEvents", "memory"] as const) {
    rewriteLog(root, evidence, platform, kind, (text) => text.replace(
      /2026-07-(?:11T23:59:59|12T00:00:0[0-7])\.\d{3}Z/g,
      (timestamp) => new Date(Date.parse(timestamp) + delta).toISOString(),
    ).replace(
      platform === "android" ? "07-12 00:00:05.000" : "2026-07-12 00:00:05.000",
      rawTimestamp,
    ));
  }
}

function rewriteIosApp(root: string, evidence: any, mutate: (app: string) => void, resign: boolean): void {
  const ios = platformEvidence(evidence, "ios");
  const artifact = join(root, "ios", ios.build.artifactPath);
  const work = mkdtempSync(join(tmpdir(), "g016-ios-rewrite-"));
  run("/usr/bin/unzip", ["-qq", artifact, "-d", work]);
  const app = join(work, "Payload/G016.app");
  mutate(app);
  if (resign) run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  rmSync(artifact);
  run("/usr/bin/zip", ["-qry", artifact, "Payload"], work);
  rmSync(work, { recursive: true, force: true });
  ios.build.artifactSha256 = digest(readFileSync(artifact));
  ios.build.buildIdentity = `g016-ios-${ios.build.artifactSha256.slice(0, 16)}`;
}

function replaceIosExecutableWithUndefinedImplementations(app: string): void {
  const source = join(dirname(app), "undefined-main.cpp");
  writeFileSync(source, [
    'extern "C" int OpenSSL_version(void);', 'extern "C" int makeHermesRuntime(void);',
    "namespace facebook::jsi { class Runtime {}; class Object {}; }",
    "namespace facebook::react { class QuickBase64Impl { public: int base64FromArrayBuffer(jsi::Runtime&, jsi::Object, bool); }; }",
    "namespace margelo::nitro { void install(facebook::jsi::Runtime&); namespace crypto { class HybridScrypt { public: int deriveKey(int); }; class HybridCipher { public: bool setAAD(int); }; } }",
    "int main() { facebook::jsi::Runtime runtime; facebook::jsi::Object object; facebook::react::QuickBase64Impl base64; margelo::nitro::crypto::HybridScrypt scrypt; margelo::nitro::crypto::HybridCipher cipher; margelo::nitro::install(runtime); return base64.base64FromArrayBuffer(runtime, object, true) + scrypt.deriveKey(1) + cipher.setAAD(1) + OpenSSL_version() + makeHermesRuntime(); }",
    "",
  ].join("\n"));
  run("/usr/bin/xcrun", [
    "--sdk", "iphonesimulator", "clang++", "-std=c++17", "-arch", "arm64", "-mios-simulator-version-min=16.4", source,
    "-F", join(app, "Frameworks"), "-framework", "OpenSSL", "-framework", "hermesvm", "-Wl,-rpath,@executable_path/Frameworks",
    "-Wl,-undefined,dynamic_lookup", "-o", join(app, "G016"),
  ]);
  const symbols = spawnSync("/usr/bin/nm", ["-arch", "arm64", "-C", join(app, "G016")], { encoding: "utf8" });
  assert.equal(symbols.status, 0, symbols.stderr);
  for (const pattern of [
    /^\s*U margelo::nitro::crypto::HybridScrypt::deriveKey\(/m,
    /^\s*U margelo::nitro::crypto::HybridCipher::setAAD\(/m,
    /^\s*U margelo::nitro::install\(facebook::jsi::Runtime&/m,
    /^\s*U facebook::react::QuickBase64Impl::base64FromArrayBuffer\(/m,
  ]) assert.match(symbols.stdout, pattern);
}

function addAndroidElf(root: string, evidence: any, name: string, bytes: Buffer): void {
  const android = platformEvidence(evidence, "android");
  const artifact = join(root, "android", android.build.artifactPath);
  const work = mkdtempSync(join(tmpdir(), "g016-apk-rewrite-"));
  const unsigned = join(work, "unsigned.apk");
  try {
    run("/usr/bin/unzip", ["-qq", artifact, "-d", join(work, "stage")]);
    writeEvidenceFile(join(work, "stage"), `lib/arm64-v8a/${name}`, bytes);
    run("/usr/bin/zip", ["-qry", unsigned, "."], join(work, "stage"));
    rmSync(artifact);
    run(androidTool("zipalign"), ["-f", "4", unsigned, artifact]);
    run(androidTool("apksigner"), ["sign", "--ks", androidSigningKey(), "--ks-key-alias", "g016", "--ks-pass", "pass:changeit", "--key-pass", "pass:changeit", artifact]);
    android.build.artifactSha256 = digest(readFileSync(artifact));
    android.build.buildIdentity = `g016-android-${android.build.artifactSha256.slice(0, 16)}`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("G016 Expo config explicitly locks the Hermes/New Architecture build contract", () => {
  const config = JSON.parse(readFileSync(resolve(repoRoot, "spikes/backup-crypto/app.json"), "utf8"));
  assert.deepEqual(config.expo.extra.g016BuildContract, { jsEngine: "hermes", newArchEnabled: true });
  assert.equal(config.expo.plugins[0][1].useHermesV1, true);
});

test("G016 compact proof stays below 900 UTF-8 bytes on success and worst-case failure", () => {
  assert.equal(compactProofByteLength("Aé😀"), 7);
  const success = serializeCompactProof(compactInput());
  assert.ok(compactProofByteLength(success) < G016_CRYPTO_PROOF_MAX_BYTES);
  assert.equal(success.match(/G016_CRYPTO_PROOF /g)?.length, 1);
  assert.equal(JSON.parse(success.slice("G016_CRYPTO_PROOF ".length)).st, "IN_PROCESS_PASS");

  const failure = serializeCompactProof(compactInput({
    failures: G016_ALL_FAILURE_CODES,
    platform: "unsupported",
    release: false,
    hermes: false,
    newArchitecture: false,
    backend: {
      adapter: "BackupCryptoPort/nativeCryptoPort@1",
      native: "react-native-quick-crypto@1.1.6/OpenSSL",
      rootImports: false,
      installCalled: true,
      rng: "expo-crypto@57.0.0",
      cryptoGlobal: false,
      bufferGlobal: false,
      nextTick: false,
      transition: "X",
    },
    vector: { bytes: 0, sha256: "" },
    selfTest: {
      ok: false,
      count: 8,
      rfc: false,
      node: false,
      aes: false,
      sliced: false,
      rejections: false,
      tamper: false,
      queue: false,
      framing: false,
    },
    scrypt: { p95: Number.NaN, max: Number.POSITIVE_INFINITY },
    aes: { encP95: Number.NaN, decP95: Number.POSITIVE_INFINITY, plaintextBytes: 4 * 1024 * 1024, framedBytes: null, tagBytes: 16 },
    heartbeat: { max: Number.NaN, limit: 250 },
  }));
  assert.ok(compactProofByteLength(failure) < G016_CRYPTO_PROOF_MAX_BYTES);
  const parsed = JSON.parse(failure.slice("G016_CRYPTO_PROOF ".length));
  assert.equal(parsed.st, "IN_PROCESS_FAIL");
  assert.deepEqual(parsed.f, G016_ALL_FAILURE_CODES);
  assert.equal(parsed.sc.p95, null);
  assert.equal(parsed.hb.max, null);
});

test("G016 compact serialization rejects unknown failure codes", () => {
  assert.throws(() => compactProofRecord(compactInput({ failures: [999] }) as never), /unknown failure code/);
});


test("G016 aggregate accepts structurally valid artifacts with dedicated independent runtime copies", async (t) => {
  const fixture = makeFinalEvidence(t);
  const iosMemory = readFileSync(join(fixture.evidenceRoot, "ios/logs/memory.txt"), "utf8");
  assert.match(iosMemory, /"command":"footprint -f bytes -p 1602"/);
  assert.match(iosMemory, /^\s*phys_footprint: \d+ B$/m);
  assert.doesNotMatch(iosMemory, /^Time:/m);
  const result: any = await validateG016FinalEvidence(fixture.evidence);
  assert.equal(result.status, "PASS", result.failures.join("; "));
  assert.deepEqual(result.failures, []);
  assert.match(result.resolutions.android ?? "", /^[0-9a-f]{64}$/);
  assert.match(result.nativeMembers.android["lib/arm64-v8a/libQuickCrypto.so"], /^[0-9a-f]{64}$/);
  assert.match(result.nativeMembers.ios["Payload/G016.app/Frameworks/OpenSSL.framework/OpenSSL"], /^[0-9a-f]{64}$/);
  assert.equal(result.packagedMembers.android["base.apk"], result.artifacts.android);
  assert.match(result.packagedMembers.ios["Payload/G016.app/G016"], /^[0-9a-f]{64}$/);
  assert.equal(result.runtimeIdentities.android.baseApk, result.artifacts.android);
  assert.equal(
    result.runtimeIdentities.ios["Payload/G016.app/main.jsbundle"],
    result.packagedMembers.ios["Payload/G016.app/main.jsbundle"],
  );
  assert.equal(result.trustBoundary, "local-consistency-and-tamper-detection-not-hardware-attestation");
  assert.equal(result.physicalIosProductionGate, "OPEN");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("G016 rejects build, resolution, log, and non-exact runtime snapshot path aliases", async (t) => {
  const fixture = makeFinalEvidence(t);

  const artifactAlias = structuredClone(fixture.evidence);
  const artifactAliasAndroid = platformEvidence(artifactAlias, "android");
  artifactAliasAndroid.runtimeIdentity.installedBaseApkPath = artifactAliasAndroid.build.artifactPath;
  artifactAliasAndroid.runtimeIdentity.installedBaseApkSha256 = artifactAliasAndroid.build.artifactSha256;
  const artifactAliasResult = await validateG016FinalEvidence(artifactAlias);
  assert.equal(artifactAliasResult.status, "FAIL");
  assert.match(artifactAliasResult.failures.join("; "), /installed base APK path must be exactly runtime\/installed-base\.apk/);
  assert.match(artifactAliasResult.failures.join("; "), /process binding requires a fully valid installed runtime identity/);

  const nonExactName = structuredClone(fixture.evidence);
  const nonExactAndroid = platformEvidence(nonExactName, "android");
  const exactBaseApk = join(fixture.evidenceRoot, "android", nonExactAndroid.runtimeIdentity.installedBaseApkPath);
  nonExactAndroid.runtimeIdentity.installedBaseApkPath = "runtime/base.apk";
  nonExactAndroid.runtimeIdentity.installedBaseApkSha256 = writeEvidenceFile(
    join(fixture.evidenceRoot, "android"),
    "runtime/base.apk",
    readFileSync(exactBaseApk),
  );
  assert.match(
    (await validateG016FinalEvidence(nonExactName)).failures.join("; "),
    /installed base APK path must be exactly runtime\/installed-base\.apk/,
  );

  const resolutionAlias = structuredClone(fixture.evidence);
  const resolutionAliasIos = platformEvidence(resolutionAlias, "ios");
  resolutionAliasIos.runtimeIdentity.installedExecutablePath = resolutionAliasIos.nativeResolution.resolutionPath;
  resolutionAliasIos.runtimeIdentity.installedExecutableSha256 = resolutionAliasIos.nativeResolution.resolutionSha256;
  assert.match(
    (await validateG016FinalEvidence(resolutionAlias)).failures.join("; "),
    /installed app executable path must be exactly runtime\/installed-G016FMBKCryptoProof/,
  );

  const logAlias = structuredClone(fixture.evidence);
  const logAliasIos = platformEvidence(logAlias, "ios");
  logAliasIos.runtimeIdentity.installedBundlePath = logAliasIos.process.logPath;
  logAliasIos.runtimeIdentity.installedBundleSha256 = logAliasIos.process.logSha256;
  assert.match(
    (await validateG016FinalEvidence(logAlias)).failures.join("; "),
    /installed main\.jsbundle path must be exactly runtime\/installed-main\.jsbundle/,
  );
});

test("G016 rejects a hardlinked Android runtime snapshot when hardlinks are supported", async (t) => {
  const fixture = makeFinalEvidence(t);
  const evidence = structuredClone(fixture.evidence);
  const android = platformEvidence(evidence, "android");
  const artifactPath = join(fixture.evidenceRoot, "android", android.build.artifactPath);
  const installedPath = join(fixture.evidenceRoot, "android", android.runtimeIdentity.installedBaseApkPath);
  rmSync(installedPath);
  try {
    linkSync(artifactPath, installedPath);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (["EPERM", "EOPNOTSUPP", "ENOTSUP", "EXDEV"].includes(code)) {
      t.skip(`hardlinks unavailable: ${code}`);
      return;
    }
    throw error;
  }
  const result: any = await validateG016FinalEvidence(evidence);
  assert.equal(result.status, "FAIL");
  assert.match(result.failures.join("; "), /installed base APK must be an independent file/);
  assert.match(result.failures.join("; "), /process binding requires a fully valid installed runtime identity/);
  assert.equal(result.runtimeIdentities.android, null);
});

test("G016 rejects installed runtime files detached from the inspected signed artifacts", async (t) => {
  const installedApkFixture = makeFinalEvidence(t);
  const installedApkEvidence = structuredClone(installedApkFixture.evidence);
  const detachedApkFixture = makeFinalEvidence(t);
  const detachedApkEvidence = structuredClone(detachedApkFixture.evidence);
  addAndroidElf(detachedApkFixture.evidenceRoot, detachedApkEvidence, "libg016-detached.so", androidUnclosedFixture());
  const installedAndroid = platformEvidence(installedApkEvidence, "android");
  const detachedAndroid = platformEvidence(detachedApkEvidence, "android");
  const detachedApk = readFileSync(join(detachedApkFixture.evidenceRoot, "android", detachedAndroid.build.artifactPath));
  assert.notEqual(digest(detachedApk), installedAndroid.build.artifactSha256);
  const installedApkPath = join(installedApkFixture.evidenceRoot, "android", installedAndroid.runtimeIdentity.installedBaseApkPath);
  writeFileSync(installedApkPath, detachedApk);
  installedAndroid.runtimeIdentity.installedBaseApkSha256 = digest(detachedApk);
  assert.match(
    (await validateG016FinalEvidence(installedApkEvidence)).failures.join("; "),
    /installed base APK (?:SHA-256|bytes) does not match the exact signed artifact/,
  );

  const executableFixture = makeFinalEvidence(t);
  const executableEvidence = structuredClone(executableFixture.evidence);
  const iosExecutable = platformEvidence(executableEvidence, "ios").runtimeIdentity;
  const installedExecutablePath = join(executableFixture.evidenceRoot, "ios", iosExecutable.installedExecutablePath);
  writeFileSync(installedExecutablePath, Buffer.concat([readFileSync(installedExecutablePath), Buffer.from("detached-executable")]));
  iosExecutable.installedExecutableSha256 = digest(readFileSync(installedExecutablePath));
  assert.match(
    (await validateG016FinalEvidence(executableEvidence)).failures.join("; "),
    /installed app executable (?:SHA-256|bytes) does not match the inspected signed ZIP member/,
  );

  const bundleFixture = makeFinalEvidence(t);
  const bundleEvidence = structuredClone(bundleFixture.evidence);
  const iosBundle = platformEvidence(bundleEvidence, "ios").runtimeIdentity;
  const installedBundlePath = join(bundleFixture.evidenceRoot, "ios", iosBundle.installedBundlePath);
  writeFileSync(installedBundlePath, "detached main.jsbundle");
  iosBundle.installedBundleSha256 = digest(readFileSync(installedBundlePath));
  assert.match(
    (await validateG016FinalEvidence(bundleEvidence)).failures.join("; "),
    /installed main\.jsbundle (?:SHA-256|bytes) does not match the inspected signed ZIP member/,
  );
});

test("G016 rejects detached runtime descriptors and PID-scoped raw proofs from another process or proof", async (t) => {
  const detachedFixture = makeFinalEvidence(t);
  const detached = structuredClone(detachedFixture.evidence);
  const detachedAndroid = platformEvidence(detached, "android");
  detachedAndroid.runtimeIdentity.artifactSha256 = platformEvidence(detached, "ios").build.artifactSha256;
  assert.match(
    (await validateG016FinalEvidence(detached)).failures.join("; "),
    /runtime identity is detached from the inspected signed artifact|live proof process is detached/,
  );

  const wrongPidFixture = makeFinalEvidence(t);
  const wrongPid = structuredClone(wrongPidFixture.evidence);
  rewriteLog(wrongPidFixture.evidenceRoot, wrongPid, "android", "adverseEvents", (text) => (
    text.replace("  1601  1701 I ReactNativeJS: G016_CRYPTO_PROOF", "  9999  1701 I ReactNativeJS: G016_CRYPTO_PROOF")
  ));
  assert.match(
    (await validateG016FinalEvidence(wrongPid)).failures.join("; "),
    /adverse raw proof PID is detached from the live process/,
  );

  const wrongProofFixture = makeFinalEvidence(t);
  const wrongProof = structuredClone(wrongProofFixture.evidence);
  rewriteLog(wrongProofFixture.evidenceRoot, wrongProof, "ios", "adverseEvents", (text) => (
    text.replace('"st":"IN_PROCESS_PASS"', '"st":"IN_PROCESS_FAIL"')
  ));
  assert.match(
    (await validateG016FinalEvidence(wrongProof)).failures.join("; "),
    /adverse raw proof is not byte-equal to the canonical process proof/,
  );
});

test("G016 requires defined Android and iOS implementation symbols, not names or undefined imports", async (t) => {
  const fixture = makeFinalEvidence(t);
  const evidence = structuredClone(fixture.evidence);
  addAndroidElf(fixture.evidenceRoot, evidence, "libQuickCrypto.so", androidNameOnlyQuickCrypto());
  const failures = (await validateG016FinalEvidence(evidence)).failures.join("; ");
  assert.match(failures, /libQuickCrypto\.so lacks linked QuickCrypto scrypt implementation symbols/);
  assert.match(failures, /libQuickCrypto\.so lacks linked QuickCrypto AES-GCM implementation symbols/);
  assert.doesNotMatch(failures, /QuickCrypto does not dynamically depend/);

  const androidFixture = makeFinalEvidence(t);
  const androidEvidence = structuredClone(androidFixture.evidence);
  addAndroidElf(androidFixture.evidenceRoot, androidEvidence, "libQuickCrypto.so", androidUndefinedQuickCrypto());
  const androidFailures = (await validateG016FinalEvidence(androidEvidence)).failures.join("; ");
  assert.match(androidFailures, /libQuickCrypto\.so lacks linked QuickCrypto scrypt implementation symbols/);
  assert.match(androidFailures, /libQuickCrypto\.so lacks linked QuickCrypto AES-GCM implementation symbols/);
  assert.doesNotMatch(androidFailures, /QuickCrypto does not dynamically depend|native dependency closure is missing/);

  const iosFixture = makeFinalEvidence(t);
  const iosEvidence = structuredClone(iosFixture.evidence);
  rewriteIosApp(iosFixture.evidenceRoot, iosEvidence, replaceIosExecutableWithUndefinedImplementations, true);
  const iosFailures = (await validateG016FinalEvidence(iosEvidence)).failures.join("; ");
  for (const implementation of ["QuickCrypto scrypt", "QuickCrypto AES-GCM", "Nitro installation", "QuickBase64 implementation"]) {
    assert.match(iosFailures, new RegExp(`iOS executable lacks linked ${implementation} implementation symbols`));
  }
  assert.doesNotMatch(iosFailures, /signature verification failed|LC_LOAD_DYLIB|signed app omits loaded|framework identity|detached build platform/);
});

test("G016 rejects forged executing roots and aggregate contradictions", async (t) => {
  const { evidence, evidenceRoot } = makeFinalEvidence(t);
  const clone = join(evidenceRoot, "clone");
  for (const path of G016_SOURCE_PATHS) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    cpSync(join(repoRoot, path), join(clone, path));
  }
  const forged = structuredClone(evidence);
  forged.candidate.rootPath = clone;
  assert.match((await validateG016FinalEvidence(forged)).failures.join("; "), /repository executing this validator/);
  const missing = structuredClone(evidence);
  missing.platforms.pop();
  assert.match((await validateG016FinalEvidence(missing)).failures.join("; "), /exactly one iOS|exactly two/);
  const mismatch = structuredClone(evidence);
  platformEvidence(mismatch, "ios").build.sourceFingerprintSha256 = "0".repeat(64);
  assert.match((await validateG016FinalEvidence(mismatch)).failures.join("; "), /source fingerprint is stale/);
});

test("G016 rejects renamed text artifacts, unlinked signed apps, and non-authentic resolutions", async (t) => {
  const renamedFixture = makeFinalEvidence(t);
  const renamed = structuredClone(renamedFixture.evidence);
  const android = platformEvidence(renamed, "android");
  const artifactPath = join(renamedFixture.evidenceRoot, "android", android.build.artifactPath);
  writeFileSync(artifactPath, "plain text renamed apk");
  android.build.artifactSha256 = digest(readFileSync(artifactPath));
  android.build.buildIdentity = `g016-android-${android.build.artifactSha256.slice(0, 16)}`;
  assert.match((await validateG016FinalEvidence(renamed)).failures.join("; "), /structurally valid APK|aapt|unzip/);

  const unlinkedFixture = makeFinalEvidence(t);
  const unlinked = structuredClone(unlinkedFixture.evidence);
  rewriteIosApp(unlinkedFixture.evidenceRoot, unlinked, (app) => {
    const executable = join(app, "G016");
    const bytes = readFileSync(executable);
    const original = Buffer.from("base64FromArrayBuffer");
    const replacement = Buffer.from("base64FroMArrayBuffer");
    let offset = bytes.indexOf(original);
    assert.ok(offset >= 0, "positive iOS fixture must link QuickBase64 implementation symbols");
    while (offset >= 0) {
      replacement.copy(bytes, offset);
      offset = bytes.indexOf(original, offset + original.length);
    }
    writeFileSync(executable, bytes);
    const symbols = spawnSync("/usr/bin/nm", ["-arch", "arm64", "-C", executable], { encoding: "utf8" });
    assert.equal(symbols.status, 0, symbols.stderr);
    assert.match(symbols.stdout, /QuickCrypto_dummy/);
    assert.match(symbols.stdout, /NitroModules_dummy/);
    assert.match(symbols.stdout, /QuickBase64_dummy/);
  }, true);
  assert.match((await validateG016FinalEvidence(unlinked)).failures.join("; "), /QuickBase64 implementation/);

  const minimalFixture = makeFinalEvidence(t);
  const minimal = structuredClone(minimalFixture.evidence);
  const native = platformEvidence(minimal, "android").nativeResolution;
  const resolutionPath = join(minimalFixture.evidenceRoot, "android", native.resolutionPath);
  writeFileSync(resolutionPath, "releaseRuntimeClasspath react-native-quick-crypto@1.1.6");
  native.resolutionSha256 = digest(readFileSync(resolutionPath));
  assert.match((await validateG016FinalEvidence(minimal)).failures.join("; "), /minimal, truncated, or unbounded Gradle report|command sections/);

  assert.match(validateG016ResolutionForTest(handcraftedAndroidResolution(), "android").join("; "), /minimal, truncated, or unbounded|command sections/);
  assert.match(validateG016ResolutionForTest(handcraftedIosResolution(), "ios").join("; "), /minimal, truncated, or unbounded|checksum does not exactly bind/);
  assert.match(validateG016ResolutionForTest(iosResolution().replace("DEPENDENCIES:", "PODS:\n  - DuplicateSectionProbe (1.0.0)\n\nDEPENDENCIES:"), "ios").join("; "), /duplicate top-level sections/);

  const conflictFixture = makeFinalEvidence(t);
  const conflict = structuredClone(conflictFixture.evidence);
  const iosNative = platformEvidence(conflict, "ios").nativeResolution;
  const podPath = join(conflictFixture.evidenceRoot, "ios", iosNative.resolutionPath);
  writeFileSync(podPath, readFileSync(podPath, "utf8").replace("  - QuickCrypto (1.1.6):", "  - QuickCrypto (1.1.6):\n  - QuickCrypto (9.9.9):"));
  iosNative.resolutionSha256 = digest(readFileSync(podPath));
  assert.match((await validateG016FinalEvidence(conflict)).failures.join("; "), /bind exactly QuickCrypto/);
});

test("G016 verifies final Android and iOS signatures after all packaging", async (t) => {
  const apkFixture = makeFinalEvidence(t);
  const apkEvidence = structuredClone(apkFixture.evidence);
  const android = platformEvidence(apkEvidence, "android");
  const apk = join(apkFixture.evidenceRoot, "android", android.build.artifactPath);
  writeFileSync(apk, Buffer.concat([readFileSync(apk), Buffer.from("tamper")]));
  android.build.artifactSha256 = digest(readFileSync(apk));
  android.build.buildIdentity = `g016-android-${android.build.artifactSha256.slice(0, 16)}`;
  assert.match((await validateG016FinalEvidence(apkEvidence)).failures.join("; "), /APK signature verification failed/);

  const iosFixture = makeFinalEvidence(t);
  const iosEvidence = structuredClone(iosFixture.evidence);
  rewriteIosApp(iosFixture.evidenceRoot, iosEvidence, (app) => writeFileSync(join(app, "main.jsbundle"), "post-sign mutation"), false);
  assert.match((await validateG016FinalEvidence(iosEvidence)).failures.join("; "), /app signature verification failed/);
});

test("G016 closes DT_NEEDED for every packaged Android arm64 ELF", async (t) => {
  const fixture = makeFinalEvidence(t);
  const evidence = structuredClone(fixture.evidence);
  addAndroidElf(fixture.evidenceRoot, evidence, "libg016-extra.so", androidUnclosedFixture());
  const result = await validateG016FinalEvidence(evidence);
  assert.match(result.failures.join("; "), /closure is missing libg016-missing\.so required by lib\/arm64-v8a\/libg016-extra\.so/);
});

test("G016 derives proof, liveness, and adverse results from hashed raw logs", async (t) => {
  const contradictoryFixture = makeFinalEvidence(t);
  const contradictory = structuredClone(contradictoryFixture.evidence);
  rewriteLog(contradictoryFixture.evidenceRoot, contradictory, "android", "process", (text) => text.replace('"st":"IN_PROCESS_PASS"', '"st":"IN_PROCESS_FAIL"'));
  assert.match((await validateG016FinalEvidence(contradictory)).failures.join("; "), /proof status must be IN_PROCESS_PASS/);

  const duplicateFixture = makeFinalEvidence(t);
  const duplicate = structuredClone(duplicateFixture.evidence);
  rewriteLog(duplicateFixture.evidenceRoot, duplicate, "android", "process", (text) => `${text}${text.split("\n")[0]}\n`);
  assert.match((await validateG016FinalEvidence(duplicate)).failures.join("; "), /exactly one proof record/);

  const benignFixture = makeFinalEvidence(t);
  const benign = structuredClone(benignFixture.evidence);
  rewriteLog(benignFixture.evidenceRoot, benign, "android", "adverseEvents", (text) => `${text}07-12 00:00:05.000   222   333 I OomAdjuster: update for ${appId} pid=1601\nlmkd: stats for ${appId} pid=1601\n07-12 00:00:05.100   511   541 I ActivityManager: Killing 1500:${appId}/u0a174 (adj 0): prior retry from pid 1601\n`);
  rewriteLog(benignFixture.evidenceRoot, benign, "ios", "adverseEvents", (text) => `${text}G016[1602] CrashReporter initialized; jetsamPriority=10; no fatal condition; aborting flush\n`);
  assert.equal((await validateG016FinalEvidence(benign)).status, "PASS");

  const exactKillFixture = makeFinalEvidence(t);
  const exactKill = structuredClone(exactKillFixture.evidence);
  rewriteLog(exactKillFixture.evidenceRoot, exactKill, "android", "adverseEvents", (text) => `${text}07-12 00:00:05.100   511   541 I ActivityManager: Killing 1601:${appId}/u0a174 (adj 0): current run\n`);
  assert.match((await validateG016FinalEvidence(exactKill)).failures.join("; "), /PID\/app-scoped events: low-memory-kill/);

  const adverseFixture = makeFinalEvidence(t);
  const adverse = structuredClone(adverseFixture.evidence);
  rewriteLog(adverseFixture.evidenceRoot, adverse, "android", "adverseEvents", (text) => `${text}07-12 00:00:05.000  1601  1601 E AndroidRuntime: FATAL EXCEPTION: main\n`);
  rewriteLog(adverseFixture.evidenceRoot, adverse, "ios", "adverseEvents", (text) => `${text}G016[1602] Fatal error: native crash\n`);
  assert.match((await validateG016FinalEvidence(adverse)).failures.join("; "), /PID\/app-scoped events/);

  const deadFixture = makeFinalEvidence(t);
  const dead = structuredClone(deadFixture.evidence);
  rewriteLog(deadFixture.evidenceRoot, dead, "android", "process", (text) => text.replace(`1601 ${appId} ${appId}`, `999999 ${appId} ${appId}`).replace(/"pid":1601/g, '"pid":999999'));
  assert.match((await validateG016FinalEvidence(dead)).failures.join("; "), /does not contain exactly one PID\/app process row|detached/);

  const summaryFixture = makeFinalEvidence(t);
  const summary = structuredClone(summaryFixture.evidence);
  rewriteLog(summaryFixture.evidenceRoot, summary, "android", "process", (text) => `${text.split("\n")[0]}\nG016_PROOF_OBSERVED_AT 2026-07-12T00:00:05.000Z\nG016_PROCESS_LIVENESS ${JSON.stringify({ pid: 999999, proofObservedAt: "2026-07-12T00:00:05.000Z", checkedAt: "2026-07-12T00:00:06.000Z", alive: true })}\n`);
  rewriteLog(summaryFixture.evidenceRoot, summary, "android", "memory", () => `G016_MEMORY_LOG ${JSON.stringify({ pid: 999999, kind: "android-pss-mib", startedAt: "2026-07-12T00:00:00.000Z", endedAt: "2026-07-12T00:00:07.000Z" })}\n${[100, 160, 110, 112, 114].map((valueMiB, index) => `G016_MEMORY_SAMPLE ${JSON.stringify({ pid: 999999, timestamp: `2026-07-12T00:00:0${index}.000Z`, valueMiB, phase: index === 0 ? "baseline" : index === 1 ? "run" : "post-first-run" })}`).join("\n")}\n`);
  assert.match((await validateG016FinalEvidence(summary)).failures.join("; "), /unframed or caller-authored summary line|native liveness command transcript/);
});

test("G016 normalizes Android local-clock proof timestamps across both New Year boundaries", async (t) => {
  const utcPlusFixture = makeFinalEvidence(t);
  const utcPlus = structuredClone(utcPlusFixture.evidence);
  shiftPlatformTiming(utcPlusFixture.evidenceRoot, utcPlus, "android", "2026-12-31T16:00:05.000Z", "01-01 00:00:05.000");
  assert.equal((await validateG016FinalEvidence(utcPlus)).status, "PASS");

  const utcMinusFixture = makeFinalEvidence(t);
  const utcMinus = structuredClone(utcMinusFixture.evidence);
  shiftPlatformTiming(utcMinusFixture.evidenceRoot, utcMinus, "android", "2027-01-01T00:00:05.000Z", "12-31 16:00:05.000");
  assert.equal((await validateG016FinalEvidence(utcMinus)).status, "PASS");
});

test("G016 accepts exact leap days and rejects impossible Android and iOS calendar dates", async (t) => {
  const leapFixture = makeFinalEvidence(t);
  const leap = structuredClone(leapFixture.evidence);
  shiftPlatformTiming(leapFixture.evidenceRoot, leap, "android", "2028-02-29T00:00:05.000Z", "02-29 00:00:05.000");
  assert.equal((await validateG016FinalEvidence(leap)).status, "PASS");

  const invalidAndroidFixture = makeFinalEvidence(t);
  const invalidAndroid = structuredClone(invalidAndroidFixture.evidence);
  shiftPlatformTiming(invalidAndroidFixture.evidenceRoot, invalidAndroid, "android", "2027-03-02T00:00:05.000Z", "02-30 00:00:05.000");
  assert.match((await validateG016FinalEvidence(invalidAndroid)).failures.join("; "), /timestamp cannot be normalized/);

  const invalidIosFixture = makeFinalEvidence(t);
  const invalidIos = structuredClone(invalidIosFixture.evidence);
  shiftPlatformTiming(invalidIosFixture.evidenceRoot, invalidIos, "ios", "2027-03-02T00:00:05.000Z", "2027-02-30 00:00:05.000");
  assert.match((await validateG016FinalEvidence(invalidIos)).failures.join("; "), /timestamp cannot be normalized/);
});

test("G016 rejects ambiguous and out-of-window raw proof timestamps", async (t) => {
  const ambiguousFixture = makeFinalEvidence(t);
  const ambiguous = structuredClone(ambiguousFixture.evidence);
  rewriteLog(ambiguousFixture.evidenceRoot, ambiguous, "android", "adverseEvents", (text) => (
    text.replace("runtime remained healthy", `${text.split("\n")[1]}\nruntime remained healthy`)
  ));
  assert.match((await validateG016FinalEvidence(ambiguous)).failures.join("; "), /exactly one G016 proof line/);

  const outsideFixture = makeFinalEvidence(t);
  const outside = structuredClone(outsideFixture.evidence);
  rewriteLog(outsideFixture.evidenceRoot, outside, "android", "adverseEvents", (text) => (
    text.replace("07-12 00:00:05.000", "07-11 23:58:05.000")
  ));
  assert.match((await validateG016FinalEvidence(outside)).failures.join("; "), /timestamp cannot be normalized/);
});

test("G016 enforces executable iOS ps, byte footprint output, and unique command IDs", async (t) => {
  const barePsFixture = makeFinalEvidence(t);
  const barePs = structuredClone(barePsFixture.evidence);
  rewriteLog(barePsFixture.evidenceRoot, barePs, "ios", "process", (text) => text.replace("xcrun simctl spawn booted /bin/ps", "xcrun simctl spawn booted ps"));
  assert.match((await validateG016FinalEvidence(barePs)).failures.join("; "), /exact simulator \/bin\/ps command/);

  const defaultFootprintFixture = makeFinalEvidence(t);
  const defaultFootprint = structuredClone(defaultFootprintFixture.evidence);
  rewriteLog(defaultFootprintFixture.evidenceRoot, defaultFootprint, "ios", "memory", (text) => text.replaceAll("footprint -f bytes -p 1602", "footprint -p 1602"));
  assert.match((await validateG016FinalEvidence(defaultFootprint)).failures.join("; "), /exact byte-format footprint command/);

  const formattedFootprintFixture = makeFinalEvidence(t);
  const formattedFootprint = structuredClone(formattedFootprintFixture.evidence);
  rewriteLog(formattedFootprintFixture.evidenceRoot, formattedFootprint, "ios", "memory", (text) => text.replace(/Footprint: \d+ B/g, "Footprint: 55 MB").replace(/^\s*phys_footprint: \d+ B$/gm, "    phys_footprint: 55 MB"));
  assert.match((await validateG016FinalEvidence(formattedFootprint)).failures.join("; "), /native byte phys_footprint value/);

  const duplicateIdFixture = makeFinalEvidence(t);
  const duplicateId = structuredClone(duplicateIdFixture.evidence);
  rewriteLog(duplicateIdFixture.evidenceRoot, duplicateId, "ios", "memory", (text) => text.replaceAll("ios-memory-1", "ios-memory-0"));
  assert.match((await validateG016FinalEvidence(duplicateId)).failures.join("; "), /command IDs must be unique within the log/);
});

test("G016 parses PID-bound memory from a hashed sampler log and retains memory limits", async (t) => {
  const pidFixture = makeFinalEvidence(t);
  const pid = structuredClone(pidFixture.evidence);
  rewriteLog(pidFixture.evidenceRoot, pid, "android", "memory", (text) => text.replace(/"pid":1601/g, '"pid":9999'));
  assert.match((await validateG016FinalEvidence(pid)).failures.join("; "), /memory command PID is detached/);

  const retainedFixture = makeFinalEvidence(t);
  const retained = structuredClone(retainedFixture.evidence);
  rewriteLog(retainedFixture.evidenceRoot, retained, "android", "memory", (text) => text.replace("TOTAL PSS:    116736", "TOTAL PSS:    199680"));
  assert.match((await validateG016FinalEvidence(retained)).failures.join("; "), /retained memory growth exceeds|peak delta exceeds/);

  const monotonicFixture = makeFinalEvidence(t);
  const monotonic = structuredClone(monotonicFixture.evidence);
  rewriteLog(monotonicFixture.evidenceRoot, monotonic, "android", "memory", (text) => text.replace("TOTAL PSS:    112640", "TOTAL PSS:    102400").replace("TOTAL PSS:    114688", "TOTAL PSS:    119808"));
  assert.match((await validateG016FinalEvidence(monotonic)).failures.join("; "), /monotonic growth exceeds/);

  const postProofMemoryFixture = makeFinalEvidence(t);
  const postProofMemory = structuredClone(postProofMemoryFixture.evidence);
  rewriteLog(postProofMemoryFixture.evidenceRoot, postProofMemory, "android", "adverseEvents", (text) => (
    text.replace("07-12 00:00:05.000", "07-12 00:00:00.000")
  ));
  const postProofMemoryResult: any = await validateG016FinalEvidence(postProofMemory);
  assert.equal(postProofMemoryResult.status, "FAIL");
  assert.match(postProofMemoryResult.failures.join("; "), /memory transcripts do not finish before the raw platform proof/);
});

test("G016 rejects symlink/TOCTOU, escape, stale-hash, proof-digest, and fake-physical probes", async (t) => {
  const evidenceAliasFixture = makeFinalEvidence(t);
  const evidenceAlias = structuredClone(evidenceAliasFixture.evidence);
  const realEvidenceRoot = `${evidenceAliasFixture.evidenceRoot}-real`;
  renameSync(evidenceAliasFixture.evidenceRoot, realEvidenceRoot);
  symlinkSync(realEvidenceRoot, evidenceAliasFixture.evidenceRoot);
  t.after(() => rmSync(realEvidenceRoot, { recursive: true, force: true }));
  assert.match((await validateG016FinalEvidence(evidenceAlias)).failures.join("; "), /evidenceRoot must be a non-symlink directory/);

  const candidateAliasFixture = makeFinalEvidence(t);
  const candidateAlias = structuredClone(candidateAliasFixture.evidence);
  const candidateLink = join(candidateAliasFixture.evidenceRoot, "candidate-link");
  symlinkSync(repoRoot, candidateLink);
  candidateAlias.candidate.rootPath = candidateLink;
  assert.match((await validateG016FinalEvidence(candidateAlias)).failures.join("; "), /candidate rootPath must be a non-symlink directory/);

  const ancestorFixture = makeFinalEvidence(t);
  const ancestor = structuredClone(ancestorFixture.evidence);
  const artifactDirectory = join(ancestorFixture.evidenceRoot, "android", "artifact");
  const realDirectory = join(ancestorFixture.evidenceRoot, "android", "artifact-real");
  renameSync(artifactDirectory, realDirectory);
  symlinkSync("artifact-real", artifactDirectory);
  assert.match((await validateG016FinalEvidence(ancestor)).failures.join("; "), /symlink path component|unsafe/);

  const leafFixture = makeFinalEvidence(t);
  const leaf = structuredClone(leafFixture.evidence);
  const processPath = join(leafFixture.evidenceRoot, "ios", platformEvidence(leaf, "ios").process.logPath);
  renameSync(processPath, `${processPath}.real`);
  symlinkSync(`${basename(processPath)}.real`, processPath);
  assert.match((await validateG016FinalEvidence(leaf)).failures.join("; "), /symlink path component|non-symlink file|unsafe/);

  const escapeFixture = makeFinalEvidence(t);
  const escape = structuredClone(escapeFixture.evidence);
  platformEvidence(escape, "android").build.artifactPath = "../ios/artifact/G016.zip";
  assert.match((await validateG016FinalEvidence(escape)).failures.join("; "), /path is invalid or forged/);

  const replacementFixture = makeFinalEvidence(t);
  const replacement = structuredClone(replacementFixture.evidence);
  const replacementPath = join(replacementFixture.evidenceRoot, "android", platformEvidence(replacement, "android").build.artifactPath);
  writeFileSync(replacementPath, "replacement after capture");
  assert.match((await validateG016FinalEvidence(replacement)).failures.join("; "), /descriptor snapshot/);

  const descriptorRoot = mkdtempSync(join(tmpdir(), "g016-descriptor-race-"));
  t.after(() => rmSync(descriptorRoot, { recursive: true, force: true }));
  const descriptorPath = join(descriptorRoot, "race.txt");
  writeFileSync(descriptorPath, "original");
  const noFollow = await snapshotG016FileForTest(descriptorRoot, "race.txt", digest("original"), { noFollowFlag: 0 });
  assert.match(noFollow.failures.join("; "), /O_NOFOLLOW is unavailable/);
  const raced = await snapshotG016FileForTest(descriptorRoot, "race.txt", digest("original"), {
    afterOpen: () => {
      renameSync(descriptorPath, `${descriptorPath}.opened`);
      writeFileSync(descriptorPath, "replacement");
    },
  });
  assert.equal(raced.snapshot, null);
  assert.match(raced.failures.join("; "), /replaced during validation|resolves through a symlink or replacement/);

  const ancestorRaceRoot = mkdtempSync(join(tmpdir(), "g016-ancestor-race-"));
  t.after(() => rmSync(ancestorRaceRoot, { recursive: true, force: true }));
  const ancestorPath = join(ancestorRaceRoot, "ancestor");
  const replacementAncestor = join(ancestorRaceRoot, "replacement");
  mkdirSync(ancestorPath);
  mkdirSync(replacementAncestor);
  writeFileSync(join(ancestorPath, "race.txt"), "original");
  writeFileSync(join(replacementAncestor, "race.txt"), "original");
  const ancestorRaced = await snapshotG016FileForTest(ancestorRaceRoot, "ancestor/race.txt", digest("original"), {
    beforeLeafOpen: () => {
      renameSync(ancestorPath, `${ancestorPath}.pinned`);
      renameSync(replacementAncestor, ancestorPath);
    },
    afterOpen: () => {
      renameSync(ancestorPath, replacementAncestor);
      renameSync(`${ancestorPath}.pinned`, ancestorPath);
    },
  });
  assert.equal(ancestorRaced.snapshot, null);
  assert.match(ancestorRaced.failures.join("; "), /opened leaf is detached from its pinned ancestor chain/);

  const proofFixture = makeFinalEvidence(t);
  const proofMismatch = structuredClone(proofFixture.evidence);
  rewriteLog(proofFixture.evidenceRoot, proofMismatch, "android", "process", (text) => text.replace(/"s":"[0-9a-f]{64}"/, `"s":"${"0".repeat(64)}"`));
  assert.match((await validateG016FinalEvidence(proofMismatch)).failures.join("; "), /proof source digest is stale/);

  const physicalFixture = makeFinalEvidence(t);
  const physical = structuredClone(physicalFixture.evidence);
  platformEvidence(physical, "ios").build.target = "physical";
  assert.match((await validateG016FinalEvidence(physical)).failures.join("; "), /target contradicts/);
});

test("G016 parses the authentic full generated Podfile.lock by section", () => {
  const authenticPodfile = "/private/tmp/G016-POSTFIX/ios/Podfile.lock";
  if (!existsSync(authenticPodfile)) return;
  assert.deepEqual(validateG016ResolutionForTest(readFileSync(authenticPodfile, "utf8"), "ios"), []);
});

test("G016 parses one real successful Gradle dependency transcript with all four insights", () => {
  const authenticGradle = "/private/tmp/g016-gradle-release-runtime.txt";
  if (!existsSync(authenticGradle)) return;
  assert.deepEqual(validateG016ResolutionForTest(readFileSync(authenticGradle, "utf8"), "android"), []);
});

test("G016 timing fails closed and aggregate CLI owns the sole final PASS", async (t) => {
  const timingFixture = makeFinalEvidence(t);
  const timing = structuredClone(timingFixture.evidence);
  rewriteLog(timingFixture.evidenceRoot, timing, "android", "process", (text) => text.replace('"p95":61.67', '"p95":-1'));
  assert.match((await validateG016FinalEvidence(timing)).failures.join("; "), /finite and nonnegative/);

  assert.equal((await validateG016FinalEvidence(null)).status, "FAIL");
  const { evidenceRoot, evidence } = makeFinalEvidence(t);
  const inputPath = join(evidenceRoot, "aggregate-evidence.json");
  writeFileSync(inputPath, JSON.stringify(evidence));
  const pass = spawnSync(process.execPath, [validatorPath, inputPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.equal(pass.stdout.match(/"status":"PASS"/g)?.length, 1);
  const fail = spawnSync(process.execPath, [validatorPath], { encoding: "utf8" });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /"status":"FAIL"/);
});

test("G016 source boundary remains exactly 49 unique existing paths", () => {
  assert.equal(G016_SOURCE_PATHS.length, 49);
  assert.equal(new Set(G016_SOURCE_PATHS).size, 49);
  for (const path of G016_SOURCE_PATHS) assert.doesNotThrow(() => readFileSync(resolve(repoRoot, path)), path);
});
