from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import secrets
import stat
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Callable, Literal, TypeAlias, TypeVar
from urllib.parse import urlsplit

if __package__:
    from .who_xlsx import read_xlsx_rows
else:
    from who_xlsx import read_xlsx_rows

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = ROOT / "knowledge/sources/who-growth"
DEFAULT_MANIFEST = DEFAULT_SOURCE / "source-manifest.json"
CsvField: TypeAlias = Literal[
    "sex",
    "indicator",
    "age_days",
    "l_value",
    "m_value",
    "s_value",
    "source_sha256",
]
FIELDS: tuple[CsvField, ...] = (
    "sex",
    "indicator",
    "age_days",
    "l_value",
    "m_value",
    "s_value",
    "source_sha256",
)
PARTITIONS = (
    ("male", "weight"),
    ("female", "weight"),
    ("male", "height"),
    ("female", "height"),
    ("male", "head"),
    ("female", "head"),
)
EXPECTED_DATASET = {
    "id": "who-child-growth-standards-expanded-zscore-tables",
    "title": "WHO Child Growth Standards",
    "publisher": "World Health Organization",
    "verified_on": "2026-07-11",
}
EXPECTED_COVERAGE = {
    "minimum_age_days": 0,
    "maximum_age_days": 365,
    "expected_rows_per_partition": 366,
    "expected_total_rows": 2196,
}
EXPECTED_RIGHTS = {
    "guidance_path": "knowledge/sources/who-growth/RIGHTS.md",
    "raw_xlsx": {
        "local_processing": "allowed-for-public-health-purposes",
        "repository_inclusion": "denied",
        "release_inclusion": "denied",
    },
    "derived_data": {
        "repository_inclusion": "denied",
        "release_inclusion": "denied",
    },
    "commercial_use": "permission-required",
}
EXPECTED_POLICY_URLS = {
    "dataset_terms": "https://www.who.int/about/policies/publishing/data-policy/terms-and-conditions",
    "copyright": "https://www.who.int/about/policies/publishing/copyright",
    "website_terms": "https://www.who.int/about/policies/terms-of-use",
    "permissions": "https://www.who.int/about/policies/publishing/permissions",
}
INDICATOR_PAGE_URLS = {
    "weight": "https://www.who.int/tools/child-growth-standards/standards/weight-for-age",
    "height": "https://www.who.int/tools/child-growth-standards/standards/length-height-for-age",
    "head": "https://www.who.int/tools/child-growth-standards/standards/head-circumference-for-age",
}
MANIFEST_KEYS = {"schema_version", "dataset", "coverage", "rights", "policy_urls", "sources"}
SOURCE_KEYS = {
    "sex",
    "indicator",
    "title",
    "page_url",
    "download_url",
    "path",
    "size_bytes",
    "sha256",
    "upstream_last_modified",
}
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class WhoSource:
    sex: str
    indicator: str
    title: str
    page_url: str
    download_url: str
    path: str
    size_bytes: int
    sha256: str
    upstream_last_modified: str


@dataclass(frozen=True)
class WhoManifest:
    minimum_age_days: int
    maximum_age_days: int
    expected_rows_per_partition: int
    expected_total_rows: int
    sources: tuple[WhoSource, ...]


@dataclass(frozen=True)
class WhoRow:
    sex: str
    indicator: str
    age_days: int
    l_value: str
    m_value: str
    s_value: str
    source_sha256: str


@dataclass(frozen=True)
class ValidatedSourceSnapshot:
    path: Path
    content: bytes
    sha256: str


def _decimal_text(value: str, label: str) -> str:
    try:
        number = Decimal(value)
    except (InvalidOperation, TypeError) as error:
        raise ValueError(f"{label} is not decimal: {value!r}") from error
    if not number.is_finite():
        raise ValueError(f"{label} is not finite: {value!r}")
    number = number.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
    return format(number, "f")


