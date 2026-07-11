from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from http.client import HTTPMessage
from pathlib import Path
from typing import IO, Any, BinaryIO, Callable
from urllib.request import HTTPRedirectHandler, Request, build_opener

if __package__:
    from .build_who_reference import (
        DEFAULT_MANIFEST,
        DEFAULT_SOURCE,
        WhoSource,
        _publish_private_file_no_clobber,
        inspect_cache_entry,
        load_source_manifest,
        resolve_source_path,
        validate_cached_source,
    )
else:
    from build_who_reference import (
        DEFAULT_MANIFEST,
        DEFAULT_SOURCE,
        WhoSource,
        _publish_private_file_no_clobber,
        inspect_cache_entry,
        load_source_manifest,
        resolve_source_path,
        validate_cached_source,
    )

CHUNK_SIZE = 64 * 1024
DEFAULT_TIMEOUT_SECONDS = 30
USER_AGENT = "fawn-who-source-fetcher/1.0"
OpenUrl = Callable[..., Any]


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> None:
        del fp, code, msg, headers
        raise ValueError(f"WHO downloads must not redirect: {req.full_url} -> {newurl}")


_DEFAULT_NETWORK_OPENER = build_opener(_RejectRedirects())


def _open_url_without_redirects(request: Request, *, timeout: int) -> Any:
    return _DEFAULT_NETWORK_OPENER.open(request, timeout=timeout)


@dataclass(frozen=True)
class DownloadResult:
    path: str
    size_bytes: int
    sha256: str
    status: str


def _download_source(
    cache_dir: Path,
    source: WhoSource,
    *,
    opener: OpenUrl,
    timeout_seconds: int,
) -> DownloadResult:
    target = resolve_source_path(cache_dir, source.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    request = Request(
        source.download_url,
        headers={
            "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "User-Agent": USER_AGENT,
        },
    )
    downloaded_blocks: list[bytes] = []
    downloaded_size = 0
    with opener(request, timeout=timeout_seconds) as response:
        final_url = response.geturl()
        if final_url != source.download_url:
            raise ValueError(f"WHO download redirected away from its frozen URL: {source.path}")
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            try:
                announced_size = int(content_length)
            except ValueError as error:
                raise ValueError(f"WHO download has invalid Content-Length: {source.path}") from error
            if announced_size != source.size_bytes:
                raise ValueError(
                    f"WHO download size header mismatch: {source.path}; "
                    f"expected {source.size_bytes}, got {announced_size}"
                )

        while True:
            block = response.read(CHUNK_SIZE)
            if not block:
                break
            if not isinstance(block, bytes):
                raise ValueError(f"WHO download returned non-byte content: {source.path}")
            downloaded_size += len(block)
            if downloaded_size > source.size_bytes:
                raise ValueError(f"WHO download exceeds frozen size: {source.path}")
            downloaded_blocks.append(block)
        if downloaded_size != source.size_bytes:
            raise ValueError(
                f"WHO download size mismatch: {source.path}; "
                f"expected {source.size_bytes}, got {downloaded_size}"
            )

    downloaded_content = b"".join(downloaded_blocks)

    def populate(payload: BinaryIO) -> None:
        payload.write(downloaded_content)

    def verify(payload: BinaryIO) -> tuple[int, str]:
        descriptor_size = os.fstat(payload.fileno()).st_size
        if descriptor_size != source.size_bytes:
            raise ValueError(
                f"WHO download size mismatch: {source.path}; "
                f"expected {source.size_bytes}, got {descriptor_size}"
            )
        digest = hashlib.sha256()
        size_bytes = 0
        while True:
            block = payload.read(CHUNK_SIZE)
            if not block:
                break
            size_bytes += len(block)
            if size_bytes > source.size_bytes:
                raise ValueError(f"WHO download exceeds frozen size: {source.path}")
            digest.update(block)
        if size_bytes != source.size_bytes:
            raise ValueError(
                f"WHO download size mismatch: {source.path}; "
                f"expected {source.size_bytes}, got {size_bytes}"
            )
        actual_hash = digest.hexdigest()
        if actual_hash != source.sha256:
            raise ValueError(f"WHO download hash mismatch: {source.path}")
        return size_bytes, actual_hash

    try:
        size_bytes, actual_hash = _publish_private_file_no_clobber(target, populate, verify)
    except FileExistsError as error:
        raise ValueError(f"WHO cache target appeared during download: {source.path}") from error
    return DownloadResult(source.path, size_bytes, actual_hash, "downloaded")


def sync_sources(
    cache_dir: Path = DEFAULT_SOURCE,
    manifest_path: Path = DEFAULT_MANIFEST,
    *,
    offline: bool = False,
    opener: OpenUrl = _open_url_without_redirects,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> list[DownloadResult]:
    if type(timeout_seconds) is not int or timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be a positive integer")
    manifest = load_source_manifest(manifest_path)
    cache_entries: list[tuple[WhoSource, bool]] = []
    for source in manifest.sources:
        cache_entry_exists = inspect_cache_entry(cache_dir, source.path)
        if cache_entry_exists:
            validate_cached_source(cache_dir, source)
        cache_entries.append((source, cache_entry_exists))

    results: list[DownloadResult] = []
    for source, cache_entry_existed in cache_entries:
        if cache_entry_existed:
            validate_cached_source(cache_dir, source)
            results.append(DownloadResult(source.path, source.size_bytes, source.sha256, "cached"))
            continue
        if inspect_cache_entry(cache_dir, source.path):
            validate_cached_source(cache_dir, source)
            results.append(DownloadResult(source.path, source.size_bytes, source.sha256, "cached"))
            continue
        if offline:
            raise ValueError(f"WHO source is missing from local cache: {source.path}")
        results.append(
            _download_source(
                cache_dir,
                source,
                opener=opener,
                timeout_seconds=timeout_seconds,
            )
        )
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Populate the ignored, hash-pinned WHO XLSX cache")
    parser.add_argument("--cache", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--offline", action="store_true", help="Verify the cache without any network access")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()
    results = sync_sources(
        cache_dir=args.cache,
        manifest_path=args.manifest,
        offline=args.offline,
        timeout_seconds=args.timeout,
    )
    print(
        json.dumps(
            {
                "cached": sum(result.status == "cached" for result in results),
                "downloaded": sum(result.status == "downloaded" for result in results),
                "files": [asdict(result) for result in results],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
