import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { BlockList, isIP, SocketAddress } from "node:net";

const QUICK_AUDIT_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/audits/quick";
const QUICK_ENDPOINT_ENUM = "official-quick";
const AUDIT_REPORT_MARKERS = new Set(["auditReportVersion", "metadata", "vulnerabilities", "advisories"]);
const HTTP_ENVELOPE_KEYS = Object.freeze(["body", "error", "headers", "message", "method", "statusCode", "uri"]);
const TRANSPORT_ENVELOPE_KEYS = Object.freeze(["error", "message"]);
const NPM_ERROR_KEYS = Object.freeze(["detail", "summary"]);
const REPORT_KEYS = Object.freeze(["auditReportVersion", "metadata", "vulnerabilities"]);
const REPORT_METADATA_KEYS = Object.freeze(["dependencies", "vulnerabilities"]);
const ADVISORY_KEYS = Object.freeze([
  "source",
  "name",
  "dependency",
  "title",
  "url",
  "severity",
  "cwe",
  "cvss",
  "range",
]);
const CVSS_KEYS = Object.freeze(["score", "vectorString"]);
const VULNERABILITY_KEYS = Object.freeze([
  "effects",
  "fixAvailable",
  "isDirect",
  "name",
  "nodes",
  "range",
  "severity",
  "via",
]);
const DEPENDENCY_COUNT_KEYS = Object.freeze(["dev", "optional", "peer", "peerOptional", "prod", "total"]);
const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);
const VULNERABILITY_COUNT_KEYS = Object.freeze([...SEVERITIES, "total"]);
const FIX_AVAILABLE_KEYS = Object.freeze(["isSemVerMajor", "name", "version"]);
const TRANSPORT_PREFIX = `request to ${QUICK_AUDIT_ENDPOINT} failed, reason: `;
const AGENT_TIMEOUT_REASONS = new Map([
  ["Timeout connecting to host `registry.npmjs.org:443`", "ECONNECTIONTIMEOUT"],
  ["Idle timeout reached for host `registry.npmjs.org:443`", "EIDLETIMEOUT"],
  ["Response timeout connecting to host `registry.npmjs.org`", "ERESPONSETIMEOUT"],
  ["Transfer timeout for `registry.npmjs.org`", "ETRANSFERTIMEOUT"],
]);
const NON_PUBLIC_IPV4_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_IPV4_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
const NON_PUBLIC_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC_IPV6_ADDRESSES.addSubnet(address, prefix, "ipv6");
}
const PUBLIC_IPV6_CONNECT_ADDRESSES = new BlockList();
PUBLIC_IPV6_CONNECT_ADDRESSES.addSubnet("2000::", 3, "ipv6");
PUBLIC_IPV6_CONNECT_ADDRESSES.addSubnet("64:ff9b::", 96, "ipv6");

export const AUDIT_TRANSIENT_CODES = Object.freeze([
  "ECONNRESET",
  "ECONNREFUSED",
  "EADDRINUSE",
  "ETIMEDOUT",
  "ECONNECTIONTIMEOUT",
  "EIDLETIMEOUT",
  "ERESPONSETIMEOUT",
  "ETRANSFERTIMEOUT",
]);

const TRANSIENT_CODE_SET = new Set(AUDIT_TRANSIENT_CODES);
const PUBLIC_SCOPES = new Set([
  "slice0-production",
  "sqlite-fts-production",
  "backup-crypto-production",
  "model-transport-production",
  "root-app-production",
]);
const CLASSIFICATIONS = new Set([
  "registry-http",
  "registry-transport",
  "spawn-error",
  "signaled",
  "unexpected-status",
  "empty-json",
  "malformed-json",
  "invalid-report",
  "invalid-count",
  "count-mismatch",
  "high-vulnerability",
  "critical-vulnerability",
  "moderate-policy",
  "inventory-invalid",
  "internal-error",
]);
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const EMPTY_EVIDENCE = Object.freeze({
  elapsedMs: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutSha256: EMPTY_SHA256,
  stderrSha256: EMPTY_SHA256,
});

