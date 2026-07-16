import type { QueryRunHandle } from "../../../application/data/ExclusiveTransactionPort.ts";
import { RepositoryConflictError } from "./conflicts.ts";
import { assertCanonicalInstant, assertFreshEventTime } from "./eventTime.ts";
import { canonicalJson, type JsonValue } from "./json.ts";

export type ChatTurnStatus = "queued" | "generating" | "completed" | "failed" | "cancelled";

type TurnRow = Readonly<{
  id: string;
  conversation_id: string;
  idempotency_key: string;
  status: ChatTurnStatus;
  retry_count: number;
  error_code: string | null;
  requested_at: string;
  completed_at: string | null;
  updated_at: string;
}>;

type MessageRow = Readonly<{
  id: string;
  conversation_id: string;
  turn_id: string;
  role: "user" | "assistant";
  ordinal: number;
  content: string;
  message_type: string;
  metadata_json: string | null;
  created_at: string;
}>;

export type EnqueueTurnInput = Readonly<{
  turnId: string;
  conversationId: string;
  idempotencyKey: string;
  userMessageId: string;
  content: string;
  requestedAt: string;
  metadata?: JsonValue;
}>;

export type AssistantCompletionInput = Readonly<{
  turnId: string;
  messageId: string;
  content: string;
  completedAt: string;
  metadata?: JsonValue;
}>;

function metadataJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : canonicalJson(value);
}

export class TurnMessageRepository {
  private async turn(transaction: QueryRunHandle, turnId: string): Promise<TurnRow> {
    const [turn] = await transaction.query<TurnRow>(
      "SELECT id, conversation_id, idempotency_key, status, retry_count, error_code, requested_at, completed_at, updated_at FROM chat_turns WHERE id = ?",
      [turnId],
    );
    if (!turn) throw new RepositoryConflictError("not_found", "chat_turn", turnId);
    return turn;
  }

  async enqueue(transaction: QueryRunHandle, input: EnqueueTurnInput): Promise<TurnRow> {
    assertCanonicalInstant(input.requestedAt);
    const [existing] = await transaction.query<TurnRow>(
      "SELECT id, conversation_id, idempotency_key, status, retry_count, error_code, requested_at, completed_at, updated_at FROM chat_turns WHERE idempotency_key = ? OR id = ?",
      [input.idempotencyKey, input.turnId],
    );
    if (existing) {
      const [message] = await transaction.query<MessageRow>(
        "SELECT id, conversation_id, turn_id, role, ordinal, content, message_type, metadata_json, created_at FROM messages WHERE turn_id = ? AND role = 'user'",
        [existing.id],
      );
      if (
        existing.id !== input.turnId
        || existing.conversation_id !== input.conversationId
        || existing.idempotency_key !== input.idempotencyKey
        || existing.requested_at !== input.requestedAt
        || message?.id !== input.userMessageId
        || message.conversation_id !== input.conversationId
        || message.turn_id !== input.turnId
        || message.role !== "user"
        || message.ordinal !== 0
        || message.content !== input.content
        || message.message_type !== "text"
        || message.metadata_json !== metadataJson(input.metadata)
        || message.created_at !== input.requestedAt
      ) {
        throw new RepositoryConflictError("duplicate", "chat_turn", existing.id, existing.status);
      }
      return existing;
    }
    const serializedMetadata = metadataJson(input.metadata);
    await transaction.run(
      "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
      [input.turnId, input.conversationId, input.idempotencyKey, input.requestedAt, input.requestedAt],
    );
    await transaction.run(
      "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, metadata_json, created_at) VALUES (?, ?, ?, 'user', 0, ?, 'text', ?, ?)",
      [input.userMessageId, input.conversationId, input.turnId, input.content, serializedMetadata, input.requestedAt],
    );
    return this.turn(transaction, input.turnId);
  }

  async start(transaction: QueryRunHandle, turnId: string, updatedAt: string): Promise<TurnRow> {
    assertCanonicalInstant(updatedAt);
    const current = await this.turn(transaction, turnId);
    if (current.status === "generating" && current.updated_at === updatedAt) return current;
    return this.transition(transaction, current, ["queued"], "generating", updatedAt);
  }

