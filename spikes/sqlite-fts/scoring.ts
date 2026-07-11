export type Chunk = Readonly<{
  chunk_id: string;
  document_id: string;
  source_id: string;
  content_sha256: string;
  title: string;
  chapter: string;
  content: string;
}>;

export type Question = Readonly<{
  query: string;
  expected_source: string;
  expected_keywords: readonly string[];
}>;

export type Report = Readonly<{
  variant: "public" | "private";
  fts5Available: true;
  corpusFixtureIds: readonly string[];
  corpusChunks: number;
  questions: number;
  sourceHitAt3Pct: number;
  keywordRecallAt3Pct: number;
  citationIntegrityPct: number;
  top10P95Ms: number;
}>;

export type BenchmarkDatabaseOpenOptions = Readonly<{
  finalizeUnusedStatementsBeforeClosing: false;
}>;

export const benchmarkDatabaseOpenOptions: BenchmarkDatabaseOpenOptions = {
  finalizeUnusedStatementsBeforeClosing: false,
};

export const thresholds = {
  sourceHitAt3Pct: 80,
  keywordRecallAt3Pct: 70,
  citationIntegrityPct: 100,
  top10P95Ms: 250,
} as const;

const citationFields = ["document_id", "chapter", "source_id", "content_sha256", "content"] as const;

export function queryExpression(query: string): string {
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) throw new Error("query has no searchable tokens");
  return tokens.slice(0, 16).map((token) => `"${token}"`).join(" OR ");
}

export function percentile95(values: readonly number[]): number {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("invalid timing");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

export function citationMatches(result: Chunk, canonical: Chunk): boolean {
  return citationFields.every((field) => result[field] === canonical[field]);
}

export function score(
  variant: "public" | "private",
  fixtureIds: readonly string[],
  chunks: readonly Chunk[],
  questions: readonly Question[],
  resultSets: readonly (readonly Chunk[])[],
  timings: readonly number[],
): Report {
  if (resultSets.length !== questions.length || timings.length !== questions.length) throw new Error("incomplete run");
  const canonical = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  let sourceHits = 0, keywordHits = 0, validCitations = 0, citationCount = 0;
  questions.forEach((question, index) => {
    const top3 = resultSets[index]!.slice(0, 3);
    if (top3.some((result) => result.title === question.expected_source)) sourceHits += 1;
    const text = top3.map((result) => result.content.toLocaleLowerCase()).join(" ");
    if (question.expected_keywords.some((keyword) => text.includes(keyword.toLocaleLowerCase()))) keywordHits += 1;
    top3.forEach((result) => {
      citationCount += 1;
      const expected = canonical.get(result.chunk_id);
      if (expected && citationMatches(result, expected)) validCitations += 1;
    });
  });
  const count = questions.length;
  return {
    variant, fts5Available: true, corpusFixtureIds: fixtureIds, corpusChunks: chunks.length, questions: count,
    sourceHitAt3Pct: sourceHits / count * 100,
    keywordRecallAt3Pct: keywordHits / count * 100,
    citationIntegrityPct: citationCount ? validCitations / citationCount * 100 : 0,
    top10P95Ms: percentile95(timings),
  };
}

export function thresholdFailures(report: Report): string[] {
  return (Object.keys(thresholds) as (keyof typeof thresholds)[])
    .filter((key) => key === "top10P95Ms"
      ? report[key] > thresholds[key]
      : key === "citationIntegrityPct"
        ? report[key] !== thresholds[key]
        : report[key] < thresholds[key]);
}
