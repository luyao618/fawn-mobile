# Knowledge Build Tools

All tooling is Python standard-library only. The `.yaml` policy files use JSON syntax, which is a
strict YAML 1.2 subset, so validation does not require PyYAML.

## WHO Growth Sources

The tracked WHO manifest pins six official CDN URLs, byte sizes, SHA-256 hashes, source pages,
access date, and separate raw/derived distribution restrictions. The XLSX cache is ignored and is
not repository content.

Populate a missing local cache from the official WHO URLs, or verify an existing cache without
network access:

```bash
python3 tools/knowledge/download_who_sources.py
python3 tools/knowledge/download_who_sources.py --offline
```

The downloader rejects redirects before following them and completes response reading and teardown
before creating any public entry. Each small frozen response is then written into a random `0700`
private staging directory beneath the stable destination parent. The payload is written as `0600`,
flushed and synced, closed, reopened read-only with symlink following disabled, verified against the
frozen exact size and SHA-256, and sealed to `0444` before publication. A single atomic, no-clobber
hard link is the commit point. Existing or ordinarily concurrently appearing cache files remain
byte-for-byte untouched; production never rolls back or otherwise removes a public target. Unit
tests inject fake responses and never contact WHO.

Build the deterministic day-keyed CSV into a local temporary path:

```bash
python3 tools/knowledge/build_who_reference.py --output /tmp/who-growth-reference.csv
```

The builder verifies all six local cache entries and emits exactly 2,196 rows: integer source days
0 through 365 for male/female weight, height, and head circumference. `age_months` is not emitted or
used as an identity, so the exact day-365 boundary remains available. Tests freeze cryptographic
digests for the LMS checkpoints and generated CSV rather than embedding WHO rows.

G020 proves provenance, deterministic LMS extraction, and the day-365 source boundary only.
Percentile conversion, chart-domain calculations, and first-birthday product lookup behavior are
intentionally owned by later Slice 3 work, so G020 does not claim completion of `UT-WHO-003`.
While derived-data repository inclusion is denied, builder output must resolve outside this
repository. The builder uses the same private-stage publication path, revalidates the opened parent
against repository ancestry immediately before the hard-link commit, and produces a read-only
`0444` output. Output creation is exclusive: the builder never overwrites an existing destination.

The hard-link commit guarantee is linearizable for ordinary concurrent writers: before that one
successful link there is no public entry created by the invocation, and at that instant the public
name identifies the complete, verified, read-only staged inode. Private-stage cleanup after commit
is best-effort and cannot revoke success. This is a commit-time guarantee, not permanent pathname
ownership: another process with the same UID and arbitrary filesystem rights can chmod or modify the
inode, enter private staging state, move ancestor directories, or replace the public name after the
commit (including before the command returns).

Run the focused tests against the default cache or a caller-provided cache with the same six
manifest-relative paths:

```bash
python3 -m unittest tools.knowledge.tests.test_who_growth -v
WHO_GROWTH_CACHE=/path/to/who-cache python3 -m unittest tools.knowledge.tests.test_who_growth -v
python3 -m unittest discover -s tools/knowledge/tests -p 'test_*.py'
```

Raw XLSX files and generated CSV/SQLite data must not be committed, published as CI artifacts, or
bundled in releases. See `knowledge/sources/who-growth/RIGHTS.md` for the current rights gate and
attribution draft.
