from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
VALID_REDISTRIBUTION_STATES = {"public-allowed", "private-only", "denied"}
MANIFEST_VARIANTS_BY_FILENAME = {
    "manifest.private.yaml": "private",
    "manifest.public.yaml": "public",
}
EVALUATION_POLICY_BY_FILENAME = {
    "eval.private.yaml": ("private", "synthetic-private"),
    "eval.public.yaml": ("public", "synthetic-public"),
}
SOURCE_POLICY_REGISTRY = {
    "synthetic-public": {
        "redistribution_status": "public-allowed",
        "path": "knowledge/fixtures/public-synthetic.json",
        "license": "CC0-1.0",
        "sections": {"public": "documents", "private": "documents"},
    },
    "synthetic-private": {
        "redistribution_status": "private-only",
        "path": "knowledge/fixtures/private-synthetic.json",
        "license": "private-test-fixture",
        "sections": {"public": "source_inventory", "private": "documents"},
    },
    "heidi-parenting-book": {
        "redistribution_status": "private-only",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
    "aap-parenting-book": {
        "redistribution_status": "private-only",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
    "iycf-model-chapter": {
        "redistribution_status": "denied",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
    "who-newborn-recommendations": {
        "redistribution_status": "denied",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
    "cdc-milestones": {
        "redistribution_status": "denied",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
    "nhc-immunization": {
        "redistribution_status": "denied",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
    "who-growth-expanded-xlsx": {
        "redistribution_status": "denied",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
    "legacy-vector-seed": {
        "redistribution_status": "denied",
        "path": None,
        "license": None,
        "sections": {"public": "source_inventory", "private": "source_inventory"},
    },
}
MANIFEST_KEYS = {
    "schema_version",
    "variant",
    "fail_closed",
    "allowed_included_statuses",
    "documents",
    "source_inventory",
}
EVALUATION_KEYS = {
    "schema_version",
    "variant",
    "fixture",
    "thresholds",
    "medical_policy",
    "embedding_dependency",
}
EVALUATION_THRESHOLDS = {
    "source_hit_at_3_pct": 80,
    "keyword_recall_at_3_pct": 70,
    "citation_integrity_pct": 100,
    "top_10_p95_ms": 250,
}
DOCUMENT_KEYS = {"id", "path", "included", "redistribution_status", "license", "basis"}
INVENTORY_KEYS = {"id", "included", "redistribution_status", "basis"}
FIXTURE_KEYS = {
    "schema_version",
    "source_id",
    "redistribution_status",
    "license",
    "provenance",
    "documents",
    "questions",
}
FIXTURE_DOCUMENT_KEYS = {
    "chunk_id",
    "document_id",
    "title",
    "chapter",
    "source_id",
    "language",
    "license",
    "age_min_days",
    "age_max_days",
    "keywords",
    "content_sha256",
    "content",
}
FIXTURE_QUESTION_KEYS = {"id", "category", "query", "expected_source", "expected_keywords"}
FIXTURE_QUESTION_CATEGORIES = {"development", "feeding", "preventive_health", "sleep", "symptom"}
CONTENT_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


def load_json_yaml(path: Path) -> dict[str, Any]:
    """Load JSON syntax from a .yaml file; JSON is a strict YAML 1.2 subset."""
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError(f"{path}: duplicate object key {key!r}")
            result[key] = item
        return result

    with path.open(encoding="utf-8") as handle:
        value = json.load(handle, object_pairs_hook=reject_duplicate_keys)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one object")
    return value


def _require_exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise ValueError(f"{label} has invalid keys; missing={missing}, unexpected={unexpected}")
    return value


def _require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{label} must be a non-empty trimmed string")
    return value


def _require_unique_text_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{label} must be a non-empty list")
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        text = _require_text(item, f"{label}[{index}]")
        if text in seen:
            raise ValueError(f"{label} contains duplicate value {text!r}")
        result.append(text)
        seen.add(text)
    return result


def _repo_document_path(value: Any, label: str) -> str:
    path_text = _require_text(value, label)
    relative = PurePosixPath(path_text)
    if (
        relative.is_absolute()
        or "\\" in path_text
        or relative.as_posix() != path_text
        or any(part in {".", ".."} for part in relative.parts)
    ):
        raise ValueError(f"{label} must be a normalized repo-relative path")
    resolved = (ROOT / Path(*relative.parts)).resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError as error:
        raise ValueError(f"{label} escapes the repository") from error
    if not resolved.is_file():
        raise ValueError(f"{label} does not name a repository file")
    return path_text


def validate_fixture(
    value: Any,
    *,
    label: str,
    expected_schema_version: int,
    expected_source_id: str,
    expected_redistribution_status: str,
    expected_license: str,
) -> dict[str, Any]:
    fixture = _require_exact_keys(value, FIXTURE_KEYS, label)
    schema_version = fixture["schema_version"]
    if type(schema_version) is not int:
        raise ValueError(f"{label}.schema_version must be an integer")
    source_id = _require_text(fixture["source_id"], f"{label}.source_id")
    redistribution_status = fixture["redistribution_status"]
    if not isinstance(redistribution_status, str) or redistribution_status not in VALID_REDISTRIBUTION_STATES:
        raise ValueError(f"{label}.redistribution_status is undefined")
    license_name = _require_text(fixture["license"], f"{label}.license")
    _require_text(fixture["provenance"], f"{label}.provenance")

    identity = {
        "schema_version": schema_version,
        "source_id": source_id,
        "redistribution_status": redistribution_status,
        "license": license_name,
    }
    expected_identity = {
        "schema_version": expected_schema_version,
        "source_id": expected_source_id,
        "redistribution_status": expected_redistribution_status,
        "license": expected_license,
    }
    for field, expected in expected_identity.items():
        if identity[field] != expected:
            raise ValueError(f"{label}.{field} does not match its manifest entry")

    documents = fixture["documents"]
    if not isinstance(documents, list) or not documents:
        raise ValueError(f"{label}.documents must be a non-empty list")
    chunk_ids: set[str] = set()
    document_ids: set[str] = set()
    document_titles: set[str] = set()
    document_content_by_title: dict[str, str] = {}
    for index, value in enumerate(documents):
        document_label = f"{label}.documents[{index}]"
        document = _require_exact_keys(value, FIXTURE_DOCUMENT_KEYS, document_label)
        chunk_id = _require_text(document["chunk_id"], f"{document_label}.chunk_id")
        document_id = _require_text(document["document_id"], f"{document_label}.document_id")
        title = _require_text(document["title"], f"{document_label}.title")
        if chunk_id in chunk_ids:
            raise ValueError(f"{label}: duplicate chunk_id {chunk_id}")
        if document_id in document_ids:
            raise ValueError(f"{label}: duplicate document_id {document_id}")
        if title in document_titles:
            raise ValueError(f"{label}: duplicate document title {title}")
        chunk_ids.add(chunk_id)
        document_ids.add(document_id)
        document_titles.add(title)

        _require_text(document["chapter"], f"{document_label}.chapter")
        document_source_id = _require_text(document["source_id"], f"{document_label}.source_id")
        if document_source_id != source_id:
            raise ValueError(f"{document_label}.source_id does not match fixture source_id")
        _require_text(document["language"], f"{document_label}.language")
        document_license = _require_text(document["license"], f"{document_label}.license")
        if document_license != license_name:
            raise ValueError(f"{document_label}.license does not match fixture license")

        age_min_days = document["age_min_days"]
        age_max_days = document["age_max_days"]
        if type(age_min_days) is not int or type(age_max_days) is not int:
            raise ValueError(f"{document_label} ages must be integers")
        if age_min_days < 0 or age_min_days > age_max_days:
            raise ValueError(f"{document_label} ages must satisfy 0 <= age_min_days <= age_max_days")
        _require_unique_text_list(document["keywords"], f"{document_label}.keywords")

        content_sha256 = document["content_sha256"]
        if not isinstance(content_sha256, str) or CONTENT_SHA256_PATTERN.fullmatch(content_sha256) is None:
            raise ValueError(f"{document_label}.content_sha256 must be 64 lowercase hexadecimal characters")
        content = _require_text(document["content"], f"{document_label}.content")
        actual_sha256 = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if content_sha256 != actual_sha256:
            raise ValueError(f"{document_label}.content_sha256 does not match content")
        document_content_by_title[title] = content

    questions = fixture["questions"]
    if not isinstance(questions, list) or not questions:
        raise ValueError(f"{label}.questions must be a non-empty list")
    question_ids: set[str] = set()
    for index, value in enumerate(questions):
        question_label = f"{label}.questions[{index}]"
        question = _require_exact_keys(value, FIXTURE_QUESTION_KEYS, question_label)
        question_id = _require_text(question["id"], f"{question_label}.id")
        if question_id in question_ids:
            raise ValueError(f"{label}: duplicate question id {question_id}")
        question_ids.add(question_id)
        category = _require_text(question["category"], f"{question_label}.category")
        if category not in FIXTURE_QUESTION_CATEGORIES:
            raise ValueError(f"{question_label}.category is unknown")
        _require_text(question["query"], f"{question_label}.query")
        expected_source = _require_text(question["expected_source"], f"{question_label}.expected_source")
        if expected_source not in document_content_by_title:
            raise ValueError(f"{question_label}.expected_source does not resolve to a fixture document")
        expected_keywords = _require_unique_text_list(
            question["expected_keywords"], f"{question_label}.expected_keywords"
        )
        source_content = document_content_by_title[expected_source]
        for keyword in expected_keywords:
            if keyword not in source_content:
                raise ValueError(f"{question_label}: expected keyword {keyword!r} is absent from its source content")
    return fixture


def validate_evaluation(path: Path) -> dict[str, Any]:
    expected_policy = EVALUATION_POLICY_BY_FILENAME.get(path.name)
    if expected_policy is None:
        raise ValueError(f"{path}: unsupported evaluation filename")

    evaluation = _require_exact_keys(load_json_yaml(path), EVALUATION_KEYS, str(path))
    if type(evaluation["schema_version"]) is not int or evaluation["schema_version"] != 1:
        raise ValueError(f"{path}: unsupported schema_version")

    expected_variant, source_id = expected_policy
    if evaluation["variant"] != expected_variant:
        raise ValueError(f"{path}: canonical evaluation filename requires variant {expected_variant}")

    source_policy = SOURCE_POLICY_REGISTRY[source_id]
    canonical_fixture_path = source_policy["path"]
    if not isinstance(canonical_fixture_path, str):
        raise ValueError(f"{path}: canonical source has no fixture")
    fixture_path = _repo_document_path(evaluation["fixture"], f"{path}.fixture")
    if fixture_path != canonical_fixture_path:
        raise ValueError(f"{path}: fixture does not match canonical variant source")

    thresholds = _require_exact_keys(evaluation["thresholds"], set(EVALUATION_THRESHOLDS), f"{path}.thresholds")
    for name, expected_value in EVALUATION_THRESHOLDS.items():
        if type(thresholds[name]) is not int or thresholds[name] != expected_value:
            raise ValueError(f"{path}.thresholds.{name} does not match canonical policy")
    if evaluation["medical_policy"] != "red_flag_queries_escalate_without_diagnosis":
        raise ValueError(f"{path}: invalid medical_policy")
    if evaluation["embedding_dependency"] != "forbidden":
        raise ValueError(f"{path}: invalid embedding_dependency")

    redistribution_status = source_policy["redistribution_status"]
    license_name = source_policy["license"]
    if not isinstance(redistribution_status, str) or not isinstance(license_name, str):
        raise ValueError(f"{path}: canonical source identity is incomplete")
    validate_fixture(
        load_json_yaml(ROOT / Path(*PurePosixPath(fixture_path).parts)),
        label=fixture_path,
        expected_schema_version=evaluation["schema_version"],
        expected_source_id=source_id,
        expected_redistribution_status=redistribution_status,
        expected_license=license_name,
    )
    return evaluation


def validate_manifest(path: Path) -> dict[str, Any]:
    manifest = _require_exact_keys(load_json_yaml(path), MANIFEST_KEYS, str(path))
    if type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1:
        raise ValueError(f"{path}: unsupported schema_version")
    variant = manifest["variant"]
    if not isinstance(variant, str) or variant not in {"private", "public"} or manifest["fail_closed"] is not True:
        raise ValueError(f"{path}: invalid variant or fail_closed policy")
    expected_variant = MANIFEST_VARIANTS_BY_FILENAME.get(path.name)
    if expected_variant is not None and variant != expected_variant:
        raise ValueError(f"{path}: canonical manifest filename requires variant {expected_variant}")
    allowed_statuses = manifest["allowed_included_statuses"]
    if not isinstance(allowed_statuses, list) or any(not isinstance(item, str) for item in allowed_statuses):
        raise ValueError(f"{path}: allowed_included_statuses must be a string list")
    allowed = set(allowed_statuses)
    required_allowed = {"public-allowed"} if variant == "public" else {"public-allowed", "private-only"}
    if allowed != required_allowed or len(allowed_statuses) != len(required_allowed):
        raise ValueError(f"{path}: allowed status set is not exact")

    documents = manifest["documents"]
    inventory = manifest["source_inventory"]
    if not isinstance(documents, list) or not documents:
        raise ValueError(f"{path}: documents must be a non-empty list")
    if not isinstance(inventory, list):
        raise ValueError(f"{path}: source_inventory must be a list")

    source_ids: set[str] = set()
    document_paths: set[str] = set()
    sections = (("documents", documents, DOCUMENT_KEYS, True), ("source_inventory", inventory, INVENTORY_KEYS, False))
    for section_name, sources, expected_keys, expected_included in sections:
        for index, value in enumerate(sources):
            label = f"{path}: {section_name}[{index}]"
            source = _require_exact_keys(value, expected_keys, label)
            source_id = _require_text(source["id"], f"{label}.id")
            if source_id in source_ids:
                raise ValueError(f"{path}: duplicate or conflicting source id {source_id}")
            source_ids.add(source_id)
            policy = SOURCE_POLICY_REGISTRY.get(source_id)
            if policy is None:
                raise ValueError(f"{path}: unknown source id {source_id}")
            if policy["sections"][variant] != section_name:
                raise ValueError(f"{label}: source {source_id} is in the wrong manifest section")
            if source["included"] is not expected_included:
                raise ValueError(f"{label}.included contradicts its manifest section")
            status = source["redistribution_status"]
            if not isinstance(status, str) or status not in VALID_REDISTRIBUTION_STATES:
                raise ValueError(f"{label}: source {source_id} has an undefined redistribution state")
            if status != policy["redistribution_status"]:
                raise ValueError(f"{label}: source {source_id} does not match canonical redistribution policy")
            _require_text(source["basis"], f"{label}.basis")
            if expected_included:
                if status not in allowed:
                    raise ValueError(f"{path}: included source {source_id} is not allowed")
                license_name = _require_text(source["license"], f"{label}.license")
                if license_name != policy["license"]:
                    raise ValueError(f"{label}: source {source_id} does not match its canonical license")
                document_path = _repo_document_path(source["path"], f"{label}.path")
                if document_path != policy["path"]:
                    raise ValueError(f"{label}: source {source_id} does not match its canonical path")
                if document_path in document_paths:
                    raise ValueError(f"{path}: duplicate included document path {document_path}")
                document_paths.add(document_path)
                fixture_path = ROOT / Path(*PurePosixPath(document_path).parts)
                validate_fixture(
                    load_json_yaml(fixture_path),
                    label=document_path,
                    expected_schema_version=manifest["schema_version"],
                    expected_source_id=source_id,
                    expected_redistribution_status=status,
                    expected_license=license_name,
                )
    canonical_source_ids = set(SOURCE_POLICY_REGISTRY)
    if source_ids != canonical_source_ids:
        missing = sorted(canonical_source_ids - source_ids)
        unexpected = sorted(source_ids - canonical_source_ids)
        raise ValueError(f"{path}: source registry mismatch; missing={missing}, unexpected={unexpected}")
    return manifest