class AuditExecutionFailure extends Error {
  constructor(diagnostic) {
    super("audit execution failed");
    this.diagnostic = diagnostic;
  }
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function hasExactNpmErrorFooter(value) {
  return hasExactKeys(value, NPM_ERROR_KEYS)
    && value.summary === ""
    && value.detail === "";
}

function hasHeaderShape(value) {
  return isRecord(value)
    && Object.values(value).every((entries) => Array.isArray(entries)
      && entries.every((entry) => typeof entry === "string"));
}

function looksLikeAuditCountObject(value) {
  return isRecord(value) && VULNERABILITY_COUNT_KEYS.every((key) => Object.hasOwn(value, key));
}

function looksLikeAuditVulnerabilityObject(value) {
  return isRecord(value) && VULNERABILITY_KEYS.every((key) => Object.hasOwn(value, key));
}

function containsAuditReportMarker(value) {
  if (Array.isArray(value)) return value.some(containsAuditReportMarker);
  if (!isRecord(value)) return false;
  if (looksLikeAuditCountObject(value) || looksLikeAuditVulnerabilityObject(value)) return true;
  if (Object.keys(value).some((key) => AUDIT_REPORT_MARKERS.has(key))) return true;
  return Object.values(value).some(containsAuditReportMarker);
}

function isRetryableHttpStatus(statusCode) {
  return statusCode === 408
    || statusCode === 420
    || statusCode === 429
    || (statusCode >= 500 && statusCode <= 599);
}

function parseNodeAddress(value) {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const address = value.slice(0, separator);
  const portText = value.slice(separator + 1);
  if (!/^[1-9]\d{0,4}$/.test(portText)) return null;
  const family = isIP(address);
  const port = Number(portText);
  if (family === 0 || port > 65_535) return null;
  let normalized;
  try {
    normalized = new SocketAddress({
      address,
      family: family === 4 ? "ipv4" : "ipv6",
      port,
    });
  } catch {
    return null;
  }
  if (normalized.address !== address || normalized.port !== port) return null;
  return { address, family, port };
}

function nat64EmbeddedIpv4(address) {
  if (!address.startsWith("64:ff9b::")) return null;
  const words = address.slice("64:ff9b::".length).split(":");
  if (words.length > 2) return null;
  const [highWord, lowWord] = words.length === 1 ? ["0", words[0] || "0"] : words;
  const high = Number.parseInt(highWord, 16);
  const low = Number.parseInt(lowWord, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPublicNodeAddress(target) {
  if (target.family === 4) return !NON_PUBLIC_IPV4_ADDRESSES.check(target.address, "ipv4");
  const embeddedIpv4 = nat64EmbeddedIpv4(target.address);
  return PUBLIC_IPV6_CONNECT_ADDRESSES.check(target.address, "ipv6")
    && !NON_PUBLIC_IPV6_ADDRESSES.check(target.address, "ipv6")
    && (embeddedIpv4 === null || !NON_PUBLIC_IPV4_ADDRESSES.check(embeddedIpv4, "ipv4"));
}

function nodeSystemTransportCode(reason) {
  if (reason === "socket hang up" || /^(?:read|write) ECONNRESET$/.test(reason)) return "ECONNRESET";

  const connect = /^connect (ECONNRESET|ECONNREFUSED|ETIMEDOUT) (.+)$/.exec(reason);
  if (connect) {
    const target = parseNodeAddress(connect[2]);
    return target?.port === 443 && isPublicNodeAddress(target) ? connect[1] : null;
  }

  const bind = /^bind EADDRINUSE (.+)$/.exec(reason);
  return bind && parseNodeAddress(bind[1]) ? "EADDRINUSE" : null;
}

function transportCode(message) {
  if (!message.startsWith(TRANSPORT_PREFIX) || message.length === TRANSPORT_PREFIX.length) return null;
  const reason = message.slice(TRANSPORT_PREFIX.length);
  return AGENT_TIMEOUT_REASONS.get(reason) ?? nodeSystemTransportCode(reason);
}

export function classifyRetryableAuditEnvelope(value) {
  if (containsAuditReportMarker(value)) return null;

  if (hasExactKeys(value, HTTP_ENVELOPE_KEYS)
    && typeof value.message === "string"
    && value.message.length > 0
    && value.method === "POST"
    && value.uri === QUICK_AUDIT_ENDPOINT
    && hasHeaderShape(value.headers)
    && Number.isSafeInteger(value.statusCode)
    && hasExactNpmErrorFooter(value.error)
    && isRetryableHttpStatus(value.statusCode)) {
    return Object.freeze({
      classification: "registry-http",
      endpoint: QUICK_ENDPOINT_ENUM,
      status: `HTTP_${value.statusCode}`,
    });
  }

  if (hasExactKeys(value, TRANSPORT_ENVELOPE_KEYS)
    && typeof value.message === "string"
    && hasExactNpmErrorFooter(value.error)) {
    const code = transportCode(value.message);
    if (code !== null && TRANSIENT_CODE_SET.has(code)) {
      return Object.freeze({
        classification: "registry-transport",
        endpoint: QUICK_ENDPOINT_ENUM,
        code,
      });
    }
  }

  return null;
}

function publicScope(scope) {
  return PUBLIC_SCOPES.has(scope) ? scope : "slice0-production";
}

function publicAttempt(attempt) {
  return attempt === 2 ? 2 : 1;
}

function nonnegativeElapsed(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function capturedText(value) {
  return typeof value === "string" ? value : "";
}

function captureEvidence(stdout, stderr, elapsedMs) {
  const stdoutText = capturedText(stdout);
  const stderrText = capturedText(stderr);
  return Object.freeze({
    elapsedMs: nonnegativeElapsed(elapsedMs),
    stdoutBytes: Buffer.byteLength(stdoutText, "utf8"),
    stderrBytes: Buffer.byteLength(stderrText, "utf8"),
    stdoutSha256: createHash("sha256").update(stdoutText, "utf8").digest("hex"),
    stderrSha256: createHash("sha256").update(stderrText, "utf8").digest("hex"),
  });
}

function safeEvidence(value) {
  return isRecord(value)
    && Number.isSafeInteger(value.elapsedMs)
    && value.elapsedMs >= 0
    && Number.isSafeInteger(value.stdoutBytes)
    && value.stdoutBytes >= 0
    && Number.isSafeInteger(value.stderrBytes)
    && value.stderrBytes >= 0
    && typeof value.stdoutSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.stdoutSha256)
    && typeof value.stderrSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.stderrSha256)
    ? Object.freeze({
      elapsedMs: value.elapsedMs,
      stdoutBytes: value.stdoutBytes,
      stderrBytes: value.stderrBytes,
      stdoutSha256: value.stdoutSha256,
      stderrSha256: value.stderrSha256,
    })
    : EMPTY_EVIDENCE;
}

function diagnostic(event, scope, attempt, classification, detail = {}, evidence = EMPTY_EVIDENCE) {
  const record = {
    audit: event === "retry" ? "retry" : "failure",
    scope: publicScope(scope),
    attempt: publicAttempt(attempt),
    classification: CLASSIFICATIONS.has(classification) ? classification : "internal-error",
  };
  if (detail?.endpoint === QUICK_ENDPOINT_ENUM) {
    record.endpoint = QUICK_ENDPOINT_ENUM;
    if (/^HTTP_(?:408|420|429|5\d\d)$/.test(detail.status ?? "")) record.status = detail.status;
    else if (TRANSIENT_CODE_SET.has(detail.code)) record.code = detail.code;
  }
  Object.assign(record, safeEvidence(evidence));
  return Object.freeze(record);
}

export function failAudit(scope, attempt, classification, detail, evidence) {
  throw new AuditExecutionFailure(diagnostic("failure", scope, attempt, classification, detail, evidence));
}

export function emitAuditFailure(error, fallbackScope) {
  const record = error instanceof AuditExecutionFailure
    ? error.diagnostic
    : diagnostic("failure", fallbackScope, 1, "internal-error");
  console.error(JSON.stringify(record));
}

function parseAuditJson(stdout, scope, attempt, evidence) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    failAudit(scope, attempt, "empty-json", undefined, evidence);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    failAudit(scope, attempt, "malformed-json", undefined, evidence);
  }
}

