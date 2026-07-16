import type { QueryRunHandle } from "../../application/data/ExclusiveTransactionPort.ts";
import { canonicalJson } from "./repositories/json.ts";

export const LOGICAL_SNAPSHOT_TABLES = Object.freeze([
  "app_meta",
  "baby_profile",
  "committed_job_effects",
  "conversation_summaries",
  "conversations",
  "diaper_records",
  "feeding_records",
  "growth_records",
  "health_records",
  "local_jobs",
  "memory_items",
  "messages",
  "model_config",
  "pending_agent_tasks",
  "photo_tags",
  "photos",
  "sleep_records",
  "chat_turns",
] as const);

const OMITTED_COLUMNS = new Set(["storage_path", "thumbnail_cache_key"]);
const INTERNAL_APP_META_KEYS = Object.freeze([
  "model_secret_revision_counter",
  "model_secret_cleanup_pending",
  "model_secret_cleanup_cursor",
  "model_secret_reservations",
]);

type TableInfoRow = Readonly<{ name: string; pk: number }>;
type SnapshotValue = string | number | null;
export type LogicalSnapshot = Readonly<{
  format: "for-mobile-logical-snapshot-v1";
  tables: Readonly<Record<string, readonly Readonly<Record<string, SnapshotValue>>[]>>;
}>;

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeValue(column: string, value: unknown): SnapshotValue {
  if (value === null || typeof value === "string" || typeof value === "number") {
    if (typeof value === "string" && column.endsWith("_json")) {
      try {
        return canonicalJson(JSON.parse(value));
      } catch {
        throw new Error(`Logical snapshot found invalid canonical JSON in ${column}`);
      }
    }
    return value;
  }
  throw new Error(`Logical snapshot does not support the value type in ${column}`);
}

export async function createLogicalSnapshot(database: QueryRunHandle): Promise<LogicalSnapshot> {
  const tables: Record<string, readonly Readonly<Record<string, SnapshotValue>>[]> = {};
  for (const table of LOGICAL_SNAPSHOT_TABLES) {
    const columns = (await database.query<TableInfoRow>(`PRAGMA table_info(${quotedIdentifier(table)})`))
      .filter((column) => !OMITTED_COLUMNS.has(column.name));
    if (columns.length === 0) throw new Error(`Logical snapshot allowlisted table is missing: ${table}`);
    const orderedColumns = [...columns].sort((left, right) => left.name.localeCompare(right.name));
    const primaryKey = [...columns].filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
    const rowOrder = primaryKey.length > 0 ? primaryKey : orderedColumns;
    const selection = orderedColumns.map((column) => quotedIdentifier(column.name)).join(", ");
    const ordering = rowOrder.map((column) => quotedIdentifier(column.name)).join(", ");
    const rows = await database.query<Record<string, unknown>>(
      table === "app_meta"
        ? `SELECT ${selection} FROM ${quotedIdentifier(table)} WHERE key NOT IN (${INTERNAL_APP_META_KEYS.map(() => "?").join(", ")}) ORDER BY ${ordering}`
        : `SELECT ${selection} FROM ${quotedIdentifier(table)} ORDER BY ${ordering}`,
      table === "app_meta" ? INTERNAL_APP_META_KEYS : [],
    );
    tables[table] = Object.freeze(rows.map((row) => Object.freeze(Object.fromEntries(
      orderedColumns.map((column) => [column.name, normalizeValue(column.name, row[column.name])]),
    ))));
  }
  return Object.freeze({
    format: "for-mobile-logical-snapshot-v1",
    tables: Object.freeze(Object.fromEntries(Object.entries(tables).sort(([left], [right]) => left.localeCompare(right)))),
  });
}

export function serializeLogicalSnapshot(snapshot: LogicalSnapshot): string {
  return canonicalJson(snapshot);
}
