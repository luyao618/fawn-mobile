from __future__ import annotations

import csv
import fcntl
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from collections import Counter
from email.message import Message
from pathlib import Path
from typing import Any, BinaryIO
from unittest import mock
from urllib.request import Request
from urllib.response import addinfourl

from tools.knowledge.build_who_reference import (
    EXPECTED_DATASET,
    EXPECTED_POLICY_URLS,
    EXPECTED_RIGHTS,
    PARTITIONS,
    WhoSource,
    build_rows,
    load_source_manifest,
    resolve_source_path,
    validate_cached_source,
    write_csv,
)
from tools.knowledge.download_who_sources import (
    _DEFAULT_NETWORK_OPENER,
    sync_sources,
)
from tools.knowledge.who_xlsx import EXPECTED_HEADERS, read_xlsx_rows

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CACHE_DIR = ROOT / "knowledge/sources/who-growth"
CACHE_DIR = Path(os.environ.get("WHO_GROWTH_CACHE", DEFAULT_CACHE_DIR))
SOURCE_MANIFEST = DEFAULT_CACHE_DIR / "source-manifest.json"
RIGHTS_GUIDANCE = DEFAULT_CACHE_DIR / "RIGHTS.md"
CACHE_IGNORE = DEFAULT_CACHE_DIR / ".gitignore"
FROZEN_SOURCES = {
    ("male", "weight"): {
        "title": "Weight-for-age expanded z-score tables (boys)",
        "path": "weight-for-age/wfa_boys_zscores_expanded.xlsx",
        "page_url": "https://www.who.int/tools/child-growth-standards/standards/weight-for-age",
        "download_url": "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/expanded-tables/wfa-boys-zscore-expanded-tables.xlsx?sfvrsn=65cce121_10",
        "size_bytes": 198984,
        "sha256": "b5b4748c6bfa5230e2eddafa1767629c349178b08d457f400b59422b8bfef86c",
    },
    ("female", "weight"): {
        "title": "Weight-for-age expanded z-score tables (girls)",
        "path": "weight-for-age/wfa_girls_zscores_expanded.xlsx",
        "page_url": "https://www.who.int/tools/child-growth-standards/standards/weight-for-age",
        "download_url": "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/expanded-tables/wfa-girls-zscore-expanded-tables.xlsx?sfvrsn=f01bc813_10",
        "size_bytes": 197671,
        "sha256": "ee3ae12cb96c6c5541cdf43665c03ce6c984f877859a183a5f6104eb06a49a6e",
    },
    ("male", "height"): {
        "title": "Length/height-for-age expanded z-score tables (boys)",
        "path": "length-for-age/lhfa_boys_zscores_expanded.xlsx",
        "page_url": "https://www.who.int/tools/child-growth-standards/standards/length-height-for-age",
        "download_url": "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/expandable-tables/lhfa-boys-zscore-expanded-tables.xlsx?sfvrsn=7b4a3428_12",
        "size_bytes": 200151,
        "sha256": "c4b1c9029ab9751a5f0888e32f35c7c0287a16d361885cf911ecf23b3f7f6b4f",
    },
    ("female", "height"): {
        "title": "Length/height-for-age expanded z-score tables (girls)",
        "path": "length-for-age/lhfa_girls_zscores_expanded.xlsx",
        "page_url": "https://www.who.int/tools/child-growth-standards/standards/length-height-for-age",
        "download_url": "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/expandable-tables/lhfa-girls-zscore-expanded-tables.xlsx?sfvrsn=27f1e2cb_10",
        "size_bytes": 199890,
        "sha256": "6aa2876319449a6b1f4d825848128902114ff53c67b92b86a0c5140846013059",
    },
    ("male", "head"): {
        "title": "Head circumference-for-age expanded z-score tables (boys)",
        "path": "head-circumference/hcfa_boys_zscores_expanded.xlsx",
        "page_url": "https://www.who.int/tools/child-growth-standards/standards/head-circumference-for-age",
        "download_url": "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/head-circumference-for-age/expanded-tables/hcfa-boys-zscore-expanded-tables.xlsx?sfvrsn=2ab1bec8_8",
        "size_bytes": 185962,
        "sha256": "89a657bc466e85f6c8f2e5e7f4635e969bdcf982bb71e519273e43896a1c3314",
    },
    ("female", "head"): {
        "title": "Head circumference-for-age expanded z-score tables (girls)",
        "path": "head-circumference/hcfa_girls_zscores_expanded.xlsx",
        "page_url": "https://www.who.int/tools/child-growth-standards/standards/head-circumference-for-age",
        "download_url": "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/head-circumference-for-age/expanded-tables/hcfa-girls-zscore-expanded-tables.xlsx?sfvrsn=3a34b8b0_8",
        "size_bytes": 186723,
        "sha256": "8eec3770d1027ce1b3b96a7b89fd1e77070558a7791b17b4462cda8a813324a3",
    },
}

FROZEN_LMS_CHECKPOINT_SHA256 = "194abb9c58943de3ba1c0bc881aa8b6f732e3e83bcb1003ca2b2e6bc4c9682db"


def source_manifest_json() -> dict[str, Any]:
    return json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))


def write_manifest(directory: Path, manifest: Any) -> Path:
    path = directory / "source-manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def write_compact_xlsx(path: Path, rows_xml: str) -> Path:
    worksheet = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{rows_xml}</sheetData>"
        "</worksheet>"
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", worksheet)
    return path


class FakeResponse:
    def __init__(
        self,
        content: bytes,
        url: str,
        *,
        announced_size: int | None = None,
        exit_error: BaseException | None = None,
    ) -> None:
        self._content = io.BytesIO(content)
        self._url = url
        self._exit_error = exit_error
        self.headers = {"Content-Length": str(len(content) if announced_size is None else announced_size)}

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: Any) -> None:
        if self._exit_error is not None:
            raise self._exit_error
        return None

    def geturl(self) -> str:
        return self._url

    def read(self, size: int = -1) -> bytes:
        return self._content.read(size)


