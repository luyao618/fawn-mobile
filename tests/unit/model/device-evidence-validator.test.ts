import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  G017_SOURCE_PATHS,
  computeG017SourceFingerprint,
  hermesCompilerPath,
  validateExportArtifact,
  validateG017Evidence,
  validateProofText,
} from "../../../spikes/model-transport/deviceEvidenceValidator.mjs";
import {
  AUDIT_TRANSIENT_CODES,
  classifyRetryableAuditEnvelope,
  executeAuditScope,
  failAudit,
  validateAuditCounts,
} from "../../../tools/audit-execution.mjs";

const EXACT_G017_SOURCE_PATHS = [
  "spikes/model-transport/App.tsx",
  "spikes/model-transport/app.json",
  "spikes/model-transport/deviceEvidenceValidator.mjs",
  "spikes/model-transport/index.ts",
  "spikes/model-transport/metro.config.cjs",
  "spikes/model-transport/package-lock.json",
  "spikes/model-transport/package.json",
  "spikes/model-transport/README.md",
  "spikes/model-transport/plugins/withLocalMockNetwork.cjs",
  "spikes/model-transport/src/adapter.ts",
  "spikes/model-transport/src/contracts.ts",
  "spikes/model-transport/src/deviceProof.ts",
  "spikes/model-transport/src/sse.ts",
  "spikes/model-transport/src/url.ts",
  "spikes/model-transport/tsconfig.json",
  "tests/fixtures/providers/chat-completions/malformed-json.sse",
  "tests/fixtures/providers/chat-completions/premature-eof.sse",
  "tests/fixtures/providers/chat-completions/profile-a.sse",
  "tests/fixtures/providers/chat-completions/profile-b.sse",
  "tests/fixtures/providers/mockCompatibleServer.ts",
  "tests/unit/model/device-evidence-validator.test.ts",
  "tests/unit/model/provider-contract.test.ts",
  "tests/unit/model/sse-parser.test.ts",
  "tests/unit/model/transport-lifecycle.test.ts",
  "tests/unit/tooling/redaction.test.ts",
  "tests/unit/tooling/typecheck-fixture-lifecycle.test.ts",
  "tools/check-audit.mjs",
  "tools/audit-execution.mjs",
  "tools/check-licenses.mjs",
  "tools/export-g017.mjs",
  "tools/redaction.d.mts",
  "tools/redaction.mjs",
  "tools/start-mock-provider.mts",
  "dependencies.slice0.lock.json",
  "licenses.slice0.json",
] as const;

const EXACT_AUDIT_SCOPES = [
  ["sqlite-fts-production", "../spikes/sqlite-fts"],
  ["backup-crypto-production", "../spikes/backup-crypto"],
  ["model-transport-production", "../spikes/model-transport"],
] as const;
const EXACT_AUDIT_OPTIONS = ["audit", "--omit=dev", "--workspaces=false", "--json"] as const;
const EXACT_APP_AUDIT_OPTIONS = ["audit", "--omit=dev", "--workspaces=false", "--include-workspace-root", "--json"] as const;
const EXACT_AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
const EXACT_AUDIT_CONSTANT_SOURCE = `const AUDIT_SCOPES = Object.freeze([
  Object.freeze(["sqlite-fts-production", "../spikes/sqlite-fts"]),
  Object.freeze(["backup-crypto-production", "../spikes/backup-crypto"]),
  Object.freeze(["model-transport-production", "../spikes/model-transport"]),
]);
const AUDIT_OPTIONS = Object.freeze(["audit", "--omit=dev", "--workspaces=false", "--json"]);
const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);`;
const EXACT_APP_AUDIT_CONSTANT_SOURCE = `const APP_AUDIT_SCOPE = "root-app-production";
const APP_AUDIT_OPTIONS = Object.freeze(["audit", "--omit=dev", "--workspaces=false", "--include-workspace-root", "--json"]);`;
const EXACT_AUDIT_SCRIPTS = {
  "test:audit:slice0": "node tools/check-audit.mjs",
  "test:audit:app": "node tools/check-app-audit.mjs",
  "test:audit": "npm run test:audit:slice0 && npm run test:audit:app",
} as const;
const EXACT_STATIC_CI_NPM_GUARD = `          test "$(npm --version)" = "10.9.3"`;
const AUDIT_COUNTS_BY_DIRECTORY = {
  "sqlite-fts": { info: 0, low: 1, moderate: 2, high: 0, critical: 0, total: 3 },
  "backup-crypto": { info: 1, low: 0, moderate: 3, high: 0, critical: 0, total: 4 },
  "model-transport": { info: 2, low: 1, moderate: 4, high: 0, critical: 0, total: 7 },
} as const;
const APP_AUDIT_COUNTS = { info: 0, low: 1, moderate: 2, high: 0, critical: 0, total: 3 } as const;
const ZERO_AUDIT_COUNTS = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } as const;
const AUDIT_DEPENDENCY_COUNTS = { prod: 24, dev: 0, optional: 2, peer: 1, peerOptional: 0, total: 27 } as const;
const QUICK_AUDIT_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/audits/quick";
const BULK_AUDIT_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const TRANSIENT_AUDIT_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "EADDRINUSE",
  "ETIMEDOUT",
  "ECONNECTIONTIMEOUT",
  "EIDLETIMEOUT",
  "ERESPONSETIMEOUT",
  "ETRANSFERTIMEOUT",
] as const;
type TransientAuditCode = typeof TRANSIENT_AUDIT_CODES[number];
const REAL_NPM_10_9_3_TRANSPORT_REASONS = {
  ECONNRESET: "write ECONNRESET",
  ECONNREFUSED: "connect ECONNREFUSED 104.16.0.34:443",
  EADDRINUSE: "bind EADDRINUSE 127.0.0.1:49152",
  ETIMEDOUT: "connect ETIMEDOUT 104.16.0.34:443",
  ECONNECTIONTIMEOUT: "Timeout connecting to host `registry.npmjs.org:443`",
  EIDLETIMEOUT: "Idle timeout reached for host `registry.npmjs.org:443`",
  ERESPONSETIMEOUT: "Response timeout connecting to host `registry.npmjs.org`",
  ETRANSFERTIMEOUT: "Transfer timeout for `registry.npmjs.org`",
} as const satisfies Record<TransientAuditCode, string>;
const REAL_NPM_10_9_3_ECONNRESET_REASONS = [
  "socket hang up",
  "read ECONNRESET",
  "write ECONNRESET",
  "connect ECONNRESET 104.16.0.34:443",
  "connect ECONNRESET 2606:4700::6810:22:443",
] as const;
const PRIVATE_SENTINELS = [
  "PRIVATE_MESSAGE_SENTINEL",
  "PRIVATE_HEADER_SENTINEL",
  "PRIVATE_BODY_SENTINEL",
  "PRIVATE_STDERR_SENTINEL",
  "PRIVATE_LOG_PATH_SENTINEL",
  "private-package-sentinel",
  "private-package-sentinel@9.9.9",
  "private-user-sentinel",
] as const;
const NPM_ERROR_FOOTER = Object.freeze({ summary: "", detail: "" });
const AUDIT_EVIDENCE_KEYS = [
  "elapsedMs",
  "stderrBytes",
  "stderrSha256",
  "stdoutBytes",
  "stdoutSha256",
] as const;
const REQUIRED_LINT_PATHS = [
  "tools/audit-execution.mjs",
  "tools/check-audit.mjs",
  "tools/check-app-audit.mjs",
  "tests/unit/model/device-evidence-validator.test.ts",
] as const;

type AuditChecker = "slice0" | "app";
type AuditCall = { cwd: string; argv: readonly string[] };
type FakeAuditResponse = {
  type?: "report" | "raw" | "signal";
  stdout?: string;
  stderr?: string;
  status?: number;
  report?: unknown;
};

