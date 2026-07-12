import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const generatedDirectory = resolve(repoRoot, "spikes/sqlite-fts/.generated");

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`));
    });
  });
}

export async function runTypecheck() {
  try {
    await run(process.execPath, ["spikes/sqlite-fts/scripts/generate-fixtures.mjs"]);
    await run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]);
  } finally {
    await rm(generatedDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTypecheck();
}
