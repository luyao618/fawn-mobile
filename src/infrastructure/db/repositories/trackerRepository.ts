import type { QueryRunHandle } from "../../../application/data/ExclusiveTransactionPort.ts";
import type { TrackerStore, TrackerWriter } from "../../../application/tracker/manualTrackerService.ts";
import type {
  TrackerCreateInputByDomain,
  TrackerDeletion,
  TrackerDomain,
  TrackerRecordByDomain,
  TrackerUpdateInputByDomain,
} from "../../../domain/tracker/types.ts";
import {
  assertTrackerListLimit,
  canonicalTrackerInstant,
  normalizePersistedTrackerRecord,
  normalizeTrackerCreateInput,
  normalizeTrackerUpdateInput,
} from "../../../domain/tracker/validation.ts";
import { RepositoryConflictError } from "./conflicts.ts";

type TrackerEntity = `${TrackerDomain}_record`;

type DomainConfig = Readonly<{
  table: string;
  entity: TrackerEntity;
  businessTime: string;
  columns: readonly string[];
  properties: readonly string[];
}>;

const configs = Object.freeze({
  growth: Object.freeze({
    table: "growth_records",
    entity: "growth_record",
    businessTime: "measurement_date",
    columns: Object.freeze([
      "measurement_date", "weight_g", "height_cm", "head_cm",
      "weight_percentile", "height_percentile", "head_percentile", "notes",
    ]),
    properties: Object.freeze([
      "measurementDate", "weightG", "heightCm", "headCm",
      "weightPercentile", "heightPercentile", "headPercentile", "notes",
    ]),
  }),
  feeding: Object.freeze({
    table: "feeding_records",
    entity: "feeding_record",
    businessTime: "feed_time",
    columns: Object.freeze(["feed_time", "feed_type", "amount_ml", "duration_min", "notes"]),
    properties: Object.freeze(["feedTime", "feedType", "amountMl", "durationMin", "notes"]),
  }),
  sleep: Object.freeze({
    table: "sleep_records",
    entity: "sleep_record",
    businessTime: "sleep_start",
    columns: Object.freeze(["sleep_start", "sleep_end", "sleep_type", "night_wakings", "notes"]),
    properties: Object.freeze(["sleepStart", "sleepEnd", "sleepType", "nightWakings", "notes"]),
  }),
  diaper: Object.freeze({
    table: "diaper_records",
    entity: "diaper_record",
    businessTime: "diaper_time",
    columns: Object.freeze(["diaper_time", "diaper_type", "notes"]),
    properties: Object.freeze(["diaperTime", "diaperType", "notes"]),
  }),
  health: Object.freeze({
    table: "health_records",
    entity: "health_record",
    businessTime: "record_date",
    columns: Object.freeze(["record_date", "record_type", "title", "description"]),
    properties: Object.freeze(["recordDate", "recordType", "title", "description"]),
  }),
} satisfies Record<TrackerDomain, DomainConfig>);

type StoredRow = Record<string, string | number | null> & Readonly<{
  id: string;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}>;

function selectColumns(config: DomainConfig): string {
  const business = config.columns.map((column, index) => `${column} AS ${config.properties[index]}`).join(", ");
  return `${business}, source_message_id AS sourceMessageId, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt`;
}

