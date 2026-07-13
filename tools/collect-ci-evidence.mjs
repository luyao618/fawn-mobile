import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateResolvedConfigs } from "./check-app-config.mjs";
import { validateFaultBundleProof } from "./check-fault-bundles.mjs";
import { inspectNativeScheme, NATIVE_EVIDENCE_PATHS } from "./check-native-schemes.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const CLEAN_REPOSITORY_STATUS_ARGS = ["status", "--porcelain=v1", "--untracked-files=all"];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function command(commandName, args) {
  const result = spawnSync(commandName, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateCommonReport(report, reportType, platform, flavor, expectedSha) {
  assert(report && typeof report === "object" && !Array.isArray(report), `${reportType} ${flavor} report is malformed`);
  assert.equal(report.schemaVersion, 1, `${reportType} ${flavor} report schema is invalid`);
  assert.equal(report.reportType, reportType, `${flavor} report type is invalid`);
  assert.equal(report.platform, platform, `${reportType} ${flavor} report platform is invalid`);
  assert.equal(report.flavor, flavor, `${reportType} report flavor is invalid`);
  assert.equal(report.checkedOutSha, expectedSha, `${reportType} ${flavor} checked-out SHA disagrees`);
  assert.equal(report.expectedSha, expectedSha, `${reportType} ${flavor} expected SHA disagrees`);
}

export function assertCleanTrackedStatus(status) {
  assert.equal(status, "", "Evidence collection requires a clean worktree and index, including nonignored untracked files");
}

export function validateTestResultInput(status, path, bytes) {
  assert.equal(status, "pass", "--test-result pass is required");
  assert(path, "--test-result-file is required");
  assert(bytes.length > 0, "--test-result-file must be nonempty");
  return {
    status,
    file: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

export function collectFaultBundleEvidence(proof, bundles) {
  return { proof, bundles };
}

export async function validateNativeReports({ platform, expectedSha, configReports, schemeReports, root = repoRoot }) {
  assert(["android", "ios"].includes(platform), "Native evidence platform must be android or ios");
  const canonicalPaths = NATIVE_EVIDENCE_PATHS[platform];
  for (const flavor of ["production", "e2e"]) {
    validateCommonReport(configReports?.[flavor], "resolved-app-config", platform, flavor, expectedSha);
    const config = configReports[flavor].config;
    assert(config && typeof config === "object" && !Array.isArray(config), `${flavor} resolved config is absent`);
    assert.equal(configReports[flavor].configSha256, hashJson(config), `${flavor} resolved config hash is invalid`);
  }
  validateResolvedConfigs(configReports.production.config, configReports.e2e.config);

  const summary = { config: {}, scheme: {}, nativeFiles: {} };
  for (const flavor of ["production", "e2e"]) {
    const configReport = configReports[flavor];
    const schemeReport = schemeReports?.[flavor];
    validateCommonReport(schemeReport, "native-scheme", platform, flavor, expectedSha);
    const canonicalPath = canonicalPaths[flavor];
    assert.equal(schemeReport.nativeInput?.path, canonicalPath, `${flavor} native input path is noncanonical`);
    const inspected = await inspectNativeScheme(platform, flavor, resolve(root, canonicalPath));
    assert.equal(schemeReport.nativeInput?.sha256, inspected.nativeInputSha256, `${flavor} native input hash disagrees with retained bytes`);
    assert.equal(schemeReport.scheme, inspected.structure.scheme, `${flavor} structural scheme name is invalid`);
    assert.equal(schemeReport.count, inspected.structure.count, `${flavor} structural scheme count is invalid`);
    assert.equal(schemeReport.placement, inspected.structure.placement, `${flavor} structural scheme placement is invalid`);
    summary.config[flavor] = { configSha256: configReport.configSha256 };
    summary.scheme[flavor] = { count: inspected.structure.count, placement: inspected.structure.placement };
    summary.nativeFiles[flavor] = { path: canonicalPath, sha256: inspected.nativeInputSha256 };
  }
  return summary;
}

async function loadReport(path) {
  assert(path, "Required CI report path is absent");
  let report;
  try {
    report = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Required CI report is absent or malformed: ${path}`, { cause: error });
  }
  return { path, sha256: await sha256(path), report };
}

async function main() {
  const output = resolve(option("--output", ".artifacts/ci-evidence.json"));
  const expectedSha = option("--expected-sha", process.env.EXPECTED_SHA);
  const checkedOutSha = command("git", ["rev-parse", "HEAD"]);
  assert(checkedOutSha, "Unable to read checked-out SHA");
  assert(expectedSha, "Expected SHA is required");
  assert.equal(checkedOutSha, expectedSha, "Evidence checkout does not match expected SHA");
  const trackedStatus = command("git", CLEAN_REPOSITORY_STATUS_ARGS);
  assert.notEqual(trackedStatus, null, "Unable to inspect tracked worktree and index status");
  assertCleanTrackedStatus(trackedStatus);

  const testResultPath = option("--test-result-file", null);
  let testResultBytes;
  try {
    assert(testResultPath, "--test-result-file is required");
    testResultBytes = await readFile(testResultPath);
  } catch (error) {
    throw new Error(`Required test result file is absent: ${testResultPath ?? "<missing>"}`, { cause: error });
  }
  const testResult = validateTestResultInput(option("--test-result", null), testResultPath, testResultBytes);

  const platform = option("--platform", process.platform);
  const flavor = option("--flavor", "static");
  let reports = null;
  let nativeFiles = null;
  let faultBundles = null;
  if (platform === "host") {
    assert.equal(flavor, "static", "Host evidence must represent static gates");
    const faultBundleProof = await loadReport(option("--fault-bundle-proof", null));
    const bundles = await validateFaultBundleProof(faultBundleProof.report, { root: repoRoot, expectedSha });
    faultBundles = collectFaultBundleEvidence({ path: faultBundleProof.path, sha256: faultBundleProof.sha256 }, bundles);
  }
  if (["android", "ios"].includes(platform)) {
    assert.equal(flavor, "e2e", "Native evidence must represent the final E2E flavor");
    const configProduction = await loadReport(option("--config-report-production", null));
    const configE2e = await loadReport(option("--config-report-e2e", null));
    const schemeProduction = await loadReport(option("--scheme-report-production", null));
    const schemeE2e = await loadReport(option("--scheme-report-e2e", null));
    const validated = await validateNativeReports({
      platform,
      expectedSha,
      configReports: { production: configProduction.report, e2e: configE2e.report },
      schemeReports: { production: schemeProduction.report, e2e: schemeE2e.report },
    });
    reports = {
      config: { production: configProduction, e2e: configE2e },
      scheme: { production: schemeProduction, e2e: schemeE2e },
    };
    for (const group of Object.values(reports)) for (const entry of Object.values(group)) delete entry.report;
    nativeFiles = validated.nativeFiles;
  }
  const evidence = {
    schemaVersion: 4,
    checkedOutSha,
    expectedSha,
    platform,
    flavor,
    testResult,
    packageLockSha256: await sha256("package-lock.json"),
    knowledgeManifestSha256: {
      public: await sha256("knowledge/manifest.public.yaml"),
      private: await sha256("knowledge/manifest.private.yaml"),
      source: await sha256("knowledge/sources/who-growth/source-manifest.json"),
    },
    nativeFiles,
    reports,
    faultBundles,
    runner: {
      os: process.env.RUNNER_OS ?? process.platform,
      arch: process.env.RUNNER_ARCH ?? process.arch,
      image: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      runnerName: process.env.RUNNER_NAME ?? null,
    },
    node: process.version,
    xcode: process.platform === "darwin" ? command("xcodebuild", ["-version"]) : null,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ evidence: "pass", output, checked_out_sha: checkedOutSha, test_result_sha256: testResult.file.sha256 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