def _require_exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise ValueError(f"{label} has invalid keys; missing={missing}, unexpected={unexpected}")
    return value


def _require_exact_object(value: Any, expected: dict[str, Any], label: str) -> dict[str, Any]:
    value = _require_exact_keys(value, set(expected), label)
    if value != expected:
        raise ValueError(f"{label} does not match the frozen G020 policy")
    return value


def _require_trimmed_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{label} must be a non-empty trimmed string")
    return value


def _require_iso_date(value: Any, label: str) -> str:
    value = _require_trimmed_string(value, label)
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be an ISO calendar date") from error
    if parsed.isoformat() != value:
        raise ValueError(f"{label} must be an ISO calendar date")
    return value


def _require_https_url(value: Any, hostname: str, label: str, *, xlsx: bool = False) -> str:
    value = _require_trimmed_string(value, label)
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError(f"{label} is not a valid URL") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname != hostname
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or not parsed.path.startswith("/")
        or parsed.fragment
    ):
        raise ValueError(f"{label} must be an HTTPS URL on {hostname}")
    if xlsx and not parsed.path.endswith(".xlsx"):
        raise ValueError(f"{label} must identify an XLSX file")
    if not xlsx and parsed.query:
        raise ValueError(f"{label} must not contain a query string")
    return value


def _relative_source_path(value: Any, label: str) -> str:
    value = _require_trimmed_string(value, label)
    relative = PurePosixPath(value)
    if (
        relative.is_absolute()
        or "\\" in value
        or relative.as_posix() != value
        or any(part in {".", ".."} for part in relative.parts)
        or relative.suffix != ".xlsx"
    ):
        raise ValueError(f"{label} must be a normalized relative XLSX path")
    return value


def _load_json_object(path: Path) -> dict[str, Any]:
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"{path}: duplicate object key {key!r}")
            result[key] = value
        return result

    try:
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle, object_pairs_hook=reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise ValueError(f"{path}: invalid JSON") from error
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain one object")
    return value