function assertAuditSourceContract(source: string): void {
  assert.equal(source.split(EXACT_AUDIT_CONSTANT_SOURCE).length - 1, 1, "Audit constants must remain exact and deeply frozen");
  assert.equal((source.match(/for \(const \[scope, relativePath\] of AUDIT_SCOPES\)/g) ?? []).length, 1, "Audit scopes must drive exactly one loop");
  assert.equal((source.match(/executeAuditScope\(scope, \(\) => spawnSync\("npm", AUDIT_OPTIONS, \{/g) ?? []).length, 1, "The shared audit execution contract must own the exact npm invocation");
  assert.equal((source.match(/cwd: new URL\(relativePath, import\.meta\.url\),/g) ?? []).length, 1, "Audit scope path must drive the npm cwd");
}

function assertAppAuditSourceContract(source: string): void {
  assert.equal(source.split(EXACT_APP_AUDIT_CONSTANT_SOURCE).length - 1, 1, "App audit constants must remain exact and frozen");
  assert.equal((source.match(/executeAuditScope\(APP_AUDIT_SCOPE, \(\) => spawnSync\("npm", APP_AUDIT_OPTIONS, \{/g) ?? []).length, 1, "The app audit checker must use the shared execution contract exactly once");
  assert.equal((source.match(/cwd: new URL\("\.\.", import\.meta\.url\),/g) ?? []).length, 1, "The app audit cwd must remain the repository root");
}

function assertAuditScriptContract(scripts: Record<string, string>): void {
  assert.deepEqual({
    "test:audit:slice0": scripts["test:audit:slice0"],
    "test:audit:app": scripts["test:audit:app"],
    "test:audit": scripts["test:audit"],
  }, EXACT_AUDIT_SCRIPTS, "Audit scripts must run the exact slice0 then app chain");
}

function assertStaticCiNpmVersionGuard(source: string): void {
  assert.equal(source.split(EXACT_STATIC_CI_NPM_GUARD).length - 1, 1, "Static CI must require exact npm 10.9.3 once");
  const setupNode = source.indexOf("node-version: 22.18.0");
  const staticPreflight = source.indexOf("      - name: Preflight frozen native tooling");
  const npmGuard = source.indexOf(EXACT_STATIC_CI_NPM_GUARD);
  const staticInstall = source.indexOf("      - run: npm ci --workspaces --include-workspace-root");
  assert(setupNode >= 0 && setupNode < staticPreflight && staticPreflight < npmGuard && npmGuard < staticInstall, "The npm guard must run inside preflight after setup-node and before static installation");
}

function assertAuditLintOwnership(lint: string): void {
  const lintPaths = new Set(lint.split(/\s+/));
  for (const path of REQUIRED_LINT_PATHS) assert(lintPaths.has(path), `${path} must remain owned by npm run lint`);
  assert(!lintPaths.has("spikes/model-transport/deviceEvidenceValidator.mjs"), "The spike validator must remain intentionally excluded from root ESLint");
}

function assertExactAuditCalls(actual: readonly AuditCall[], expected: readonly AuditCall[]): void {
  assert.deepEqual(actual, expected, "Audit CLI calls must preserve exact ordered cwd/argv values");
}

async function readAuditCalls(logPath: string): Promise<AuditCall[]> {
  const source = await readFile(logPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return source.trim() === ""
    ? []
    : source.trim().split("\n").map((line) => JSON.parse(line) as AuditCall);
}

function checkerPath(checker: AuditChecker, root = resolve(".")): string {
  return resolve(root, checker === "slice0" ? "tools/check-audit.mjs" : "tools/check-app-audit.mjs");
}

async function runAuditCli(
  root: string,
  pathValue: string,
  name: string,
  checker: AuditChecker,
  responses: readonly FakeAuditResponse[] = [],
  checkerRoot = resolve("."),
) {
  const logPath = join(root, `${checker}-${name.replace(/[^a-z0-9-]/gi, "-")}.jsonl`);
  const result = spawnSync(process.execPath, [checkerPath(checker, checkerRoot)], {
    cwd: resolve("."),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: pathValue,
      FAKE_NPM_LOG: logPath,
      FAKE_NPM_RESPONSES: JSON.stringify(responses),
    },
  });
  return { result, calls: await readAuditCalls(logPath) };
}

async function expectedAuditCalls(checker: AuditChecker, root = resolve(".")): Promise<AuditCall[]> {
  if (checker === "app") {
    return [{ cwd: await realpath(root), argv: [...EXACT_APP_AUDIT_OPTIONS] }];
  }
  return Promise.all(EXACT_AUDIT_SCOPES.map(async ([, relativePath]) => ({
    cwd: await realpath(resolve(root, "tools", relativePath)),
    argv: [...EXACT_AUDIT_OPTIONS],
  })));
}

function stdoutResponse(value: unknown, status = 1, stderr = ""): FakeAuditResponse {
  return { type: "raw", stdout: typeof value === "string" ? value : JSON.stringify(value), status, stderr };
}

function httpAuditEnvelope(statusCode: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: `PRIVATE_MESSAGE_SENTINEL ${statusCode}`,
    method: "POST",
    uri: QUICK_AUDIT_ENDPOINT,
    headers: {
      "x-private-header": ["PRIVATE_HEADER_SENTINEL"],
      authorization: ["Bearer PRIVATE_HEADER_SENTINEL"],
    },
    statusCode,
    body: {
      error: "PRIVATE_BODY_SENTINEL 宝宝",
      dependencyTree: "private-package-sentinel@9.9.9",
      npmLogPath: "PRIVATE_LOG_PATH_SENTINEL",
    },
    error: { ...NPM_ERROR_FOOTER },
    ...overrides,
  };
}

function transportAuditReason(reason: string, endpoint = QUICK_AUDIT_ENDPOINT): Record<string, unknown> {
  return {
    message: `request to ${endpoint} failed, reason: ${reason}`,
    error: { ...NPM_ERROR_FOOTER },
  };
}

function transportAuditEnvelope(code: TransientAuditCode, endpoint = QUICK_AUDIT_ENDPOINT): Record<string, unknown> {
  return transportAuditReason(REAL_NPM_10_9_3_TRANSPORT_REASONS[code], endpoint);
}

function validAuditReport(counts: Readonly<Record<string, number>>) {
  const vulnerabilities: Record<string, unknown> = {};
  let index = 0;
  for (const severity of EXACT_AUDIT_SEVERITIES) {
    for (let entry = 0; entry < counts[severity]; entry += 1) {
      index += 1;
      const name = `private-package-sentinel-${index}`;
      vulnerabilities[name] = {
        name,
        severity,
        isDirect: index % 2 === 0,
        via: index % 2 === 0 ? ["PRIVATE_BODY_SENTINEL"] : [{
          source: 1_000_000 + index,
          name,
          dependency: name,
          title: "PRIVATE_BODY_SENTINEL",
          url: `https://github.com/advisories/GHSA-private-${index}`,
          severity,
          cwe: ["CWE-PRIVATE_SENTINEL"],
          cvss: { score: 5.3, vectorString: "CVSS:3.1/PRIVATE_SENTINEL" },
          range: `<${index}.0.0`,
        }],
        effects: [],
        range: `<${index}.0.0`,
        nodes: [`node_modules/${name}`],
        fixAvailable: index % 2 === 0 ? false : {
          name,
          version: `${index}.0.0`,
          isSemVerMajor: false,
        },
      };
    }
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { ...counts },
      dependencies: { ...AUDIT_DEPENDENCY_COUNTS } as Record<string, number>,
    },
  };
}

function mutateFirstVulnerability(mutate: (value: Record<string, unknown>) => void) {
  const report = structuredClone(validAuditReport(APP_AUDIT_COUNTS));
  const [name] = Object.keys(report.vulnerabilities);
  const vulnerability = report.vulnerabilities[name];
  assert(vulnerability && typeof vulnerability === "object" && !Array.isArray(vulnerability));
  mutate(vulnerability as Record<string, unknown>);
  return report;
}

function mutateFirstAdvisory(mutate: (value: Record<string, unknown>) => void) {
  return mutateFirstVulnerability((vulnerability) => {
    assert(Array.isArray(vulnerability.via));
    const advisory = vulnerability.via.find((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry));
    assert(advisory);
    mutate(advisory as Record<string, unknown>);
  });
}

function reportWithMetadataCounts(checker: AuditChecker, counts: Record<string, unknown>) {
  const base = validAuditReport(checker === "slice0" ? AUDIT_COUNTS_BY_DIRECTORY["sqlite-fts"] : APP_AUDIT_COUNTS);
  return {
    ...base,
    metadata: {
      ...base.metadata,
      vulnerabilities: { ...counts },
    },
  };
}

function reportWithDependencyCounts(checker: AuditChecker, counts: Record<string, unknown>) {
  const base = validAuditReport(checker === "slice0" ? AUDIT_COUNTS_BY_DIRECTORY["sqlite-fts"] : APP_AUDIT_COUNTS);
  return {
    ...base,
    metadata: {
      ...base.metadata,
      dependencies: { ...counts },
    },
  };
}

function countsWith(checker: AuditChecker, severity: "high" | "critical") {
  const base = checker === "slice0" ? AUDIT_COUNTS_BY_DIRECTORY["sqlite-fts"] : APP_AUDIT_COUNTS;
  return { ...base, [severity]: 1, total: base.total + 1 };
}

function validVulnerabilityReport(checker: AuditChecker, severity: "high" | "critical") {
  return validAuditReport(countsWith(checker, severity));
}

const DEFAULT_AUDIT_REPORTS = Object.freeze({
  "sqlite-fts": validAuditReport(AUDIT_COUNTS_BY_DIRECTORY["sqlite-fts"]),
  "backup-crypto": validAuditReport(AUDIT_COUNTS_BY_DIRECTORY["backup-crypto"]),
  "model-transport": validAuditReport(AUDIT_COUNTS_BY_DIRECTORY["model-transport"]),
});
const DEFAULT_APP_AUDIT_REPORT = Object.freeze(validAuditReport(APP_AUDIT_COUNTS));
const ZERO_AUDIT_REPORT = Object.freeze(validAuditReport(ZERO_AUDIT_COUNTS));

function diagnosticLines(stderr: string): Record<string, unknown>[] {
  return stderr.trim() === ""
    ? []
    : stderr.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertDiagnostic(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  stdout = "",
  stderr = "",
): void {
  const elapsedMs = expected.elapsedMs ?? actual.elapsedMs;
  assert(Number.isSafeInteger(elapsedMs) && Number(elapsedMs) >= 0, "elapsedMs must be a nonnegative safe integer");
  const fullExpected = {
    ...expected,
    elapsedMs,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(fullExpected).sort(), "Audit diagnostics must have the exact fixed schema");
  assert.deepEqual(actual, fullExpected);
  for (const key of AUDIT_EVIDENCE_KEYS) assert(Object.hasOwn(actual, key));
  for (const key of ["stdoutSha256", "stderrSha256"] as const) {
    assert.match(String(actual[key]), /^[a-f0-9]{64}$/);
  }
}

function auditFailureDiagnostic(invoke: () => unknown): Record<string, unknown> {
  let thrown: unknown;
  try {
    invoke();
  } catch (error) {
    thrown = error;
  }
  assert(thrown && typeof thrown === "object" && "diagnostic" in thrown);
  return (thrown as { diagnostic: Record<string, unknown> }).diagnostic;
}

function assertPrivateSentinelsAbsent(result: { stdout: string; stderr: string }): void {
  for (const sentinel of PRIVATE_SENTINELS) {
    assert(!result.stdout.includes(sentinel), "Audit stdout must not expose private process data");
    assert(!result.stderr.includes(sentinel), "Audit stderr must not expose private process data");
  }
}

async function createFakeNpm(root: string): Promise<string> {
  const bin = join(root, "bin");
  const executable = join(bin, "npm");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { basename } = require("node:path");

let prior = "";
try { prior = readFileSync(process.env.FAKE_NPM_LOG, "utf8"); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const callIndex = prior.trim() === "" ? 0 : prior.trim().split("\\n").length;
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}) + "\\n");

const responses = JSON.parse(process.env.FAKE_NPM_RESPONSES || "[]");
const response = responses[callIndex] || { type: "report" };
if (response.stderr) process.stderr.write(response.stderr);
if (response.type === "signal") {
  process.kill(process.pid, "SIGTERM");
} else if (response.type === "raw") {
  process.stdout.write(response.stdout || "");
  process.exitCode = response.status === undefined ? 1 : response.status;
} else {
  const baseReport = ${JSON.stringify(DEFAULT_AUDIT_REPORTS)}[basename(process.cwd())]
    || ${JSON.stringify(DEFAULT_APP_AUDIT_REPORT)};
  const report = response.report === undefined ? baseReport : response.report;
  process.stdout.write(JSON.stringify(report));
  const total = report && report.metadata && report.metadata.vulnerabilities
    ? report.metadata.vulnerabilities.total
    : undefined;
  process.exitCode = response.status === undefined ? (total > 0 ? 1 : 0) : response.status;
}
`);
  await chmod(executable, 0o755);
  return bin;
}

async function createAuditCheckerFixture(root: string, checker: AuditChecker): Promise<string> {
  const fixture = join(root, `checker-${checker}`);
  await mkdir(join(fixture, "tools"), { recursive: true });
  await Promise.all([
    writeFile(join(fixture, "tools/audit-execution.mjs"), await readFile("tools/audit-execution.mjs")),
    writeFile(join(fixture, "tools/check-audit.mjs"), await readFile("tools/check-audit.mjs")),
    writeFile(join(fixture, "tools/check-app-audit.mjs"), await readFile("tools/check-app-audit.mjs")),
  ]);
  if (checker === "slice0") {
    await Promise.all(EXACT_AUDIT_SCOPES.map(([, relativePath]) => mkdir(resolve(fixture, "tools", relativePath), { recursive: true })));
    await writeFile(join(fixture, "licenses.slice0.json"), JSON.stringify({
      audit_policy: { fail_levels: ["high", "critical"], documented_moderate: "not an approved Expo policy" },
    }));
  } else {
    await writeFile(join(fixture, "licenses.app.json"), JSON.stringify({
      audit_policy: { fail_levels: ["high", "critical"], documented_moderate: "" },
    }));
  }
  return fixture;
}

async function observeSocketHangUp(): Promise<NodeJS.ErrnoException> {
  const server = createServer((request) => request.socket.destroy());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    return await new Promise<NodeJS.ErrnoException>((resolveError, rejectError) => {
      const timeout = setTimeout(() => rejectError(new Error("socket hang up fixture timed out")), 2_000);
      const request = httpRequest({ host: "127.0.0.1", port: address.port, path: "/audit" });
      request.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        resolveError(error);
      });
      request.end();
    });
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function proofRecord(platform: "android" | "ios", fingerprint: string) {
  return `G017_TRANSPORT_PROOF ${JSON.stringify({
    schemaVersion: 1,
    contractId: "for-mobile-g017-device-proof-v1",
    status: "PASS",
    platform,
    targetScope: "emulator-or-simulator-local-mock-only",
    release: true,
    hermes: true,
    newArchitecture: true,
    profiles: [
      { profile: "profile-a", content: "profile-a ok" },
      { profile: "profile-b", content: "profile-b 宝宝 ok" },
    ],
    cancellation: "cancelled",
    sourceFingerprint: fingerprint,
    dependencies: { expo: "57.0.4", react: "19.2.3", reactNative: "0.86.0", eventsourceParser: "3.1.0" },
  })}`;
}

function proofLog(
  platform: "android" | "ios",
  fingerprint: string,
  options: { pid?: number; rawTime?: string; observedAt?: string; offset?: string } = {},
) {
  const pid = options.pid ?? (platform === "android" ? 1601 : 1602);
  const rawTime = options.rawTime ?? (platform === "android" ? "07-12 00:00:05.000" : "2026-07-12 00:00:05.000");
  const observedAt = options.observedAt ?? "2026-07-12T00:00:05.100Z";
  const observedMs = Date.parse(observedAt);
  const record = proofRecord(platform, fingerprint);
  const raw = platform === "android"
    ? `${rawTime}  ${pid}  1701 I ReactNativeJS: ${record}`
    : `${rawTime} I FawnG017TransportProof[${pid}:3e8] [com.facebook.react.log:javascript] ${record}`;
  const command = platform === "android" ? "adb shell ps -A -o PID,NAME,ARGS" : "xcrun simctl spawn booted /bin/ps -axo pid=,state=,command=";
  const target = platform === "android" ? "emulator" : "simulator";
  const body = platform === "android"
    ? `  PID NAME ARGS\n ${pid} com.luyao618.fawn.g017transportproof com.luyao618.fawn.g017transportproof`
    : ` ${pid} Ss /Users/test/Containers/Bundle/Application/fixture/FawnG017TransportProof.app/FawnG017TransportProof`;
  return [
    raw,
    `G017_TARGET_UTC_OFFSET ${options.offset ?? "+00:00"}`,
    `G017_PROOF_OBSERVED_AT ${observedAt}`,
    `G017_NATIVE_COMMAND_BEGIN ${JSON.stringify({ id: `${platform}-liveness`, platform, kind: "liveness", phase: "post-proof", pid, startedAt: new Date(observedMs + 900).toISOString(), target, command })}`,
    body,
    `G017_NATIVE_COMMAND_END ${JSON.stringify({ id: `${platform}-liveness`, endedAt: new Date(observedMs + 1_000).toISOString(), exitCode: 0 })}`,
    "",
  ].join("\n");
}

async function writeSyntheticArtifact(root: string, platform: "android" | "ios", fingerprint: string) {
  const bundlePath = `_expo/static/js/${platform}/index-${(platform === "android" ? "a" : "b").repeat(32)}.hbc`;
  const directory = join(root, `${platform}-export`);
  const metadata = { version: 0, bundler: "metro", fileMetadata: { [platform]: { bundle: bundlePath, assets: [] } } };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  const embedded = [fingerprint, "57.0.4", "19.2.3", "0.86.0", "3.1.0", "G017_TRANSPORT_PROOF"].join("\0");
  const bundle = Buffer.concat([Buffer.from("c61fbc03c103191f", "hex"), Buffer.from(embedded), Buffer.alloc(110_000, 1)]);
  const manifest = {
    schemaVersion: 1,
    contractId: "for-mobile-g017-expo-export-v1",
    platform,
    sourceFingerprint: fingerprint,
    dependencies: { expo: "57.0.4", react: "19.2.3", reactNative: "0.86.0", eventsourceParser: "3.1.0" },
    metadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
    bundle: { path: bundlePath, bytes: bundle.length, sha256: createHash("sha256").update(bundle).digest("hex"), format: "hermes-bytecode" },
  };
  await mkdir(join(directory, `_expo/static/js/${platform}`), { recursive: true });
  await Promise.all([
    writeFile(join(directory, "metadata.json"), metadataBytes),
    writeFile(join(directory, "g017-proof-manifest.json"), JSON.stringify(manifest)),
    writeFile(join(directory, bundlePath), bundle),
  ]);
  return directory;
}


test("Metro selected resolver values equal Expo defaults with no explicit root fallback", async () => {
  const projectRoot = resolve("spikes/model-transport");
  const spikeRequire = createRequire(resolve(projectRoot, "package.json"));
  const { getDefaultConfig } = spikeRequire("expo/metro-config");
  const config = spikeRequire("./metro.config.cjs");
  const defaults = getDefaultConfig(projectRoot);
  assert.deepEqual(config.watchFolders, defaults.watchFolders);
  assert.deepEqual(config.resolver.nodeModulesPaths, defaults.resolver.nodeModulesPaths);
  assert.equal(config.resolver.disableHierarchicalLookup, defaults.resolver.disableHierarchicalLookup);
  const source = await readFile(resolve(projectRoot, "metro.config.cjs"), "utf8");
  assert.doesNotMatch(source, /workspaceRoot|nodeModulesPaths|disableHierarchicalLookup/);
});

test("platform-shaped proof and retained PID liveness are required", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  assert.deepEqual(validateProofText(proofLog("android", fingerprint), "android", fingerprint), []);
  assert.deepEqual(validateProofText(proofLog("ios", fingerprint), "ios", fingerprint), []);
  assert.match(validateProofText(`${proofRecord("android", fingerprint)}\n`, "android", fingerprint).join("; "), /platform-shaped/);
  assert.match(validateProofText(proofLog("android", fingerprint).replace(" 1601 com.luyao618", " 9999 com.luyao618"), "android", fingerprint).join("; "), /liveness output/);
  assert.match(validateProofText(proofLog("ios", fingerprint).replace("00:00:05.000", "00:02:05.000"), "ios", fingerprint).join("; "), /timestamp/);
});

test("proof logs require exactly one canonical bounded target UTC offset", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  const valid = proofLog("android", fingerprint);
  assert.match(validateProofText(valid.replace("G017_TARGET_UTC_OFFSET +00:00\n", ""), "android", fingerprint).join("; "), /target UTC offset/);
  for (const malformed of ["UTC+08:00", "+8:00", "+14:01", "-12:01", "-00:00"]) {
    assert.match(validateProofText(valid.replace("+00:00", malformed), "android", fingerprint).join("; "), /target UTC offset/);
  }
  assert.match(validateProofText(valid.replace("G017_TARGET_UTC_OFFSET +00:00", "G017_TARGET_UTC_OFFSET +00:00\nG017_TARGET_UTC_OFFSET +00:00"), "android", fingerprint).join("; "), /target UTC offset/);
});

test("UTC+8 and UTC-8 target-local timestamps normalize before observation checks", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  for (const platform of ["android", "ios"] as const) {
    const positiveRaw = platform === "android" ? "07-12 08:00:05.000" : "2026-07-12 08:00:05.000";
    const negativeRaw = platform === "android" ? "07-11 16:00:05.000" : "2026-07-11 16:00:05.000";
    assert.deepEqual(validateProofText(proofLog(platform, fingerprint, { rawTime: positiveRaw, offset: "+08:00" }), platform, fingerprint), []);
    assert.deepEqual(validateProofText(proofLog(platform, fingerprint, { rawTime: negativeRaw, offset: "-08:00" }), platform, fingerprint), []);
  }
});

test("target-local timestamps bind uniquely across a UTC year boundary", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  assert.deepEqual(validateProofText(proofLog("android", fingerprint, {
    rawTime: "01-01 00:00:05.000",
    observedAt: "2025-12-31T16:00:05.100Z",
    offset: "+08:00",
  }), "android", fingerprint), []);
  assert.deepEqual(validateProofText(proofLog("ios", fingerprint, {
    rawTime: "2025-12-31 16:00:05.000",
    observedAt: "2026-01-01T00:00:05.100Z",
    offset: "-08:00",
  }), "ios", fingerprint), []);
});

test("raw local calendars accept leap days and reject impossible rollover dates", async () => {
  const fingerprint = await computeG017SourceFingerprint();
  for (const platform of ["android", "ios"] as const) {
    const leapRaw = platform === "android" ? "02-29 12:00:05.000" : "2028-02-29 12:00:05.000";
    const impossibleRaw = platform === "android" ? "02-30 12:00:05.000" : "2028-02-30 12:00:05.000";
    const options = { observedAt: "2028-02-29T12:00:05.100Z", rawTime: leapRaw };
    assert.deepEqual(validateProofText(proofLog(platform, fingerprint, options), platform, fingerprint), []);
    assert.match(validateProofText(proofLog(platform, fingerprint, { ...options, rawTime: impossibleRaw }), platform, fingerprint).join("; "), /timestamp/);
  }
  assert.match(validateProofText(proofLog("ios", fingerprint, {
    rawTime: "2027-02-29 12:00:05.000",
    observedAt: "2027-03-01T12:00:05.100Z",
  }), "ios", fingerprint).join("; "), /timestamp/);
});

test("fully synthetic artifacts and symlinked proof inputs fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "g017-forged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fingerprint = await computeG017SourceFingerprint();
  const androidLog = join(root, "android.log");
  const iosLog = join(root, "ios.log");
  const linkedAndroidLog = join(root, "android-linked.log");
  await Promise.all([writeFile(androidLog, proofLog("android", fingerprint)), writeFile(iosLog, proofLog("ios", fingerprint))]);
  await symlink(androidLog, linkedAndroidLog);
  const androidArtifact = await writeSyntheticArtifact(root, "android", fingerprint);
  const iosArtifact = await writeSyntheticArtifact(root, "ios", fingerprint);
  const result = await validateG017Evidence({ androidLog: linkedAndroidLog, iosLog, androidArtifact, iosArtifact });
  assert.equal(result.status, "FAIL");
  assert.match(result.failures.join("; "), /non-symlink regular file|canonical Expo export path|Hermes bytecode validation/);
});

test("fresh canonical Android and iOS exports pass Hermes validation and local-consistency evidence", async (t) => {
  const spikeExpo = resolve("spikes/model-transport/.expo");
  const exportRoot = resolve("spikes/model-transport/.expo-export");
  await Promise.all([
    rm(spikeExpo, { recursive: true, force: true }),
    rm(exportRoot, { recursive: true, force: true }),
  ]);
  t.after(() => Promise.all([
    rm(spikeExpo, { recursive: true, force: true }),
    rm(exportRoot, { recursive: true, force: true }),
  ]));
  for (const platform of ["android", "ios"] as const) {
    const exported = spawnSync("npm", ["run", `g017:export:${platform}`, "--silent"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    assert.equal(exported.status, 0, `${platform} export failed: ${exported.stderr}`);
  }
  const fingerprint = await computeG017SourceFingerprint();
  for (const platform of ["android", "ios"] as const) {
    assert.deepEqual(await validateExportArtifact(resolve(exportRoot, platform), platform, fingerprint), []);
  }
  const logs = await mkdtemp(join(tmpdir(), "g017-real-export-"));
  t.after(() => rm(logs, { recursive: true, force: true }));
  const androidLog = join(logs, "android.log");
  const iosLog = join(logs, "ios.log");
  await Promise.all([writeFile(androidLog, proofLog("android", fingerprint)), writeFile(iosLog, proofLog("ios", fingerprint))]);
  const result = await validateG017Evidence({
    androidLog,
    iosLog,
    androidArtifact: resolve(exportRoot, "android"),
    iosArtifact: resolve(exportRoot, "ios"),
  });
  assert.equal(result.status, "PASS", result.failures.join("; "));
});

test("audit retry classifier owns exact npm 10.9.3 message and HTTP allowlists", () => {
  assert.deepEqual(AUDIT_TRANSIENT_CODES, TRANSIENT_AUDIT_CODES);
  for (let statusCode = 100; statusCode <= 699; statusCode += 1) {
    const classified = classifyRetryableAuditEnvelope(httpAuditEnvelope(statusCode));
    const expected = statusCode === 408
      || statusCode === 420
      || statusCode === 429
      || (statusCode >= 500 && statusCode <= 599);
    assert.equal(classified !== null, expected, `HTTP ${statusCode}`);
  }
  for (const code of TRANSIENT_AUDIT_CODES) {
    assert.deepEqual(classifyRetryableAuditEnvelope(transportAuditEnvelope(code)), {
      classification: "registry-transport",
      endpoint: "official-quick",
      code,
    });
  }
  for (const reason of REAL_NPM_10_9_3_ECONNRESET_REASONS) {
    assert.deepEqual(classifyRetryableAuditEnvelope(transportAuditReason(reason)), {
      classification: "registry-transport",
      endpoint: "official-quick",
      code: "ECONNRESET",
    }, reason);
  }
  for (const code of TRANSIENT_AUDIT_CODES.slice(4)) {
    assert(!REAL_NPM_10_9_3_TRANSPORT_REASONS[code].includes(code), `${code} must use npm's serialized message without a synthetic code`);
  }
});

test("G038 audit address parsing rejects non-public and noncanonical connect targets without blocking canonical forms", () => {
  assert.equal(
    classifyRetryableAuditEnvelope(transportAuditReason("connect ECONNREFUSED 100:0:0:1::1:443")),
    null,
    "IANA dummy IPv6 prefix must not be treated as globally reachable",
  );
  for (const address of [
    "2606:4700:0000:0000:0000:0000:6810:0022",
    "2606:4700::6810:22%en0",
  ]) {
    assert.equal(
      classifyRetryableAuditEnvelope(transportAuditReason(`connect ECONNREFUSED ${address}:443`)),
      null,
      address,
    );
  }
  assert.deepEqual(
    classifyRetryableAuditEnvelope(transportAuditReason("connect ECONNREFUSED 2606:4700::6810:22:443")),
    { classification: "registry-transport", endpoint: "official-quick", code: "ECONNREFUSED" },
    "canonical IANA global-unicast IPv6 must remain retryable",
  );
  assert.deepEqual(
    classifyRetryableAuditEnvelope(transportAuditReason("connect ECONNREFUSED 3000::1:443")),
    { classification: "registry-transport", endpoint: "official-quick", code: "ECONNREFUSED" },
    "upper-half global-unicast IPv6 must remain retryable",
  );
  assert.deepEqual(
    classifyRetryableAuditEnvelope(transportAuditReason("connect ECONNREFUSED 64:ff9b::6810:22:443")),
    { classification: "registry-transport", endpoint: "official-quick", code: "ECONNREFUSED" },
    "canonical globally reachable NAT64 IPv6 must remain retryable",
  );
  assert.deepEqual(
    classifyRetryableAuditEnvelope(transportAuditReason("connect ECONNREFUSED 64:ff9b::c801:101:443")),
    { classification: "registry-transport", endpoint: "official-quick", code: "ECONNREFUSED" },
    "upper-half globally reachable NAT64 IPv6 must remain retryable",
  );
  const nonPublicNat64Addresses = [
    "64:ff9b::1",
    "64:ff9b::a00:1",
    "64:ff9b::6440:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:101",
    "64:ff9b::ac10:1",
    "64:ff9b::c000:1",
    "64:ff9b::c000:201",
    "64:ff9b::c058:6301",
    "64:ff9b::c0a8:1",
    "64:ff9b::c612:1",
    "64:ff9b::c633:6401",
    "64:ff9b::cb00:7101",
    "64:ff9b::e000:1",
    "64:ff9b::f000:1",
  ];
  assert.deepEqual(
    nonPublicNat64Addresses.map((address) => (
      classifyRetryableAuditEnvelope(transportAuditReason(`connect ECONNREFUSED ${address}:443`))
    )),
    nonPublicNat64Addresses.map(() => null),
    "NAT64 addresses embedding non-public IPv4 categories must not become retryable",
  );
  assert.deepEqual(
    ["4000::1", "fec0::1"].map((address) => (
      classifyRetryableAuditEnvelope(transportAuditReason(`connect ECONNREFUSED ${address}:443`))
    )),
    [null, null],
    "canonical reserved IPv6 targets must not be treated as globally reachable",
  );
  assert.equal(
    classifyRetryableAuditEnvelope(transportAuditReason("connect ECONNREFUSED 1000::1:443")),
    null,
    "adjacent non-global-unicast IPv6 must not become retryable",
  );
  assert.deepEqual(
    ["64:ff9a::c801:101", "64:ff9b::1:c801:101"].map((address) => (
      classifyRetryableAuditEnvelope(transportAuditReason(`connect ECONNREFUSED ${address}:443`))
    )),
    [null, null],
    "adjacent non-NAT64 IPv6 must not become retryable",
  );
  assert.deepEqual(
    classifyRetryableAuditEnvelope(transportAuditReason("bind EADDRINUSE 127.0.0.1:49152")),
    { classification: "registry-transport", endpoint: "official-quick", code: "EADDRINUSE" },
  );
});

test("G038 audit npm-v2 validation rejects every hostile exact-schema mutation", () => {
  const validStringViaAndBooleanFix = mutateFirstVulnerability((vulnerability) => {
    vulnerability.via = ["private-package-sentinel-metavulnerability"];
    vulnerability.fixAvailable = true;
  });
  assert.deepEqual(
    validateAuditCounts(validStringViaAndBooleanFix, "root-app-production", 1),
    APP_AUDIT_COUNTS,
  );

  const mutateReport = (mutate: (report: Record<string, unknown>) => void): unknown => {
    const report = structuredClone(validAuditReport(APP_AUDIT_COUNTS)) as unknown as Record<string, unknown>;
    mutate(report);
    return report;
  };
  const hostileReports: [string, unknown][] = [
    ["extra top-level key", mutateReport((report) => { report.privateTopLevel = "PRIVATE_BODY_SENTINEL"; })],
    ["extra metadata key", mutateReport((report) => {
      (report.metadata as Record<string, unknown>).privateMetadata = "PRIVATE_BODY_SENTINEL";
    })],
    ["non-object vulnerabilities", mutateReport((report) => { report.vulnerabilities = "PRIVATE_BODY_SENTINEL"; })],
    ["array vulnerabilities", mutateReport((report) => { report.vulnerabilities = []; })],
    ["missing fixAvailable", mutateFirstVulnerability((vulnerability) => { delete vulnerability.fixAvailable; })],
    ["vulnerability key/name mismatch", mutateFirstVulnerability((vulnerability) => { vulnerability.name = "different-package"; })],
    ["invalid vulnerability severity", mutateFirstVulnerability((vulnerability) => { vulnerability.severity = "urgent"; })],
    ["invalid isDirect", mutateFirstVulnerability((vulnerability) => { vulnerability.isDirect = "false"; })],
    ["invalid vulnerability range", mutateFirstVulnerability((vulnerability) => { vulnerability.range = false; })],
    ["via container", mutateFirstVulnerability((vulnerability) => { vulnerability.via = {}; })],
    ["via entry", mutateFirstVulnerability((vulnerability) => { vulnerability.via = [false]; })],
    ["advisory extra key", mutateFirstAdvisory((advisory) => { advisory.privateAdvisory = "PRIVATE_BODY_SENTINEL"; })],
    ["advisory missing key", mutateFirstAdvisory((advisory) => { delete advisory.source; })],
    ["advisory source", mutateFirstAdvisory((advisory) => { advisory.source = Number.MAX_SAFE_INTEGER + 1; })],
    ["negative advisory source", mutateFirstAdvisory((advisory) => { advisory.source = -1; })],
    ["advisory name", mutateFirstAdvisory((advisory) => { advisory.name = false; })],
    ["advisory dependency", mutateFirstAdvisory((advisory) => { advisory.dependency = false; })],
    ["advisory title", mutateFirstAdvisory((advisory) => { advisory.title = false; })],
    ["advisory url", mutateFirstAdvisory((advisory) => { advisory.url = false; })],
    ["advisory severity", mutateFirstAdvisory((advisory) => { advisory.severity = "urgent"; })],
    ["advisory cwe container", mutateFirstAdvisory((advisory) => { advisory.cwe = "CWE-787"; })],
    ["advisory cwe entry", mutateFirstAdvisory((advisory) => { advisory.cwe = [false]; })],
    ["advisory cvss extra key", mutateFirstAdvisory((advisory) => {
      advisory.cvss = { ...(advisory.cvss as Record<string, unknown>), privateScore: "PRIVATE_BODY_SENTINEL" };
    })],
    ["advisory cvss missing key", mutateFirstAdvisory((advisory) => { advisory.cvss = { score: 5.3 }; })],
    ["advisory cvss score", mutateFirstAdvisory((advisory) => {
      advisory.cvss = { score: "5.3", vectorString: "CVSS:3.1/PRIVATE_SENTINEL" };
    })],
    ["advisory cvss below zero", mutateFirstAdvisory((advisory) => {
      advisory.cvss = { score: -0.1, vectorString: "CVSS:3.1/PRIVATE_SENTINEL" };
    })],
    ["advisory cvss above ten", mutateFirstAdvisory((advisory) => {
      advisory.cvss = { score: 10.1, vectorString: "CVSS:3.1/PRIVATE_SENTINEL" };
    })],
    ["advisory cvss vector", mutateFirstAdvisory((advisory) => {
      advisory.cvss = { score: 5.3, vectorString: false };
    })],
    ["advisory range", mutateFirstAdvisory((advisory) => { advisory.range = false; })],
    ["effects container", mutateFirstVulnerability((vulnerability) => { vulnerability.effects = {}; })],
    ["effects entry", mutateFirstVulnerability((vulnerability) => { vulnerability.effects = [false]; })],
    ["nodes container", mutateFirstVulnerability((vulnerability) => { vulnerability.nodes = {}; })],
    ["nodes entry", mutateFirstVulnerability((vulnerability) => { vulnerability.nodes = [false]; })],
    ["fixAvailable null", mutateFirstVulnerability((vulnerability) => { vulnerability.fixAvailable = null; })],
    ["fixAvailable missing key", mutateFirstVulnerability((vulnerability) => {
      vulnerability.fixAvailable = { name: "private-package-sentinel-1", version: "1.0.0" };
    })],
    ["fixAvailable extra key", mutateFirstVulnerability((vulnerability) => {
      vulnerability.fixAvailable = {
        name: "private-package-sentinel-1",
        version: "1.0.0",
        isSemVerMajor: false,
        privateFix: "PRIVATE_BODY_SENTINEL",
      };
    })],
    ["fixAvailable name", mutateFirstVulnerability((vulnerability) => {
      vulnerability.fixAvailable = { name: false, version: "1.0.0", isSemVerMajor: false };
    })],
    ["fixAvailable version", mutateFirstVulnerability((vulnerability) => {
      vulnerability.fixAvailable = { name: "private-package-sentinel-1", version: false, isSemVerMajor: false };
    })],
    ["fixAvailable isSemVerMajor", mutateFirstVulnerability((vulnerability) => {
      vulnerability.fixAvailable = { name: "private-package-sentinel-1", version: "1.0.0", isSemVerMajor: "false" };
    })],
  ];
  for (const key of ["auditReportVersion", "metadata", "vulnerabilities"]) {
    hostileReports.push([`missing top-level ${key}`, mutateReport((report) => { delete report[key]; })]);
  }
  for (const key of ["dependencies", "vulnerabilities"]) {
    hostileReports.push([`missing metadata ${key}`, mutateReport((report) => {
      delete (report.metadata as Record<string, unknown>)[key];
    })]);
  }

  for (const [name, report] of hostileReports) {
    const diagnostic = auditFailureDiagnostic(() => validateAuditCounts(report, "root-app-production", 1));
    assert.equal(diagnostic.classification, "invalid-report", name);
    assertDiagnostic(diagnostic, {
      audit: "failure",
      scope: "root-app-production",
      attempt: 1,
      classification: "invalid-report",
      elapsedMs: 0,
    });
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_|private-package/);
    assert(name.length > 0);
  }
});

