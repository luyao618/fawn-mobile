import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = "scripts/e2e/run-fault-matrix.sh";
const normative = JSON.parse(await readFile("src/testing/faultPoints.json", "utf8"));

function run(registry: string) {
  return spawnSync("bash", [script, "all", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, FAULT_POINTS_FILE: registry },
  });
}

test("fault matrix accepts only the exact normative ordered registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "g018-fault-matrix-"));
  try {
    const valid = join(root, "valid.json");
    await writeFile(valid, JSON.stringify(normative));
    assert.equal(run(valid).status, 0);
    const variants = [
      ["replacement.point", ...normative.slice(1)],
      [normative[1], normative[0], ...normative.slice(2)],
      [...normative.slice(0, 12), normative[11]],
      normative.slice(0, 12),
      [...normative, "extra.point"],
    ];
    for (const [index, variant] of variants.entries()) {
      const path = join(root, `${index}.json`);
      await writeFile(path, JSON.stringify(variant));
      const result = run(path);
      assert.notEqual(result.status, 0, `variant ${index} unexpectedly passed`);
      assert.match(result.stderr, /ordered normative 13-point contract/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
