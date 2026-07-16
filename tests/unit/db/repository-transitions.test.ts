import assert from "node:assert/strict";
import test from "node:test";

import { ExpoSqliteExclusiveTransactionAdapter } from "../../../src/infrastructure/db/exclusiveTransaction.ts";
import { RepositoryConflictError } from "../../../src/infrastructure/db/repositories/conflicts.ts";
import { LocalJobRepository, type LocalJobStatus } from "../../../src/infrastructure/db/repositories/localJobRepository.ts";
import { PendingTaskRepository, type PendingTaskEvent, type PendingTaskStatus } from "../../../src/infrastructure/db/repositories/pendingTaskRepository.ts";
import { TurnMessageRepository, type ChatTurnStatus } from "../../../src/infrastructure/db/repositories/turnMessageRepository.ts";
import { migratedTestDatabase } from "../../support/sqliteTestDatabase.ts";

const timestamp = "2026-07-16T01:00:00.000Z";
const later = "2026-07-16T01:00:01.000Z";
const latest = "2026-07-16T01:00:02.000Z";
const newest = "2026-07-16T01:00:03.000Z";
const final = "2026-07-16T01:00:04.000Z";

async function expectConflict(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error) => error instanceof RepositoryConflictError && error.code === "illegal_transition");
}

test("every chat turn transition is table-tested for legal, replay, and illegal states", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?)", "conversation", timestamp, timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new TurnMessageRepository();
  const statuses: ChatTurnStatus[] = ["queued", "generating", "completed", "failed", "cancelled"];
  const cases = [
    { name: "start", legal: ["queued", "generating"], next: "generating" },
    { name: "retry", legal: ["failed", "queued"], next: "queued" },
    { name: "fail", legal: ["generating", "failed"], next: "failed" },
    { name: "cancel", legal: ["queued", "generating", "cancelled"], next: "cancelled" },
    { name: "complete", legal: ["generating", "completed"], next: "completed" },
  ] as const;
  for (const transition of cases) {
    for (const status of statuses) {
      const id = `${transition.name}-${status}`;
      await database.runAsync(
        "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, retry_count, error_code, requested_at, completed_at, updated_at) VALUES (?, 'conversation', ?, ?, ?, ?, ?, ?, ?)",
        id, id, status, status === "queued" && transition.name === "retry" ? 1 : 0,
        status === "failed" ? "failure" : status === "cancelled" ? "cancel" : null,
        timestamp, ["completed", "failed", "cancelled"].includes(status) ? timestamp : null, timestamp,
      );
      if (status === "completed") {
        await database.runAsync(
          "INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at) VALUES (?, 'conversation', ?, 'assistant', 1, 'done', 'text', ?)",
          `message-${id}`, id, timestamp,
        );
      }
      const operation = transactions.runExclusive((transaction) => {
        const eventTime = status === transition.next ? timestamp : later;
        switch (transition.name) {
          case "start": return repository.start(transaction, id, eventTime);
          case "retry": return repository.retry(transaction, id, eventTime);
          case "fail": return repository.fail(transaction, id, "failure", eventTime);
          case "cancel": return repository.cancel(transaction, id, "cancel", eventTime);
          case "complete": return repository.completeAssistant(transaction, { turnId: id, messageId: `message-${id}`, content: "done", completedAt: eventTime });
        }
      });
      if ((transition.legal as readonly string[]).includes(status)) {
        assert.equal((await operation).status, transition.next, `${transition.name} from ${status}`);
      } else {
        await expectConflict(operation);
      }
      await database.runAsync("DELETE FROM messages WHERE turn_id = ?", id);
      await database.runAsync("DELETE FROM chat_turns WHERE id = ?", id);
    }
  }
});

