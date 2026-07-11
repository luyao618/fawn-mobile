from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.knowledge.manifest_policy import load_json_yaml, validate_evaluation, validate_fixture, validate_manifest

ROOT = Path(__file__).resolve().parents[3]
FROZEN_CONTENT_HASHES = {
    "private-feeding-1": "220ab431e9991b34356018f29ebc03940587520534e1db898ddbba610d0c57d3",
    "private-sleep-1": "8e9447c7c46c053fdd79d8a1c9f74f6c85be58f842c531a7f400862d358d71fe",
    "private-development-1": "13146404763df277092e89d785d9422778182d59b528e8b7ed9257feb2da1fa0",
    "private-symptoms-1": "8a568dde411fdd563620f9b4ebc172f5b3e4cce72c49ac1eb19723b349061ef7",
    "private-prevention-1": "6db755dd83db4063d8679ee7cc8575726235a680ea39e0f5af9677917e6fb6ac",
    "public-feeding-1": "562757796c3193666563c9054dc0d1624a7fb671bd31a23e91df301485a9bb53",
    "public-sleep-1": "8ea85c5509cd005fdc788fd2d757e75fbd80996015b3479a577e1654914bf80c",
    "public-development-1": "1d4eda3d5466d51e3d7745c49046e01933fb25917d093f51bee707722b9b94e9",
    "public-symptoms-1": "1578249493792cf924d8d03126d579e1d7091b3141cac17d19b75151323285c9",
    "public-prevention-1": "ef72e34051e9503aa83cf957a5ff26824c42c41fc383040137cc07226cee74e0",
}
FIXTURE_IDENTITIES = {
    "public": {
        "expected_schema_version": 1,
        "expected_source_id": "synthetic-public",
        "expected_redistribution_status": "public-allowed",
        "expected_license": "CC0-1.0",
    },
    "private": {
        "expected_schema_version": 1,
        "expected_source_id": "synthetic-private",
        "expected_redistribution_status": "private-only",
        "expected_license": "private-test-fixture",
    },
}