export function executeAuditScope(scope, invoke, runtime = {}) {
  const now = typeof runtime.now === "function" ? runtime.now : Date.now;
  const emit = typeof runtime.emit === "function" ? runtime.emit : console.error;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = now();
    let audit;
    try {
      audit = invoke();
    } catch {
      const evidence = captureEvidence("", "", now() - startedAt);
      failAudit(scope, attempt, "spawn-error", undefined, evidence);
    }
    const evidence = captureEvidence(audit?.stdout, audit?.stderr, now() - startedAt);
    if (!isRecord(audit) || audit.error !== undefined) {
      failAudit(scope, attempt, "spawn-error", undefined, evidence);
    }
    if (audit.signal !== null) failAudit(scope, attempt, "signaled", undefined, evidence);
    if (audit.status !== 0 && audit.status !== 1) {
      failAudit(scope, attempt, "unexpected-status", undefined, evidence);
    }

    const report = parseAuditJson(audit.stdout, scope, attempt, evidence);
    const retry = audit.status === 1 ? classifyRetryableAuditEnvelope(report) : null;
    if (retry === null) return Object.freeze({ report, attempt, evidence });
    if (attempt === 2) failAudit(scope, attempt, retry.classification, retry, evidence);
    emit(JSON.stringify(diagnostic("retry", scope, attempt, retry.classification, retry, evidence)));
  }
  failAudit(scope, 2, "internal-error");
}

