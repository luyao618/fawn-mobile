# WHO Child Growth Standards: Rights And Attribution

This directory tracks provenance for six WHO Child Growth Standards expanded z-score tables. The
XLSX files are local, ignored build inputs. They and any CSV, SQLite, or other data generated from
them are excluded from this project's software license and must not be committed, attached to CI
artifacts, published, or bundled in a release without written WHO permission or legal approval.

## Current Boundary

- Local download and processing for public-health purposes is supported by the WHO dataset terms.
- The six official download pages do not identify a file-specific license, and the XLSX files contain
  no embedded license, dataset year, or attribution statement.
- Public-source hosting, format conversion, mobile bundling, downstream redistribution, and any
  commercial use remain unapproved. WHO expressly requires permission for commercial uses.
- The WHO emblem must not be used, and the project must not imply WHO endorsement.

This is a conservative engineering gate, not legal advice. Keep both raw inputs and derived outputs
out of repository history and releases until the required permission is recorded and reviewed.
While derived-data repository inclusion is denied, the builder rejects every output path that
resolves anywhere inside this repository; local generation must target an external directory.
Tracked conformance tests contain only provenance, sizes, cryptographic hashes, and row topology;
they do not embed WHO LMS rows or a generated reference dataset.

## Attribution Draft

Use the following only after WHO confirms the missing dataset year and any required country
acknowledgement:

```text
Source: World Health Organization (WHO), "WHO Child Growth Standards",
[dataset year to be confirmed], accessed 11 July 2026,
[official indicator page and file URL].
Derived format produced by Fawn; not created or endorsed by WHO.
WHO data are excluded from the project's software license and remain subject to WHO's terms.
```

## Official Policy Evidence

Accessed 11 July 2026:

- Dataset terms: https://www.who.int/about/policies/publishing/data-policy/terms-and-conditions
- Copyright and licensing: https://www.who.int/about/policies/publishing/copyright
- Website terms: https://www.who.int/about/policies/terms-of-use
- Permissions: https://www.who.int/about/policies/publishing/permissions

Before distribution, request permission that expressly covers public-source hosting, CSV/SQLite
conversion, mobile bundling, downstream redistribution, and the intended commercial or
noncommercial context.
