#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const PREFIX = "G016_LICENSE_CHECK ";

const packages = [
  ["react-native-quick-crypto", "1.1.6", "sha512-FPq628/KjdwUCtKEMzbNDXiw+Z1DM6tBcQnUu/qtLtiGsIFNebrCMTpCjry0T3hhDcGbd9IC4acHxprAteh8rA==", "react-native-quick-crypto-MIT.txt"],
  ["react-native-nitro-modules", "0.36.1", "sha512-kBv/VvKqAmkXAvP1DxJMC9b/fRhh7JdSO4EUnPP46hJjrIFeFR8AwKm8mYaKZEuF014M/TVdv2vomVUW0umsQQ==", "react-native-nitro-modules-MIT.txt"],
  ["react-native-quick-base64", "3.0.1", "sha512-EjUP2U7WqKmlMmoY7XGyHomy8bM0q4+yCDCRg4ZezQ6zedYRwc7yVk4V2O/iSftKaLEzhuW98lpyPMdk1iPHXQ==", "react-native-quick-base64-MIT.txt"],
  ["expo-build-properties", "57.0.3", "sha512-oiqyD583acVmFVdF5nPSYEI7B/1ulOfIJhmfhr3bT51/64jtwaY0FzgVL8C2o23Z+CvCnEL8gOnhtH0sqcRWiA==", "expo-build-properties-MIT.txt"],
  ["expo-crypto", "57.0.0", "sha512-vd0kdUO14h9CgPcgzcR8nmy/wgz3zSOhQmucnbDdyn/z9eAeR2IB5BKaDvPbg/lrIT+KweGAV5IlrK5PZFqUSQ==", "expo-crypto-MIT.txt"],
  ["@craftzdog/react-native-buffer", "6.1.2", "sha512-KV1HitN05FHLLDG7Zb/yftDsa+mKBYBzFMQ0PMldvUicq6vWOtAvz9mDavt7Fzozh+WNqORE+yFDkkdWysZ/SA==", "craftzdog-react-native-buffer-MIT.txt"],
  ["events", "3.3.0", "sha512-mQw+2fkQbALzQ7V0MY0IqdnXNOeTtP4r0lN9z7AAawCXgqea7bDii20AYrIBrFd/Hx0M2Ocz6S111CaFkUcb0Q==", "events-MIT.txt"],
  ["readable-stream", "4.7.0", "sha512-oIGGmcpTLwPga8Bn6/Z75SVaH1z5dUut2ibSyAMVhmUggWpmDn2dapB0n7f8nwaSiRtepAsfJyfXIO5DCVAODg==", "readable-stream-MIT.txt"],
  ["safe-buffer", "5.2.1", "sha512-rp3So07KcdmmKbGvgaNxQSJr7bGVSVk5S9Eq1F+ppbRo70+YeaDxkw5Dd8NPN+GD6bjnYm2VuPuCXmpuYvmCXQ==", "safe-buffer-MIT.txt"],
  ["string_decoder", "1.3.0", "sha512-hkRX8U1WjJFd8LsDJ2yQ/wWWxaopEsABU1XfkM8A+j0+85JAGppt16cr1Whg6KIbb4okU6Mql6BOj+uup/wKeA==", "string_decoder-MIT.txt"],
  ["util", "0.12.5", "sha512-kZf/K6hEIrWHI6XqOFUiiMa+79wE/D8Q+NCNAWclkyg3b4d2k7s0QGepNjiABc+aR3N1PAyHL7p6UcLY6LmrnA==", "util-MIT.txt"],
];

const licenseFiles = [
  ["react-native-quick-crypto-MIT.txt", "23a40842fe81de8bb8046e58abc393c2eb6b364989d7c5834cbd420be38ffbb7", null],
  ["react-native-nitro-modules-MIT.txt", "833ee7046f3908173364391ad4a2028560029503faf3a29e8acb77506dfe52ea", null],
  ["react-native-quick-base64-MIT.txt", "cce0924a5108e418fdab4317777387e8fbeaf4abfae06d66fbb4314fba3bbcb8", "react-native-quick-base64/LICENSE"],
  ["expo-build-properties-MIT.txt", "fb3ca4a837f5779e83cef89b78253a8949cfb9429c340309f62d0465ec6610b4", "expo-build-properties/LICENSE"],
  ["expo-crypto-MIT.txt", "fb3ca4a837f5779e83cef89b78253a8949cfb9429c340309f62d0465ec6610b4", "expo-crypto/LICENSE"],
  ["craftzdog-react-native-buffer-MIT.txt", "ed2e878b5cbcda860c7640ce99838e3d83d7cf5e8ad31fc57c11f313b685ae00", "@craftzdog/react-native-buffer/LICENSE"],
  ["events-MIT.txt", "631987b7616a325a5b97566c232418481ddf7dbb5ecadefb991e791876cc2599", "events/LICENSE"],
  ["readable-stream-MIT.txt", "ec62dc96da0099b87f4511736c87309335527fb7031639493e06c95728dc8c54", "readable-stream/LICENSE"],
  ["safe-buffer-MIT.txt", "c7cc929b57080f4b9d0c6cf57669f0463fc5b39906344dfc8d3bc43426b30eac", "safe-buffer/LICENSE"],
  ["string_decoder-MIT.txt", "11f2aafb37d06b3ee5bdaf06e9811141d0da05263c316f3d627f45c20d43261b", "string_decoder/LICENSE"],
  ["util-MIT.txt", "6239c6144c31e58cf925c34483606969c555574d64ffa96518ab5d7f45c75d43", "util/LICENSE"],
  ["ncrypto-MIT.txt", "6b44642e301e561e683a3874ac3c300780fd18f851191f988d12a144d0d482f7", "react-native-quick-crypto/deps/ncrypto/LICENSE"],
  ["simdutf-MIT.txt", "fc8dbc04e03ad4efc08a647ffe7f995b811a95bc04c0e85a56d5277c6593fa5f", "react-native-quick-crypto/deps/simdutf/LICENSE-MIT"],
  ["simdutf-Apache-2.0.txt", "3d34610fc6b5e1b0bfe4e2f36171c2d62c28ef05cb8d704f5a0073be41a43b3d", "react-native-quick-crypto/deps/simdutf/LICENSE-APACHE"],
  ["blake3-Apache-2.0.txt", "00fcc7a934ddbc9ece2a7cc063ac788e284b703b1d705ccbba72d462aa97921e", "react-native-quick-crypto/deps/blake3/LICENSE_A2"],
  ["blake3-Apache-2.0-LLVM-exception.txt", "a5695f57ea0c221e0e8b7d784ff774c35e88c3d3270353646a925880bb3492cc", "react-native-quick-crypto/deps/blake3/LICENSE_A2LLVM"],
  ["blake3-CC0-1.0.txt", "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499", "react-native-quick-crypto/deps/blake3/LICENSE_CC0"],
  ["fastpbkdf2-CC0-notice.txt", "5c6a682c677b94448e41ba048a740f604b8638254ae9090c40aedd443ff67126", null],
  ["quick-crypto-base64-notice.txt", "0c3b60e3c1a56e073cc4b0fdeae2efe5fbddb9b968754f695fd4337fa350e4c5", null],
  ["openssl-Apache-2.0.txt", "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a", null],
  ["openssl-ACKNOWLEDGEMENTS.md", "58dee45791f007ced048114717f86672778fe75c551827c57e760861446ce3c3", null],
];