class ManifestPolicyTest(unittest.TestCase):
    def assert_manifest_rejected(self, manifest: Any, message: str) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = write_manifest(Path(directory), manifest)
            with self.assertRaisesRegex(ValueError, message):
                load_source_manifest(path)

    def test_manifest_freezes_official_provenance_and_separate_rights(self) -> None:
        raw = source_manifest_json()
        self.assertEqual(raw["schema_version"], 2)
        self.assertEqual(raw["dataset"], EXPECTED_DATASET)
        self.assertEqual(raw["rights"], EXPECTED_RIGHTS)
        self.assertEqual(raw["policy_urls"], EXPECTED_POLICY_URLS)
        self.assertEqual(
            raw["coverage"],
            {
                "minimum_age_days": 0,
                "maximum_age_days": 365,
                "expected_rows_per_partition": 366,
                "expected_total_rows": 2196,
            },
        )
        sources = {(source["sex"], source["indicator"]): source for source in raw["sources"]}
        self.assertEqual(set(sources), set(FROZEN_SOURCES))
        for partition, expected in FROZEN_SOURCES.items():
            for key, value in expected.items():
                self.assertEqual(sources[partition][key], value)
            self.assertEqual(sources[partition]["upstream_last_modified"], "2024-04-05")

    def test_rights_guidance_and_cache_ignore_are_present(self) -> None:
        guidance = RIGHTS_GUIDANCE.read_text(encoding="utf-8")
        for url in EXPECTED_POLICY_URLS.values():
            self.assertIn(url, guidance)
        self.assertIn("must not be committed", guidance)
        self.assertIn("written WHO permission", guidance)
        ignore_patterns = {
            line for line in CACHE_IGNORE.read_text(encoding="utf-8").splitlines() if line and not line.startswith("#")
        }
        self.assertEqual(ignore_patterns, {"*.xlsx", "*.part"})

    def test_manifest_rejects_unknown_schema_or_policy_drift(self) -> None:
        for schema_version in (1, 3, True, "2"):
            altered = source_manifest_json()
            altered["schema_version"] = schema_version
            with self.subTest(schema_version=schema_version):
                self.assert_manifest_rejected(altered, "unsupported schema_version")
        altered = source_manifest_json()
        altered["rights"]["raw_xlsx"]["repository_inclusion"] = "allowed"
        self.assert_manifest_rejected(altered, "frozen G020 policy")
        altered = source_manifest_json()
        altered["dataset"]["publisher"] = "Example Publisher"
        self.assert_manifest_rejected(altered, "frozen G020 policy")

    def test_manifest_rejects_altered_coverage_or_partition_topology(self) -> None:
        alterations = (
            lambda manifest: manifest["coverage"].__setitem__("maximum_age_days", 364),
            lambda manifest: manifest["coverage"].__setitem__("expected_total_rows", 2195),
            lambda manifest: manifest["sources"].pop(),
            lambda manifest: manifest["sources"][0].__setitem__("sex", "other"),
            lambda manifest: manifest["sources"][1].update(manifest["sources"][0]),
        )
        for alter in alterations:
            altered = source_manifest_json()
            alter(altered)
            with self.subTest(alter=alter):
                self.assert_manifest_rejected(altered, "coverage|six entries|partition")

    def test_manifest_rejects_unsafe_paths_unofficial_urls_and_invalid_metadata(self) -> None:
        alterations = (
            ("normalized relative XLSX path", "path", "../source.xlsx"),
            ("on cdn.who.int", "download_url", "https://example.invalid/source.xlsx"),
            ("match indicator", "page_url", FROZEN_SOURCES[("male", "head")]["page_url"]),
            ("positive integer", "size_bytes", True),
            ("64 lowercase", "sha256", "A" * 64),
            ("ISO calendar date", "upstream_last_modified", "5 April 2024"),
        )
        for message, key, value in alterations:
            altered = source_manifest_json()
            altered["sources"][0][key] = value
            with self.subTest(key=key):
                self.assert_manifest_rejected(altered, message)

    def test_manifest_rejects_duplicate_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text('{"schema_version":2,"schema_version":2}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate object key"):
                load_source_manifest(path)


class CachedSourceSafetyTest(unittest.TestCase):
    @staticmethod
    def synthetic_source(content: bytes) -> WhoSource:
        return WhoSource(
            sex="male",
            indicator="weight",
            title="Synthetic WHO source",
            page_url="https://www.who.int/example",
            download_url="https://cdn.who.int/example.xlsx",
            path="partition/source.xlsx",
            size_bytes=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            upstream_last_modified="2024-04-05",
        )

    def test_cache_validation_fails_closed_before_open_without_stat_dir_fd_support(self) -> None:
        source = self.synthetic_source(b"synthetic cache bytes")
        supported = frozenset(function for function in os.supports_dir_fd if function is not os.stat)
        with (
            mock.patch("tools.knowledge.build_who_reference.os.supports_dir_fd", supported),
            mock.patch("tools.knowledge.build_who_reference.os.open") as secure_open,
            self.assertRaisesRegex(RuntimeError, "Secure directory-relative WHO cache validation"),
        ):
            validate_cached_source(Path("unused-cache"), source)
        secure_open.assert_not_called()

    def test_cache_validation_fails_closed_before_open_without_stat_no_follow_support(self) -> None:
        source = self.synthetic_source(b"synthetic cache bytes")
        supported = frozenset(
            function for function in os.supports_follow_symlinks if function is not os.stat
        )
        with (
            mock.patch(
                "tools.knowledge.build_who_reference.os.supports_follow_symlinks",
                supported,
            ),
            mock.patch("tools.knowledge.build_who_reference.os.open") as secure_open,
            self.assertRaisesRegex(RuntimeError, "Secure directory-relative WHO cache validation"),
        ):
            validate_cached_source(Path("unused-cache"), source)
        secure_open.assert_not_called()

    def test_cache_validation_rejects_final_symlink_without_following_it(self) -> None:
        content = b"valid synthetic WHO cache bytes"
        source = self.synthetic_source(content)
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache"
            parent = cache / "partition"
            parent.mkdir(parents=True)
            actual = parent / "actual.xlsx"
            actual.write_bytes(content)
            (parent / "source.xlsx").symlink_to(actual.name)

            with self.assertRaisesRegex(ValueError, "cache path contains a symbolic link"):
                validate_cached_source(cache, source)

    def test_cache_validation_rejects_parent_symlink_without_following_it(self) -> None:
        content = b"valid synthetic WHO cache bytes"
        source = self.synthetic_source(content)
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache"
            actual_parent = cache / "actual-partition"
            actual_parent.mkdir(parents=True)
            (actual_parent / "source.xlsx").write_bytes(content)
            (cache / "partition").symlink_to(actual_parent.name, target_is_directory=True)

            with self.assertRaisesRegex(ValueError, "cache path contains a symbolic link"):
                validate_cached_source(cache, source)

    def test_cache_validation_rejects_fifo_promptly_as_non_regular(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache"
            parent = cache / "partition"
            parent.mkdir(parents=True)
            os.mkfifo(parent / "source.xlsx")
            probe = """
import hashlib
import sys
from pathlib import Path

from tools.knowledge.build_who_reference import WhoSource, validate_cached_source

content = b"x"
source = WhoSource(
    sex="male",
    indicator="weight",
    title="Synthetic WHO source",
    page_url="https://www.who.int/example",
    download_url="https://cdn.who.int/example.xlsx",
    path="partition/source.xlsx",
    size_bytes=len(content),
    sha256=hashlib.sha256(content).hexdigest(),
    upstream_last_modified="2024-04-05",
)
try:
    validate_cached_source(Path(sys.argv[1]), source)
except ValueError as error:
    print(error)
else:
    raise SystemExit("FIFO cache entry was accepted")
"""
            started = time.monotonic()
            completed = subprocess.run(
                [sys.executable, "-c", probe, str(cache)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            elapsed = time.monotonic() - started

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("WHO source is not a regular file", completed.stdout)
            self.assertLess(elapsed, 2)


class BuilderRightsBoundaryTest(unittest.TestCase):
    def test_denied_derived_rights_reject_repository_outputs_but_allow_external_output(self) -> None:
        repository_outputs = (
            ROOT / "g020-forbidden-reference.csv",
            ROOT / "assets/reference/g020-forbidden-reference.csv",
        )
        for output in repository_outputs:
            with self.subTest(output=output), self.assertRaisesRegex(
                ValueError, "anywhere inside the repository"
            ):
                write_csv(output, [])

        with tempfile.TemporaryDirectory() as directory:
            external_output = Path(directory) / "who-growth-reference.csv"
            write_csv(external_output, [])
            self.assertTrue(external_output.is_file())

    def test_mixed_case_repository_alias_is_rejected_when_supported(self) -> None:
        alias_name = "".join(character.swapcase() if character.isalpha() else character for character in ROOT.name)
        alias_root = ROOT.with_name(alias_name)
        if alias_root == ROOT or not alias_root.exists() or not os.path.samefile(alias_root, ROOT):
            self.skipTest("repository filesystem does not expose mixed-case aliases")

        output = alias_root / "g020-forbidden-mixed-case-reference.csv"
        with self.assertRaisesRegex(ValueError, "anywhere inside the repository"):
            write_csv(output, [])
        self.assertFalse(output.exists())

    def test_symlink_alias_to_repository_is_rejected(self) -> None:
        output_name = "g020-forbidden-symlink-reference.csv"
        with tempfile.TemporaryDirectory() as directory:
            alias = Path(directory) / "repository-alias"
            alias.symlink_to(ROOT, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "anywhere inside the repository"):
                write_csv(alias / output_name, [])
        self.assertFalse((ROOT / output_name).exists())

    def test_parent_symlink_swap_after_validation_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = base / "repository"
            (repository / "parent").mkdir(parents=True)
            route = base / "external-route"
            external_parent = route / "parent"
            external_parent.mkdir(parents=True)
            parked_route = base / "parked-route"
            output = external_parent / "who-growth-reference.csv"
            real_mkdir = Path.mkdir
            swapped = False

            def swap_route(self: Path, *args: Any, **kwargs: Any) -> None:
                nonlocal swapped
                if self == external_parent and not swapped:
                    route.rename(parked_route)
                    route.symlink_to(repository, target_is_directory=True)
                    swapped = True
                    return
                real_mkdir(self, *args, **kwargs)

            with (
                mock.patch("tools.knowledge.build_who_reference.ROOT", repository),
                mock.patch.object(Path, "mkdir", new=swap_route),
                self.assertRaisesRegex(ValueError, "anywhere inside the repository"),
            ):
                write_csv(output, [])

            self.assertTrue(swapped)
            self.assertFalse((repository / "parent" / output.name).exists())
            self.assertFalse((parked_route / "parent" / output.name).exists())

    def test_open_output_directory_moved_into_repository_before_commit_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repository = base / "repository"
            repository.mkdir()
            external_parent = base / "verified-external"
            external_parent.mkdir()
            moved_parent = repository / "moved-output"
            output = external_parent / "who-growth-reference.csv"
            moved = False

            def move_before_link(event: str, _state: Any) -> None:
                nonlocal moved
                if event == "before_link" and not moved:
                    external_parent.rename(moved_parent)
                    moved = True

            with (
                mock.patch("tools.knowledge.build_who_reference.ROOT", repository),
                mock.patch(
                    "tools.knowledge.build_who_reference._PUBLICATION_TEST_HOOK",
                    move_before_link,
                ),
                self.assertRaisesRegex(ValueError, "anywhere inside the repository"),
            ):
                write_csv(output, [])

            self.assertTrue(moved)
            self.assertFalse(output.exists())
            self.assertEqual(list(base.rglob(output.name)), [])

    def test_existing_output_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            existing = b"preserve-existing-output"
            output.write_bytes(existing)
            with self.assertRaises(FileExistsError):
                write_csv(output, [])
            self.assertEqual(output.read_bytes(), existing)

    def test_partial_output_is_removed_after_write_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            with mock.patch(
                "tools.knowledge.build_who_reference.csv.DictWriter.writeheader",
                side_effect=OSError("synthetic write failure"),
            ):
                with self.assertRaisesRegex(OSError, "synthetic write failure"):
                    write_csv(output, [])
            self.assertFalse(output.exists())

    def test_write_failure_preserves_a_concurrently_appearing_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            replacement = b"concurrent-output-replacement"

            def create_output_then_fail() -> None:
                output.write_bytes(replacement)
                raise OSError("synthetic write failure after concurrent creation")

            with mock.patch(
                "tools.knowledge.build_who_reference.csv.DictWriter.writeheader",
                side_effect=create_output_then_fail,
            ):
                with self.assertRaisesRegex(OSError, "write failure after concurrent creation"):
                    write_csv(output, [])

            self.assertEqual(output.read_bytes(), replacement)
            self.assertEqual(
                [entry for entry in output.parent.iterdir() if entry.name.startswith(".who-publish-")],
                [],
            )

    def test_builder_links_only_after_read_only_seal_and_writable_descriptors_close(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            checked = False

            def inspect_before_link(event: str, state: Any) -> None:
                nonlocal checked
                if event != "before_link":
                    return
                checked = True
                sealed_stat = os.fstat(state.sealed_fd)
                self.assertEqual(stat.S_IMODE(sealed_stat.st_mode), 0o444)
                self.assertEqual(stat.S_IMODE(os.fstat(state.stage_fd).st_mode), 0o700)
                self.assertEqual(fcntl.fcntl(state.sealed_fd, fcntl.F_GETFL) & os.O_ACCMODE, os.O_RDONLY)
                with self.assertRaises(OSError):
                    os.write(state.sealed_fd, b"not writable")

                matching_access_modes: list[int] = []
                for descriptor_name in os.listdir("/dev/fd"):
                    try:
                        descriptor = int(descriptor_name)
                        descriptor_stat = os.fstat(descriptor)
                        if (descriptor_stat.st_dev, descriptor_stat.st_ino) != (
                            sealed_stat.st_dev,
                            sealed_stat.st_ino,
                        ):
                            continue
                        matching_access_modes.append(
                            fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_ACCMODE
                        )
                    except (OSError, ValueError):
                        continue
                self.assertEqual(matching_access_modes, [os.O_RDONLY])

            with mock.patch(
                "tools.knowledge.build_who_reference._PUBLICATION_TEST_HOOK",
                inspect_before_link,
            ):
                write_csv(output, [])

            self.assertTrue(checked)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o444)

    def test_stage_descriptor_closes_when_stage_fchmod_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            real_fchmod = os.fchmod
            failed_descriptor: int | None = None

            def fail_stage_fchmod(descriptor: int, mode: int) -> None:
                nonlocal failed_descriptor
                if mode == 0o700:
                    failed_descriptor = descriptor
                    raise OSError("synthetic stage fchmod failure")
                real_fchmod(descriptor, mode)

            with mock.patch(
                "tools.knowledge.build_who_reference.os.fchmod",
                side_effect=fail_stage_fchmod,
            ):
                with self.assertRaisesRegex(OSError, "stage fchmod failure"):
                    write_csv(output, [])

            self.assertIsNotNone(failed_descriptor)
            assert failed_descriptor is not None
            with self.assertRaises(OSError):
                os.fstat(failed_descriptor)
            self.assertEqual(list(output.parent.glob(".who-publish-*")), [])

    def test_writable_payload_descriptor_closes_when_fchmod_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            real_fchmod = os.fchmod
            failed_descriptor: int | None = None

            def fail_payload_fchmod(descriptor: int, mode: int) -> None:
                nonlocal failed_descriptor
                if mode == 0o600:
                    failed_descriptor = descriptor
                    raise OSError("synthetic payload fchmod failure")
                real_fchmod(descriptor, mode)

            with mock.patch(
                "tools.knowledge.build_who_reference.os.fchmod",
                side_effect=fail_payload_fchmod,
            ):
                with self.assertRaisesRegex(OSError, "payload fchmod failure"):
                    write_csv(output, [])

            self.assertIsNotNone(failed_descriptor)
            assert failed_descriptor is not None
            with self.assertRaises(OSError):
                os.fstat(failed_descriptor)
            self.assertEqual(list(output.parent.glob(".who-publish-*")), [])

    def test_writable_payload_descriptor_closes_when_fdopen_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            failed_descriptor: int | None = None

            def fail_payload_fdopen(descriptor: int, mode: str) -> BinaryIO:
                nonlocal failed_descriptor
                self.assertEqual(mode, "w+b")
                failed_descriptor = descriptor
                raise OSError("synthetic payload fdopen failure")

            with mock.patch(
                "tools.knowledge.build_who_reference.os.fdopen",
                side_effect=fail_payload_fdopen,
            ):
                with self.assertRaisesRegex(OSError, "payload fdopen failure"):
                    write_csv(output, [])

            self.assertIsNotNone(failed_descriptor)
            assert failed_descriptor is not None
            with self.assertRaises(OSError):
                os.fstat(failed_descriptor)
            self.assertEqual(list(output.parent.glob(".who-publish-*")), [])

    def test_output_creation_fails_closed_without_directory_fd_support(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory) / "not-created"
            output = parent / "who-growth-reference.csv"
            with mock.patch("tools.knowledge.build_who_reference.os.supports_dir_fd", frozenset()):
                with self.assertRaisesRegex(RuntimeError, "directory-relative"):
                    write_csv(output, [])
            self.assertFalse(parent.exists())

    def test_output_creation_fails_closed_without_no_follow_stat_support(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "who-growth-reference.csv"
            supported = frozenset(
                function for function in os.supports_follow_symlinks if function is not os.stat
            )
            with mock.patch(
                "tools.knowledge.build_who_reference.os.supports_follow_symlinks",
                supported,
            ):
                with self.assertRaisesRegex(RuntimeError, "directory-relative"):
                    write_csv(output, [])
            self.assertFalse(output.exists())


class DownloaderTest(unittest.TestCase):
    def synthetic_manifest(self) -> tuple[dict[str, Any], dict[str, bytes]]:
        manifest = source_manifest_json()
        content_by_url: dict[str, bytes] = {}
        for index, source in enumerate(manifest["sources"]):
            content = f"network-free WHO fixture {index}".encode()
            source["size_bytes"] = len(content)
            source["sha256"] = hashlib.sha256(content).hexdigest()
            content_by_url[source["download_url"]] = content
        return manifest, content_by_url

    def test_downloader_streams_verified_files_then_reuses_cache_offline(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        calls: list[tuple[str, int]] = []

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            url = request.full_url
            calls.append((url, timeout))
            return FakeResponse(content_by_url[url], url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            results = sync_sources(cache, manifest_path, opener=opener)
            self.assertEqual({result.status for result in results}, {"downloaded"})
            self.assertEqual(len(calls), 6)
            for source in manifest["sources"]:
                self.assertEqual((cache / source["path"]).read_bytes(), content_by_url[source["download_url"]])

            def no_network(*_args: Any, **_kwargs: Any) -> FakeResponse:
                self.fail("offline cache verification attempted network access")

            cached = sync_sources(cache, manifest_path, offline=True, opener=no_network)
            self.assertEqual({result.status for result in cached}, {"cached"})

    def test_downloader_rejects_bad_content_without_leaving_partial_files(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        first_url = manifest["sources"][0]["download_url"]
        bad_content = b"X" + content_by_url[first_url][1:]

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(bad_content, request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                sync_sources(cache, manifest_path, opener=opener)
            self.assertEqual(list(cache.rglob("*.xlsx")), [])
            self.assertEqual(list(cache.rglob("*.part")), [])

    def test_downloader_never_overwrites_an_invalid_existing_cache_file(self) -> None:
        manifest, _content_by_url = self.synthetic_manifest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            target = cache / manifest["sources"][0]["path"]
            target.parent.mkdir(parents=True)
            target.write_bytes(b"preserve-me")

            def no_network(*_args: Any, **_kwargs: Any) -> FakeResponse:
                self.fail("invalid existing content should fail before network access")

            with self.assertRaisesRegex(ValueError, "size mismatch"):
                sync_sources(cache, manifest_path, opener=no_network)
            self.assertEqual(target.read_bytes(), b"preserve-me")

    def test_online_sync_rejects_dangling_final_symlink_before_network(self) -> None:
        manifest, _content_by_url = self.synthetic_manifest()
        first_source = manifest["sources"][0]
        calls: list[str] = []

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            calls.append(request.full_url)
            self.fail("dangling cache symlink should fail before network access")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            target = cache / first_source["path"]
            link_target = target.with_name("dangling-target.xlsx")
            target.parent.mkdir(parents=True)
            target.symlink_to(link_target.name)

            lexical_target = cache.resolve() / first_source["path"]
            self.assertEqual(resolve_source_path(cache, first_source["path"]), lexical_target)
            self.assertTrue(lexical_target.is_symlink())
            self.assertNotEqual(lexical_target, link_target.resolve())
            with self.assertRaisesRegex(ValueError, "cache path contains a symbolic link"):
                sync_sources(cache, manifest_path, opener=opener)

            self.assertEqual(calls, [])
            self.assertTrue(target.is_symlink())
            self.assertFalse(link_target.exists())
            self.assertEqual(list(cache.rglob("*.part")), [])
            self.assertEqual(list(cache.rglob(".who-publish-*")), [])

    def test_online_sync_rejects_unsafe_parent_before_network(self) -> None:
        manifest, _content_by_url = self.synthetic_manifest()

        for unsafe_parent_kind in ("symlink", "non-directory"):
            with self.subTest(unsafe_parent_kind=unsafe_parent_kind):
                calls: list[str] = []

                def opener(request: Request, *, timeout: int) -> FakeResponse:
                    del timeout
                    calls.append(request.full_url)
                    self.fail("unsafe cache parent should fail before network access")

                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    manifest_path = write_manifest(root, manifest)
                    cache = root / "cache"
                    source_parent = cache / Path(manifest["sources"][0]["path"]).parent
                    cache.mkdir()
                    if unsafe_parent_kind == "symlink":
                        actual_parent = cache / "actual-parent"
                        actual_parent.mkdir()
                        source_parent.symlink_to(actual_parent.name, target_is_directory=True)
                        expected_error = "cache path contains a symbolic link"
                    else:
                        source_parent.write_bytes(b"not a directory")
                        expected_error = "cache path contains a non-directory component"

                    with self.assertRaisesRegex(ValueError, expected_error):
                        sync_sources(cache, manifest_path, opener=opener)

                    self.assertEqual(calls, [])

    def test_online_sync_validates_late_existing_entries_before_any_network(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        first_source = manifest["sources"][0]
        last_source = manifest["sources"][-1]

        for invalid_kind, expected_error in (
            ("directory", "WHO source is not a regular file"),
            ("fifo", "WHO source is not a regular file"),
            ("invalid-regular", "WHO source hash mismatch"),
        ):
            with self.subTest(invalid_kind=invalid_kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                manifest_path = write_manifest(root, manifest)
                cache = root / "cache"
                first_target = cache / first_source["path"]
                last_target = cache / last_source["path"]
                last_target.parent.mkdir(parents=True)
                if invalid_kind == "directory":
                    last_target.mkdir()
                elif invalid_kind == "fifo":
                    os.mkfifo(last_target)
                else:
                    valid_content = content_by_url[last_source["download_url"]]
                    last_target.write_bytes(b"X" + valid_content[1:])

                calls: list[str] = []

                def opener(request: Request, *, timeout: int) -> FakeResponse:
                    del timeout
                    calls.append(request.full_url)
                    self.fail("late invalid cache entry should fail before network access")

                with self.assertRaisesRegex(ValueError, expected_error):
                    sync_sources(cache, manifest_path, opener=opener)

                self.assertEqual(calls, [])
                self.assertFalse(first_target.exists())
                self.assertEqual(list(cache.rglob("*.part")), [])
                self.assertEqual(list(cache.rglob(".who-publish-*")), [])

    def test_default_network_opener_rejects_off_origin_redirect_before_following(self) -> None:
        origin = next(iter(FROZEN_SOURCES.values()))["download_url"]
        off_origin = "https://off-origin.example.invalid/stolen.xlsx"
        headers = Message()
        headers["Location"] = off_origin
        requested_urls: list[str] = []

        def fake_transport_open(request: Request, data: Any = None) -> Any:
            del data
            requested_urls.append(request.full_url)
            response = addinfourl(io.BytesIO(), headers, request.full_url, 302)
            setattr(response, "msg", "Found")
            return response

        with mock.patch.object(_DEFAULT_NETWORK_OPENER, "_open", side_effect=fake_transport_open):
            with self.assertRaisesRegex(ValueError, "must not redirect"):
                _DEFAULT_NETWORK_OPENER.open(Request(origin), timeout=1)

        self.assertEqual(requested_urls, [origin])

    def test_injected_opener_cannot_mask_a_redirected_final_url(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], "https://cdn.who.int/different.xlsx")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            with self.assertRaisesRegex(ValueError, "redirected away"):
                sync_sources(cache, manifest_path, opener=opener)
            self.assertEqual([path for path in cache.rglob("*") if path.is_file()], [])

    def test_response_exit_failure_occurs_before_any_public_commit(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        first_url = manifest["sources"][0]["download_url"]

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            exit_error = OSError("synthetic response teardown failure") if request.full_url == first_url else None
            return FakeResponse(
                content_by_url[request.full_url],
                request.full_url,
                exit_error=exit_error,
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            with self.assertRaisesRegex(OSError, "response teardown failure"):
                sync_sources(cache, manifest_path, opener=opener)

            self.assertEqual(list(cache.rglob("*.xlsx")), [])
            self.assertEqual(list(cache.rglob("*.part")), [])
            self.assertEqual(list(cache.rglob(".who-publish-*")), [])

    def test_atomic_publication_preserves_a_concurrently_appearing_target(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        first_source = manifest["sources"][0]

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            target = cache / first_source["path"]
            concurrent_content = b"concurrent-cache-winner"

            def create_competitor(event: str, state: Any) -> None:
                if event != "before_link" or state.destination_name != target.name:
                    return
                descriptor = os.open(
                    state.destination_name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=state.parent_fd,
                )
                try:
                    os.write(descriptor, concurrent_content)
                finally:
                    os.close(descriptor)

            with mock.patch(
                "tools.knowledge.build_who_reference._PUBLICATION_TEST_HOOK",
                create_competitor,
            ):
                with self.assertRaisesRegex(ValueError, "target appeared during download"):
                    sync_sources(cache, manifest_path, opener=opener)

            self.assertEqual(target.read_bytes(), concurrent_content)
            self.assertEqual(list(cache.rglob("*.part")), [])
            self.assertEqual(list(cache.rglob(".who-publish-*")), [])

    def test_private_payload_swap_before_link_cannot_publish_unverified_bytes(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        first_source = manifest["sources"][0]

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            target = cache / first_source["path"]
            swapped = False

            def swap_private_payload(event: str, state: Any) -> None:
                nonlocal swapped
                if event != "before_link" or state.destination_name != target.name:
                    return
                os.rename(
                    "payload.part",
                    "verified.parked",
                    src_dir_fd=state.stage_fd,
                    dst_dir_fd=state.stage_fd,
                )
                replacement_fd = os.open(
                    "payload.part",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o444,
                    dir_fd=state.stage_fd,
                )
                os.close(replacement_fd)
                swapped = True

            with mock.patch(
                "tools.knowledge.build_who_reference._PUBLICATION_TEST_HOOK",
                swap_private_payload,
            ):
                with self.assertRaisesRegex(ValueError, "payload changed before commit"):
                    sync_sources(cache, manifest_path, opener=opener)

            self.assertTrue(swapped)
            self.assertFalse(target.exists())

    def test_replacement_after_successful_link_survives_without_public_rollback(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        first_source = manifest["sources"][0]

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            target = cache / first_source["path"]
            replacement = b"post-commit-concurrent-replacement"
            replaced = False

            def replace_after_link(event: str, state: Any) -> None:
                nonlocal replaced
                if event != "after_link" or state.destination_name != target.name or replaced:
                    return
                target.unlink()
                target.write_bytes(replacement)
                replaced = True
                raise OSError("post-commit observer failure")

            with mock.patch(
                "tools.knowledge.build_who_reference._PUBLICATION_TEST_HOOK",
                replace_after_link,
            ):
                results = sync_sources(cache, manifest_path, opener=opener)

            self.assertTrue(replaced)
            self.assertEqual({result.status for result in results}, {"downloaded"})
            self.assertEqual(target.read_bytes(), replacement)

    def test_private_cleanup_failure_after_commit_keeps_success_and_target(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            failing_stage_fd: int | None = None
            real_unlink = os.unlink

            def select_first_stage(event: str, state: Any) -> None:
                nonlocal failing_stage_fd
                if event == "before_private_cleanup" and failing_stage_fd is None:
                    failing_stage_fd = state.stage_fd

            def fail_selected_private_cleanup(
                path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
                *,
                dir_fd: int | None = None,
            ) -> None:
                if path == "payload.part" and dir_fd == failing_stage_fd:
                    raise OSError("synthetic private cleanup failure")
                real_unlink(path, dir_fd=dir_fd)

            with (
                mock.patch(
                    "tools.knowledge.build_who_reference._PUBLICATION_TEST_HOOK",
                    select_first_stage,
                ),
                mock.patch(
                    "tools.knowledge.build_who_reference.os.unlink",
                    side_effect=fail_selected_private_cleanup,
                ),
            ):
                results = sync_sources(cache, manifest_path, opener=opener)

            self.assertEqual({result.status for result in results}, {"downloaded"})
            first_source = manifest["sources"][0]
            self.assertEqual(
                (cache / first_source["path"]).read_bytes(),
                content_by_url[first_source["download_url"]],
            )

    def test_public_destination_is_never_passed_to_cleanup_or_replacement_apis(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()
        first_source = manifest["sources"][0]

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            target = cache / first_source["path"]
            unlink_calls: list[tuple[Any, int | None]] = []
            real_unlink = os.unlink

            def record_unlink(
                path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
                *,
                dir_fd: int | None = None,
            ) -> None:
                unlink_calls.append((path, dir_fd))
                real_unlink(path, dir_fd=dir_fd)

            with (
                mock.patch(
                    "tools.knowledge.build_who_reference.os.unlink",
                    side_effect=record_unlink,
                ),
                mock.patch("tools.knowledge.build_who_reference.os.rename") as rename,
                mock.patch("tools.knowledge.build_who_reference.os.replace") as replace,
            ):
                results = sync_sources(cache, manifest_path, opener=opener)

            self.assertEqual({result.status for result in results}, {"downloaded"})
            self.assertTrue(unlink_calls)
            self.assertEqual({call[0] for call in unlink_calls}, {"payload.part"})
            self.assertNotIn(target, {Path(call[0]) for call in unlink_calls})
            rename.assert_not_called()
            replace.assert_not_called()

    def test_sealed_verification_reopens_private_payload_with_no_follow(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            read_reopens: list[tuple[int, int | None]] = []
            real_open = os.open

            def record_open(
                path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
                flags: int,
                mode: int = 0o777,
                *,
                dir_fd: int | None = None,
            ) -> int:
                if path == "payload.part" and flags & os.O_ACCMODE == os.O_RDONLY:
                    read_reopens.append((flags, dir_fd))
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch(
                "tools.knowledge.build_who_reference.os.open",
                side_effect=record_open,
            ):
                sync_sources(cache, manifest_path, opener=opener)

            self.assertEqual(len(read_reopens), 6)
            for flags, dir_fd in read_reopens:
                self.assertIsNotNone(dir_fd)
                self.assertTrue(flags & os.O_NOFOLLOW)

    def test_stat_to_unlink_public_swap_reproduction_is_absent(self) -> None:
        manifest, content_by_url = self.synthetic_manifest()

        def opener(request: Request, *, timeout: int) -> FakeResponse:
            del timeout
            return FakeResponse(content_by_url[request.full_url], request.full_url)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = write_manifest(root, manifest)
            cache = root / "cache"
            public_names = {Path(source["path"]).name for source in manifest["sources"]}
            real_unlink = os.unlink
            observed_unlinks: list[Any] = []

            def reject_public_unlink(
                path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
                *,
                dir_fd: int | None = None,
            ) -> None:
                observed_unlinks.append(path)
                if Path(os.fsdecode(path)).name in public_names:
                    self.fail("public stat-to-unlink cleanup path returned")
                real_unlink(path, dir_fd=dir_fd)

            with mock.patch(
                "tools.knowledge.build_who_reference.os.unlink",
                side_effect=reject_public_unlink,
            ):
                results = sync_sources(cache, manifest_path, opener=opener)

            self.assertEqual({result.status for result in results}, {"downloaded"})
            self.assertEqual(set(observed_unlinks), {"payload.part"})


class XlsxSafetyTest(unittest.TestCase):
    @staticmethod
    def header_row_xml() -> str:
        cells = "".join(
            f'<c r="{chr(ord("A") + index)}1" t="inlineStr"><is><t>{header}</t></is></c>'
            for index, header in enumerate(EXPECTED_HEADERS)
        )
        return f'<row r="1">{cells}</row>'

    def test_compact_far_column_is_rejected_before_row_allocation(self) -> None:
        rows_xml = self.header_row_xml() + '<row r="2"><c r="ZZZZ2"><v>1</v></c></row>'
        with tempfile.TemporaryDirectory() as directory:
            path = write_compact_xlsx(Path(directory) / "far-column.xlsx", rows_xml)
            self.assertLess(path.stat().st_size, 2_048)
            with self.assertRaisesRegex(ValueError, "outside the exact 13 WHO columns"):
                read_xlsx_rows(path)

    def test_parser_enforces_bounded_row_and_cell_counts(self) -> None:
        rows_xml = self.header_row_xml() + '<row r="2"><c r="A2"><v>0</v></c></row>'
        with tempfile.TemporaryDirectory() as directory:
            path = write_compact_xlsx(Path(directory) / "bounded.xlsx", rows_xml)
            with mock.patch("tools.knowledge.who_xlsx.MAX_WORKSHEET_ROWS", 1):
                with self.assertRaisesRegex(ValueError, "too many XLSX worksheet rows"):
                    read_xlsx_rows(path)
            with mock.patch("tools.knowledge.who_xlsx.MAX_WORKSHEET_CELLS", len(EXPECTED_HEADERS)):
                with self.assertRaisesRegex(ValueError, "too many XLSX worksheet cells"):
                    read_xlsx_rows(path)


class LocalCacheConformanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rows = build_rows(CACHE_DIR, SOURCE_MANIFEST)
        cls.by_key = {(row.sex, row.indicator, row.age_days): row for row in cls.rows}

    def test_existing_cache_is_complete_without_network_access(self) -> None:
        def no_network(*_args: Any, **_kwargs: Any) -> FakeResponse:
            self.fail("local-cache conformance attempted network access")

        results = sync_sources(CACHE_DIR, SOURCE_MANIFEST, offline=True, opener=no_network)
        self.assertEqual(len(results), 6)
        self.assertEqual({result.status for result in results}, {"cached"})
        self.assertEqual(sum(result.size_bytes for result in results), 1169381)

    def test_parser_reads_the_exact_official_worksheet_shape(self) -> None:
        for expected in FROZEN_SOURCES.values():
            records = read_xlsx_rows(CACHE_DIR / expected["path"])
            self.assertEqual(tuple(records[0]), EXPECTED_HEADERS)
            self.assertEqual(len(records), 1857)
            self.assertEqual(records[0]["Day"], "0")
            self.assertEqual(records[-1]["Day"], "1856")

    def test_six_partitions_cover_every_integer_day_through_365(self) -> None:
        self.assertEqual(len(self.rows), 6 * 366)
        self.assertEqual(len(self.by_key), 2196)
        counts = Counter((row.sex, row.indicator) for row in self.rows)
        self.assertEqual(set(counts), set(PARTITIONS))
        self.assertEqual(set(counts.values()), {366})
        for partition in counts:
            days = [row.age_days for row in self.rows if (row.sex, row.indicator) == partition]
            self.assertEqual(days, list(range(366)))

    def test_frozen_lms_values_match_days_0_183_and_365(self) -> None:
        checkpoint = "".join(
            f"{sex},{indicator},{age_days},{row.l_value},{row.m_value},{row.s_value}\n"
            for sex, indicator in PARTITIONS
            for age_days in (0, 183, 365)
            for row in (self.by_key[(sex, indicator, age_days)],)
        )
        self.assertEqual(hashlib.sha256(checkpoint.encode()).hexdigest(), FROZEN_LMS_CHECKPOINT_SHA256)

    def test_g020_source_boundary_includes_day_365_without_extrapolation(self) -> None:
        """G020 proves source coverage only; Slice 3 owns UT-WHO-003 chart and percentile math."""
        for sex, indicator in PARTITIONS:
            for age_days in (0, 183, 365):
                self.assertEqual(self.by_key[(sex, indicator, age_days)].age_days, age_days)
            self.assertNotIn((sex, indicator, 366), self.by_key)

    def test_csv_output_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.csv"
            second = Path(directory) / "second.csv"
            write_csv(first, self.rows)
            write_csv(second, self.rows)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with first.open(encoding="utf-8", newline="") as handle:
                parsed = list(csv.DictReader(handle))
            self.assertEqual(len(parsed), 2196)
            self.assertEqual(
                hashlib.sha256(first.read_bytes()).hexdigest(),
                "e50187375ca79ed199cf3600847bb915036ebfe33ca2678d27a386d6a5c0bf0c",
            )

    def test_cache_rejects_manifest_size_or_hash_drift_for_the_right_reason(self) -> None:
        alterations = (
            ("size mismatch", "size_bytes", FROZEN_SOURCES[("male", "weight")]["size_bytes"] + 1),
            ("hash mismatch", "sha256", "0" * 64),
        )
        for message, key, value in alterations:
            altered = source_manifest_json()
            altered["sources"][0][key] = value
            with tempfile.TemporaryDirectory() as directory:
                manifest_path = write_manifest(Path(directory), altered)
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, message):
                    build_rows(CACHE_DIR, manifest_path)

    def test_source_swap_after_snapshot_emits_original_verified_bytes_and_hash(self) -> None:
        manifest = load_source_manifest(SOURCE_MANIFEST)
        male_source = next(
            source for source in manifest.sources if (source.sex, source.indicator) == ("male", "weight")
        )
        female_source = next(
            source for source in manifest.sources if (source.sex, source.indicator) == ("female", "weight")
        )
        expected_rows = [
            row for row in self.rows if (row.sex, row.indicator) == (male_source.sex, male_source.indicator)
        ]

        with tempfile.TemporaryDirectory() as directory:
            source_dir = Path(directory) / "cache"
            for source in manifest.sources:
                target = source_dir / source.path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((CACHE_DIR / source.path).read_bytes())

            target = source_dir / male_source.path
            replacement = source_dir / "replacement-female.xlsx"
            replacement.write_bytes((CACHE_DIR / female_source.path).read_bytes())
            real_read_xlsx_rows = read_xlsx_rows
            snapshot_hashes: list[str] = []
            swapped = False

            def swap_after_snapshot(
                source: Path | BinaryIO,
                *,
                label: str | None = None,
            ) -> list[dict[str, str]]:
                nonlocal swapped
                diagnostic = str(source) if isinstance(source, Path) else label
                if diagnostic is not None and Path(diagnostic).resolve() == target.resolve() and not swapped:
                    if not isinstance(source, Path):
                        position = source.tell()
                        snapshot_hashes.append(hashlib.sha256(source.read()).hexdigest())
                        source.seek(position)
                    replacement.replace(target)
                    swapped = True
                return real_read_xlsx_rows(source, label=label)

            with mock.patch(
                "tools.knowledge.build_who_reference.read_xlsx_rows",
                side_effect=swap_after_snapshot,
            ):
                rows = build_rows(source_dir, SOURCE_MANIFEST)

            actual_rows = [
                row for row in rows if (row.sex, row.indicator) == (male_source.sex, male_source.indicator)
            ]
            self.assertTrue(swapped)
            self.assertEqual(snapshot_hashes, [male_source.sha256])
            self.assertEqual(actual_rows, expected_rows)
            self.assertEqual({row.source_sha256 for row in actual_rows}, {male_source.sha256})
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), female_source.sha256)


if __name__ == "__main__":
    unittest.main()