  async retry(transaction: QueryRunHandle, turnId: string, updatedAt: string): Promise<TurnRow> {
    assertCanonicalInstant(updatedAt);
    const current = await this.turn(transaction, turnId);
    if (current.status === "queued" && current.retry_count > 0 && current.error_code === null && current.completed_at === null) {
      if (current.updated_at === updatedAt) return current;
    }
    assertFreshEventTime(updatedAt, current.updated_at, "chat_turn", turnId, current.status);
    if (current.status === "queued" && current.retry_count > 0) throw new RepositoryConflictError("duplicate", "chat_turn", turnId, current.status);
    if (current.status !== "failed") throw new RepositoryConflictError("illegal_transition", "chat_turn", turnId, current.status);
    const result = await transaction.run(
      "UPDATE chat_turns SET status = 'queued', retry_count = retry_count + 1, error_code = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'",
      [updatedAt, turnId],
    );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "chat_turn", turnId, current.status);
    return this.turn(transaction, turnId);
  }

  async fail(transaction: QueryRunHandle, turnId: string, errorCode: string, completedAt: string): Promise<TurnRow> {
    assertCanonicalInstant(completedAt);
    const current = await this.turn(transaction, turnId);
    if (current.status === "failed") {
      if (current.error_code === errorCode && current.completed_at === completedAt && current.updated_at === completedAt) return current;
    }
    assertFreshEventTime(completedAt, current.updated_at, "chat_turn", turnId, current.status);
    if (current.status === "failed") throw new RepositoryConflictError("duplicate", "chat_turn", turnId, current.status);
    if (current.status !== "generating") throw new RepositoryConflictError("illegal_transition", "chat_turn", turnId, current.status);
    const result = await transaction.run(
      "UPDATE chat_turns SET status = 'failed', error_code = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'generating'",
      [errorCode, completedAt, completedAt, turnId],
    );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "chat_turn", turnId, current.status);
    return this.turn(transaction, turnId);
  }

  async cancel(transaction: QueryRunHandle, turnId: string, reasonCode: string, completedAt: string): Promise<TurnRow> {
    assertCanonicalInstant(completedAt);
    const current = await this.turn(transaction, turnId);
    if (current.status === "cancelled") {
      if (current.error_code === reasonCode && current.completed_at === completedAt && current.updated_at === completedAt) return current;
    }
    assertFreshEventTime(completedAt, current.updated_at, "chat_turn", turnId, current.status);
    if (current.status === "cancelled") throw new RepositoryConflictError("duplicate", "chat_turn", turnId, current.status);
    if (current.status !== "queued" && current.status !== "generating") {
      throw new RepositoryConflictError("illegal_transition", "chat_turn", turnId, current.status);
    }
    const result = await transaction.run(
      "UPDATE chat_turns SET status = 'cancelled', error_code = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'generating')",
      [reasonCode, completedAt, completedAt, turnId],
    );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "chat_turn", turnId, current.status);
    return this.turn(transaction, turnId);
  }

  async completeAssistant(transaction: QueryRunHandle, input: AssistantCompletionInput): Promise<TurnRow> {
    assertCanonicalInstant(input.completedAt);
    const current = await this.turn(transaction, input.turnId);
    if (current.status === "completed") {
      const [message] = await transaction.query<MessageRow>(
        "SELECT id, conversation_id, turn_id, role, ordinal, content, message_type, metadata_json, created_at FROM messages WHERE turn_id = ? AND role = 'assistant'",
        [input.turnId],
      );
      if (
        message?.id === input.messageId
        && message.conversation_id === current.conversation_id
        && message.turn_id === input.turnId
        && message.role === "assistant"
        && message.ordinal === 1
        && message.content === input.content
        && message.message_type === "text"
        && message.metadata_json === metadataJson(input.metadata)
        && message.created_at === input.completedAt
        && current.completed_at === input.completedAt
        && current.error_code === null
        && current.updated_at === input.completedAt
      ) return current;
    }
    assertFreshEventTime(input.completedAt, current.updated_at, "chat_turn", input.turnId, current.status);
    if (current.status === "completed") throw new RepositoryConflictError("duplicate", "chat_turn", input.turnId, current.status);
    if (current.status !== "generating") {
      throw new RepositoryConflictError("illegal_transition", "chat_turn", input.turnId, current.status);
    }
    const serializedMetadata = metadataJson(input.metadata);
    await transaction.run(
      "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, metadata_json, created_at) VALUES (?, ?, ?, 'assistant', 1, ?, 'text', ?, ?)",
      [input.messageId, current.conversation_id, input.turnId, input.content, serializedMetadata, input.completedAt],
    );
    const update = await transaction.run(
      "UPDATE chat_turns SET status = 'completed', error_code = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'generating'",
      [input.completedAt, input.completedAt, input.turnId],
    );
    if (update.changes !== 1) throw new RepositoryConflictError("stale_write", "chat_turn", input.turnId);
    return this.turn(transaction, input.turnId);
  }

  private async transition(
    transaction: QueryRunHandle,
    current: TurnRow,
    allowed: readonly ChatTurnStatus[],
    next: ChatTurnStatus,
    updatedAt: string,
  ): Promise<TurnRow> {
    assertFreshEventTime(updatedAt, current.updated_at, "chat_turn", current.id, current.status);
    if (!allowed.includes(current.status)) throw new RepositoryConflictError("illegal_transition", "chat_turn", current.id, current.status);
    const placeholders = allowed.map(() => "?").join(", ");
    const result = await transaction.run(
      `UPDATE chat_turns SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
      [next, updatedAt, current.id, ...allowed],
    );
    if (result.changes !== 1) throw new RepositoryConflictError("stale_write", "chat_turn", current.id, current.status);
    return this.turn(transaction, current.id);
  }
}
