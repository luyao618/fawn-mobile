from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_public_and_private_corpus_composition(self) -> None:
        public = benchmark.load_inputs("public")
        private = benchmark.load_inputs("private")
        self.assertEqual(public.fixture_ids, ("synthetic-public",))
        self.assertEqual(private.fixture_ids, ("synthetic-public", "synthetic-private"))
        self.assertEqual(len(public.chunks), 5)
        self.assertEqual(len(private.chunks), 10)
        self.assertTrue(all(question["id"].startswith("priv-") for question in private.questions))

    def test_exact_citation_detects_each_tampered_field(self) -> None:
        canonical = benchmark.load_inputs("public").chunks[0]
        result = {"chunk_id": canonical["chunk_id"], "title": canonical["title"], **canonical}
        self.assertTrue(benchmark.citation_matches(result, canonical))
        for field in benchmark.CITATION_FIELDS:
            tampered = deepcopy(result)
            tampered[field] = f"{tampered[field]}-tampered"
            self.assertFalse(benchmark.citation_matches(tampered, canonical), field)

    def test_threshold_failure_names_failed_metric(self) -> None:
        inputs = benchmark.load_inputs("public")
        report = {
            "sourceHitAt3Pct": 79,
            "keywordRecallAt3Pct": 100,
            "citationIntegrityPct": 100,
            "top10P95Ms": 1,
        }
        with self.assertRaisesRegex(benchmark.ThresholdFailure, "source_hit_at_3_pct"):
            benchmark.enforce_thresholds(report, inputs.thresholds)

    def test_query_and_nearest_rank_percentile(self) -> None:
        self.assertEqual(benchmark.query_expression("Sleep 仰卧_crib"), '"sleep" OR "仰卧" OR "crib"')
        self.assertEqual(benchmark.percentile_95(range(1, 21)), 19)
        self.assertEqual(benchmark.percentile_95([]), 0)
        with self.assertRaises(ValueError):
            benchmark.query_expression("___")
        with self.assertRaises(ValueError):
            benchmark.percentile_95([float("nan")])


if __name__ == "__main__":
    unittest.main()