function hasNpmAdvisoryShape(value) {
  return hasExactKeys(value, ADVISORY_KEYS)
    && Number.isSafeInteger(value.source)
    && value.source >= 0
    && typeof value.name === "string"
    && typeof value.dependency === "string"
    && typeof value.title === "string"
    && typeof value.url === "string"
    && SEVERITIES.includes(value.severity)
    && Array.isArray(value.cwe)
    && value.cwe.every((entry) => typeof entry === "string")
    && hasExactKeys(value.cvss, CVSS_KEYS)
    && Number.isFinite(value.cvss.score)
    && value.cvss.score >= 0
    && value.cvss.score <= 10
    && (value.cvss.vectorString === null || typeof value.cvss.vectorString === "string")
    && typeof value.range === "string";
}

function hasNpmVulnerabilityShape(name, value) {
  const fixAvailable = value?.fixAvailable;
  const validFix = typeof fixAvailable === "boolean"
    || (hasExactKeys(fixAvailable, FIX_AVAILABLE_KEYS)
      && typeof fixAvailable.name === "string"
      && typeof fixAvailable.version === "string"
      && typeof fixAvailable.isSemVerMajor === "boolean");
  return hasExactKeys(value, VULNERABILITY_KEYS)
    && value.name === name
    && SEVERITIES.includes(value.severity)
    && typeof value.isDirect === "boolean"
    && Array.isArray(value.via)
    && value.via.every((entry) => typeof entry === "string" || hasNpmAdvisoryShape(entry))
    && Array.isArray(value.effects)
    && value.effects.every((entry) => typeof entry === "string")
    && typeof value.range === "string"
    && Array.isArray(value.nodes)
    && value.nodes.every((entry) => typeof entry === "string")
    && validFix;
}

export function validateAuditCounts(report, scope, attempt, evidence) {
  if (!hasExactKeys(report, REPORT_KEYS)
    || report.auditReportVersion !== 2
    || !isRecord(report.vulnerabilities)
    || !hasExactKeys(report.metadata, REPORT_METADATA_KEYS)
    || !isRecord(report.metadata.vulnerabilities)
    || !isRecord(report.metadata.dependencies)
    || Object.entries(report.vulnerabilities).some(([name, value]) => !hasNpmVulnerabilityShape(name, value))) {
    failAudit(scope, attempt, "invalid-report", undefined, evidence);
  }

  const counts = report.metadata.vulnerabilities;
  if (!hasExactKeys(counts, VULNERABILITY_COUNT_KEYS)
    || !hasExactKeys(report.metadata.dependencies, DEPENDENCY_COUNT_KEYS)) {
    failAudit(scope, attempt, "invalid-count", undefined, evidence);
  }
  for (const value of [...Object.values(counts), ...Object.values(report.metadata.dependencies)]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      failAudit(scope, attempt, "invalid-count", undefined, evidence);
    }
  }

  const total = SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
  const actual = Object.values(report.vulnerabilities).reduce((tally, vulnerability) => {
    tally[vulnerability.severity] += 1;
    return tally;
  }, Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])));
  if (counts.total !== total
    || counts.total !== Object.keys(report.vulnerabilities).length
    || SEVERITIES.some((severity) => counts[severity] !== actual[severity])) {
    failAudit(scope, attempt, "count-mismatch", undefined, evidence);
  }
  return counts;
}

export function enforceAuditThreshold(counts, scope, attempt, evidence) {
  if (counts.high !== 0) failAudit(scope, attempt, "high-vulnerability", undefined, evidence);
  if (counts.critical !== 0) failAudit(scope, attempt, "critical-vulnerability", undefined, evidence);
}
