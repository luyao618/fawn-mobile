import assert from "node:assert/strict";
import test from "node:test";

import { createLogicalSnapshot, LOGICAL_SNAPSHOT_TABLES, serializeLogicalSnapshot } from "../../../src/infrastructure/db/logicalSnapshot.ts";
import { migratedTestDatabase } from "../../support/sqliteTestDatabase.ts";

const timestamp = "2026-07-16T01:00:00.000Z";

test("logical snapshots are deterministic, canonical, and exclude derived/cache/file-layout state", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", "z", "{\"z\":1,\"a\":2}", timestamp);
  await database.runAsync("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", "a", "{\"b\":[2,1],\"a\":true}", timestamp);
  await database.runAsync("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", "prototype-keys", '{"__proto__":{"x":1},"constructor":{"y":2},"prototype":{"z":3}}', timestamp);
  for (const key of ["model_secret_revision_counter", "model_secret_cleanup_pending", "model_secret_cleanup_cursor", "model_secret_reservations"]) {
    await database.runAsync("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", key, "999", timestamp);
  }
  await database.runAsync(
    "INSERT INTO photos(id, storage_path, thumbnail_cache_key, original_filename, mime_type, file_size_bytes, taken_at, import_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "photo-1", "/private/layout/secret.jpg", "cache-secret", "one.jpg", "image/jpeg", 1, timestamp, "committed", timestamp, timestamp,
  );
  await database.runAsync("INSERT INTO diagnostic_events(id, event_name, schema_version, operation_id, result_category, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "event-1", "test", 1, "operation", "success", "{\"secret\":\"diagnostic-sentinel\"}", timestamp);
  await database.runAsync("INSERT INTO model_capabilities(config_fingerprint, probe_version, capability, status, probed_at) VALUES (?, ?, ?, ?, ?)", "cache-fingerprint", 1, "text", "supported", timestamp);

  const first = serializeLogicalSnapshot(await createLogicalSnapshot(database));
  const second = serializeLogicalSnapshot(await createLogicalSnapshot(database));
  assert.equal(first, second);
  assert.deepEqual(Object.keys(JSON.parse(first).tables), [...LOGICAL_SNAPSHOT_TABLES].sort());
  assert.match(first, /\\"a\\":2,\\"z\\":1/);
  const prototypeValue = JSON.parse(JSON.parse(first).tables.app_meta.find((row: { key: string }) => row.key === "prototype-keys").value_json);
  assert.equal(Object.hasOwn(prototypeValue, "__proto__"), true);
  assert.notDeepEqual(prototypeValue, {});
  assert.doesNotMatch(first, /model_secret_revision_counter|model_secret_cleanup_pending|model_secret_cleanup_cursor|model_secret_reservations/);
  assert.doesNotMatch(first, /message_search_fts|sqlite_|diagnostic_events|model_capabilities|storage_path|thumbnail_cache_key/);
  assert.doesNotMatch(first, /private\/layout|cache-secret|diagnostic-sentinel|cache-fingerprint/);
});