test("G038 audit npm-v2 validation accepts inclusive advisory source and CVSS boundaries", () => {
  const boundaryReports = [
    ["source zero", mutateFirstAdvisory((advisory) => { advisory.source = 0; })],
    ["CVSS zero", mutateFirstAdvisory((advisory) => {
      advisory.cvss = { score: 0, vectorString: "CVSS:3.1/PRIVATE_SENTINEL" };
    })],
    ["CVSS ten", mutateFirstAdvisory((advisory) => {
      advisory.cvss = { score: 10, vectorString: "CVSS:3.1/PRIVATE_SENTINEL" };
    })],
  ] as const;

  for (const [name, report] of boundaryReports) {
    assert.doesNotThrow(() => {
      assert.deepEqual(validateAuditCounts(report, "root-app-production", 1), APP_AUDIT_COUNTS);
    }, name);
  }
});

test("audit classifier locks Node's canonical socket hang up ECONNRESET fixture", async () => {
  const observed = await observeSocketHangUp();
  assert.equal(observed.code, "ECONNRESET");
  assert.equal(observed.message, "socket hang up");
  assert.deepEqual(classifyRetryableAuditEnvelope(transportAuditReason(observed.message)), {
    classification: "registry-transport",
    endpoint: "official-quick",
    code: "ECONNRESET",
  });
});

