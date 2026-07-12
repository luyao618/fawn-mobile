import { spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const source = resolve(new URL("../spikes/model-transport", import.meta.url).pathname);
const temporary = await realpath(await mkdtemp(resolve(tmpdir(), "g017-expo-doctor-")));
const excluded = new Set(["node_modules", ".expo", ".expo-export", "android", "ios"]);
const placeholderFingerprint = "0".repeat(64);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: temporary,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_config_loglevel: "warn", ...options.env },
  });
  if (result.error) throw result.error;
  if (options.capture && options.print !== false) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  return result;
}

function hermesCompiler() {
  const binary = process.platform === "darwin" ? "osx-bin/hermesc" : process.platform === "linux" ? "linux64-bin/hermesc" : "win64-bin/hermesc.exe";
  return resolve(temporary, "node_modules/hermes-compiler/hermesc", binary);
}

async function verifyExport(platform) {
  const output = resolve(temporary, `.expo-export/${platform}`);
  run("npx", ["expo", "export", "--platform", platform, "--output-dir", output, "--clear"], {
    env: { EXPO_PUBLIC_G017_SOURCE_FINGERPRINT: placeholderFingerprint },
  });
  const metadata = JSON.parse(await readFile(resolve(output, "metadata.json"), "utf8"));
  const bundlePath = metadata.fileMetadata?.[platform]?.bundle;
  if (typeof bundlePath !== "string" || !new RegExp(`^_expo/static/js/${platform}/index-[a-f0-9]{32}\\.hbc$`).test(bundlePath)) {
    throw new Error(`${platform} isolated export did not produce a canonical Hermes bundle`);
  }
  const bundle = resolve(output, bundlePath);
  if (!(await lstat(bundle)).isFile()) throw new Error(`${platform} isolated Hermes bundle is not a regular file`);
  const inspected = run(hermesCompiler(), ["-dump-bytecode", bundle], { capture: true, print: false });
  if (!/Bytecode File Information|Function<global>/i.test(`${inspected.stdout}\n${inspected.stderr}`)) {
    throw new Error(`${platform} isolated export was not parseable Hermes bytecode`);
  }
  return bundlePath;
}

try {
  await cp(source, temporary, {
    recursive: true,
    filter(path) {
      return path === source || !excluded.has(basename(path));
    },
  });
  run("npm", ["ci", "--ignore-scripts", "--workspaces=false"]);
  const doctor = run("npx", ["expo-doctor", "--verbose"], { capture: true });
  if (!/20\/20 checks passed\./.test(`${doctor.stdout}\n${doctor.stderr}`)) {
    throw new Error("isolated expo-doctor did not report 20/20 checks passed");
  }
  const androidBundle = await verifyExport("android");
  const iosBundle = await verifyExport("ios");
  console.log(JSON.stringify({
    expo_doctor: "pass",
    mode: "isolated",
    checks: "20/20",
    exports: { android: androidBundle, ios: iosBundle },
    hermes_bytecode: "validated",
  }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
