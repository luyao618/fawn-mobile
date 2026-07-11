import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = resolve(spikeRoot, "..", "..", "knowledge", "fixtures");
const outputPath = resolve(spikeRoot, ".generated", "fixtures.ts");
const sources = [
  ["publicFixture", "public-synthetic.json"],
  ["privateFixture", "private-synthetic.json"],
];

async function render() {
  const declarations = await Promise.all(sources.map(async ([exportName, fileName]) => {
    const source = JSON.parse(await readFile(resolve(fixturesRoot, fileName), "utf8"));
    return `export const ${exportName} = ${JSON.stringify(source, null, 2)} as const;`;
  }));
  return [
    "// Generated from canonical knowledge fixtures. Do not edit or commit.",
    ...declarations,
    "",
  ].join("\n\n");
}

const expected = await render();
if (process.argv.includes("--check")) {
  let actual;
  try {
    actual = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (actual !== expected) {
    console.error("Generated fixtures are missing or stale; run npm run fixtures:generate.");
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, "utf8");
  console.log("Generated .generated/fixtures.ts from canonical knowledge fixtures.");
}