test("audit retry evidence hashes exact UTF-8 captures with deterministic elapsed time", () => {
  const payload = httpAuditEnvelope(503);
  const stdout = JSON.stringify(payload);
  const stderr = "PRIVATE_STDERR_SENTINEL 宝宝";
  const responses = [
    { stdout, stderr, status: 1, signal: null },
    { stdout: JSON.stringify(ZERO_AUDIT_REPORT), stderr: "", status: 0, signal: null },
  ];
  const times = [1_000, 1_037, 2_000, 2_005];
  const emitted: string[] = [];
  let invocation = 0;
  const result = executeAuditScope("root-app-production", () => responses[invocation++], {
    now: () => times.shift(),
    emit: (line: string) => emitted.push(line),
  });
  assert(result);
  assert.equal(result.attempt, 2);
  assert.equal(invocation, 2);
  assert.equal(emitted.length, 1);
  assertDiagnostic(JSON.parse(emitted[0]) as Record<string, unknown>, {
    audit: "retry",
    scope: "root-app-production",
    attempt: 1,
    classification: "registry-http",
    endpoint: "official-quick",
    status: "HTTP_503",
    elapsedMs: 37,
  }, stdout, stderr);
  assert.equal(result.evidence.elapsedMs, 5);
  assert.equal(result.evidence.stdoutSha256, sha256(JSON.stringify(ZERO_AUDIT_REPORT)));
  assert.doesNotMatch(emitted[0], /PRIVATE_|宝宝|registry\.npmjs\.org|private-package/);
});