class KnowledgePolicyTest(unittest.TestCase):
    def assert_evaluation_rejected(self, evaluation: object, filename: str = "eval.public.yaml") -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / filename
            path.write_text(json.dumps(evaluation), encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_evaluation(path)

    def assert_manifest_rejected(self, manifest: object) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", encoding="utf-8") as handle:
            json.dump(manifest, handle)
            handle.flush()
            with self.assertRaises(ValueError):
                validate_manifest(Path(handle.name))

    def public_manifest(self) -> dict[str, object]:
        return json.loads((ROOT / "knowledge/manifest.public.yaml").read_text(encoding="utf-8"))

    def evaluation(self, variant: str = "public") -> dict[str, object]:
        return json.loads((ROOT / f"knowledge/eval.{variant}.yaml").read_text(encoding="utf-8"))

    def fixture(self, variant: str = "public") -> dict[str, object]:
        return json.loads((ROOT / f"knowledge/fixtures/{variant}-synthetic.json").read_text(encoding="utf-8"))

    def assert_fixture_rejected(self, fixture: object, variant: str = "public") -> None:
        with self.assertRaises(ValueError):
            validate_fixture(fixture, label=f"{variant} fixture", **FIXTURE_IDENTITIES[variant])

    def test_current_private_and_public_evaluations_are_valid(self) -> None:
        for variant in ("private", "public"):
            evaluation = validate_evaluation(ROOT / f"knowledge/eval.{variant}.yaml")
            self.assertEqual(evaluation["variant"], variant)
            self.assertEqual(evaluation["fixture"], f"knowledge/fixtures/{variant}-synthetic.json")

    def test_evaluation_rejects_public_private_fixture_swap(self) -> None:
        for variant, other_variant in (("public", "private"), ("private", "public")):
            altered = self.evaluation(variant)
            altered["fixture"] = f"knowledge/fixtures/{other_variant}-synthetic.json"
            with self.subTest(variant=variant):
                self.assert_evaluation_rejected(altered, f"eval.{variant}.yaml")

        real_load_json_yaml = load_json_yaml
        public_fixture_path = (ROOT / "knowledge/fixtures/public-synthetic.json").resolve()
        private_fixture = self.fixture("private")

        def load_with_fixture_swap(path: Path) -> dict[str, object]:
            if path.resolve() == public_fixture_path:
                return private_fixture
            return real_load_json_yaml(path)

        with patch("tools.knowledge.manifest_policy.load_json_yaml", side_effect=load_with_fixture_swap):
            with self.assertRaises(ValueError):
                validate_evaluation(ROOT / "knowledge/eval.public.yaml")

    def test_evaluation_rejects_missing_canonical_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch("tools.knowledge.manifest_policy.ROOT", Path(temp_dir)):
                self.assert_evaluation_rejected(self.evaluation())

    def test_evaluation_rejects_filename_or_variant_substitution(self) -> None:
        for variant, other_variant in (("public", "private"), ("private", "public")):
            with self.subTest(filename_variant=variant):
                self.assert_evaluation_rejected(self.evaluation(other_variant), f"eval.{variant}.yaml")

        altered = self.evaluation()
        altered["variant"] = "private"
        self.assert_evaluation_rejected(altered)
        self.assert_evaluation_rejected(self.evaluation(), "evaluation.public.yaml")

    def test_evaluation_requires_exact_top_level_keys(self) -> None:
        for key in self.evaluation():
            altered = self.evaluation()
            altered.pop(key)
            with self.subTest(missing=key):
                self.assert_evaluation_rejected(altered)

        altered = self.evaluation()
        altered["unexpected"] = True
        self.assert_evaluation_rejected(altered)

    def test_evaluation_requires_schema_version_one(self) -> None:
        for schema_version in (2, True, "1", 1.0):
            altered = self.evaluation()
            altered["schema_version"] = schema_version
            with self.subTest(schema_version=schema_version):
                self.assert_evaluation_rejected(altered)

    def test_evaluation_rejects_malformed_thresholds(self) -> None:
        expected = self.evaluation()["thresholds"]
        for malformed in (None, [], {}, {**expected, "unexpected": 0}):
            altered = self.evaluation()
            altered["thresholds"] = malformed
            with self.subTest(malformed=malformed):
                self.assert_evaluation_rejected(altered)

        for name, value in expected.items():
            altered = self.evaluation()
            altered["thresholds"][name] = value + 1
            with self.subTest(threshold=name):
                self.assert_evaluation_rejected(altered)

        altered = self.evaluation()
        altered["thresholds"]["source_hit_at_3_pct"] = 80.0
        self.assert_evaluation_rejected(altered)

    def test_evaluation_rejects_altered_policy_or_embedding_values(self) -> None:
        for field, value in (
            ("medical_policy", "red_flag_queries_may_diagnose"),
            ("embedding_dependency", "optional"),
        ):
            altered = self.evaluation()
            altered[field] = value
            with self.subTest(field=field):
                self.assert_evaluation_rejected(altered)

    def test_evaluation_rejects_duplicate_keys(self) -> None:
        payload = (ROOT / "knowledge/eval.public.yaml").read_text(encoding="utf-8")
        payloads = (
            payload.replace('"schema_version": 1,', '"schema_version": 1,\n  "schema_version": 1,', 1),
            payload.replace(
                '"source_hit_at_3_pct": 80,',
                '"source_hit_at_3_pct": 80,\n    "source_hit_at_3_pct": 80,',
                1,
            ),
        )
        for duplicate_payload in payloads:
            with self.subTest(payload=duplicate_payload):
                with tempfile.TemporaryDirectory() as temp_dir:
                    path = Path(temp_dir) / "eval.public.yaml"
                    path.write_text(duplicate_payload, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        validate_evaluation(path)

    def test_current_private_and_public_manifests_are_valid(self) -> None:
        expected_documents = {
            "private": {"synthetic-private", "synthetic-public"},
            "public": {"synthetic-public"},
        }
        for variant in ("private", "public"):
            manifest = validate_manifest(ROOT / f"knowledge/manifest.{variant}.yaml")
            self.assertEqual(manifest["variant"], variant)
            self.assertTrue(manifest["fail_closed"])
            self.assertEqual({document["id"] for document in manifest["documents"]}, expected_documents[variant])

    def test_public_manifest_filename_rejects_private_manifest_content(self) -> None:
        private_manifest = json.loads((ROOT / "knowledge/manifest.private.yaml").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as temp_dir:
            public_path = Path(temp_dir) / "manifest.public.yaml"
            public_path.write_text(json.dumps(private_manifest), encoding="utf-8")
            with self.assertRaises(ValueError):
                validate_manifest(public_path)

    def test_public_manifest_rejects_denied_or_missing_status(self) -> None:
        for status in ("denied", None):
            altered = self.public_manifest()
            document = altered["documents"][0]
            if status is None:
                document.pop("redistribution_status")
            else:
                document["redistribution_status"] = status
            with self.subTest(status=status):
                self.assert_manifest_rejected(altered)

    def test_public_manifest_rejects_private_fixture_relabeling(self) -> None:
        altered = self.public_manifest()
        altered["documents"][0].update(
            {
                "id": "synthetic-relabel",
                "path": "knowledge/fixtures/private-synthetic.json",
                "included": True,
                "redistribution_status": "public-allowed",
                "license": "private-test-fixture",
                "basis": "Adversarial relabel of a private fixture as public.",
            }
        )
        self.assert_manifest_rejected(altered)

    def test_public_manifest_rejects_coordinated_private_source_relabeling(self) -> None:
        altered_manifest = self.public_manifest()
        altered_manifest["source_inventory"] = [
            source for source in altered_manifest["source_inventory"] if source["id"] != "synthetic-private"
        ]
        altered_manifest["documents"].append(
            {
                "id": "synthetic-private",
                "path": "knowledge/fixtures/private-synthetic.json",
                "included": True,
                "redistribution_status": "public-allowed",
                "license": "CC0-1.0",
                "basis": "Adversarial coordinated relabel of the private fixture as public.",
            }
        )
        altered_fixture = self.fixture("private")
        altered_fixture["redistribution_status"] = "public-allowed"
        altered_fixture["license"] = "CC0-1.0"
        for document in altered_fixture["documents"]:
            document["license"] = "CC0-1.0"

        real_load_json_yaml = load_json_yaml
        private_fixture_path = (ROOT / "knowledge/fixtures/private-synthetic.json").resolve()

        def load_with_relabel(path: Path) -> dict[str, object]:
            if path.resolve() == private_fixture_path:
                return altered_fixture
            return real_load_json_yaml(path)

        with tempfile.TemporaryDirectory() as temp_dir:
            manifest_path = Path(temp_dir) / "manifest.public.yaml"
            manifest_path.write_text(json.dumps(altered_manifest), encoding="utf-8")
            with patch("tools.knowledge.manifest_policy.load_json_yaml", side_effect=load_with_relabel):
                with self.assertRaises(ValueError):
                    validate_manifest(manifest_path)

    def test_manifest_requires_exact_canonical_source_id_set(self) -> None:
        missing = self.public_manifest()
        missing["source_inventory"].pop()
        self.assert_manifest_rejected(missing)

        unknown = self.public_manifest()
        unknown["source_inventory"][0]["id"] = "unregistered-source"
        self.assert_manifest_rejected(unknown)

    def test_load_json_yaml_rejects_duplicate_object_keys_at_any_depth(self) -> None:
        payloads = (
            '{"schema_version":1,"schema_version":1}',
            '{"outer":{"id":"first","id":"second"}}',
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                with tempfile.NamedTemporaryFile("w", suffix=".yaml", encoding="utf-8") as handle:
                    handle.write(payload)
                    handle.flush()
                    with self.assertRaises(ValueError):
                        load_json_yaml(Path(handle.name))

    def test_manifest_rejects_fixture_license_mismatch(self) -> None:
        altered = self.public_manifest()
        altered["documents"][0]["license"] = "CC-BY-4.0"
        self.assert_manifest_rejected(altered)

    def test_manifest_rejects_unknown_schema_version(self) -> None:
        for schema_version in (2, True, "1"):
            altered = self.public_manifest()
            altered["schema_version"] = schema_version
            with self.subTest(schema_version=schema_version):
                self.assert_manifest_rejected(altered)

    def test_manifest_rejects_missing_required_metadata(self) -> None:
        for section, key in (("documents", "path"), ("documents", "license"), ("source_inventory", "basis")):
            altered = self.public_manifest()
            altered[section][0].pop(key)
            with self.subTest(section=section, key=key):
                self.assert_manifest_rejected(altered)

    def test_manifest_rejects_unsafe_or_non_normalized_document_paths(self) -> None:
        paths = (
            "../knowledge/fixtures/public-synthetic.json",
            "knowledge/fixtures/../fixtures/public-synthetic.json",
            "./knowledge/fixtures/public-synthetic.json",
            "/knowledge/fixtures/public-synthetic.json",
            "knowledge/fixtures/missing.json",
        )
        for document_path in paths:
            altered = self.public_manifest()
            altered["documents"][0]["path"] = document_path
            with self.subTest(document_path=document_path):
                self.assert_manifest_rejected(altered)

    def test_manifest_rejects_contradictory_duplicate_source_ids(self) -> None:
        altered = self.public_manifest()
        altered["source_inventory"][0] = {
            "id": altered["documents"][0]["id"],
            "included": False,
            "redistribution_status": "private-only",
            "basis": "Contradictory duplicate for adversarial validation.",
        }
        self.assert_manifest_rejected(altered)

    def test_manifest_rejects_malformed_section_shapes(self) -> None:
        malformed_sections = (
            ("documents", {}),
            ("documents", [None]),
            ("source_inventory", {}),
            ("source_inventory", ["not-an-object"]),
            ("allowed_included_statuses", "public-allowed"),
        )
        for section, malformed in malformed_sections:
            altered = self.public_manifest()
            altered[section] = malformed
            with self.subTest(section=section, malformed=malformed):
                self.assert_manifest_rejected(altered)

    def test_manifest_rejects_malformed_policy_scalars(self) -> None:
        alterations = (
            ("variant", ["public"]),
            ("fail_closed", 1),
            ("redistribution_status", ["public-allowed"]),
            ("included", 1),
        )
        for field, malformed in alterations:
            altered = self.public_manifest()
            if field in {"variant", "fail_closed"}:
                altered[field] = malformed
            else:
                altered["documents"][0][field] = malformed
            with self.subTest(field=field):
                self.assert_manifest_rejected(altered)

    def test_fixture_rejects_malformed_sections_and_duplicate_ids(self) -> None:
        for section, malformed in (
            ("documents", {}),
            ("documents", []),
            ("documents", [None]),
            ("questions", {}),
            ("questions", []),
            ("questions", [None]),
        ):
            altered = self.fixture()
            altered[section] = malformed
            with self.subTest(section=section, malformed=malformed):
                self.assert_fixture_rejected(altered)

        for field in ("chunk_id", "document_id"):
            altered = self.fixture()
            altered["documents"][1][field] = altered["documents"][0][field]
            with self.subTest(duplicate=field):
                self.assert_fixture_rejected(altered)

            altered = self.fixture()
            altered["documents"][0][field] = ""
            with self.subTest(empty=field):
                self.assert_fixture_rejected(altered)

        altered = self.fixture()
        altered["questions"][1]["id"] = altered["questions"][0]["id"]
        self.assert_fixture_rejected(altered)

        altered = self.fixture()
        altered["documents"][1]["title"] = altered["documents"][0]["title"]
        self.assert_fixture_rejected(altered)

    def test_fixture_rejects_missing_title_and_malformed_ages(self) -> None:
        altered = self.fixture()
        altered["documents"][0].pop("title")
        self.assert_fixture_rejected(altered)

        age_cases = (
            ("age_min_days", True),
            ("age_max_days", "365"),
            ("age_min_days", -1),
            ("age_min_days", 366),
        )
        for field, value in age_cases:
            altered = self.fixture()
            altered["documents"][0][field] = value
            with self.subTest(field=field, value=value):
                self.assert_fixture_rejected(altered)

    def test_fixture_rejects_malformed_questions(self) -> None:
        alterations = (
            ("missing-query", "query", None),
            ("empty-query", "query", ""),
            ("unknown-category", "category", "unknown"),
            ("dangling-source", "expected_source", "Missing Fixture Document"),
        )
        for name, field, value in alterations:
            altered = self.fixture()
            if value is None:
                altered["questions"][0].pop(field)
            else:
                altered["questions"][0][field] = value
            with self.subTest(name=name):
                self.assert_fixture_rejected(altered)

    def test_fixture_rejects_malformed_keyword_lists(self) -> None:
        document_keyword_cases = ([], ["feeding", "feeding"], [""])
        for keywords in document_keyword_cases:
            altered = self.fixture()
            altered["documents"][0]["keywords"] = keywords
            with self.subTest(document_keywords=keywords):
                self.assert_fixture_rejected(altered)

        expected_keyword_cases = (None, [], ["hunger", "hunger"], [""], ["absent-from-source-content"])
        for keywords in expected_keyword_cases:
            altered = self.fixture()
            altered["questions"][0]["expected_keywords"] = keywords
            with self.subTest(expected_keywords=keywords):
                self.assert_fixture_rejected(altered)

    def test_fixture_rejects_tampered_identity(self) -> None:
        for field, value in (
            ("schema_version", 2),
            ("source_id", "synthetic-private"),
            ("redistribution_status", "private-only"),
            ("license", "private-test-fixture"),
            ("schema_version", True),
            ("source_id", ""),
            ("redistribution_status", "unknown"),
            ("license", None),
        ):
            altered = self.fixture()
            altered[field] = value
            with self.subTest(field=field):
                self.assert_fixture_rejected(altered)

        for field, value in (("source_id", "synthetic-other"), ("license", "CC-BY-4.0")):
            altered = self.fixture()
            altered["documents"][0][field] = value
            with self.subTest(document_field=field):
                self.assert_fixture_rejected(altered)

    def test_fixture_rejects_malformed_or_tampered_content(self) -> None:
        for field, value in (
            ("content_sha256", "A" * 64),
            ("content_sha256", "0" * 63),
            ("content_sha256", "0" * 64),
            ("content", "tampered fixture content"),
        ):
            altered = self.fixture()
            altered["documents"][0][field] = value
            with self.subTest(field=field, value=value):
                self.assert_fixture_rejected(altered)

        altered = self.fixture()
        altered["documents"][0]["content"] = ""
        altered["documents"][0]["content_sha256"] = hashlib.sha256(b"").hexdigest()
        self.assert_fixture_rejected(altered)

    def test_fixture_metadata_hashes_and_question_counts_are_frozen(self) -> None:
        seen_hashes: set[str] = set()
        for variant, identity in FIXTURE_IDENTITIES.items():
            source_id = identity["expected_source_id"]
            expected_license = identity["expected_license"]
            fixture_path = ROOT / f"knowledge/fixtures/{variant}-synthetic.json"
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            self.assertEqual(fixture["schema_version"], identity["expected_schema_version"])
            self.assertEqual(fixture["source_id"], source_id)
            self.assertEqual(fixture["redistribution_status"], identity["expected_redistribution_status"])
            self.assertEqual(fixture["license"], expected_license)
            self.assertEqual(len(fixture["documents"]), 5)
            self.assertEqual(len(fixture["questions"]), 25)
            self.assertEqual(len({question["id"] for question in fixture["questions"]}), 25)
            self.assertEqual(len({document["document_id"] for document in fixture["documents"]}), 5)
            for document in fixture["documents"]:
                for field in ("chunk_id", "document_id", "chapter", "source_id", "license", "content"):
                    self.assertIsInstance(document[field], str)
                    self.assertTrue(document[field])
                self.assertEqual(document["source_id"], source_id)
                self.assertEqual(document["license"], expected_license)
                actual_hash = hashlib.sha256(document["content"].encode("utf-8")).hexdigest()
                frozen_hash = FROZEN_CONTENT_HASHES[document["chunk_id"]]
                self.assertEqual(document["content_sha256"], frozen_hash)
                self.assertEqual(actual_hash, frozen_hash)
                seen_hashes.add(actual_hash)
        self.assertEqual(seen_hashes, set(FROZEN_CONTENT_HASHES.values()))

    def test_prohibited_legacy_content_is_not_present(self) -> None:
        paths = {path.name for path in ROOT.rglob("*") if path.is_file()}
        self.assertNotIn("knowledge_seed.sql.gz", paths)
        self.assertNotIn("海蒂育儿大百科_0-1岁_完整版.md", paths)
        self.assertFalse(any("美国儿科学会育儿百科" in name for name in paths))


if __name__ == "__main__":
    unittest.main()