def load_source_manifest(path: Path = DEFAULT_MANIFEST) -> WhoManifest:
    raw = _require_exact_keys(_load_json_object(path), MANIFEST_KEYS, str(path))
    if type(raw["schema_version"]) is not int or raw["schema_version"] != 2:
        raise ValueError(f"{path}: unsupported schema_version")

    _require_exact_object(raw["dataset"], EXPECTED_DATASET, f"{path}: dataset")
    coverage = _require_exact_object(raw["coverage"], EXPECTED_COVERAGE, f"{path}: coverage")
    for key, value in coverage.items():
        if type(value) is not int:
            raise ValueError(f"{path}: coverage.{key} must be an integer")
    _require_exact_object(raw["rights"], EXPECTED_RIGHTS, f"{path}: rights")
    policy_urls = _require_exact_object(raw["policy_urls"], EXPECTED_POLICY_URLS, f"{path}: policy_urls")
    for key, value in policy_urls.items():
        _require_https_url(value, "www.who.int", f"{path}: policy_urls.{key}")

    raw_sources = raw["sources"]
    if not isinstance(raw_sources, list) or len(raw_sources) != len(PARTITIONS):
        raise ValueError(f"{path}: sources must contain exactly six entries")
    sources: list[WhoSource] = []
    partitions: set[tuple[str, str]] = set()
    paths: set[str] = set()
    download_urls: set[str] = set()
    for index, raw_source in enumerate(raw_sources):
        label = f"{path}: sources[{index}]"
        raw_source = _require_exact_keys(raw_source, SOURCE_KEYS, label)
        sex = _require_trimmed_string(raw_source["sex"], f"{label}.sex")
        indicator = _require_trimmed_string(raw_source["indicator"], f"{label}.indicator")
        partition = (sex, indicator)
        if partition not in PARTITIONS or partition in partitions:
            raise ValueError(f"{label}: unexpected or duplicate WHO partition {sex}/{indicator}")
        partitions.add(partition)

        title = _require_trimmed_string(raw_source["title"], f"{label}.title")
        page_url = _require_https_url(raw_source["page_url"], "www.who.int", f"{label}.page_url")
        if page_url != INDICATOR_PAGE_URLS[indicator]:
            raise ValueError(f"{label}.page_url does not match indicator {indicator}")
        download_url = _require_https_url(
            raw_source["download_url"], "cdn.who.int", f"{label}.download_url", xlsx=True
        )
        if download_url in download_urls:
            raise ValueError(f"{path}: duplicate WHO download URL {download_url}")
        download_urls.add(download_url)

        source_path = _relative_source_path(raw_source["path"], f"{label}.path")
        if source_path in paths:
            raise ValueError(f"{path}: duplicate WHO source path {source_path}")
        paths.add(source_path)
        size_bytes = raw_source["size_bytes"]
        if type(size_bytes) is not int or size_bytes <= 0:
            raise ValueError(f"{label}.size_bytes must be a positive integer")
        source_hash = raw_source["sha256"]
        if not isinstance(source_hash, str) or SHA256_PATTERN.fullmatch(source_hash) is None:
            raise ValueError(f"{label}.sha256 must be exactly 64 lowercase hexadecimal characters")
        upstream_last_modified = _require_iso_date(
            raw_source["upstream_last_modified"], f"{label}.upstream_last_modified"
        )
        sources.append(
            WhoSource(
                sex=sex,
                indicator=indicator,
                title=title,
                page_url=page_url,
                download_url=download_url,
                path=source_path,
                size_bytes=size_bytes,
                sha256=source_hash,
                upstream_last_modified=upstream_last_modified,
            )
        )
    if partitions != set(PARTITIONS):
        raise ValueError(f"{path}: WHO partition set is not exact")
    return WhoManifest(
        minimum_age_days=coverage["minimum_age_days"],
        maximum_age_days=coverage["maximum_age_days"],
        expected_rows_per_partition=coverage["expected_rows_per_partition"],
        expected_total_rows=coverage["expected_total_rows"],
        sources=tuple(sources),
    )


def resolve_source_path(source_dir: Path, relative_path: str) -> Path:
    normalized = _relative_source_path(relative_path, "WHO source path")
    source_root = source_dir.resolve()
    target = source_root.joinpath(*PurePosixPath(normalized).parts)
    try:
        target.relative_to(source_root)
    except ValueError as error:
        raise ValueError(f"WHO source path escapes cache: {relative_path}") from error
    return target


_SECURE_CACHE_DIR_FD_FUNCTIONS = (os.open, os.stat)
_SECURE_CACHE_FOLLOW_SYMLINK_FUNCTIONS = (os.stat,)


def _secure_cache_flags() -> tuple[int, int]:
    supports_dir_fd = getattr(os, "supports_dir_fd", None)
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", None)
    directory = getattr(os, "O_DIRECTORY", None)
    no_follow = getattr(os, "O_NOFOLLOW", None)
    non_blocking = getattr(os, "O_NONBLOCK", None)
    close_on_exec = getattr(os, "O_CLOEXEC", None)
    if (
        supports_dir_fd is None
        or any(function not in supports_dir_fd for function in _SECURE_CACHE_DIR_FD_FUNCTIONS)
        or supports_follow_symlinks is None
        or any(
            function not in supports_follow_symlinks
            for function in _SECURE_CACHE_FOLLOW_SYMLINK_FUNCTIONS
        )
        or not isinstance(directory, int)
        or not isinstance(no_follow, int)
        or not isinstance(non_blocking, int)
        or not isinstance(close_on_exec, int)
    ):
        raise RuntimeError("Secure directory-relative WHO cache validation is unavailable")
    directory_flags = os.O_RDONLY | directory | no_follow | close_on_exec
    source_flags = os.O_RDONLY | no_follow | non_blocking | close_on_exec
    return directory_flags, source_flags


