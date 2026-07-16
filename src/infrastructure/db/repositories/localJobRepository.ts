import type { QueryRunHandle } from "../../../application/data/ExclusiveTransactionPort.ts";
import { RepositoryConflictError } from "./conflicts.ts";
import { assertCanonicalInstant, assertFreshEventTime } from "./eventTime.ts";
import { canonicalJson, type JsonValue } from "./json.ts";

export type LocalJobStatus = "queued" | "leased" | "succeeded" | "failed" | "cancelled";
type LocalJobRow = Readonly<{
  id: string;
  kind: string;
  dedupe_key: string;
  effect_key: string;
  status: LocalJobStatus;
  payload_json: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}>;

type EffectRow = Readonly<{ job_id: string; result_hash: string | null; committed_at: string }>;

export type EnqueueLocalJobInput = Readonly<{
  id: string;
  kind: string;
  dedupeKey: string;
  effectKey: string;
  payload: JsonValue;
  createdAt: string;
}>;

const JOB_COLUMNS = "id, kind, dedupe_key, effect_key, status, payload_json, attempt_count, lease_owner, lease_expires_at, next_attempt_at, last_error_code, created_at, updated_at";

export class LocalJobRepository {
  private async job(transaction: QueryRunHandle, jobId: string): Promise<LocalJobRow> {
    const [job] = await transaction.query<LocalJobRow>(`SELECT ${JOB_COLUMNS} FROM local_jobs WHERE id = ?`, [jobId]);
    if (!job) throw new RepositoryConflictError("not_found", "local_job", jobId);
    return job;
  }