const quickRuntimeDependencies = [
  "@craftzdog/react-native-buffer",
  "events",
  "readable-stream",
  "safe-buffer",
  "string_decoder",
  "util",
];

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function packagePath(name) {
  return `node_modules/${name}`;
}

async function check() {
  const failures = [];
  const [lock, manifest, notices, gradle, podspec] = await Promise.all([
    readFile(join(root, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    readFile(join(root, "node_modules/react-native-quick-crypto/android/build.gradle"), "utf8"),
    readFile(join(root, "node_modules/react-native-quick-crypto/QuickCrypto.podspec"), "utf8"),
  ]);

  for (const [name, version, integrity, licenseFile] of packages) {
    const locked = lock.packages?.[packagePath(name)];
    if (locked?.version !== version) failures.push(`${name} version mismatch`);
    if (locked?.integrity !== integrity) failures.push(`${name} integrity mismatch`);
    if (locked?.license !== "MIT") failures.push(`${name} lock license is not MIT`);
    for (const token of [`${name}@${version}`, integrity, licenseFile]) {
      if (!notices.includes(token)) failures.push(`THIRD_PARTY_NOTICES.md omits ${token}`);
    }
  }

  for (const name of [
    "react-native-quick-crypto",
    "react-native-nitro-modules",
    "react-native-quick-base64",
    "expo-build-properties",
    "expo-crypto",
  ]) {
    const expected = packages.find(([candidate]) => candidate === name)?.[1];
    if (manifest.dependencies?.[name] !== expected) failures.push(`package.json does not pin ${name}@${expected}`);
  }

  const quick = lock.packages?.[packagePath("react-native-quick-crypto")];
  const runtimeNames = Object.keys(quick?.dependencies ?? {}).sort();
  if (JSON.stringify(runtimeNames) !== JSON.stringify([...quickRuntimeDependencies].sort())) {
    failures.push("Quick Crypto runtime dependency set is not the approved six-package set");
  }

  for (const [file, expectedHash, installedPath] of licenseFiles) {
    const committedPath = join(root, "third-party-licenses", file);
    let committedHash;
    try {
      committedHash = await sha256(committedPath);
    } catch {
      failures.push(`missing third-party license file ${file}`);
      continue;
    }
    if (committedHash !== expectedHash) failures.push(`${file} hash mismatch`);
    if (!notices.includes(file) || !notices.includes(expectedHash)) {
      failures.push(`THIRD_PARTY_NOTICES.md does not bind ${file} to ${expectedHash}`);
    }
    if (installedPath !== null) {
      try {
        if (await sha256(join(root, "node_modules", installedPath)) !== expectedHash) {
          failures.push(`${file} does not match the installed package source`);
        }
      } catch {
        failures.push(`installed license source is missing for ${file}`);
      }
    }
  }

  if (!gradle.includes("io.github.ronickg:openssl:3.6.2-1")) failures.push("Android OpenSSL coordinate mismatch");
  if (!podspec.includes('s.dependency "OpenSSL-Universal", "~> 3.6.2000"')) failures.push("iOS OpenSSL coordinate mismatch");
  if (!notices.includes("io.github.ronickg:openssl:3.6.2-1")) failures.push("Android OpenSSL coordinate missing from notices");
  if (!notices.includes("OpenSSL-Universal ~> 3.6.2000")) failures.push("iOS OpenSSL coordinate missing from notices");

  const nobleEntries = Object.keys(lock.packages ?? {}).filter((name) => name.includes("@noble/"));
  if (nobleEntries.length > 0) failures.push("Noble packages remain in the G016 lockfile");

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    packageIdentities: packages.length,
    retainedLicenseFiles: licenseFiles.length,
    quickCryptoRuntimeDependencies: quickRuntimeDependencies.length,
  };
}

let result;
try {
  result = await check();
} catch (error) {
  result = { status: "FAIL", failures: [error instanceof Error ? error.message : String(error)] };
}
process.stdout.write(PREFIX + JSON.stringify(result) + "\n");
if (result.status !== "PASS") process.exitCode = 1;
