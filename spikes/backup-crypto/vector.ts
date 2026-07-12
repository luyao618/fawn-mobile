import { canonicalJson } from "./canonicalJson.ts";
import { utf8 } from "./bytes.ts";
import type { FmbkEntry } from "./fmbk.ts";

export const VECTOR_PASSPHRASE = "for-mobile-vector-1";
export const VECTOR_DERIVED_KEY_HEX = "176127f861b5ece1d97ecea67a17e176cc0fe3f4ed378fee6950fef8f50ee561";
export const VECTOR_PLAINTEXT_LENGTH = 383;
export const VECTOR_PLAINTEXT_SHA256 = "97008c5408e25cedaf61233947179163b11f348af8a703015a3a3c0f23798ec6";
export const VECTOR_ARCHIVE_LENGTH = 790;
export const VECTOR_ARCHIVE_SHA256 = "231f64bf4045b430ca0de6c18b215f9a4414293683021528c411ae85d0010231";

export const vectorManifest = {
  album_count: 0,
  app_schema_version: 1,
  backup_format_version: 1,
  dataset_id: "00000000-0000-0000-0000-000000000001",
  exported_at: "2026-07-11T00:00:00.000Z",
  files: [{
    name: "user.db",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    size: 3,
  }],
};

export function vectorEntries(): readonly FmbkEntry[] {
  const file = utf8("abc");
  return [
    { type: "manifest", name: "manifest.json", content: utf8(canonicalJson(vectorManifest)) },
    { type: "file", name: "user.db", content: file },
  ];
}