test("G038 audit evidence retains valid required values while dropping enumerable extras", () => {
  const leakedStdout = "PRIVATE_BODY_SENTINEL raw stdout";
  const leakedStderr = "PRIVATE_STDERR_SENTINEL raw stderr";
  const suppliedEvidence = {
    elapsedMs: 11,
    stdoutBytes: Buffer.byteLength(leakedStdout, "utf8"),
    stderrBytes: Buffer.byteLength(leakedStderr, "utf8"),
    stdoutSha256: sha256(leakedStdout),
    stderrSha256: sha256(leakedStderr),
    rawStdout: leakedStdout,
    nestedToken: { authorization: "PRIVATE_HEADER_SENTINEL" },
  };
  const reconstructed = auditFailureDiagnostic(() => {
    failAudit("root-app-production", 1, "invalid-report", undefined, suppliedEvidence);
  });
  assertDiagnostic(reconstructed, {
    audit: "failure",
    scope: "root-app-production",
    attempt: 1,
    classification: "invalid-report",
    elapsedMs: 11,
  }, leakedStdout, leakedStderr);
  for (const key of AUDIT_EVIDENCE_KEYS) assert.equal(reconstructed[key], suppliedEvidence[key], key);
  assert.doesNotMatch(JSON.stringify(reconstructed), /PRIVATE_|rawStdout|nestedToken|authorization/);
});

test("G038 audit evidence retains valid zero elapsed time with nonzero captured evidence", () => {
  const stdout = "captured stdout";
  const stderr = "captured stderr";
  const suppliedEvidence = {
    elapsedMs: 0,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
  const reconstructed = auditFailureDiagnostic(() => {
    failAudit("root-app-production", 1, "invalid-report", undefined, suppliedEvidence);
  });

  for (const key of AUDIT_EVIDENCE_KEYS) assert.equal(reconstructed[key], suppliedEvidence[key], key);
  assertDiagnostic(reconstructed, {
    audit: "failure",
    scope: "root-app-production",
    attempt: 1,
    classification: "invalid-report",
    elapsedMs: 0,
  }, stdout, stderr);
  assert(Number(reconstructed.stdoutBytes) > 0);
  assert(Number(reconstructed.stderrBytes) > 0);
});

test("G038 audit invalid required evidence matrix falls back to the fixed empty-evidence schema", () => {
  const validEvidence: Record<string, unknown> = {
    elapsedMs: 11,
    stdoutBytes: 19,
    stderrBytes: 23,
    stdoutSha256: sha256("supplied stdout"),
    stderrSha256: sha256("supplied stderr"),
  };
  const hostileValues: Record<string, readonly unknown[]> = {
    elapsedMs: [-1, 0.5, Number.MAX_SAFE_INTEGER + 1],
    stdoutBytes: [-1, 0.5, Number.MAX_SAFE_INTEGER + 1],
    stderrBytes: [-1, 0.5, Number.MAX_SAFE_INTEGER + 1],
    stdoutSha256: [false, "a".repeat(63), "A".repeat(64)],
    stderrSha256: [false, "b".repeat(63), "B".repeat(64)],
  };

  for (const [field, values] of Object.entries(hostileValues)) {
    for (const value of values) {
      const reconstructed = auditFailureDiagnostic(() => {
        failAudit("root-app-production", 1, "invalid-report", undefined, {
          ...validEvidence,
          [field]: value,
        });
      });
      assertDiagnostic(reconstructed, {
        audit: "failure",
        scope: "root-app-production",
        attempt: 1,
        classification: "invalid-report",
        elapsedMs: 0,
      });
    }
  }
});

test("G038 direct audit invocation throws with an exact sanitized spawn-error diagnostic", () => {
  const times = [1_000, 1_037];
  let invocations = 0;
  const diagnostic = auditFailureDiagnostic(() => executeAuditScope("root-app-production", () => {
    invocations += 1;
    throw new Error("PRIVATE_BODY_SENTINEL");
  }, { now: () => times.shift() }));
  assert.equal(invocations, 1);
  assertDiagnostic(diagnostic, {
    audit: "failure",
    scope: "root-app-production",
    attempt: 1,
    classification: "spawn-error",
    elapsedMs: 37,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/);
});

test("audit checkers preserve exact successful status-1 invocation order and output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const firstVulnerability = Object.values(DEFAULT_APP_AUDIT_REPORT.vulnerabilities)[0] as Record<string, unknown>;
  assert(firstVulnerability.via && typeof (firstVulnerability.via as unknown[])[0] === "object");
  assert(firstVulnerability.fixAvailable && typeof firstVulnerability.fixAvailable === "object");

  const slice0 = await runAuditCli(root, fakeBin, "success", "slice0", [
    { type: "report", stderr: "PRIVATE_STDERR_SENTINEL PRIVATE_LOG_PATH_SENTINEL" },
  ]);
  assert.equal(slice0.result.error, undefined);
  assert.equal(slice0.result.signal, null);
  assert.equal(slice0.result.status, 0);
  assert.equal(slice0.result.stderr, "");
  assertExactAuditCalls(slice0.calls, await expectedAuditCalls("slice0"));
  assertPrivateSentinelsAbsent(slice0.result);
  assert.deepEqual(JSON.parse(slice0.result.stdout), {
    audit: "pass",
    scopes: [
      { scope: "sqlite-fts-production", ...AUDIT_COUNTS_BY_DIRECTORY["sqlite-fts"] },
      { scope: "backup-crypto-production", ...AUDIT_COUNTS_BY_DIRECTORY["backup-crypto"] },
      { scope: "model-transport-production", ...AUDIT_COUNTS_BY_DIRECTORY["model-transport"] },
    ],
    moderate_policy: "documented inherited Expo chain; unsafe force-downgrade rejected",
  });

  const app = await runAuditCli(root, fakeBin, "success", "app", [
    { type: "report", stderr: "PRIVATE_STDERR_SENTINEL PRIVATE_LOG_PATH_SENTINEL" },
  ]);
  assert.equal(app.result.error, undefined);
  assert.equal(app.result.signal, null);
  assert.equal(app.result.status, 0);
  assert.equal(app.result.stderr, "");
  assertExactAuditCalls(app.calls, await expectedAuditCalls("app"));
  assertPrivateSentinelsAbsent(app.result);
  assert.deepEqual(JSON.parse(app.result.stdout), {
    audit: "pass",
    scope: "root-app-production",
    high: 0,
    critical: 0,
    moderate: APP_AUDIT_COUNTS.moderate,
  });
});

test("audit checkers preserve genuine status-0 zero-vulnerability reports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-zero-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const zero = { type: "report", report: ZERO_AUDIT_REPORT, status: 0 } as const;

  const slice0 = await runAuditCli(root, fakeBin, "zero", "slice0", [zero, zero, zero]);
  assert.equal(slice0.result.status, 0, slice0.result.stderr);
  assertExactAuditCalls(slice0.calls, await expectedAuditCalls("slice0"));
  assert.deepEqual(JSON.parse(slice0.result.stdout), {
    audit: "pass",
    scopes: EXACT_AUDIT_SCOPES.map(([scope]) => ({ scope, ...ZERO_AUDIT_COUNTS })),
    moderate_policy: "none",
  });

  const app = await runAuditCli(root, fakeBin, "zero", "app", [zero]);
  assert.equal(app.result.status, 0, app.result.stderr);
  assertExactAuditCalls(app.calls, await expectedAuditCalls("app"));
  assert.deepEqual(JSON.parse(app.result.stdout), {
    audit: "pass",
    scope: "root-app-production",
    high: 0,
    critical: 0,
    moderate: 0,
  });
});

test("audit checkers retry only the failed scope once with identical cwd and arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-one-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const eligible = stdoutResponse(httpAuditEnvelope(503), 1, "PRIVATE_STDERR_SENTINEL PRIVATE_LOG_PATH_SENTINEL");

  const sliceExpected = await expectedAuditCalls("slice0");
  const slice0 = await runAuditCli(root, fakeBin, "one-retry", "slice0", [
    { type: "report" },
    eligible,
    { type: "report" },
    { type: "report" },
  ]);
  assert.equal(slice0.result.status, 0);
  assertExactAuditCalls(slice0.calls, [sliceExpected[0], sliceExpected[1], sliceExpected[1], sliceExpected[2]]);
  const [sliceDiagnostic] = diagnosticLines(slice0.result.stderr);
  assertDiagnostic(sliceDiagnostic, {
    audit: "retry",
    scope: "backup-crypto-production",
    attempt: 1,
    classification: "registry-http",
    endpoint: "official-quick",
    status: "HTTP_503",
  }, eligible.stdout, eligible.stderr);
  assertPrivateSentinelsAbsent(slice0.result);

  const appExpected = await expectedAuditCalls("app");
  const app = await runAuditCli(root, fakeBin, "one-retry", "app", [eligible, { type: "report" }]);
  assert.equal(app.result.status, 0);
  assertExactAuditCalls(app.calls, [appExpected[0], appExpected[0]]);
  const [appDiagnostic] = diagnosticLines(app.result.stderr);
  assertDiagnostic(appDiagnostic, {
    audit: "retry",
    scope: "root-app-production",
    attempt: 1,
    classification: "registry-http",
    endpoint: "official-quick",
    status: "HTTP_503",
  }, eligible.stdout, eligible.stderr);
  assertPrivateSentinelsAbsent(app.result);
});

test("repeated HTTP and transport audit failures stop after two calls with no later scopes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-repeated-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const failures = [
    {
      name: "http",
      response: stdoutResponse(httpAuditEnvelope(429), 1, "PRIVATE_STDERR_SENTINEL"),
      classification: "registry-http",
      detail: { status: "HTTP_429" },
    },
    {
      name: "transport",
      response: stdoutResponse(transportAuditEnvelope("ETRANSFERTIMEOUT"), 1, "PRIVATE_STDERR_SENTINEL"),
      classification: "registry-transport",
      detail: { code: "ETRANSFERTIMEOUT" },
    },
  ] as const;

  for (const checker of ["slice0", "app"] as const) {
    const expected = await expectedAuditCalls(checker);
    for (const failure of failures) {
      const failed = await runAuditCli(root, fakeBin, `repeated-${failure.name}`, checker, [failure.response, failure.response]);
      assert.notEqual(failed.result.status, 0);
      assertExactAuditCalls(failed.calls, [expected[0], expected[0]]);
      const diagnostics = diagnosticLines(failed.result.stderr);
      assert.equal(diagnostics.length, 2);
      for (const [index, audit] of ["retry", "failure"].entries()) {
        assertDiagnostic(diagnostics[index], {
          audit,
          scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
          attempt: index + 1,
          classification: failure.classification,
          endpoint: "official-quick",
          ...failure.detail,
        }, failure.response.stdout, failure.response.stderr);
      }
      assertPrivateSentinelsAbsent(failed.result);
    }
  }
});