function decode<D extends TrackerDomain>(domain: D, row: StoredRow): TrackerRecordByDomain[D] {
  const config = configs[domain];
  const business = Object.fromEntries(config.properties.map((property) => [property, row[property]]));
  return normalizePersistedTrackerRecord(domain, {
    ...business,
    id: row.id,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as TrackerRecordByDomain[D]);
}

function values(config: DomainConfig, input: Record<string, unknown>): readonly (string | number | null)[] {
  return config.properties.map((property) => input[property] as string | number | null);
}

function sameCreate<D extends TrackerDomain>(
  current: TrackerRecordByDomain[D],
  input: TrackerCreateInputByDomain[D],
): boolean {
  return Object.keys(input).every((field) => (
    Object.is(
      (current as unknown as Record<string, unknown>)[field],
      (input as unknown as Record<string, unknown>)[field],
    )
  ));
}

function nextRevision(domain: TrackerDomain, requested: string, current: string): string {
  canonicalTrackerInstant(domain, "updatedAt", requested);
  canonicalTrackerInstant(domain, "updatedAt", current);
  if (requested > current) return requested;
  return canonicalTrackerInstant(domain, "updatedAt", new Date(new Date(current).getTime() + 1).toISOString());
}

async function classifyZeroChange(
  transaction: QueryRunHandle,
  domain: TrackerDomain,
  id: string,
): Promise<never> {
  const config = configs[domain];
  const rows = await transaction.query<{ updatedAt: string; deletedAt: string | null }>(
    `SELECT updated_at AS updatedAt, deleted_at AS deletedAt FROM ${config.table} WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row || row.deletedAt !== null) {
    throw new RepositoryConflictError("not_found", config.entity, id);
  }
  canonicalTrackerInstant(domain, "updatedAt", row.updatedAt);
  throw new RepositoryConflictError("stale_write", config.entity, id, row.updatedAt);
}

export class TrackerRepository implements TrackerStore, TrackerWriter {
  async getById<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    id: string,
  ): Promise<TrackerRecordByDomain[D] | null> {
    const config = configs[domain];
    const rows = await transaction.query<StoredRow>(
      `SELECT id, ${selectColumns(config)} FROM ${config.table} WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    if (rows.length > 1) throw new Error(`Stored ${config.entity} primary key is corrupt`);
    return rows[0] ? decode(domain, rows[0]) : null;
  }

  async list<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    limit: number,
  ): Promise<readonly TrackerRecordByDomain[D][]> {
    assertTrackerListLimit(limit);
    const config = configs[domain];
    const rows = await transaction.query<StoredRow>(
      `SELECT id, ${selectColumns(config)} FROM ${config.table}
       WHERE deleted_at IS NULL ORDER BY ${config.businessTime} DESC, id DESC LIMIT ?`,
      [limit],
    );
    return Object.freeze(rows.map((row) => decode(domain, row)));
  }

  async create<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    id: string,
    input: TrackerCreateInputByDomain[D],
    now: string,
  ): Promise<TrackerRecordByDomain[D]> {
    const normalized = normalizeTrackerCreateInput(domain, input);
    const createdAt = canonicalTrackerInstant(domain, "createdAt", now);
    const config = configs[domain];
    const existing = await transaction.query<StoredRow>(
      `SELECT id, ${selectColumns(config)} FROM ${config.table} WHERE id = ?`,
      [id],
    );
    if (existing[0]) {
      if (existing[0].deletedAt === null) {
        const current = decode(domain, existing[0]);
        if (sameCreate(current, normalized)) return current;
      }
      throw new RepositoryConflictError("duplicate", config.entity, id);
    }
    const placeholders = Array.from({ length: config.columns.length + 5 }, () => "?").join(", ");
    await transaction.run(
      `INSERT INTO ${config.table}(
        id, ${config.columns.join(", ")}, source_message_id, created_at, updated_at, deleted_at
      ) VALUES (${placeholders})`,
      [
        id,
        ...values(config, normalized as unknown as Record<string, unknown>),
        normalized.sourceMessageId,
        createdAt,
        createdAt,
        null,
      ],
    );
    return normalizePersistedTrackerRecord(domain, {
      ...normalized,
      id,
      createdAt,
      updatedAt: createdAt,
    } as TrackerRecordByDomain[D]);
  }

  async update<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    id: string,
    input: TrackerUpdateInputByDomain[D],
    expectedUpdatedAt: string,
    now: string,
  ): Promise<TrackerRecordByDomain[D]> {
    const normalized = normalizeTrackerUpdateInput(domain, input);
    canonicalTrackerInstant(domain, "expectedUpdatedAt", expectedUpdatedAt);
    const config = configs[domain];
    const current = await this.getById(transaction, domain, id);
    if (!current) return classifyZeroChange(transaction, domain, id);
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new RepositoryConflictError("stale_write", config.entity, id, current.updatedAt);
    }
    const updatedAt = nextRevision(domain, now, current.updatedAt);
    const assignments = config.columns.map((column) => `${column} = ?`).join(", ");
    const result = await transaction.run(
      `UPDATE ${config.table} SET ${assignments}, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
      [
        ...values(config, normalized as unknown as Record<string, unknown>),
        updatedAt,
        id,
        expectedUpdatedAt,
      ],
    );
    if (result.changes !== 1) return classifyZeroChange(transaction, domain, id);
    return normalizePersistedTrackerRecord(domain, {
      ...normalized,
      id,
      sourceMessageId: current.sourceMessageId,
      createdAt: current.createdAt,
      updatedAt,
    } as TrackerRecordByDomain[D]);
  }

  async softDelete(
    transaction: QueryRunHandle,
    domain: TrackerDomain,
    id: string,
    expectedUpdatedAt: string,
    now: string,
  ): Promise<TrackerDeletion> {
    canonicalTrackerInstant(domain, "expectedUpdatedAt", expectedUpdatedAt);
    const config = configs[domain];
    const current = await this.getById(transaction, domain, id);
    if (!current) return classifyZeroChange(transaction, domain, id);
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new RepositoryConflictError("stale_write", config.entity, id, current.updatedAt);
    }
    const deletedAt = nextRevision(domain, now, current.updatedAt);
    const result = await transaction.run(
      `UPDATE ${config.table} SET deleted_at = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
      [deletedAt, deletedAt, id, expectedUpdatedAt],
    );
    if (result.changes !== 1) return classifyZeroChange(transaction, domain, id);
    return Object.freeze({ domain, id, updatedAt: deletedAt, deletedAt });
  }
}
