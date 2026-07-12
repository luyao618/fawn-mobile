import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { redactOutput } from "./redaction.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const generatedWho = join(tmpdir(), "fawn-slice0-who-reference.csv");
const commands = [
  ["node", ["--version"]],
  ["npm", ["--version"]],
  ["npm", ["run", "typecheck", "--silent"]],
  ["npm", ["run", "test:node", "--silent"]],
  ["python3", ["-m", "unittest", "discover", "-s", "tools/knowledge/tests", "-p", "test_*.py"]],
  ["python3", ["spikes/sqlite-fts/benchmark.py", "--all"]],
  ["python3", ["tools/knowledge/build_who_reference.py", "--output", generatedWho]],
  ["node", ["tools/check-licenses.mjs"]],
  ["node", ["tools/check-audit.mjs"]],
];

export async function cleanupGeneratedArtifacts(root = repoRoot, whoOutput = generatedWho) {
  await Promise.all([
    "spikes/model-transport/.expo",
    "spikes/model-transport/.expo-export",
    "spikes/model-transport/android",
    "spikes/model-transport/ios",
    "spikes/sqlite-fts/.generated",
    "tools/__pycache__",
    "tools/knowledge/__pycache__",
    "tools/knowledge/tests/__pycache__",
  ].map((path) => rm(resolve(root, path), { recursive: true, force: true })));
  await rm(whoOutput, { force: true });
}

async function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      const safeOut = redactOutput(stdout).trim();
      const safeError = redactOutput(stderr).trim();
      if (safeOut) process.stdout.write(`${safeOut}\n`);
      if (safeError) process.stderr.write(`${safeError}\n`);
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

export async function runSlice0() {
  try {
    for (const [command, args] of commands) await run(command, args);
    console.log(JSON.stringify({ slice0: "pass", checks: commands.length, cleanup: "pass" }));
  } finally {
    await cleanupGeneratedArtifacts();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSlice0();
}
