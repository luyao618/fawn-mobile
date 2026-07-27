import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const inventory = JSON.parse(await readFile(new URL("../licenses.slice0.json", import.meta.url), "utf8"));
assert.deepEqual(inventory.audit_policy?.fail_levels, ["high", "critical"], "Audit policy must fail high and critical findings");
const AUDIT_SCOPES = Object.freeze([
  Object.freeze(["sqlite-fts-production", "../spikes/sqlite-fts"]),
  Object.freeze(["backup-crypto-production", "../spikes/backup-crypto"]),
  Object.freeze(["model-transport-production", "../spikes/model-transport"]),
]);
const AUDIT_OPTIONS = Object.freeze(["audit", "--omit=dev", "--workspaces=false", "--json"]);
const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);
const results = [];

for (const [scope, relativePath] of AUDIT_SCOPES) {
  const audit = spawnSync("npm", AUDIT_OPTIONS, {
    cwd: new URL(relativePath, import.meta.url),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(audit.error, undefined, `${scope} npm audit could not start: ${audit.error?.message ?? audit.stderr}`);
  assert.equal(audit.signal, null, `${scope} npm audit was terminated by ${audit.signal}`);
  assert([0, 1].includes(audit.status), `${scope} npm audit exited unexpectedly with ${audit.status}: ${audit.stderr}`);
  assert(audit.stdout?.trim(), `${scope} npm audit produced no JSON: ${audit.stderr}`);

  const report = JSON.parse(audit.stdout);
  const counts = report.metadata?.vulnerabilities;
  assert(counts, `${scope} npm audit metadata is missing`);
  for (const severity of [...SEVERITIES, "total"]) {
    assert(Number.isSafeInteger(counts[severity]) && counts[severity] >= 0, `${scope} npm audit ${severity} count is missing or invalid`);
  }
  assert.equal(counts.total, SEVERITIES.reduce((total, severity) => total + counts[severity], 0), `${scope} npm audit total does not match severity counts`);
  assert.equal(counts.high, 0, `High vulnerabilities fail the ${scope} audit policy`);
  assert.equal(counts.critical, 0, `Critical vulnerabilities fail the ${scope} audit policy`);
  if (counts.moderate > 0) {
    assert.match(inventory.audit_policy.documented_moderate, /Expo 57\.0\.4.*unsafe downgrade.*Expo 46\.0\.21/i);
  }
  results.push({
    scope,
    info: counts.info,
    low: counts.low,
    moderate: counts.moderate,
    high: counts.high,
    critical: counts.critical,
    total: counts.total,
  });
}

console.log(JSON.stringify({
  audit: "pass",
  scopes: results,
  moderate_policy: results.some(({ moderate }) => moderate > 0) ? "documented inherited Expo chain; unsafe force-downgrade rejected" : "none",
}));
