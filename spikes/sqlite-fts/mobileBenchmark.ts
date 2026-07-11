import * as SQLite from "expo-sqlite";

import { privateFixture, publicFixture } from "./.generated/fixtures";
import {
  benchmarkDatabaseOpenOptions,
  type Chunk,
  queryExpression,
  type Question,
  type Report,
  score,
} from "./scoring";

const columns = "chunk_id,document_id,source_id,content_sha256,title,chapter,content";
type Fixture = Readonly<{
  source_id: string;
  documents: readonly Chunk[];
  questions: readonly Question[];
}>;

export async function evaluateVariant(variant: "public" | "private"): Promise<Report> {
  const fixtures: readonly Fixture[] = variant === "private" ? [publicFixture, privateFixture] : [publicFixture];
  const evaluationFixture: Fixture = variant === "private" ? privateFixture : publicFixture;
  const chunks = fixtures.flatMap((fixture) => fixture.documents);
  const database = await SQLite.openDatabaseAsync(`g015-${variant}.db`, benchmarkDatabaseOpenOptions);
  const resultSets: Chunk[][] = [];
  const timings: number[] = [];
  try {
    await database.execAsync(
      `DROP TABLE IF EXISTS chunks; CREATE VIRTUAL TABLE chunks USING fts5(` +
      `chunk_id UNINDEXED,document_id UNINDEXED,source_id UNINDEXED,content_sha256 UNINDEXED,` +
      `title,chapter,content,tokenize='unicode61')`,
    );
    for (const chunk of chunks) {
      await database.runAsync(`INSERT INTO chunks(${columns}) VALUES(?,?,?,?,?,?,?)`,
        chunk.chunk_id, chunk.document_id, chunk.source_id, chunk.content_sha256,
        chunk.title, chunk.chapter, chunk.content);
    }
    for (const question of evaluationFixture.questions) {
      const started = performance.now();
      resultSets.push(await database.getAllAsync<Chunk>(
        `SELECT ${columns} FROM chunks WHERE chunks MATCH ? ` +
        `ORDER BY bm25(chunks,0,0,0,0.25,0.1,1),chunk_id LIMIT 10`, queryExpression(question.query)));
      timings.push(performance.now() - started);
    }
  } finally {
    await database.closeAsync();
  }
  return score(variant, fixtures.map((fixture) => fixture.source_id), chunks,
    evaluationFixture.questions, resultSets, timings);
}