def _cache_entry_is_symlink(directory_fd: int, name: str) -> bool:
    try:
        entry_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISLNK(entry_stat.st_mode)


def _inspect_cache_component(
    directory_fd: int,
    name: str,
    relative_path: str,
) -> os.stat_result | None:
    try:
        entry_stat = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ValueError(f"WHO source cache path cannot be inspected: {relative_path}") from error
    if stat.S_ISLNK(entry_stat.st_mode):
        raise ValueError(f"WHO source cache path contains a symbolic link: {relative_path}")
    return entry_stat


def inspect_cache_entry(source_dir: Path, relative_path: str) -> bool:
    """Return whether a lexical cache entry exists without following cache symlinks."""
    normalized = _relative_source_path(relative_path, "WHO source path")
    source_root = source_dir.resolve()
    parts = PurePosixPath(normalized).parts
    directory_flags, _source_flags = _secure_cache_flags()
    directory_fd = -1
    try:
        try:
            root_stat = os.stat(source_root, follow_symlinks=False)
        except FileNotFoundError:
            return False
        except OSError as error:
            raise ValueError(f"WHO source cache path cannot be inspected: {relative_path}") from error
        if stat.S_ISLNK(root_stat.st_mode):
            raise ValueError(f"WHO source cache path contains a symbolic link: {relative_path}")
        if not stat.S_ISDIR(root_stat.st_mode):
            raise ValueError(
                f"WHO source cache path contains a non-directory component: {relative_path}"
            )
        try:
            directory_fd = os.open(source_root, directory_flags)
        except OSError as error:
            try:
                current_root_stat = os.stat(source_root, follow_symlinks=False)
            except FileNotFoundError:
                return False
            except OSError:
                current_root_stat = root_stat
            if stat.S_ISLNK(current_root_stat.st_mode):
                raise ValueError(
                    f"WHO source cache path contains a symbolic link: {relative_path}"
                ) from error
            if not stat.S_ISDIR(current_root_stat.st_mode):
                raise ValueError(
                    f"WHO source cache path contains a non-directory component: {relative_path}"
                ) from error
            raise ValueError(f"WHO source cache path cannot be inspected: {relative_path}") from error

        for parent_name in parts[:-1]:
            parent_stat = _inspect_cache_component(directory_fd, parent_name, relative_path)
            if parent_stat is None:
                return False
            if not stat.S_ISDIR(parent_stat.st_mode):
                raise ValueError(
                    f"WHO source cache path contains a non-directory component: {relative_path}"
                )
            try:
                next_directory_fd = os.open(parent_name, directory_flags, dir_fd=directory_fd)
            except OSError as error:
                current_parent_stat = _inspect_cache_component(
                    directory_fd,
                    parent_name,
                    relative_path,
                )
                if current_parent_stat is None:
                    return False
                if not stat.S_ISDIR(current_parent_stat.st_mode):
                    raise ValueError(
                        f"WHO source cache path contains a non-directory component: {relative_path}"
                    ) from error
                raise ValueError(
                    f"WHO source cache path cannot be inspected: {relative_path}"
                ) from error
            previous_directory_fd = directory_fd
            directory_fd = next_directory_fd
            os.close(previous_directory_fd)

        entry_stat = _inspect_cache_component(directory_fd, parts[-1], relative_path)
        if entry_stat is None:
            return False
        return True
    finally:
        if directory_fd >= 0:
            os.close(directory_fd)


