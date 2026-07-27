import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  emitAuditFailure,
  enforceAuditThreshold,
  executeAuditScope,
  failAudit,
  validateAuditCounts,
} from "./audit-execution.mjs";

const APP_AUDIT_SCOPE = "root-app-production";
const APP_AUDIT_OPTIONS = Object.freeze(["audit", "--omit=dev", "--workspaces=false", "--include-workspace-root", "--json"]);

async function main() {
  let inventory;
  try {
    inventory = JSON.parse(await readFile(new URL("../licenses.app.json", import.meta.url), "utf8"));
  } catch {
    failAudit(APP_AUDIT_SCOPE, 1, "inventory-invalid");
  }
  if (JSON.stringify(inventory?.audit_policy?.fail_levels) !== JSON.stringify(["high", "critical"])) {
    failAudit(APP_AUDIT_SCOPE, 1, "inventory-invalid");
  }

  const { report, attempt, evidence } = executeAuditScope(APP_AUDIT_SCOPE, () => spawnSync("npm", APP_AUDIT_OPTIONS, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }));
  const counts = validateAuditCounts(report, APP_AUDIT_SCOPE, attempt, evidence);
  enforceAuditThreshold(counts, APP_AUDIT_SCOPE, attempt, evidence);
  if (counts.moderate > 0 && !inventory.audit_policy.documented_moderate) {
    failAudit(APP_AUDIT_SCOPE, attempt, "moderate-policy", undefined, evidence);
  }
  console.log(JSON.stringify({
    audit: "pass",
    scope: APP_AUDIT_SCOPE,
    high: counts.high,
    critical: counts.critical,
    moderate: counts.moderate,
  }));
}

try {
  await main();
} catch (error) {
  emitAuditFailure(error, APP_AUDIT_SCOPE);
  process.exitCode = 1;
}