test("every pending task event is table-tested for legal and illegal states", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?)", "conversation", timestamp, timestamp, timestamp);
  await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('source', 'conversation', 'source', 'completed', ?, ?)", timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new PendingTaskRepository();
  const statuses: PendingTaskStatus[] = ["pending", "awaiting_confirmation", "completed", "cancelled", "expired"];
  const events: PendingTaskEvent[] = ["supplement_incomplete", "supplement_complete_high_risk", "supplement_complete_low_risk", "cancel", "expire", "confirm_success", "correction_incomplete"];
  const schemaPlan = [
    { source: "pending", event: "supplement_incomplete", target: "pending", content: true },
    { source: "pending", event: "supplement_complete_high_risk", target: "awaiting_confirmation", content: true },
    { source: "pending", event: "supplement_complete_low_risk", target: "completed", content: true },
    { source: "pending", event: "cancel", target: "cancelled", content: false },
    { source: "pending", event: "expire", target: "expired", content: false },
    { source: "awaiting_confirmation", event: "confirm_success", target: "completed", content: false },
    { source: "awaiting_confirmation", event: "correction_incomplete", target: "pending", content: true },
    { source: "awaiting_confirmation", event: "cancel", target: "cancelled", content: false },
    { source: "awaiting_confirmation", event: "expire", target: "expired", content: false },
  ] as const;
  for (const status of statuses) {
    for (const event of events) {
      const id = `${status}-${event}`;
      await database.runAsync(
        "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, completed_at, created_at, updated_at) VALUES (?, 'conversation', 'source', 'tracker_create', ?, 'high', '{\"a\":1}', '[\"slot\"]', ?, ?, ?, ?)",
        id, status, timestamp, status === "completed" ? timestamp : null, timestamp, timestamp,
      );
      const planned = schemaPlan.find((entry) => entry.source === status && entry.event === event);
      const content = planned?.content ? { payload: { a: 1 }, missingSlots: ["slot"] } : undefined;
      const operation = transactions.runExclusive((transaction) => repository.transition(transaction, id, event, later, content));
      if (planned) assert.equal((await operation).status, planned.target, `${event} from ${status}`);
      else await expectConflict(operation);
      await database.runAsync("DELETE FROM pending_agent_tasks WHERE id = ?", id);
    }
  }
});

test("pending task content presence exactly follows the schema plan", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation', ?, ?, ?)", timestamp, timestamp, timestamp);
  await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('source', 'conversation', 'source', 'completed', ?, ?)", timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new PendingTaskRepository();
  const cases = [
    { id: "missing-content", status: "pending", event: "supplement_incomplete", content: undefined },
    { id: "unexpected-content", status: "pending", event: "cancel", content: { payload: {}, missingSlots: [] } },
  ] as const;
  for (const input of cases) {
    await database.runAsync(
      "INSERT INTO pending_agent_tasks(id, conversation_id, source_turn_id, task_type, status, risk_level, payload_json, missing_slots_json, expires_at, created_at, updated_at) VALUES (?, 'conversation', 'source', 'tracker_create', ?, 'high', '{}', '[]', ?, ?, ?)",
      input.id, input.status, later, timestamp, timestamp,
    );
    await expectConflict(transactions.runExclusive((transaction) => repository.transition(
      transaction, input.id, input.event, later, input.content,
    )));
    await database.runAsync("DELETE FROM pending_agent_tasks WHERE id = ?", input.id);
  }
});

test("every local job transition is table-tested for legal, replay, and illegal states", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new LocalJobRepository();
  const statuses: LocalJobStatus[] = ["queued", "leased", "succeeded", "failed", "cancelled"];
  const cases = [
    { name: "lease", legal: ["queued", "leased"], next: "leased" },
    { name: "requeue", legal: ["leased", "queued"], next: "queued" },
    { name: "fail", legal: ["leased", "failed"], next: "failed" },
    { name: "cancel", legal: ["queued", "leased", "cancelled"], next: "cancelled" },
    { name: "commit", legal: ["leased", "succeeded"], next: "succeeded" },
  ] as const;
  for (const transition of cases) {
    for (const status of statuses) {
      const id = `${transition.name}-${status}`;
      const attemptCount = status === "queued" && transition.name === "requeue" ? 1 : status === "leased" ? 1 : 0;
      await database.runAsync(
        "INSERT INTO local_jobs(id, kind, dedupe_key, effect_key, status, payload_json, attempt_count, lease_owner, lease_expires_at, next_attempt_at, last_error_code, created_at, updated_at) VALUES (?, 'test', ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)",
        id, id, `effect-${id}`, status, attemptCount,
        status === "leased" ? "owner" : null, status === "leased" ? timestamp : null,
        status === "queued" && transition.name === "requeue" ? timestamp : null,
        status === "failed" || (status === "queued" && transition.name === "requeue") ? "failure" : null,
        timestamp, timestamp,
      );
      if (status === "succeeded") {
        await database.runAsync("INSERT INTO committed_job_effects(effect_key, job_id, result_hash, committed_at) VALUES (?, ?, 'result', ?)", `effect-${id}`, id, timestamp);
      }
      const operation = transactions.runExclusive((transaction) => {
        const eventTime = status === transition.next ? timestamp : later;
        switch (transition.name) {
          case "lease": return repository.lease(transaction, id, "owner", eventTime, eventTime);
          case "requeue": return repository.requeue(transaction, id, eventTime, "failure", eventTime);
          case "fail": return repository.fail(transaction, id, "failure", eventTime);
          case "cancel": return repository.cancel(transaction, id, eventTime);
          case "commit": return repository.commitEffect(transaction, id, "result", eventTime);
        }
      });
      if ((transition.legal as readonly string[]).includes(status)) assert.equal((await operation).status, transition.next, `${transition.name} from ${status}`);
      else await expectConflict(operation);
      await database.runAsync("DELETE FROM committed_job_effects WHERE job_id = ?", id);
      await database.runAsync("DELETE FROM local_jobs WHERE id = ?", id);
    }
  }
});