def validate_cached_source(source_dir: Path, source: WhoSource) -> ValidatedSourceSnapshot:
    normalized = _relative_source_path(source.path, "WHO source path")
    source_root = source_dir.resolve()
    parts = PurePosixPath(normalized).parts
    path = source_root.joinpath(*parts)
    directory_flags, source_flags = _secure_cache_flags()
    directory_fd = -1
    source_fd = -1
    try:
        directory_fd = os.open(source_root, directory_flags)
        for parent_name in parts[:-1]:
            try:
                next_directory_fd = os.open(parent_name, directory_flags, dir_fd=directory_fd)
            except OSError as error:
                if _cache_entry_is_symlink(directory_fd, parent_name):
                    raise ValueError(
                        f"WHO source cache path contains a symbolic link: {source.path}"
                    ) from error
                raise ValueError(f"WHO source is missing from local cache: {source.path}") from error
            previous_directory_fd = directory_fd
            directory_fd = next_directory_fd
            os.close(previous_directory_fd)

        source_name = parts[-1]
        try:
            source_fd = os.open(source_name, source_flags, dir_fd=directory_fd)
        except OSError as error:
            if _cache_entry_is_symlink(directory_fd, source_name):
                raise ValueError(
                    f"WHO source cache path contains a symbolic link: {source.path}"
                ) from error
            raise ValueError(f"WHO source is missing from local cache: {source.path}") from error

        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError(f"WHO source is not a regular file: {source.path}")
        actual_size = source_stat.st_size
        if actual_size != source.size_bytes:
            raise ValueError(
                f"WHO source size mismatch: {source.path}; expected {source.size_bytes}, got {actual_size}"
            )
        blocks: list[bytes] = []
        remaining = source.size_bytes + 1
        while remaining:
            block = os.read(source_fd, remaining)
            if not block:
                break
            blocks.append(block)
            remaining -= len(block)
        content = b"".join(blocks)
    except FileNotFoundError as error:
        raise ValueError(f"WHO source is missing from local cache: {source.path}") from error
    finally:
        if source_fd >= 0:
            os.close(source_fd)
        if directory_fd >= 0:
            os.close(directory_fd)
    if len(content) != source.size_bytes:
        raise ValueError(
            f"WHO source size mismatch: {source.path}; expected {source.size_bytes}, got {len(content)}"
        )
    actual_hash = hashlib.sha256(content).hexdigest()
    if actual_hash != source.sha256:
        raise ValueError(f"WHO source hash mismatch: {source.path}")
    return ValidatedSourceSnapshot(path=path, content=content, sha256=actual_hash)


def build_rows(source_dir: Path = DEFAULT_SOURCE, manifest_path: Path = DEFAULT_MANIFEST) -> list[WhoRow]:
    manifest = load_source_manifest(manifest_path)
    sources = {(source.sex, source.indicator): source for source in manifest.sources}
    rows: list[WhoRow] = []
    for partition_key in PARTITIONS:
        source = sources[partition_key]
        snapshot = validate_cached_source(source_dir, source)
        partition: list[WhoRow] = []
        for record in read_xlsx_rows(io.BytesIO(snapshot.content), label=str(snapshot.path)):
            try:
                day_decimal = Decimal(record["Day"])
            except (InvalidOperation, TypeError) as error:
                raise ValueError(f"WHO day is not decimal: {record['Day']!r}") from error
            if not day_decimal.is_finite():
                raise ValueError(f"WHO day is not finite: {record['Day']!r}")
            if day_decimal != day_decimal.to_integral_value():
                raise ValueError(f"WHO day is not an integer: {record['Day']}")
            age_days = int(day_decimal)
            if manifest.minimum_age_days <= age_days <= manifest.maximum_age_days:
                l_value = _decimal_text(record["L"], "WHO L value")
                m_value = _decimal_text(record["M"], "WHO M value")
                s_value = _decimal_text(record["S"], "WHO S value")
                if Decimal(m_value) <= 0 or Decimal(s_value) <= 0:
                    raise ValueError(f"WHO M and S values must be positive: {source.path} day {age_days}")
                partition.append(
                    WhoRow(
                        sex=source.sex,
                        indicator=source.indicator,
                        age_days=age_days,
                        l_value=l_value,
                        m_value=m_value,
                        s_value=s_value,
                        source_sha256=snapshot.sha256,
                    )
                )
        days = [row.age_days for row in partition]
        expected_days = list(range(manifest.minimum_age_days, manifest.maximum_age_days + 1))
        if len(partition) != manifest.expected_rows_per_partition or days != expected_days:
            raise ValueError(f"WHO partition is not contiguous through day 365: {source.sex}/{source.indicator}")
        rows.extend(partition)
    keys = {(row.sex, row.indicator, row.age_days) for row in rows}
    if len(rows) != manifest.expected_total_rows or len(keys) != manifest.expected_total_rows:
        raise ValueError(
            f"WHO output must contain 2,196 unique rows; got {len(rows)} rows and {len(keys)} keys"
        )
    return rows