test("both audit checkers accept every realistic HTTP and transport retry class", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-allowlist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const accepted: {
    name: string;
    payload: Record<string, unknown>;
    classification: "registry-http" | "registry-transport";
    detail: { status: string } | { code: TransientAuditCode };
  }[] = [
    ...[408, 420, 429, 500, 599].map((statusCode) => ({
      name: `http-${statusCode}`,
      payload: httpAuditEnvelope(statusCode),
      classification: "registry-http" as const,
      detail: { status: `HTTP_${statusCode}` },
    })),
    ...TRANSIENT_AUDIT_CODES.filter((code) => code !== "ECONNRESET").map((code) => ({
      name: `transport-${code}`,
      payload: transportAuditEnvelope(code),
      classification: "registry-transport" as const,
      detail: { code },
    })),
    ...REAL_NPM_10_9_3_ECONNRESET_REASONS.map((reason, index) => ({
      name: `transport-ECONNRESET-${index}`,
      payload: transportAuditReason(reason),
      classification: "registry-transport" as const,
      detail: { code: "ECONNRESET" as const },
    })),
  ];

  for (const checker of ["slice0", "app"] as const) {
    const expected = await expectedAuditCalls(checker);
    for (const acceptedCase of accepted) {
      const response = stdoutResponse(acceptedCase.payload, 1, "PRIVATE_STDERR_SENTINEL");
      const run = await runAuditCli(root, fakeBin, acceptedCase.name, checker, [response, { type: "report" }]);
      assert.equal(run.result.status, 0, `${checker} ${acceptedCase.name}`);
      const expectedCalls = checker === "slice0"
        ? [expected[0], expected[0], expected[1], expected[2]]
        : [expected[0], expected[0]];
      assertExactAuditCalls(run.calls, expectedCalls);
      const [record] = diagnosticLines(run.result.stderr);
      assertDiagnostic(record, {
        audit: "retry",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 1,
        classification: acceptedCase.classification,
        endpoint: "official-quick",
        ...acceptedCase.detail,
      }, response.stdout, response.stderr);
      assertPrivateSentinelsAbsent(run.result);
    }
  }
});

test("both audit checkers reject hostile endpoints, proxy forms, laundering, and nontransient variants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-rejections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const withoutBody = httpAuditEnvelope(503);
  delete withoutBody.body;
  const validZero = validAuditReport(ZERO_AUDIT_COUNTS);
  const rejected: readonly (readonly [string, unknown])[] = [
    ["alternate-host", httpAuditEnvelope(503, { uri: "https://registry.example.invalid/-/npm/v1/security/audits/quick" })],
    ["protocol-downgrade", httpAuditEnvelope(503, { uri: "http://registry.npmjs.org/-/npm/v1/security/audits/quick" })],
    ["bulk-endpoint", httpAuditEnvelope(503, { uri: BULK_AUDIT_ENDPOINT })],
    ["path-suffix", httpAuditEnvelope(503, { uri: `${QUICK_AUDIT_ENDPOINT}/extra` })],
    ["query", httpAuditEnvelope(503, { uri: `${QUICK_AUDIT_ENDPOINT}?private=PRIVATE_BODY_SENTINEL` })],
    ["credentials", httpAuditEnvelope(503, { uri: "https://private-user-sentinel:PRIVATE_BODY_SENTINEL@registry.npmjs.org/-/npm/v1/security/audits/quick" })],
    ["fragment", httpAuditEnvelope(503, { uri: `${QUICK_AUDIT_ENDPOINT}#PRIVATE_BODY_SENTINEL` })],
    ["get", httpAuditEnvelope(503, { method: "GET" })],
    ["http-400", httpAuditEnvelope(400)],
    ["http-401", httpAuditEnvelope(401)],
    ["http-403", httpAuditEnvelope(403)],
    ["http-404", httpAuditEnvelope(404)],
    ["http-407", httpAuditEnvelope(407)],
    ["http-499", httpAuditEnvelope(499)],
    ["http-600", httpAuditEnvelope(600)],
    ["string-status", httpAuditEnvelope(503, { statusCode: "503" })],
    ["empty-message", httpAuditEnvelope(503, { message: "" })],
    ["missing-body", withoutBody],
    ["extra-field", { ...httpAuditEnvelope(503), code: "ECONNRESET" }],
    ["header-shape", httpAuditEnvelope(503, { headers: { "x-private": "PRIVATE_HEADER_SENTINEL" } })],
    ["header-array-entry", httpAuditEnvelope(503, { headers: { "x-private": ["PRIVATE_HEADER_SENTINEL", false] } })],
    ["error-footer-extra", httpAuditEnvelope(503, { error: { ...NPM_ERROR_FOOTER, code: "ECONNRESET" } })],
    ["error-footer-summary", httpAuditEnvelope(503, { error: { summary: "PRIVATE_BODY_SENTINEL", detail: "" } })],
    ["error-footer-detail", httpAuditEnvelope(503, { error: { summary: "", detail: "PRIVATE_BODY_SENTINEL" } })],
    ["report-in-body", httpAuditEnvelope(503, { body: { metadata: { vulnerabilities: APP_AUDIT_COUNTS } } })],
    ["report-in-nested-array", httpAuditEnvelope(503, { body: [[{ metadata: { vulnerabilities: APP_AUDIT_COUNTS } }]] })],
    ["vulnerabilities-in-body", httpAuditEnvelope(503, { body: { vulnerabilities: { private: {} } } })],
    ["audit-counts-in-body", httpAuditEnvelope(503, { body: { ...APP_AUDIT_COUNTS } })],
    ["vulnerability-object-in-body", httpAuditEnvelope(503, { body: validVulnerabilityReport("app", "high").vulnerabilities["private-package-sentinel-1"] })],
    ["transport-alternate-host", transportAuditEnvelope("ECONNRESET", "https://registry.example.invalid/-/npm/v1/security/audits/quick")],
    ["transport-protocol", transportAuditEnvelope("ECONNRESET", "http://registry.npmjs.org/-/npm/v1/security/audits/quick")],
    ["transport-bulk", transportAuditEnvelope("ECONNRESET", BULK_AUDIT_ENDPOINT)],
    ["transport-path", transportAuditEnvelope("ECONNRESET", `${QUICK_AUDIT_ENDPOINT}/extra`)],
    ["transport-query", transportAuditEnvelope("ECONNRESET", `${QUICK_AUDIT_ENDPOINT}?private=PRIVATE_BODY_SENTINEL`)],
    ["transport-fragment", transportAuditEnvelope("ECONNRESET", `${QUICK_AUDIT_ENDPOINT}#PRIVATE_BODY_SENTINEL`)],
    ["transport-credentials", transportAuditEnvelope("ECONNRESET", "https://private-user-sentinel:PRIVATE_BODY_SENTINEL@registry.npmjs.org/-/npm/v1/security/audits/quick")],
    ["transport-extra-field", { ...transportAuditEnvelope("ECONNRESET"), method: "POST" }],
    ["transport-footer-detail", { ...transportAuditEnvelope("ECONNRESET"), error: { summary: "", detail: "PRIVATE_BODY_SENTINEL" } }],
    ["agent-proxy-response", transportAuditReason("Response timeout from proxy `proxy.example:8080` connecting to host `registry.npmjs.org`")],
    ["agent-proxy-transfer", transportAuditReason("Transfer timeout from proxy `proxy.example:8080` for `registry.npmjs.org`")],
    ["agent-host-port", transportAuditReason("Timeout connecting to host `registry.npmjs.org:80`")],
    ["agent-host-path", transportAuditReason("Idle timeout reached for host `registry.npmjs.org:443/-/npm/v1/security/audits/quick`")],
    ["agent-response-port", transportAuditReason("Response timeout connecting to host `registry.npmjs.org:443`")],
    ["agent-transfer-port", transportAuditReason("Transfer timeout for `registry.npmjs.org:443`")],
    ["agent-host-credentials", transportAuditReason("Response timeout connecting to host `private-user-sentinel@registry.npmjs.org`")],
    ["agent-code-mixture", transportAuditReason("Transfer timeout for `registry.npmjs.org` ETRANSFERTIMEOUT")],
    ["system-wrong-port", transportAuditReason("connect ECONNREFUSED 104.16.0.34:80")],
    ["system-hostname", transportAuditReason("connect ETIMEDOUT registry.npmjs.org:443")],
    ["system-path", transportAuditReason("connect ECONNREFUSED 104.16.0.34:443/-/npm/v1/security/audits/quick")],
    ["system-proxy", transportAuditReason("connect ECONNREFUSED proxy.example:8080")],
    ["system-plus-port", transportAuditReason("connect ECONNREFUSED 104.16.0.34:+443")],
    ["system-leading-zero-port", transportAuditReason("connect ECONNREFUSED 104.16.0.34:0443")],
    ["system-exponent-port", transportAuditReason("connect ECONNREFUSED 104.16.0.34:4.43e2")],
    ["system-port-zero", transportAuditReason("connect ECONNREFUSED 104.16.0.34:0")],
    ["system-port-overflow", transportAuditReason("connect ECONNREFUSED 104.16.0.34:65536")],
    ["system-opening-bracket", transportAuditReason("connect ECONNREFUSED [2606:4700::6810:22:443")],
    ["system-closing-bracket", transportAuditReason("connect ECONNREFUSED 2606:4700::6810:22]:443")],
    ["system-full-brackets", transportAuditReason("connect ECONNREFUSED [2606:4700::6810:22]:443")],
    ["system-loopback", transportAuditReason("connect ECONNRESET 127.0.0.1:443")],
    ["system-private", transportAuditReason("connect ECONNREFUSED 10.0.0.1:443")],
    ["system-private-172", transportAuditReason("connect ECONNREFUSED 172.16.0.1:443")],
    ["system-private-192", transportAuditReason("connect ECONNREFUSED 192.168.0.1:443")],
    ["system-link-local", transportAuditReason("connect ETIMEDOUT 169.254.1.1:443")],
    ["system-documentation", transportAuditReason("connect ECONNRESET 192.0.2.1:443")],
    ["system-documentation-198", transportAuditReason("connect ECONNRESET 198.51.100.1:443")],
    ["system-documentation-203", transportAuditReason("connect ECONNRESET 203.0.113.1:443")],
    ["system-private-172-upper", transportAuditReason("connect ECONNREFUSED 172.31.255.254:443")],
    ["system-private-192-upper", transportAuditReason("connect ECONNREFUSED 192.168.255.254:443")],
    ["system-documentation-198-upper", transportAuditReason("connect ECONNRESET 198.51.100.200:443")],
    ["system-documentation-203-upper", transportAuditReason("connect ECONNRESET 203.0.113.200:443")],
    ["system-ipv6-loopback", transportAuditReason("connect ECONNRESET ::1:443")],
    ["system-ipv6-private", transportAuditReason("connect ECONNREFUSED fd00::1:443")],
    ["system-ipv6-link-local", transportAuditReason("connect ETIMEDOUT fe80::1:443")],
    ["system-ipv6-documentation", transportAuditReason("connect ECONNRESET 2001:db8::1:443")],
    ["system-ipv6-dummy", transportAuditReason("connect ECONNREFUSED 100:0:0:1::1:443")],
    ["system-ipv6-dummy-upper", transportAuditReason("connect ECONNREFUSED 100::1:8000:0:0:1:443")],
    ["system-bind-malformed", transportAuditReason("bind EADDRINUSE 127.0.0.1:049152")],
    ["system-code-mixture", transportAuditReason("read ECONNRESET ETIMEDOUT")],
    ["system-code-only", transportAuditReason("ECONNRESET")],
    ["dns-enotfound", transportAuditReason("getaddrinfo ENOTFOUND registry.npmjs.org")],
    ["dns-eai-again", transportAuditReason("getaddrinfo EAI_AGAIN registry.npmjs.org")],
    ["tls-expired", transportAuditReason("CERT_HAS_EXPIRED")],
    ["tls-signature", transportAuditReason("UNABLE_TO_VERIFY_LEAF_SIGNATURE")],
    ["proxy", transportAuditReason("EINVALIDPROXY")],
    ["auth", transportAuditReason("EOTP")],
    ["config", transportAuditReason("ERR_INVALID_URL")],
    ["generic-fetch", transportAuditReason("FETCH_ERROR")],
    ["generic-timeout", transportAuditReason(`network timeout at: ${QUICK_AUDIT_ENDPOINT}`)],
    ["advisories-in-http-body", httpAuditEnvelope(503, { body: { advisories: { private: "PRIVATE_BODY_SENTINEL" } } })],
    ["report-version-only", { auditReportVersion: 2 }],
    ["metadata-only", { metadata: { vulnerabilities: APP_AUDIT_COUNTS } }],
    ["vulnerabilities-only", { vulnerabilities: {} }],
    ["mixed-transport-report", { ...transportAuditEnvelope("ECONNRESET"), ...validZero }],
    ["mixed-http-report", { ...httpAuditEnvelope(503), ...validZero }],
    ["valid-report-error-extra", { ...validZero, error: { ...NPM_ERROR_FOOTER } }],
  ];

  for (const checker of ["slice0", "app"] as const) {
    const [expected] = await expectedAuditCalls(checker);
    for (const [name, payload] of rejected) {
      const response = stdoutResponse(payload, 1, "PRIVATE_STDERR_SENTINEL");
      const run = await runAuditCli(root, fakeBin, name, checker, [response]);
      assert.notEqual(run.result.status, 0, `${checker} ${name}`);
      assertExactAuditCalls(run.calls, [expected]);
      const [record] = diagnosticLines(run.result.stderr);
      assertDiagnostic(record, {
        audit: "failure",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 1,
        classification: "invalid-report",
      }, response.stdout, response.stderr);
      assertPrivateSentinelsAbsent(run.result);
    }
  }
});

