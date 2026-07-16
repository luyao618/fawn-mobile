import type { QueryRunHandle } from "../../../application/data/ExclusiveTransactionPort.ts";
import { sha256 } from "../migrations/sha256.ts";
import { RepositoryConflictError } from "./conflicts.ts";
import { assertCanonicalInstant } from "./eventTime.ts";
import { canonicalJson, type JsonValue } from "./json.ts";

export type PendingTaskStatus = "pending" | "awaiting_confirmation" | "completed" | "cancelled" | "expired";
export type PendingTaskEvent =
  | "supplement_incomplete"
  | "supplement_complete_high_risk"
  | "supplement_complete_low_risk"
  | "cancel"
  | "expire"
  | "confirm_success"
  | "correction_incomplete";

type PendingTaskRow = Readonly<{
  id: string;
  conversation_id: string;
  source_turn_id: string;
  task_type: string;
  status: PendingTaskStatus;
  risk_level: string;
  payload_json: string;
  missing_slots_json: string;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type CreatePendingTaskInput = Readonly<{
  id: string;
  conversationId: string;
  sourceTurnId: string;
  taskType: "tracker_create" | "tracker_update" | "tracker_delete" | "baby_profile_update";
  status: "pending" | "awaiting_confirmation";
  riskLevel: "low" | "medium" | "high";
  payload: JsonValue;
  missingSlots: readonly string[];
  expiresAt: string;
  createdAt: string;
}>;

export type PendingTaskContent = Readonly<{ payload: JsonValue; missingSlots: readonly string[] }>;

const LEGAL_TRANSITIONS: Readonly<Record<"pending" | "awaiting_confirmation", Partial<Record<PendingTaskEvent, PendingTaskStatus>>>> = {
  pending: {
    supplement_incomplete: "pending",
    supplement_complete_high_risk: "awaiting_confirmation",
    supplement_complete_low_risk: "completed",
    cancel: "cancelled",
    expire: "expired",
  },
  awaiting_confirmation: {
    confirm_success: "completed",
    correction_incomplete: "pending",
    cancel: "cancelled",
    expire: "expired",
  },
};

const CONTENT_EVENTS = new Set<PendingTaskEvent>([
  "supplement_incomplete",
  "supplement_complete_high_risk",
  "supplement_complete_low_risk",
  "correction_incomplete",
]);
const REPLAY_KEY_PREFIX = "pending_task_event_fingerprint:";

type MetaRow = Readonly<{ value_json: string }>;

function serializedContent(content: PendingTaskContent): readonly [string, string] {
  return [canonicalJson(content.payload), canonicalJson(content.missingSlots)];
}

function eventFingerprint(event: PendingTaskEvent, updatedAt: string, content?: readonly [string, string]): string {
  return sha256(canonicalJson({ event, updatedAt, content: content ?? null }));
}

export class PendingTaskRepository {
  private async task(transaction: QueryRunHandle, taskId: string): Promise<PendingTaskRow> {
    const [task] = await transaction.query<PendingTaskRow>(
      "SELECT id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, completed_at, created_at, updated_at FROM pending_agent_tasks WHERE id = ?",
      [taskId],
    );
    if (!task) throw new RepositoryConflictError("not_found", "pending_agent_task", taskId);
    return task;
  }

  async create(transaction: QueryRunHandle, input: CreatePendingTaskInput): Promise<PendingTaskRow> {
    assertCanonicalInstant(input.createdAt);
    assertCanonicalInstant(input.expiresAt);
    if (input.expiresAt <= input.createdAt) throw new TypeError("Pending task expiry must be after creation");
    const payloadJson = canonicalJson(input.payload);
    const missingSlotsJson = canonicalJson(input.missingSlots);
    const [existing] = await transaction.query<PendingTaskRow>(
      "SELECT id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, completed_at, created_at, updated_at FROM pending_agent_tasks WHERE id = ?",
      [input.id],
    );
    if (existing) {
      if (
        existing.conversation_id !== input.conversationId
        || existing.source_turn_id !== input.sourceTurnId
        || existing.task_type !== input.taskType
        || existing.status !== input.status
        || existing.risk_level !== input.riskLevel
        || existing.payload_json !== payloadJson
        || existing.missing_slots_json !== missingSlotsJson
        || existing.expires_at !== input.expiresAt
        || existing.created_at !== input.createdAt
      ) throw new RepositoryConflictError("duplicate", "pending_agent_task", input.id, existing.status);
      return existing;
    }
    await transaction.run(
      "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [input.id, input.conversationId, input.sourceTurnId, input.taskType, input.status, input.riskLevel, payloadJson, missingSlotsJson, input.expiresAt, input.createdAt, input.createdAt],
    );
    return this.task(transaction, input.id);
  }

  async transition(
    transaction: QueryRunHandle,
    taskId: string,
    event: PendingTaskEvent,
    updatedAt: string,
    content?: PendingTaskContent,
  ): Promise<PendingTaskRow> {
    assertCanonicalInstant(updatedAt);
    const current = await this.task(transaction, taskId);
    if (CONTENT_EVENTS.has(event) !== (content !== undefined)) {
      throw new RepositoryConflictError("illegal_transition", "pending_agent_task", taskId, current.status);
    }
    const expectedContent = content ? serializedContent(content) : undefined;
    const fingerprint = eventFingerprint(event, updatedAt, expectedContent);
    const replayKey = `${REPLAY_KEY_PREFIX}${taskId}`;
    const replayTargets: Partial<Record<PendingTaskEvent, PendingTaskStatus>> = {
      supplement_incomplete: "pending",
      supplement_complete_high_risk: "awaiting_confirmation",
      supplement_complete_low_risk: "completed",
      correction_incomplete: "pending",
      confirm_success: "completed",
      cancel: "cancelled",
      expire: "expired",
    };
    const [storedReplay] = await transaction.query<MetaRow>("SELECT value_json FROM app_meta WHERE key = ?", [replayKey]);
    if (current.status === replayTargets[event] && current.updated_at === updatedAt && storedReplay) {
      if (
        storedReplay.value_json === JSON.stringify(fingerprint)
        && (!expectedContent || (current.payload_json === expectedContent[0] && current.missing_slots_json === expectedContent[1]))
      ) return current;
      throw new RepositoryConflictError("duplicate", "pending_agent_task", taskId, current.status);
    }
    if (updatedAt <= current.updated_at) {
      throw new RepositoryConflictError(updatedAt === current.updated_at ? "duplicate" : "stale_write", "pending_agent_task", taskId, current.status);
    }
    if (current.status !== "pending" && current.status !== "awaiting_confirmation") {
      throw new RepositoryConflictError("illegal_transition", "pending_agent_task", taskId, current.status);
    }
    const next = LEGAL_TRANSITIONS[current.status][event];
    if (!next) throw new RepositoryConflictError("illegal_transition", "pending_agent_task", taskId, current.status);
    const completedAt = next === "completed" ? updatedAt : null;
    const result = expectedContent
      ? await transaction.run(
        "UPDATE pending_agent_tasks SET status = ?, payload_json = ?, missing_slots_json = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?",
        [next, expectedContent[0], expectedContent[1], completedAt, updatedAt, taskId, current.status],
      )
      : await transaction.run(
        "UPDATE pending_agent_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?",
        [next, completedAt, updatedAt, taskId, current.status],
      );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "pending_agent_task", taskId, current.status);
    await transaction.run(
      `INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [replayKey, JSON.stringify(fingerprint), updatedAt],
    );
    return this.task(transaction, taskId);
  }
}