test("transition fields, lease release, retry counters, and committed effects remain durable", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation', ?, ?, ?)", timestamp, timestamp, timestamp);
  await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('source', 'conversation', 'source', 'completed', ?, ?)", timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);

  const turns = new TurnMessageRepository();
  await transactions.runExclusive((transaction) => turns.enqueue(transaction, {
    turnId: "turn", conversationId: "conversation", idempotencyKey: "turn", userMessageId: "user", content: "hello", requestedAt: timestamp,
  }));
  await transactions.runExclusive((transaction) => turns.start(transaction, "turn", later));
  await transactions.runExclusive((transaction) => turns.fail(transaction, "turn", "network", latest));
  await transactions.runExclusive((transaction) => turns.retry(transaction, "turn", newest));
  assert.deepEqual({ ...(await database.getAllAsync<Record<string, unknown>>("SELECT status, retry_count, error_code, completed_at, updated_at FROM chat_turns WHERE id = 'turn'"))[0] }, {
    status: "queued", retry_count: 1, error_code: null, completed_at: null, updated_at: newest,
  });

  const tasks = new PendingTaskRepository();
  await transactions.runExclusive((transaction) => tasks.create(transaction, {
    id: "task", conversationId: "conversation", sourceTurnId: "source", taskType: "tracker_create", status: "pending",
    riskLevel: "high", payload: { old: true }, missingSlots: ["amount"], expiresAt: later, createdAt: timestamp,
  }));
  await transactions.runExclusive((transaction) => tasks.transition(transaction, "task", "supplement_complete_high_risk", later, {
    payload: { amount: 1 }, missingSlots: [],
  }));
  await transactions.runExclusive((transaction) => tasks.transition(transaction, "task", "confirm_success", "2026-07-16T01:00:02.000Z"));
  assert.deepEqual({ ...(await database.getAllAsync<Record<string, unknown>>("SELECT status, payload_json, missing_slots_json, completed_at FROM pending_agent_tasks WHERE id = 'task'"))[0] }, {
    status: "completed", payload_json: '{"amount":1}', missing_slots_json: "[]", completed_at: "2026-07-16T01:00:02.000Z",
  });

  const jobs = new LocalJobRepository();
  await transactions.runExclusive((transaction) => jobs.enqueue(transaction, {
    id: "job", kind: "sync", dedupeKey: "job", effectKey: "effect", payload: { a: 1 }, createdAt: timestamp,
  }));
  await transactions.runExclusive((transaction) => jobs.lease(transaction, "job", "worker-1", final, later));
  await transactions.runExclusive((transaction) => jobs.requeue(transaction, "job", newest, "retryable", latest));
  await transactions.runExclusive((transaction) => jobs.lease(transaction, "job", "worker-2", final, newest));
  await transactions.runExclusive((transaction) => jobs.commitEffect(transaction, "job", "result", final));
  assert.deepEqual({ ...(await database.getAllAsync<Record<string, unknown>>("SELECT status, attempt_count, lease_owner, lease_expires_at, next_attempt_at, last_error_code FROM local_jobs WHERE id = 'job'"))[0] }, {
    status: "succeeded", attempt_count: 2, lease_owner: null, lease_expires_at: null, next_attempt_at: null, last_error_code: "retryable",
  });
  assert.deepEqual({ ...(await database.getAllAsync<Record<string, unknown>>("SELECT effect_key, job_id, result_hash, committed_at FROM committed_job_effects"))[0] }, {
    effect_key: "effect", job_id: "job", result_hash: "result", committed_at: final,
  });
});
