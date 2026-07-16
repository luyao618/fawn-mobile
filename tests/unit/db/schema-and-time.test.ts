import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { MIGRATION_1_SQL } from "../../../src/infrastructure/db/migrations/migration1.ts";
import {
  applyUserDatabaseMigrations,
  type MigrationDatabase,
  USER_DATABASE_MIGRATIONS,
} from "../../../src/infrastructure/db/migrations/index.ts";
import { sha256 } from "../../../src/infrastructure/db/migrations/sha256.ts";
import {
  configureUserDatabase,
  USER_DATABASE_BUSY_TIMEOUT_MS,
  USER_DATABASE_NAME,
  USER_DATABASE_OPEN_OPTIONS,
  type UserDatabaseConnection,
} from "../../../src/infrastructure/db/initializeDatabase.ts";

function toSqliteParams(params: readonly unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (
      value === null
      || typeof value === "number"
      || typeof value === "bigint"
      || typeof value === "string"
      || ArrayBuffer.isView(value)
    ) {
      return value as SQLInputValue;
    }
    throw new TypeError(`Unsupported SQLite test parameter: ${typeof value}`);
  });
}

class RealDatabase implements MigrationDatabase, UserDatabaseConnection {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
  }

  async closeAsync(): Promise<void> {
    this.raw.close();
  }

  async execAsync(source: string): Promise<void> {
    this.raw.exec(source);
  }

  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    return this.raw.prepare(source).all(...toSqliteParams(params)) as T[];
  }

  async runAsync(source: string, ...params: unknown[]): Promise<unknown> {
    return this.raw.prepare(source).run(...toSqliteParams(params));
  }
}

const fixedNow = () => "2026-07-16T00:00:00.000Z";

