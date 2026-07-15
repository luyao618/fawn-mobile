import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const inventory = JSON.parse(await readFile(new URL("../licenses.app.json", import.meta.url), "utf8"));
assert.deepEqual(inventory.audit_policy?.fail_levels, ["high", "critical"], "App audit policy must fail high and critical findings");
const audit = spawnSync("npm", ["audit", "--omit=dev", "--workspaces=false", "--include-workspace-root", "--json"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
assert(audit.stdout, `npm audit produced no JSON: ${audit.stderr}`);
const report = JSON.parse(audit.stdout);
const counts = report.metadata?.vulnerabilities;
assert(counts, "npm audit metadata is missing");
assert.equal(counts.high, 0, "High vulnerabilities fail the app audit policy");
assert.equal(counts.critical, 0, "Critical vulnerabilities fail the app audit policy");
if (counts.moderate > 0) assert(inventory.audit_policy.documented_moderate, "Moderate findings must be documented");
console.log(JSON.stringify({ audit: "pass", scope: "root-app-production", high: counts.high, critical: counts.critical, moderate: counts.moderate }));