test("both audit checkers emit exact evidence schema on process and spawn failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-process-failures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const wrongVersion = validAuditReport(APP_AUDIT_COUNTS);
  wrongVersion.auditReportVersion = 1;
  const missingVersion = validAuditReport(APP_AUDIT_COUNTS) as { auditReportVersion?: number };
  delete missingVersion.auditReportVersion;
  const missingVulnerabilityField = mutateFirstVulnerability((vulnerability) => delete vulnerability.via);
  const extraVulnerabilityField = mutateFirstVulnerability((vulnerability) => {
    vulnerability.rawAdvisory = "PRIVATE_BODY_SENTINEL";
  });
  const invalidVia = mutateFirstVulnerability((vulnerability) => {
    vulnerability.via = [false];
  });
  const invalidFixAvailable = mutateFirstVulnerability((vulnerability) => {
    vulnerability.fixAvailable = { name: "private-package-sentinel-1", version: "1.0.0" };
  });
  const cases: readonly (readonly [string, FakeAuditResponse, string])[] = [
    ["empty", stdoutResponse("", 1, "PRIVATE_STDERR_SENTINEL"), "empty-json"],
    ["blank", stdoutResponse("   \n", 1, "PRIVATE_STDERR_SENTINEL"), "empty-json"],
    ["malformed", stdoutResponse("{PRIVATE_BODY_SENTINEL", 1, "PRIVATE_STDERR_SENTINEL"), "malformed-json"],
    ["generic", stdoutResponse({ error: "PRIVATE_BODY_SENTINEL" }, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["missing-metadata", stdoutResponse({ auditReportVersion: 2, vulnerabilities: {} }, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["wrong-report-version", stdoutResponse(wrongVersion, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["missing-report-version", stdoutResponse(missingVersion, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["missing-vulnerability-field", stdoutResponse(missingVulnerabilityField, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["extra-vulnerability-field", stdoutResponse(extraVulnerabilityField, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["invalid-via", stdoutResponse(invalidVia, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["invalid-fix-available", stdoutResponse(invalidFixAvailable, 1, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["status-two", stdoutResponse(httpAuditEnvelope(503), 2, "PRIVATE_STDERR_SENTINEL"), "unexpected-status"],
    ["status-zero-envelope", stdoutResponse(httpAuditEnvelope(503), 0, "PRIVATE_STDERR_SENTINEL"), "invalid-report"],
    ["signal", { type: "signal", stderr: "PRIVATE_STDERR_SENTINEL" }, "signaled"],
  ];

  for (const checker of ["slice0", "app"] as const) {
    const [expected] = await expectedAuditCalls(checker);
    for (const [name, response, classification] of cases) {
      const run = await runAuditCli(root, fakeBin, name, checker, [response]);
      assert.notEqual(run.result.status, 0, `${checker} ${name}`);
      assertExactAuditCalls(run.calls, [expected]);
      const [record] = diagnosticLines(run.result.stderr);
      assertDiagnostic(record, {
        audit: "failure",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 1,
        classification,
      }, response.stdout ?? "", response.stderr ?? "");
      assertPrivateSentinelsAbsent(run.result);
    }

    const emptyBin = join(root, `empty-bin-${checker}`);
    await mkdir(emptyBin);
    const spawnFailure = await runAuditCli(root, emptyBin, "spawn", checker);
    assert.notEqual(spawnFailure.result.status, 0);
    assert.deepEqual(spawnFailure.calls, []);
    const [record] = diagnosticLines(spawnFailure.result.stderr);
    assertDiagnostic(record, {
      audit: "failure",
      scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
      attempt: 1,
      classification: "spawn-error",
    });
    assertPrivateSentinelsAbsent(spawnFailure.result);
  }
});

test("genuine npm v2 audit reports reject invalid counts and count laundering in both checkers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-counts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);

  for (const checker of ["slice0", "app"] as const) {
    const base = checker === "slice0" ? { ...AUDIT_COUNTS_BY_DIRECTORY["sqlite-fts"] } : { ...APP_AUDIT_COUNTS };
    const [expected] = await expectedAuditCalls(checker);
    for (const field of [...EXACT_AUDIT_SEVERITIES, "total"] as const) {
      const missing: Record<string, unknown> = { ...base };
      delete missing[field];
      const variants: readonly (readonly [string, Record<string, unknown>])[] = [
        ["missing", missing],
        ["negative", { ...base, [field]: -1 }],
        ["fractional", { ...base, [field]: 0.5 }],
        ["string", { ...base, [field]: "1" }],
        ["unsafe", { ...base, [field]: Number.MAX_SAFE_INTEGER + 1 }],
      ];
      for (const [mode, counts] of variants) {
        const report = reportWithMetadataCounts(checker, counts);
        const response = { type: "report", report, status: 1 } as const;
        const run = await runAuditCli(root, fakeBin, `${mode}-${field}`, checker, [response]);
        assert.notEqual(run.result.status, 0, `${checker} ${mode} ${field}`);
        assertExactAuditCalls(run.calls, [expected]);
        const [record] = diagnosticLines(run.result.stderr);
        assertDiagnostic(record, {
          audit: "failure",
          scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
          attempt: 1,
          classification: "invalid-count",
        }, JSON.stringify(report));
        assertPrivateSentinelsAbsent(run.result);
      }
    }

    const extraVulnerabilityCount = reportWithMetadataCounts(checker, { ...base, private: 0 });
    const extraVulnerabilityFailure = await runAuditCli(root, fakeBin, "extra-vulnerability-count", checker, [{
      type: "report",
      report: extraVulnerabilityCount,
      status: 1,
    }]);
    assert.notEqual(extraVulnerabilityFailure.result.status, 0);
    assertExactAuditCalls(extraVulnerabilityFailure.calls, [expected]);
    const [extraVulnerabilityDiagnostic] = diagnosticLines(extraVulnerabilityFailure.result.stderr);
    assertDiagnostic(extraVulnerabilityDiagnostic, {
      audit: "failure",
      scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
      attempt: 1,
      classification: "invalid-count",
    }, JSON.stringify(extraVulnerabilityCount));
    assertPrivateSentinelsAbsent(extraVulnerabilityFailure.result);

    for (const field of Object.keys(AUDIT_DEPENDENCY_COUNTS)) {
      const missing = { ...AUDIT_DEPENDENCY_COUNTS } as Record<string, unknown>;
      delete missing[field];
      const report = reportWithDependencyCounts(checker, missing);
      const failure = await runAuditCli(root, fakeBin, `missing-dependency-${field}`, checker, [{
        type: "report",
        report,
        status: 1,
      }]);
      assert.notEqual(failure.result.status, 0, `${checker} missing dependency ${field}`);
      assertExactAuditCalls(failure.calls, [expected]);
      const [record] = diagnosticLines(failure.result.stderr);
      assertDiagnostic(record, {
        audit: "failure",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 1,
        classification: "invalid-count",
      }, JSON.stringify(report));
      assertPrivateSentinelsAbsent(failure.result);
    }

    const extraDependencyCount = reportWithDependencyCounts(checker, { ...AUDIT_DEPENDENCY_COUNTS, private: 0 });
    const extraDependencyFailure = await runAuditCli(root, fakeBin, "extra-dependency-count", checker, [{
      type: "report",
      report: extraDependencyCount,
      status: 1,
    }]);
    assert.notEqual(extraDependencyFailure.result.status, 0);
    assertExactAuditCalls(extraDependencyFailure.calls, [expected]);
    const [extraDependencyDiagnostic] = diagnosticLines(extraDependencyFailure.result.stderr);
    assertDiagnostic(extraDependencyDiagnostic, {
      audit: "failure",
      scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
      attempt: 1,
      classification: "invalid-count",
    }, JSON.stringify(extraDependencyCount));
    assertPrivateSentinelsAbsent(extraDependencyFailure.result);

    const mismatchReports = [
      reportWithMetadataCounts(checker, { ...base, total: base.total + 1 }),
      reportWithMetadataCounts(checker, { ...base, low: base.low + 1, moderate: Math.max(0, base.moderate - 1) }),
    ];
    for (const [index, report] of mismatchReports.entries()) {
      const run = await runAuditCli(root, fakeBin, `count-mismatch-${index}`, checker, [{ type: "report", report, status: 1 }]);
      assert.notEqual(run.result.status, 0);
      assertExactAuditCalls(run.calls, [expected]);
      const [record] = diagnosticLines(run.result.stderr);
      assertDiagnostic(record, {
        audit: "failure",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 1,
        classification: "count-mismatch",
      }, JSON.stringify(report));
      assertPrivateSentinelsAbsent(run.result);
    }

    const dependencyReport = validAuditReport(base);
    dependencyReport.metadata.dependencies.total = 0.25;
    const dependencyFailure = await runAuditCli(root, fakeBin, "fractional-dependency-count", checker, [{
      type: "report",
      report: dependencyReport,
      status: 1,
    }]);
    const [dependencyDiagnostic] = diagnosticLines(dependencyFailure.result.stderr);
    assert.notEqual(dependencyFailure.result.status, 0);
    assertExactAuditCalls(dependencyFailure.calls, [expected]);
    assertDiagnostic(dependencyDiagnostic, {
      audit: "failure",
      scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
      attempt: 1,
      classification: "invalid-count",
    }, JSON.stringify(dependencyReport));
    assertPrivateSentinelsAbsent(dependencyFailure.result);
  }
});

test("exact inventory and moderate audit policies remain enforced by both checkers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-moderate-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);

  for (const checker of ["slice0", "app"] as const) {
    const fixture = await createAuditCheckerFixture(root, checker);
    const inventoryPath = join(fixture, checker === "slice0" ? "licenses.slice0.json" : "licenses.app.json");
    await rm(inventoryPath);
    const missingInventory = await runAuditCli(root, fakeBin, "inventory-file-missing", checker, [], fixture);
    assert.notEqual(missingInventory.result.status, 0);
    assertExactAuditCalls(missingInventory.calls, []);
    const [missingInventoryDiagnostic] = diagnosticLines(missingInventory.result.stderr);
    assertDiagnostic(missingInventoryDiagnostic, {
      audit: "failure",
      scope: checker === "slice0" ? "slice0-production" : "root-app-production",
      attempt: 1,
      classification: "inventory-invalid",
    });
    assertPrivateSentinelsAbsent(missingInventory.result);

    await writeFile(inventoryPath, "{PRIVATE_BODY_SENTINEL");
    const malformedInventory = await runAuditCli(root, fakeBin, "inventory-file-malformed", checker, [], fixture);
    assert.notEqual(malformedInventory.result.status, 0);
    assertExactAuditCalls(malformedInventory.calls, []);
    const [malformedInventoryDiagnostic] = diagnosticLines(malformedInventory.result.stderr);
    assertDiagnostic(malformedInventoryDiagnostic, {
      audit: "failure",
      scope: checker === "slice0" ? "slice0-production" : "root-app-production",
      attempt: 1,
      classification: "inventory-invalid",
    });
    assertPrivateSentinelsAbsent(malformedInventory.result);

    const invalidFailLevels: readonly (readonly [string, unknown])[] = [
      ["missing", undefined],
      ["missing-high", ["critical"]],
      ["missing-critical", ["high"]],
      ["reordered", ["critical", "high"]],
      ["extra", ["high", "critical", "moderate"]],
      ["string", "high,critical"],
    ];
    for (const [name, failLevels] of invalidFailLevels) {
      await writeFile(inventoryPath, JSON.stringify({
        audit_policy: {
          fail_levels: failLevels,
          documented_moderate: "PRIVATE_BODY_SENTINEL",
        },
      }));
      const invalid = await runAuditCli(root, fakeBin, `inventory-${name}`, checker, [], fixture);
      assert.notEqual(invalid.result.status, 0, `${checker} ${name}`);
      assertExactAuditCalls(invalid.calls, []);
      const [record] = diagnosticLines(invalid.result.stderr);
      assertDiagnostic(record, {
        audit: "failure",
        scope: checker === "slice0" ? "slice0-production" : "root-app-production",
        attempt: 1,
        classification: "inventory-invalid",
      });
      assertPrivateSentinelsAbsent(invalid.result);
    }
    await writeFile(inventoryPath, JSON.stringify({
      audit_policy: {
        fail_levels: ["high", "critical"],
        documented_moderate: checker === "slice0" ? "not an approved Expo policy" : "",
      },
    }));
    const run = await runAuditCli(root, fakeBin, "moderate-policy", checker, [], fixture);
    assert.notEqual(run.result.status, 0);
    const [expected] = await expectedAuditCalls(checker, fixture);
    assertExactAuditCalls(run.calls, [expected]);
    const report = checker === "slice0" ? DEFAULT_AUDIT_REPORTS["sqlite-fts"] : DEFAULT_APP_AUDIT_REPORT;
    const [record] = diagnosticLines(run.result.stderr);
    assertDiagnostic(record, {
      audit: "failure",
      scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
      attempt: 1,
      classification: "moderate-policy",
    }, JSON.stringify(report));
    assertPrivateSentinelsAbsent(run.result);
  }
});

test("valid high and critical audit reports fail closed before or after an eligible retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-checkers-threshold-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeBin = await createFakeNpm(root);
  const eligible = stdoutResponse(httpAuditEnvelope(500), 1, "PRIVATE_STDERR_SENTINEL");

  for (const checker of ["slice0", "app"] as const) {
    const [expected] = await expectedAuditCalls(checker);
    for (const severity of ["high", "critical"] as const) {
      const report = validVulnerabilityReport(checker, severity);
      const reportStdout = JSON.stringify(report);
      const direct = await runAuditCli(root, fakeBin, `direct-${severity}`, checker, [stdoutResponse(report)]);
      assert.notEqual(direct.result.status, 0);
      assertExactAuditCalls(direct.calls, [expected]);
      const [directDiagnostic] = diagnosticLines(direct.result.stderr);
      assertDiagnostic(directDiagnostic, {
        audit: "failure",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 1,
        classification: `${severity}-vulnerability`,
      }, reportStdout);
      assertPrivateSentinelsAbsent(direct.result);

      const afterRetry = await runAuditCli(root, fakeBin, `after-retry-${severity}`, checker, [eligible, stdoutResponse(report)]);
      assert.notEqual(afterRetry.result.status, 0);
      assertExactAuditCalls(afterRetry.calls, [expected, expected]);
      const diagnostics = diagnosticLines(afterRetry.result.stderr);
      assert.equal(diagnostics.length, 2);
      assertDiagnostic(diagnostics[0], {
        audit: "retry",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 1,
        classification: "registry-http",
        endpoint: "official-quick",
        status: "HTTP_500",
      }, eligible.stdout, eligible.stderr);
      assertDiagnostic(diagnostics[1], {
        audit: "failure",
        scope: checker === "slice0" ? "sqlite-fts-production" : "root-app-production",
        attempt: 2,
        classification: `${severity}-vulnerability`,
      }, reportStdout);
      assertPrivateSentinelsAbsent(afterRetry.result);
    }
  }
});

test("package audit scripts and normal lint retain exact ownership", async () => {
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  const staticCi = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
  assert.doesNotThrow(() => assertAuditScriptContract(manifest.scripts));
  const hostileScripts: [string, Record<string, string>][] = [
    ["drop slice0", { ...manifest.scripts, "test:audit": "npm run test:audit:app" }],
    ["drop app", { ...manifest.scripts, "test:audit": "npm run test:audit:slice0" }],
    ["reorder", { ...manifest.scripts, "test:audit": "npm run test:audit:app && npm run test:audit:slice0" }],
    ["replace slice0 leaf", { ...manifest.scripts, "test:audit:slice0": "node tools/check-app-audit.mjs" }],
    ["replace app leaf", { ...manifest.scripts, "test:audit:app": "node tools/check-audit.mjs" }],
    ["conditional bypass", { ...manifest.scripts, "test:audit": "npm run test:audit:slice0 || npm run test:audit:app" }],
  ];
  for (const [name, scripts] of hostileScripts) {
    assert.throws(() => assertAuditScriptContract(scripts), /Audit scripts/, name);
  }

  assert.doesNotThrow(() => assertAuditLintOwnership(manifest.scripts.lint));
  for (const path of REQUIRED_LINT_PATHS) {
    const hostileLint = manifest.scripts.lint.replace(` ${path} `, " ");
    assert.notEqual(hostileLint, manifest.scripts.lint, `${path} lint-ownership fixture must mutate the script`);
    assert.throws(() => assertAuditLintOwnership(hostileLint), /npm run lint/);
  }

  assert.doesNotThrow(() => assertStaticCiNpmVersionGuard(staticCi));
  for (const hostileCi of [
    staticCi.replace(EXACT_STATIC_CI_NPM_GUARD, ""),
    staticCi.replaceAll("10.9.3", "10.9.4"),
    staticCi.replace("node-version: 22.18.0", "node-version: 22.19.0"),
  ]) {
    assert.notEqual(hostileCi, staticCi, "The static CI guard fixture must mutate the workflow");
    assert.throws(() => assertStaticCiNpmVersionGuard(hostileCi), /npm guard|npm 10\.9\.3/);
  }
});

test("G017 source boundary remains exact and rejects hostile audit-scope mutations", async () => {
  const auditSource = await readFile(resolve("tools/check-audit.mjs"), "utf8");
  const appAuditSource = await readFile(resolve("tools/check-app-audit.mjs"), "utf8");
  const spikeSyntax = spawnSync(process.execPath, ["--check", resolve("spikes/model-transport/deviceEvidenceValidator.mjs")], { encoding: "utf8" });
  assert.equal(spikeSyntax.status, 0, spikeSyntax.stderr);
  assert.doesNotThrow(() => assertAuditSourceContract(auditSource));
  assert.doesNotThrow(() => assertAppAuditSourceContract(appAuditSource));
  const hostileAuditSources = [
    ["scope omission", auditSource.replace('  Object.freeze(["backup-crypto-production", "../spikes/backup-crypto"]),\n', "")],
    ["scope substitution", auditSource.replace('"../spikes/backup-crypto"', '"../spikes/sqlite-fts"')],
    ["scope reorder", auditSource.replace(
      '  Object.freeze(["sqlite-fts-production", "../spikes/sqlite-fts"]),\n  Object.freeze(["backup-crypto-production", "../spikes/backup-crypto"]),',
      '  Object.freeze(["backup-crypto-production", "../spikes/backup-crypto"]),\n  Object.freeze(["sqlite-fts-production", "../spikes/sqlite-fts"]),',
    )],
    ["option substitution", auditSource.replace('"--omit=dev"', '"--include=dev"')],
    ["invocation substitution", auditSource.replace('spawnSync("npm", AUDIT_OPTIONS, {', 'spawnSync("npm", ["audit", "--json"], {')],
    ["mutable scope container", auditSource.replace("const AUDIT_SCOPES = Object.freeze([", "const AUDIT_SCOPES = [")],
    ["mutable scope row", auditSource.replace(
      'Object.freeze(["backup-crypto-production", "../spikes/backup-crypto"])',
      '["backup-crypto-production", "../spikes/backup-crypto"]',
    )],
    ["mutable options", auditSource.replace(
      'const AUDIT_OPTIONS = Object.freeze(["audit", "--omit=dev", "--workspaces=false", "--json"]);',
      'const AUDIT_OPTIONS = ["audit", "--omit=dev", "--workspaces=false", "--json"];',
    )],
    ["mutable severities", auditSource.replace(
      'const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);',
      'const SEVERITIES = ["info", "low", "moderate", "high", "critical"];',
    )],
  ] as const;
  for (const [name, hostileSource] of hostileAuditSources) {
    assert.notEqual(hostileSource, auditSource, `${name} fixture must mutate the audit source`);
    assert.throws(() => assertAuditSourceContract(hostileSource), /audit/i, name);
  }
  const hostileAppAuditSources = [
    ["app option substitution", appAuditSource.replace('"--include-workspace-root"', '"--include=dev"')],
    ["app invocation substitution", appAuditSource.replace('spawnSync("npm", APP_AUDIT_OPTIONS, {', 'spawnSync("npm", ["audit", "--json"], {')],
    ["app cwd substitution", appAuditSource.replace('cwd: new URL("..", import.meta.url),', 'cwd: new URL("../spikes/model-transport", import.meta.url),')],
    ["mutable app options", appAuditSource.replace(
      'const APP_AUDIT_OPTIONS = Object.freeze(["audit", "--omit=dev", "--workspaces=false", "--include-workspace-root", "--json"]);',
      'const APP_AUDIT_OPTIONS = ["audit", "--omit=dev", "--workspaces=false", "--include-workspace-root", "--json"];',
    )],
  ] as const;
  for (const [name, hostileSource] of hostileAppAuditSources) {
    assert.notEqual(hostileSource, appAuditSource, `${name} fixture must mutate the app audit source`);
    assert.throws(() => assertAppAuditSourceContract(hostileSource), /audit/i, name);
  }

  const excludedRootAppPaths = [
    ".gitignore",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tools/run-slice0.mjs",
    "tools/run-typecheck.mjs",
    "tools/run-expo-doctor-isolated.mjs",
    "tools/check-app-audit.mjs",
  ];
  assert.deepEqual(G017_SOURCE_PATHS, EXACT_G017_SOURCE_PATHS);
  assert.equal(G017_SOURCE_PATHS.length, 35);
  assert.equal(new Set(G017_SOURCE_PATHS).size, 35);
  const sourcePaths: readonly string[] = G017_SOURCE_PATHS;
  for (const path of excludedRootAppPaths) assert(!sourcePaths.includes(path), path);
  assert(G017_SOURCE_PATHS.includes("tools/audit-execution.mjs"));
  assert(G017_SOURCE_PATHS.includes("tools/redaction.d.mts"));
  for (const path of G017_SOURCE_PATHS) await assert.doesNotReject(readFile(resolve(path)), path);
});

test("G017 Hermes compiler identity is owned by the spike lock while the root lock remains excluded", async () => {
  const spikeLock = JSON.parse(await readFile("spikes/model-transport/package-lock.json", "utf8"));
  const currentHermesVersion = "250829098.0.14";
  assert.equal(spikeLock.packages["node_modules/hermes-compiler"].version, currentHermesVersion);
  assert.equal(
    hermesCompilerPath(),
    resolve("spikes/model-transport/node_modules/hermes-compiler/hermesc", process.platform === "darwin" ? "osx-bin/hermesc" : process.platform === "linux" ? "linux64-bin/hermesc" : "win64-bin/hermesc.exe"),
  );
  assert.match(hermesCompilerPath(), /spikes\/model-transport\/node_modules\/hermes-compiler\/hermesc/);
  assert(!G017_SOURCE_PATHS.includes("package-lock.json"));
  assert(G017_SOURCE_PATHS.includes("spikes/model-transport/package-lock.json"));
});

test("G017 fingerprint ignores excluded root-app mutations but changes for spike-owned mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "g017-source-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of G017_SOURCE_PATHS) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), await readFile(resolve(path)));
  }

  const baseline = await computeG017SourceFingerprint(root);
  for (const path of [
    ".gitignore",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tools/run-slice0.mjs",
    "tools/run-typecheck.mjs",
    "tools/run-expo-doctor-isolated.mjs",
  ]) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), `root-app mutation: ${path}\n`);
  }
  assert.equal(await computeG017SourceFingerprint(root), baseline);

  for (const path of EXACT_G017_SOURCE_PATHS) {
    const original = await readFile(resolve(root, path));
    await writeFile(resolve(root, path), Buffer.concat([original, Buffer.from(`\nG017 owned mutation: ${path}\n`)]));
    assert.notEqual(await computeG017SourceFingerprint(root), baseline, path);
    await writeFile(resolve(root, path), original);
    assert.equal(await computeG017SourceFingerprint(root), baseline, `${path} restoration`);
  }
});