async function migratedDatabase(path = ":memory:"): Promise<RealDatabase> {
  const database = new RealDatabase(path);
  if (path === ":memory:") {
    await database.execAsync(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
  } else {
    await configureUserDatabase(database);
  }
  await applyUserDatabaseMigrations(database, USER_DATABASE_MIGRATIONS, fixedNow);
  return database;
}

async function assertForeignKeyFailure(database: RealDatabase, sql: string, ...params: unknown[]): Promise<void> {
  await assert.rejects(database.runAsync(sql, ...params), /FOREIGN KEY constraint failed/);
}

async function count(database: RealDatabase, source: string, ...params: unknown[]): Promise<number> {
  const [row] = await database.getAllAsync<{ total: number }>(source, ...params);
  return row!.total;
}

test("real SQLite enables foreign keys, WAL, and the bounded busy timeout", async (context) => {
  assert.equal(USER_DATABASE_OPEN_OPTIONS.finalizeUnusedStatementsBeforeClosing, false);
  const directory = mkdtempSync(join(tmpdir(), "fawn-user-db-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new RealDatabase(join(directory, USER_DATABASE_NAME));
  context.after(() => database.closeAsync());
  await configureUserDatabase(database);

  assert.equal((await database.getAllAsync<{ foreign_keys: number }>("PRAGMA foreign_keys"))[0]!.foreign_keys, 1);
  assert.equal((await database.getAllAsync<{ journal_mode: string }>("PRAGMA journal_mode"))[0]!.journal_mode, "wal");
  assert.equal((await database.getAllAsync<{ timeout: number }>("PRAGMA busy_timeout"))[0]!.timeout, USER_DATABASE_BUSY_TIMEOUT_MS);
});

test("SHA-256 covers empty, Unicode, and multi-block vectors and migration 1 matches its frozen hash", () => {
  const vectors = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["你好，世界🌍", "169bff907bb53e1729d762bdd0a854735201cbeff533aa9712b97d93be364d85"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    ["a".repeat(1_000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"],
  ] as const;
  for (const [input, expected] of vectors) assert.equal(sha256(input), expected);
  assert.equal(sha256(MIGRATION_1_SQL), USER_DATABASE_MIGRATIONS[0]!.sha256);
});

test("migration 1 creates every frozen table, index, trigger, and FTS object", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  const objects = await database.getAllAsync<{ type: string; name: string }>(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  );
  const byType = (type: string) => new Set(objects.filter((object) => object.type === type).map((object) => object.name));

  const tables = byType("table");
  for (const name of [
    "schema_migrations", "app_meta", "baby_profile", "conversations", "chat_turns", "messages",
    "message_search_fts", "growth_records", "feeding_records", "sleep_records", "diaper_records",
    "health_records", "pending_agent_tasks", "local_jobs", "committed_job_effects", "memory_items",
    "conversation_summaries", "model_config", "model_capabilities", "photos", "photo_tags", "diagnostic_events",
  ]) {
    assert(tables.has(name), `missing table ${name}`);
  }

  const indexes = byType("index");
  for (const name of [
    "uq_messages_one_user_per_turn", "uq_messages_one_assistant_per_turn", "idx_growth_records_date",
    "idx_feeding_records_time", "idx_sleep_records_start", "idx_diaper_records_time", "idx_health_records_date",
    "idx_messages_conversation_created", "uq_pending_agent_task_active", "uq_local_job_active_dedupe",
    "idx_memory_items_scope_status", "idx_local_jobs_schedule", "idx_diagnostic_events_created", "idx_photos_taken_deleted",
  ]) {
    assert(indexes.has(name), `missing index ${name}`);
  }

  assert.deepEqual(byType("trigger"), new Set(["messages_fts_insert", "messages_fts_delete", "messages_fts_update"]));
});

test("all three composite foreign keys reject cross-conversation ownership", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  const timestamp = fixedNow();
  await database.runAsync(
    "INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    "c1", timestamp, timestamp, timestamp, "c2", timestamp, timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?), (?, ?, ?, 'queued', ?, ?)",
    "t1", "c1", "key-1", timestamp, timestamp, "t2", "c2", "key-2", timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES (?, ?, ?, 'user', 0, ?, 'text', ?)",
    "m1", "c1", "t1", "hello", timestamp,
  );

  await assertForeignKeyFailure(
    database,
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES (?, ?, ?, 'tool', 1, ?, 'text', ?)",
    "m-cross", "c2", "t1", "cross", timestamp,
  );
  await assertForeignKeyFailure(
    database,
    "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'tracker_create', 'pending', 'low', '{}', '[]', ?, ?, ?)",
    "p-cross", "c2", "t1", timestamp, timestamp, timestamp,
  );
  await assertForeignKeyFailure(
    database,
    "INSERT INTO conversation_summaries(id, conversation_id, through_message_id, summary, created_at) VALUES (?, ?, ?, ?, ?)",
    "s-cross", "c2", "m1", "cross", timestamp,
  );
});

test("FTS external-content triggers synchronize insert, content update, and delete", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  const timestamp = fixedNow();
  await database.runAsync(
    "INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?)",
    "c1", timestamp, timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
    "t1", "c1", "key-1", timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES (?, ?, ?, 'user', 0, ?, 'text', ?)",
    "m1", "c1", "t1", "alpha token", timestamp,
  );

  assert.equal(await count(database, "SELECT count(*) AS total FROM message_search_fts WHERE message_search_fts MATCH ?", "alpha"), 1);
  await database.runAsync("UPDATE messages SET content = ? WHERE id = ?", "beta token", "m1");
  assert.equal(await count(database, "SELECT count(*) AS total FROM message_search_fts WHERE message_search_fts MATCH ?", "alpha"), 0);
  assert.equal(await count(database, "SELECT count(*) AS total FROM message_search_fts WHERE message_search_fts MATCH ?", "beta"), 1);
  await database.runAsync("DELETE FROM messages WHERE id = ?", "m1");
  assert.equal(await count(database, "SELECT count(*) AS total FROM message_search_fts WHERE message_search_fts MATCH ?", "beta"), 0);
});


test("pragma configuration fails closed when SQLite does not retain every required value", async () => {
  const database = {
    async closeAsync() {},
    async execAsync() {},
    async getAllAsync<T>(source: string) {
      if (source === "PRAGMA foreign_keys") return [{ foreign_keys: 1 }] as T[];
      if (source === "PRAGMA journal_mode") return [{ journal_mode: "delete" }] as T[];
      return [{ timeout: USER_DATABASE_BUSY_TIMEOUT_MS }] as T[];
    },
    async runAsync() {},
  };

  await assert.rejects(configureUserDatabase(database), /pragma verification failed/);
});

test("every migration-1 CHECK constraint rejects a hostile row", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  const timestamp = fixedNow();
  await database.runAsync(
    "INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('c-check', ?, ?, ?)",
    timestamp, timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('t-check', 'c-check', 'key-check', 'queued', ?, ?)",
    timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('m-check', 'c-check', 't-check', 'tool', 0, 'seed', 'text', ?)",
    timestamp,
  );
  await database.runAsync(
    "INSERT INTO photos(id, storage_path, original_filename, mime_type, file_size_bytes, taken_at, import_state, created_at, updated_at) VALUES ('photo-check', '/photo-check', 'photo.jpg', 'image/jpeg', 1, ?, 'staging', ?, ?)",
    timestamp, timestamp, timestamp,
  );

  const invalidStatements = [
    "INSERT INTO baby_profile(singleton_id, created_at, updated_at) VALUES (2, 'now', 'now')",
    "INSERT INTO baby_profile(singleton_id, sex, created_at, updated_at) VALUES (1, 'unknown', 'now', 'now')",
    "INSERT INTO baby_profile(singleton_id, is_premature, created_at, updated_at) VALUES (1, 2, 'now', 'now')",
    "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('t-status', 'c-check', 'key-status', 'unknown', 'now', 'now')",
    "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, retry_count, requested_at, updated_at) VALUES ('t-retry', 'c-check', 'key-retry', 'queued', 101, 'now', 'now')",
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('m-role', 'c-check', 't-check', 'system', 1, 'x', 'text', 'now')",
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('m-type', 'c-check', 't-check', 'tool', 1, 'x', 'audio', 'now')",
    "INSERT INTO growth_records(id, measurement_date, weight_g, created_at, updated_at) VALUES ('g-weight', 'now', 99, 'now', 'now')",
    "INSERT INTO growth_records(id, measurement_date, height_cm, created_at, updated_at) VALUES ('g-height', 'now', 9, 'now', 'now')",
    "INSERT INTO growth_records(id, measurement_date, head_cm, created_at, updated_at) VALUES ('g-head', 'now', 101, 'now', 'now')",
    "INSERT INTO growth_records(id, measurement_date, weight_g, weight_percentile, created_at, updated_at) VALUES ('g-wp', 'now', 100, -1, 'now', 'now')",
    "INSERT INTO growth_records(id, measurement_date, height_cm, height_percentile, created_at, updated_at) VALUES ('g-hp', 'now', 10, 101, 'now', 'now')",
    "INSERT INTO growth_records(id, measurement_date, head_cm, head_percentile, created_at, updated_at) VALUES ('g-headp', 'now', 10, 101, 'now', 'now')",
    "INSERT INTO growth_records(id, measurement_date, created_at, updated_at) VALUES ('g-empty', 'now', 'now', 'now')",
    "INSERT INTO feeding_records(id, feed_time, feed_type, created_at, updated_at) VALUES ('f-type', 'now', 'tube', 'now', 'now')",
    "INSERT INTO feeding_records(id, feed_time, feed_type, amount_ml, created_at, updated_at) VALUES ('f-amount', 'now', 'solid', 2001, 'now', 'now')",
    "INSERT INTO feeding_records(id, feed_time, feed_type, duration_min, created_at, updated_at) VALUES ('f-duration', 'now', 'solid', 1441, 'now', 'now')",
    "INSERT INTO feeding_records(id, feed_time, feed_type, created_at, updated_at) VALUES ('f-formula', 'now', 'formula', 'now', 'now')",
    "INSERT INTO feeding_records(id, feed_time, feed_type, created_at, updated_at) VALUES ('f-breast', 'now', 'breast', 'now', 'now')",
    "INSERT INTO sleep_records(id, sleep_start, sleep_type, created_at, updated_at) VALUES ('s-type', 'now', 'day', 'now', 'now')",
    "INSERT INTO sleep_records(id, sleep_start, sleep_type, night_wakings, created_at, updated_at) VALUES ('s-wakings', 'now', 'night', 101, 'now', 'now')",
    "INSERT INTO sleep_records(id, sleep_start, sleep_type, night_wakings, created_at, updated_at) VALUES ('s-nap', 'now', 'nap', 1, 'now', 'now')",
    "INSERT INTO diaper_records(id, diaper_time, diaper_type, created_at, updated_at) VALUES ('d-type', 'now', 'dry', 'now', 'now')",
    "INSERT INTO health_records(id, record_date, record_type, title, created_at, updated_at) VALUES ('h-type', 'now', 'other', 'title', 'now', 'now')",
    "INSERT INTO health_records(id, record_date, record_type, title, created_at, updated_at) VALUES ('h-title', 'now', 'checkup', '   ', 'now', 'now')",
    "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES ('p-type', 'c-check', 't-check', 'unknown', 'completed', 'low', '{}', '[]', 'now', 'now', 'now')",
    "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES ('p-status', 'c-check', 't-check', 'tracker_create', 'unknown', 'low', '{}', '[]', 'now', 'now', 'now')",
    "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES ('p-risk', 'c-check', 't-check', 'tracker_create', 'completed', 'critical', '{}', '[]', 'now', 'now', 'now')",
    "INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, created_at, updated_at) VALUES ('j-status', 'kind', 'd-status', 'e-status', 'unknown', '{}', 'now', 'now')",
    "INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, attempt_count, created_at, updated_at) VALUES ('j-attempt', 'kind', 'd-attempt', 'e-attempt', 'queued', '{}', 1001, 'now', 'now')",
    "INSERT INTO memory_items(id, scope, status, content, confidence, created_at, updated_at) VALUES ('mem-scope', 'world', 'active', 'x', 1, 'now', 'now')",
    "INSERT INTO memory_items(id, scope, status, content, confidence, created_at, updated_at) VALUES ('mem-status', 'baby', 'hidden', 'x', 1, 'now', 'now')",
    "INSERT INTO memory_items(id, scope, status, content, confidence, created_at, updated_at) VALUES ('mem-confidence', 'baby', 'active', 'x', 1.1, 'now', 'now')",
    "INSERT INTO model_config(singleton_id, display_name, base_url, chat_path, model_id, auth_mode, header_names_json, updated_at) VALUES (2, 'x', 'https://x', '/chat', 'm', 'bearer', '[]', 'now')",
    "INSERT INTO model_config(singleton_id, display_name, base_url, chat_path, model_id, auth_mode, header_names_json, updated_at) VALUES (1, 'x', 'https://x', '/chat', 'm', 'none', '[]', 'now')",
    "INSERT INTO model_capabilities(config_fingerprint, probe_version, capability, status, probed_at) VALUES ('f', 1, 'chat', 'unknown', 'now')",
    "INSERT INTO photos(id, storage_path, original_filename, mime_type, file_size_bytes, taken_at, import_state, created_at, updated_at) VALUES ('photo-state', '/photo-state', 'x', 'image/jpeg', 1, 'now', 'unknown', 'now', 'now')",
    "INSERT INTO photo_tags(id, photo_id, tag_type, tag_value, created_at) VALUES ('tag-type', 'photo-check', 'other', 'x', 'now')",
    "INSERT INTO photo_tags(id, photo_id, tag_type, tag_value, is_confirmed, created_at) VALUES ('tag-confirmed', 'photo-check', 'scene', 'x', 2, 'now')",
  ] as const;

  assert.equal(invalidStatements.length, 39);
  for (const source of invalidStatements) {
    await assert.rejects(database.runAsync(source), /CHECK constraint failed/, source);
  }
});

test("all four partial unique indexes reject duplicate active rows", async (context) => {
  const database = await migratedDatabase();
  context.after(() => database.closeAsync());
  const timestamp = fixedNow();
  await database.runAsync(
    "INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('c-unique', ?, ?, ?)",
    timestamp, timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('t-unique', 'c-unique', 'key-unique', 'queued', ?, ?)",
    timestamp, timestamp,
  );
  await database.runAsync(
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('user-1', 'c-unique', 't-unique', 'user', 0, 'x', 'text', ?)",
    timestamp,
  );
  await assert.rejects(
    database.runAsync("INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('user-2', 'c-unique', 't-unique', 'user', 1, 'x', 'text', ?)", timestamp),
    /UNIQUE constraint failed/,
  );
  await database.runAsync(
    "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('assistant-1', 'c-unique', 't-unique', 'assistant', 0, 'x', 'text', ?)",
    timestamp,
  );
  await assert.rejects(
    database.runAsync("INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES ('assistant-2', 'c-unique', 't-unique', 'assistant', 1, 'x', 'text', ?)", timestamp),
    /UNIQUE constraint failed/,
  );

  await database.runAsync(
    "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES ('pending-1', 'c-unique', 't-unique', 'tracker_create', 'pending', 'low', '{}', '[]', ?, ?, ?)",
    timestamp, timestamp, timestamp,
  );
  await assert.rejects(
    database.runAsync("INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES ('pending-2', 'c-unique', 't-unique', 'tracker_update', 'awaiting_confirmation', 'medium', '{}', '[]', ?, ?, ?)", timestamp, timestamp, timestamp),
    /UNIQUE constraint failed/,
  );
  await database.runAsync(
    "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES ('pending-complete', 'c-unique', 't-unique', 'tracker_update', 'completed', 'medium', '{}', '[]', ?, ?, ?)",
    timestamp, timestamp, timestamp,
  );

  await database.runAsync(
    "INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, created_at, updated_at) VALUES ('job-1', 'kind', 'dedupe', 'effect-1', 'queued', '{}', ?, ?)",
    timestamp, timestamp,
  );
  await assert.rejects(
    database.runAsync("INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, created_at, updated_at) VALUES ('job-2', 'kind', 'dedupe', 'effect-2', 'leased', '{}', ?, ?)", timestamp, timestamp),
    /UNIQUE constraint failed/,
  );
  await database.runAsync(
    "INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, created_at, updated_at) VALUES ('job-succeeded', 'kind', 'dedupe', 'effect-3', 'succeeded', '{}', ?, ?)",
    timestamp, timestamp,
  );
});