def _path_identity(stat_result: os.stat_result) -> tuple[int, int]:
    return stat_result.st_dev, stat_result.st_ino


_PublishResult = TypeVar("_PublishResult")
_PublicationHook = Callable[[str, "_PrivatePublicationState"], None]
_PUBLICATION_TEST_HOOK: _PublicationHook | None = None
_STAGE_PAYLOAD_NAME = "payload.part"
_STAGE_CREATION_ATTEMPTS = 128
_SECURE_DIR_FD_FUNCTIONS = (os.link, os.mkdir, os.open, os.rmdir, os.stat, os.unlink)
_SECURE_FOLLOW_SYMLINK_FUNCTIONS = (os.link, os.stat)


@dataclass(frozen=True)
class _PrivatePublicationState:
    parent_fd: int
    stage_fd: int
    sealed_fd: int
    stage_name: str
    destination_name: str


def _run_publication_hook(event: str, state: _PrivatePublicationState) -> None:
    hook = _PUBLICATION_TEST_HOOK
    if hook is not None:
        hook(event, state)


def _secure_publication_flags() -> tuple[int, int, int]:
    supports_dir_fd = getattr(os, "supports_dir_fd", None)
    supports_follow_symlinks = getattr(os, "supports_follow_symlinks", None)
    directory = getattr(os, "O_DIRECTORY", None)
    no_follow = getattr(os, "O_NOFOLLOW", None)
    close_on_exec = getattr(os, "O_CLOEXEC", None)
    if (
        supports_dir_fd is None
        or any(function not in supports_dir_fd for function in _SECURE_DIR_FD_FUNCTIONS)
        or supports_follow_symlinks is None
        or any(
            function not in supports_follow_symlinks
            for function in _SECURE_FOLLOW_SYMLINK_FUNCTIONS
        )
        or not isinstance(directory, int)
        or not isinstance(no_follow, int)
        or not isinstance(close_on_exec, int)
    ):
        raise RuntimeError("Secure directory-relative WHO publication is unavailable")
    directory_flags = os.O_RDONLY | directory | no_follow | close_on_exec
    writable_flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | no_follow | close_on_exec
    sealed_flags = os.O_RDONLY | no_follow | close_on_exec
    return directory_flags, writable_flags, sealed_flags


