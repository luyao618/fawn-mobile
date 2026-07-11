import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkDatabaseOpenOptions,
  citationMatches,
  percentile95,
  queryExpression,
  thresholdFailures,
  type Chunk,
  type Report,
} from "./scoring";

const chunk: Chunk = {
  chunk_id: "c", document_id: "d", source_id: "s", content_sha256: "h",
  title: "t", chapter: "chapter", content: "content",
};

test("query expression and percentile use deterministic policies", () => {
  assert.equal(queryExpression("Sleep 仰卧_crib"), '"sleep" OR "仰卧" OR "crib"');
  assert.equal(percentile95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  assert.equal(percentile95([]), 0);
  assert.throws(() => queryExpression("___"));
});

test("benchmark database open options preserve the FTS close workaround", () => {
  assert.deepEqual(benchmarkDatabaseOpenOptions, { finalizeUnusedStatementsBeforeClosing: false });
});

test("citation integrity is exact and thresholds fail closed", () => {
  assert.equal(citationMatches(chunk, chunk), true);
  assert.equal(citationMatches({ ...chunk, content: "tampered" }, chunk), false);
  const report = {
    variant: "public", fts5Available: true, corpusFixtureIds: ["synthetic-public"], corpusChunks: 5, questions: 25,
    sourceHitAt3Pct: 79, keywordRecallAt3Pct: 100, citationIntegrityPct: 100, top10P95Ms: 1,
  } satisfies Report;
  assert.deepEqual(thresholdFailures(report), ["sourceHitAt3Pct"]);
  assert.deepEqual(thresholdFailures({ ...report, sourceHitAt3Pct: 100, citationIntegrityPct: 101 }), ["citationIntegrityPct"]);
});
