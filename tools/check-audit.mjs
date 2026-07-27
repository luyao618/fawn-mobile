import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  emitAuditFailure,
  enforceAuditThreshold,
  executeAuditScope,
  failAudit,
  validateAuditCounts,
} from "./audit-execution.mjs";

const AUDIT_SCOPES = Object.freeze([
  Object.freeze(["sqlite-fts-production", "../spikes/sqlite-fts"]),
  Object.freeze(["backup-crypto-production", "../spikes/backup-crypto"]),
  Object.freeze(["model-transport-production", "../spikes/model-transport"]),
]);
const AUDIT_OPTIONS = Object.freeze(["audit", "--omit=dev", "--workspaces=false", "--json"]);
const SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);

async function main() {
  let inventory;
  try {
    inventory = JSON.parse(await readFile(new URL("../licenses.slice0.json", import.meta.url), "utf8"));
  } catch {
    failAudit("slice0-production", 1, "inventory-invalid");
  }
  if (JSON.stringify(inventory?.audit_policy?.fail_levels) !== JSON.stringify(["high", "critical"])) {
    failAudit("slice0-production", 1, "inventory-invalid");
  }

  const results = [];
  for (const [scope, relativePath] of AUDIT_SCOPES) {
    const { report, attempt, evidence } = executeAuditScope(scope, () => spawnSync("npm", AUDIT_OPTIONS, {
      cwd: new URL(relativePath, import.meta.url),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }));
    const counts = validateAuditCounts(report, scope, attempt, evidence);
    enforceAuditThreshold(counts, scope, attempt, evidence);
    if (counts.moderate > 0
      && !/Expo 57\.0\.4.*unsafe downgrade.*Expo 46\.0\.21/i.test(inventory.audit_policy.documented_moderate)) {
      failAudit(scope, attempt, "moderate-policy", undefined, evidence);
    }
    results.push({
      scope,
      ...Object.fromEntries(SEVERITIES.map((severity) => [severity, counts[severity]])),
      total: counts.total,
    });
  }

  console.log(JSON.stringify({
    audit: "pass",
    scopes: results,
    moderate_policy: results.some(({ moderate }) => moderate > 0) ? "documented inherited Expo chain; unsafe force-downgrade rejected" : "none",
  }));
}

try {
  await main();
} catch (error) {
  emitAuditFailure(error, "slice0-production");
  process.exitCode = 1;
}