  async enqueue(transaction: QueryRunHandle, input: EnqueueLocalJobInput): Promise<LocalJobRow> {
    assertCanonicalInstant(input.createdAt);
    const payloadJson = canonicalJson(input.payload);
    const [existing] = await transaction.query<LocalJobRow>(
      `SELECT ${JOB_COLUMNS} FROM local_jobs WHERE id = ? OR (dedupe_key = ? AND status IN ('queued', 'leased')) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
      [input.id, input.dedupeKey, input.id],
    );
    if (existing) {
      if (
        existing.id !== input.id
        || existing.kind !== input.kind
        || existing.dedupe_key !== input.dedupeKey
        || existing.effect_key !== input.effectKey
        || existing.payload_json !== payloadJson
        || existing.created_at !== input.createdAt
      ) throw new RepositoryConflictError("duplicate", "local_job", existing.id, existing.status);
      return existing;
    }
    await transaction.run(
      "INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)",
      [input.id, input.kind, input.dedupeKey, input.effectKey, payloadJson, input.createdAt, input.createdAt],
    );
    return this.job(transaction, input.id);
  }

  async lease(transaction: QueryRunHandle, jobId: string, owner: string, expiresAt: string, updatedAt: string): Promise<LocalJobRow> {
    assertCanonicalInstant(expiresAt);
    assertCanonicalInstant(updatedAt);
    const current = await this.job(transaction, jobId);
    if (current.status === "leased") {
      if (
        current.lease_owner === owner
        && current.lease_expires_at === expiresAt
        && current.next_attempt_at === null
        && current.updated_at === updatedAt
      ) return current;
    }
    assertFreshEventTime(updatedAt, current.updated_at, "local_job", jobId, current.status);
    if (current.status === "leased") throw new RepositoryConflictError("duplicate", "local_job", jobId, current.status);
    if (current.status !== "queued") throw new RepositoryConflictError("illegal_transition", "local_job", jobId, current.status);
    const result = await transaction.run(
      "UPDATE local_jobs SET status = 'leased', attempt_count = attempt_count + 1, lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
      [owner, expiresAt, updatedAt, jobId],
    );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "local_job", jobId, current.status);
    return this.job(transaction, jobId);
  }

  async requeue(transaction: QueryRunHandle, jobId: string, nextAttemptAt: string, errorCode: string, updatedAt: string): Promise<LocalJobRow> {
    assertCanonicalInstant(nextAttemptAt);
    assertCanonicalInstant(updatedAt);
    const current = await this.job(transaction, jobId);
    if (current.status === "queued" && current.attempt_count > 0) {
      if (
        current.lease_owner === null
        && current.lease_expires_at === null
        && current.next_attempt_at === nextAttemptAt
        && current.last_error_code === errorCode
        && current.updated_at === updatedAt
      ) return current;
    }
    assertFreshEventTime(updatedAt, current.updated_at, "local_job", jobId, current.status);
    if (current.status === "queued" && current.attempt_count > 0) throw new RepositoryConflictError("duplicate", "local_job", jobId, current.status);
    return this.fromLease(transaction, current, "queued", updatedAt, [nextAttemptAt, errorCode],
      "UPDATE local_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?, last_error_code = ?, updated_at = ? WHERE id = ? AND status = 'leased'");
  }

  async retry(transaction: QueryRunHandle, jobId: string, nextAttemptAt: string, errorCode: string, updatedAt: string): Promise<LocalJobRow> {
    return this.requeue(transaction, jobId, nextAttemptAt, errorCode, updatedAt);
  }

  async fail(transaction: QueryRunHandle, jobId: string, errorCode: string, updatedAt: string): Promise<LocalJobRow> {
    assertCanonicalInstant(updatedAt);
    const current = await this.job(transaction, jobId);
    if (current.status === "failed") {
      if (
        current.lease_owner === null
        && current.lease_expires_at === null
        && current.last_error_code === errorCode
        && current.updated_at === updatedAt
      ) return current;
    }
    assertFreshEventTime(updatedAt, current.updated_at, "local_job", jobId, current.status);
    if (current.status === "failed") throw new RepositoryConflictError("duplicate", "local_job", jobId, current.status);
    return this.fromLease(transaction, current, "failed", updatedAt, [errorCode],
      "UPDATE local_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?, updated_at = ? WHERE id = ? AND status = 'leased'");
  }

  async cancel(transaction: QueryRunHandle, jobId: string, updatedAt: string): Promise<LocalJobRow> {
    assertCanonicalInstant(updatedAt);
    const current = await this.job(transaction, jobId);
    if (current.status === "cancelled") {
      if (current.lease_owner === null && current.lease_expires_at === null && current.updated_at === updatedAt) return current;
    }
    assertFreshEventTime(updatedAt, current.updated_at, "local_job", jobId, current.status);
    if (current.status === "cancelled") throw new RepositoryConflictError("duplicate", "local_job", jobId, current.status);
    if (current.status !== "queued" && current.status !== "leased") {
      throw new RepositoryConflictError("illegal_transition", "local_job", jobId, current.status);
    }
    const result = await transaction.run(
      "UPDATE local_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'leased')",
      [updatedAt, jobId],
    );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "local_job", jobId, current.status);
    return this.job(transaction, jobId);
  }

  async commitEffect(transaction: QueryRunHandle, jobId: string, resultHash: string | null, committedAt: string): Promise<LocalJobRow> {
    assertCanonicalInstant(committedAt);
    const current = await this.job(transaction, jobId);
    const [effect] = await transaction.query<EffectRow>(
      "SELECT job_id, result_hash, committed_at FROM committed_job_effects WHERE effect_key = ?",
      [current.effect_key],
    );
    if (current.status === "succeeded") {
      if (
        effect?.result_hash === resultHash
        && effect.committed_at === committedAt
        && current.lease_owner === null
        && current.lease_expires_at === null
        && current.updated_at === committedAt
      ) return current;
    }
    assertFreshEventTime(committedAt, current.updated_at, "local_job", jobId, current.status);
    if (current.status === "succeeded") throw new RepositoryConflictError("duplicate", "local_job", jobId, current.status);
    if (current.status !== "leased") throw new RepositoryConflictError("illegal_transition", "local_job", jobId, current.status);
    if (effect && effect.result_hash !== resultHash) {
      throw new RepositoryConflictError("duplicate", "local_job", jobId, current.status);
    }
    if (effect && effect.committed_at !== committedAt) {
      throw new RepositoryConflictError("duplicate", "local_job", jobId, current.status);
    }
    if (!effect) {
      await transaction.run(
        "INSERT INTO committed_job_effects(effect_key, job_id, result_hash, committed_at) VALUES (?, ?, ?, ?)",
        [current.effect_key, jobId, resultHash, committedAt],
      );
    }
    const result = await transaction.run(
      "UPDATE local_jobs SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'leased'",
      [committedAt, jobId],
    );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "local_job", jobId, current.status);
    return this.job(transaction, jobId);
  }

  private async fromLease(
    transaction: QueryRunHandle,
    current: LocalJobRow,
    next: "queued" | "failed",
    updatedAt: string,
    values: readonly (string | null)[],
    sql: string,
  ): Promise<LocalJobRow> {
    if (current.status !== "leased") throw new RepositoryConflictError("illegal_transition", "local_job", current.id, current.status);
    const result = await transaction.run(sql, [...values, updatedAt, current.id]);
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "local_job", current.id, current.status);
    const updated = await this.job(transaction, current.id);
    if (updated.status !== next) throw new RepositoryConflictError("stale_write", "local_job", current.id, updated.status);
    return updated;
  }
}