def _create_private_stage(parent_fd: int, directory_flags: int) -> tuple[str, int]:
    for _attempt in range(_STAGE_CREATION_ATTEMPTS):
        stage_name = f".who-publish-{secrets.token_hex(16)}"
        try:
            os.mkdir(stage_name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            continue
        try:
            stage_fd = os.open(stage_name, directory_flags, dir_fd=parent_fd)
            try:
                os.fchmod(stage_fd, 0o700)
                if not stat.S_ISDIR(os.fstat(stage_fd).st_mode):
                    raise RuntimeError("Private WHO publication stage is not a directory")
                return stage_name, stage_fd
            except BaseException:
                try:
                    os.close(stage_fd)
                except OSError:
                    pass
                raise
        except BaseException:
            try:
                os.rmdir(stage_name, dir_fd=parent_fd)
            except OSError:
                pass
            raise
    raise FileExistsError("Unable to allocate a private WHO publication stage")


def _best_effort_private_cleanup(
    parent_fd: int,
    stage_fd: int,
    stage_name: str | None,
) -> None:
    if stage_fd >= 0:
        try:
            os.unlink(_STAGE_PAYLOAD_NAME, dir_fd=stage_fd)
        except OSError:
            pass
        try:
            os.close(stage_fd)
        except OSError:
            pass
    if stage_name is not None:
        try:
            os.rmdir(stage_name, dir_fd=parent_fd)
        except OSError:
            pass


def _publish_private_file_no_clobber(
    destination: Path,
    populate: Callable[[BinaryIO], None],
    verify: Callable[[BinaryIO], _PublishResult],
    *,
    validate_parent_before_commit: Callable[[int, int], None] | None = None,
) -> _PublishResult:
    """Publish one sealed private inode with a single no-clobber hard-link commit."""
    output = _absolute_output_path(destination)
    if not output.name:
        raise ValueError("WHO output must identify a file")
    directory_flags, writable_flags, sealed_flags = _secure_publication_flags()
    output.parent.mkdir(parents=True, exist_ok=True)
    parent_fd = os.open(output.parent, directory_flags)
    stage_name: str | None = None
    stage_fd = -1
    sealed_fd = -1
    committed = False
    state: _PrivatePublicationState | None = None
    try:
        stage_name, stage_fd = _create_private_stage(parent_fd, directory_flags)
        writable_fd = os.open(
            _STAGE_PAYLOAD_NAME,
            writable_flags,
            0o600,
            dir_fd=stage_fd,
        )
        try:
            os.fchmod(writable_fd, 0o600)
            payload = os.fdopen(writable_fd, "w+b")
        except BaseException:
            try:
                os.close(writable_fd)
            except OSError:
                pass
            raise
        with payload:
            populate(payload)
            payload.flush()
            os.fsync(payload.fileno())

        sealed_fd = os.open(_STAGE_PAYLOAD_NAME, sealed_flags, dir_fd=stage_fd)
        opened_stat = os.fstat(sealed_fd)
        if not stat.S_ISREG(opened_stat.st_mode):
            raise ValueError("Private WHO publication payload is not a regular file")
        with os.fdopen(sealed_fd, "rb", closefd=False) as sealed_payload:
            result = verify(sealed_payload)
        verified_stat = os.fstat(sealed_fd)
        if (
            _path_identity(verified_stat) != _path_identity(opened_stat)
            or verified_stat.st_size != opened_stat.st_size
        ):
            raise ValueError("Private WHO publication payload changed during verification")

        os.fchmod(sealed_fd, 0o444)
        os.fsync(sealed_fd)
        sealed_stat = os.fstat(sealed_fd)
        if stat.S_IMODE(sealed_stat.st_mode) != 0o444:
            raise ValueError("Private WHO publication payload was not sealed read-only")

        state = _PrivatePublicationState(
            parent_fd=parent_fd,
            stage_fd=stage_fd,
            sealed_fd=sealed_fd,
            stage_name=stage_name,
            destination_name=output.name,
        )
        _run_publication_hook("stage_sealed", state)
        _run_publication_hook("before_link", state)

        staged_stat = os.stat(_STAGE_PAYLOAD_NAME, dir_fd=stage_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(staged_stat.st_mode)
            or _path_identity(staged_stat) != _path_identity(sealed_stat)
            or staged_stat.st_size != sealed_stat.st_size
            or stat.S_IMODE(staged_stat.st_mode) != 0o444
        ):
            raise ValueError("Private WHO publication payload changed before commit")
        if validate_parent_before_commit is not None:
            validate_parent_before_commit(parent_fd, directory_flags)
        os.link(
            _STAGE_PAYLOAD_NAME,
            output.name,
            src_dir_fd=stage_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        committed = True
        try:
            _run_publication_hook("after_link", state)
        except BaseException:
            pass
        return result
    finally:
        if committed and state is not None:
            try:
                _run_publication_hook("before_private_cleanup", state)
            except BaseException:
                pass
        if sealed_fd >= 0:
            try:
                os.close(sealed_fd)
            except OSError:
                pass
        _best_effort_private_cleanup(parent_fd, stage_fd, stage_name)
        try:
            os.close(parent_fd)
        except OSError:
            pass


def _repository_output_error() -> ValueError:
    return ValueError(
        "Generated WHO data must not be written anywhere inside the repository "
        "while derived-data rights are denied"
    )


def _absolute_output_path(path: Path) -> Path:
    return Path(os.path.abspath(path))


def _reject_open_directory_inside_repository(directory_fd: int, directory_flags: int) -> None:
    repository_identity = _path_identity(ROOT.stat())
    current_fd = os.dup(directory_fd)
    try:
        while True:
            current_identity = _path_identity(os.fstat(current_fd))
            if current_identity == repository_identity:
                raise _repository_output_error()
            parent_fd = os.open("..", directory_flags, dir_fd=current_fd)
            parent_identity = _path_identity(os.fstat(parent_fd))
            if parent_identity == current_identity:
                os.close(parent_fd)
                return
            os.close(current_fd)
            current_fd = parent_fd
    finally:
        os.close(current_fd)


def write_csv(path: Path, rows: list[WhoRow]) -> None:
    output = _absolute_output_path(path)
    if not output.name:
        raise ValueError("WHO output must identify a file")
    _reject_output_inside_repository(output)

    def populate(payload: BinaryIO) -> None:
        text_payload = io.TextIOWrapper(payload, encoding="utf-8", newline="")
        try:
            writer = csv.DictWriter(text_payload, fieldnames=FIELDS)
            writer.writeheader()
            for row in rows:
                csv_row: dict[CsvField, str | int] = {
                    "sex": row.sex,
                    "indicator": row.indicator,
                    "age_days": row.age_days,
                    "l_value": row.l_value,
                    "m_value": row.m_value,
                    "s_value": row.s_value,
                    "source_sha256": row.source_sha256,
                }
                writer.writerow(csv_row)
            text_payload.flush()
        finally:
            text_payload.detach()

    def verify(payload: BinaryIO) -> None:
        expected_size = os.fstat(payload.fileno()).st_size
        actual_size = 0
        while True:
            block = payload.read(64 * 1024)
            if not block:
                break
            actual_size += len(block)
        if actual_size != expected_size:
            raise ValueError("Generated WHO CSV changed during private verification")

    _publish_private_file_no_clobber(
        output,
        populate,
        verify,
        validate_parent_before_commit=_reject_open_directory_inside_repository,
    )

def _reject_output_inside_repository(output: Path) -> None:
    if EXPECTED_RIGHTS["derived_data"]["repository_inclusion"] != "denied":
        return
    repository_identity = _path_identity(ROOT.stat())
    candidate = _absolute_output_path(output)
    while True:
        try:
            candidate_identity = _path_identity(candidate.stat())
        except FileNotFoundError:
            pass
        else:
            if candidate_identity == repository_identity:
                raise _repository_output_error()
        parent = candidate.parent
        if parent == candidate:
            return
        candidate = parent


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the local-only, day-based WHO growth reference")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Ignored local XLSX cache")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--output", type=Path, required=True, help="Local generated CSV; do not publish")
    args = parser.parse_args()
    _reject_output_inside_repository(args.output)
    rows = build_rows(args.source, args.manifest)
    write_csv(args.output, rows)
    print(
        json.dumps(
            {
                "maximum_age_days": max(row.age_days for row in rows),
                "minimum_age_days": min(row.age_days for row in rows),
                "partitions": len(PARTITIONS),
                "rows": len(rows),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
