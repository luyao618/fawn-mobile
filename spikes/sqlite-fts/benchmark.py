from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.knowledge.manifest_policy import (  # noqa: E402
    load_json_yaml,
    validate_evaluation,
    validate_manifest,
)

VARIANTS = ("public", "private")
CITATION_FIELDS = ("document_id", "chapter", "source_id", "content_sha256", "content")


class ThresholdFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class Inputs:
    variant: str
    fixture_ids: tuple[str, ...]
    chunks: tuple[dict[str, Any], ...]
    questions: tuple[dict[str, Any], ...]
    thresholds: dict[str, int]


def load_inputs(variant: str) -> Inputs:
    if variant not in VARIANTS:
        raise ValueError(f"unsupported variant: {variant}")
    manifest = validate_manifest(ROOT / f"knowledge/manifest.{variant}.yaml")
    evaluation = validate_evaluation(ROOT / f"knowledge/eval.{variant}.yaml")
    fixtures = [load_json_yaml(ROOT / item["path"]) for item in manifest["documents"]]
    evaluation_fixture = load_json_yaml(ROOT / evaluation["fixture"])
    chunks = tuple(chunk for fixture in fixtures for chunk in fixture["documents"])
    chunk_ids = [chunk["chunk_id"] for chunk in chunks]
    if len(chunk_ids) != len(set(chunk_ids)):
        raise ValueError(f"{variant} corpus has duplicate chunk ids")
    return Inputs(
        variant,
        tuple(fixture["source_id"] for fixture in fixtures),
        chunks,
        tuple(evaluation_fixture["questions"]),
        evaluation["thresholds"],
    )


def query_expression(query: str) -> str:
    tokens = re.findall(r"[^\W_]+", query.casefold(), re.UNICODE)
    if not tokens:
        raise ValueError("query has no searchable tokens")
    return " OR ".join(f'"{token}"' for token in tokens[:16])


def percentile_95(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    if any(value < 0 or not math.isfinite(value) for value in values):
        raise ValueError("timings must be finite and non-negative")
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * 0.95) - 1]


def citation_matches(result: dict[str, Any], canonical: dict[str, Any]) -> bool:
    return all(result[field] == canonical[field] for field in CITATION_FIELDS)


def score(inputs: Inputs, result_sets: Sequence[Sequence[dict[str, Any]]], timings: Sequence[float]) -> dict[str, Any]:
    if len(result_sets) != len(inputs.questions) or len(timings) != len(inputs.questions):
        raise ValueError("each question requires results and a timing")
    canonical = {chunk["chunk_id"]: chunk for chunk in inputs.chunks}
    source_hits = keyword_hits = valid_citations = citation_count = 0
    for question, results in zip(inputs.questions, result_sets, strict=True):
        top_three = results[:3]
        source_hits += any(result["title"] == question["expected_source"] for result in top_three)
        text = " ".join(result["content"].casefold() for result in top_three)
        keyword_hits += any(keyword.casefold() in text for keyword in question["expected_keywords"])
        for result in top_three:
            citation_count += 1
            chunk = canonical.get(result["chunk_id"])
            valid_citations += chunk is not None and citation_matches(result, chunk)
    count = len(inputs.questions)
    return {
        "variant": inputs.variant,
        "fts5Available": True,
        "corpusFixtureIds": list(inputs.fixture_ids),
        "corpusChunks": len(inputs.chunks),
        "questions": count,
        "sourceHitAt3Pct": source_hits / count * 100,
        "keywordRecallAt3Pct": keyword_hits / count * 100,
        "citationIntegrityPct": valid_citations / citation_count * 100 if citation_count else 0.0,
        "top10P95Ms": percentile_95(timings),
    }


def threshold_failures(report: dict[str, Any], thresholds: dict[str, int]) -> list[str]:
    checks = {
        "source_hit_at_3_pct": report["sourceHitAt3Pct"] >= thresholds["source_hit_at_3_pct"],
        "keyword_recall_at_3_pct": report["keywordRecallAt3Pct"] >= thresholds["keyword_recall_at_3_pct"],
        "citation_integrity_pct": report["citationIntegrityPct"] == thresholds["citation_integrity_pct"],
        "top_10_p95_ms": report["top10P95Ms"] <= thresholds["top_10_p95_ms"],
    }
    return [name for name, passed in checks.items() if not passed]


def enforce_thresholds(report: dict[str, Any], thresholds: dict[str, int]) -> None:
    failures = threshold_failures(report, thresholds)
    if failures:
        raise ThresholdFailure(",".join(failures))


def create_database(chunks: Sequence[dict[str, Any]]) -> sqlite3.Connection:
    database = sqlite3.connect(":memory:")
    database.execute(
        "CREATE VIRTUAL TABLE chunks USING fts5("
        "chunk_id UNINDEXED, document_id UNINDEXED, source_id UNINDEXED, content_sha256 UNINDEXED, "
        "title, chapter, content, tokenize='unicode61')"
    )
    database.executemany(
        "INSERT INTO chunks VALUES(:chunk_id,:document_id,:source_id,:content_sha256,:title,:chapter,:content)", chunks
    )
    return database


def search(database: sqlite3.Connection, query: str) -> list[dict[str, Any]]:
    columns = ("chunk_id", "document_id", "source_id", "content_sha256", "title", "chapter", "content")
    rows = database.execute(
        "SELECT chunk_id,document_id,source_id,content_sha256,title,chapter,content "
        "FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks,0,0,0,0.25,0.1,1),chunk_id LIMIT 10",
        (query_expression(query),),
    ).fetchall()
    return [dict(zip(columns, row, strict=True)) for row in rows]


def evaluate(variant: str) -> dict[str, Any]:
    inputs = load_inputs(variant)
    database = create_database(inputs.chunks)
    results: list[list[dict[str, Any]]] = []
    timings: list[float] = []
    try:
        for question in inputs.questions:
            started = time.perf_counter_ns()
            results.append(search(database, question["query"]))
            timings.append((time.perf_counter_ns() - started) / 1_000_000)
    finally:
        database.close()
    report = score(inputs, results, timings)
    enforce_thresholds(report, inputs.thresholds)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="G015 desktop SQLite FTS5 proof")
    parser.add_argument("--variant", choices=VARIANTS)
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args(argv)
    variants = VARIANTS if args.all else (args.variant or "public",)
    payload: dict[str, Any] = {"schemaVersion": 1, "platform": "desktop", "reports": []}
    try:
        payload["reports"] = [evaluate(variant) for variant in variants]
        payload["status"] = "PASS"
    except Exception as error:
        payload.update(status="FAIL", errorType=type(error).__name__, error=str(error))
    print("G015_DESKTOP_PROOF " + json.dumps(payload, sort_keys=True, separators=(",", ":")))
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
