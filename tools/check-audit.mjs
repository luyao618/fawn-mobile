import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const inventory = JSON.parse(await readFile(new URL("../licenses.slice0.json", import.meta.url), "utf8"));
assert.deepEqual(inventory.audit_policy?.fail_levels, ["high", "critical"], "Audit policy must fail high and critical findings");
const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  cwd: new URL("../spikes/model-transport", import.meta.url),
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
assert(audit.stdout, `npm audit produced no JSON: ${audit.stderr}`);
const report = JSON.parse(audit.stdout);
const counts = report.metadata?.vulnerabilities;
assert(counts, "npm audit metadata is missing");
assert.equal(counts.high, 0, "High vulnerabilities fail the G017 audit policy");
assert.equal(counts.critical, 0, "Critical vulnerabilities fail the G017 audit policy");
if (counts.moderate > 0) {
  assert.match(inventory.audit_policy.documented_moderate, /Expo 57\.0\.4.*unsafe downgrade.*Expo 46\.0\.21/i);
}
console.log(JSON.stringify({
  audit: "pass",
  high: counts.high,
  critical: counts.critical,
  moderate: counts.moderate,
  moderate_policy: counts.moderate ? "documented inherited Expo chain; unsafe force-downgrade rejected" : "none",
}));
