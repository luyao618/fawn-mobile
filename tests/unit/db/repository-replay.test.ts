import assert from "node:assert/strict";
import test from "node:test";

import { ExpoSqliteExclusiveTransactionAdapter } from "../../../src/infrastructure/db/exclusiveTransaction.ts";
import { RepositoryConflictError } from "../../../src/infrastructure/db/repositories/conflicts.ts";
import { LocalJobRepository, type EnqueueLocalJobInput } from "../../../src/infrastructure/db/repositories/localJobRepository.ts";
import { PendingTaskRepository, type CreatePendingTaskInput } from "../../../src/infrastructure/db/repositories/pendingTaskRepository.ts";
import { TurnMessageRepository, type EnqueueTurnInput } from "../../../src/infrastructure/db/repositories/turnMessageRepository.ts";
import { migratedTestDatabase } from "../../support/sqliteTestDatabase.ts";

const timestamp = "2026-07-16T01:00:00.000Z";
const later = "2026-07-16T01:00:01.000Z";
const latest = "2026-07-16T01:00:02.000Z";
const newest = "2026-07-16T01:00:03.000Z";
const final = "2026-07-16T01:00:04.000Z";

async function duplicate(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error) => error instanceof RepositoryConflictError && error.code === "duplicate");
}

async function stale(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error) => error instanceof RepositoryConflictError && error.code === "stale_write");
}

test("turn idempotency and assistant completion compare every persisted semantic field", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  for (const id of ["conversation-1", "conversation-2"]) {
    await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?)", id, timestamp, timestamp, timestamp);
  }
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new TurnMessageRepository();
  const original: EnqueueTurnInput = {
    turnId: "turn", conversationId: "conversation-1", idempotencyKey: "idem", userMessageId: "user",
    content: "hello", requestedAt: timestamp, metadata: { b: 2, a: 1 },
  };
  await transactions.runExclusive((transaction) => repository.enqueue(transaction, original));
  assert.equal((await transactions.runExclusive((transaction) => repository.enqueue(transaction, original))).id, "turn");
  const divergent: EnqueueTurnInput[] = [
    { ...original, turnId: "other-turn" },
    { ...original, idempotencyKey: "other-idem" },
    { ...original, conversationId: "conversation-2" },
    { ...original, userMessageId: "other-user" },
    { ...original, content: "different" },
    { ...original, requestedAt: later },
    { ...original, metadata: { a: 1, b: 3 } },
  ];
  for (const input of divergent) await duplicate(transactions.runExclusive((transaction) => repository.enqueue(transaction, input)));

  await transactions.runExclusive((transaction) => repository.start(transaction, "turn", later));
  const completion = { turnId: "turn", messageId: "assistant", content: "done", completedAt: latest, metadata: { ok: true } } as const;
  await transactions.runExclusive((transaction) => repository.completeAssistant(transaction, completion));
  await transactions.runExclusive((transaction) => repository.completeAssistant(transaction, completion));
  for (const input of [
    { ...completion, messageId: "other" }, { ...completion, content: "different" },
    { ...completion, metadata: { ok: false } },
  ]) await duplicate(transactions.runExclusive((transaction) => repository.completeAssistant(transaction, input)));
  await stale(transactions.runExclusive((transaction) => repository.completeAssistant(transaction, { ...completion, completedAt: later })));
});

test("pending task IDs and active job dedupe keys compare all identity, payload, and effect fields", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  for (const id of ["conversation-1", "conversation-2"]) {
    await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?)", id, timestamp, timestamp, timestamp);
    await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)", `source-${id}`, id, `idem-${id}`, timestamp, timestamp);
  }
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const tasks = new PendingTaskRepository();
  const task: CreatePendingTaskInput = {
    id: "task", conversationId: "conversation-1", sourceTurnId: "source-conversation-1", taskType: "tracker_create",
    status: "pending", riskLevel: "high", payload: { a: 1 }, missingSlots: ["slot"], expiresAt: later, createdAt: timestamp,
  };
  await transactions.runExclusive((transaction) => tasks.create(transaction, task));
  await transactions.runExclusive((transaction) => tasks.create(transaction, task));
  const taskVariants: CreatePendingTaskInput[] = [
    { ...task, conversationId: "conversation-2", sourceTurnId: "source-conversation-2" },
    { ...task, sourceTurnId: "source-conversation-2" }, { ...task, taskType: "tracker_update" },
    { ...task, status: "awaiting_confirmation" }, { ...task, riskLevel: "medium" },
    { ...task, payload: { a: 2 } }, { ...task, missingSlots: ["other"] },
    { ...task, expiresAt: latest }, { ...task, createdAt: "2026-07-15T01:00:00.000Z" },
  ];
  for (const input of taskVariants) await duplicate(transactions.runExclusive((transaction) => tasks.create(transaction, input)));

  const jobs = new LocalJobRepository();
  const job: EnqueueLocalJobInput = { id: "job", kind: "sync", dedupeKey: "dedupe", effectKey: "effect", payload: { a: 1 }, createdAt: timestamp };
  await transactions.runExclusive((transaction) => jobs.enqueue(transaction, job));
  await transactions.runExclusive((transaction) => jobs.enqueue(transaction, job));
  const jobVariants: EnqueueLocalJobInput[] = [
    { ...job, id: "other" }, { ...job, kind: "other" }, { ...job, dedupeKey: "other-dedupe" }, { ...job, effectKey: "other-effect" },
    { ...job, payload: { a: 2 } }, { ...job, createdAt: later },
  ];
  for (const input of jobVariants) await duplicate(transactions.runExclusive((transaction) => jobs.enqueue(transaction, input)));
  await transactions.runExclusive((transaction) => jobs.lease(transaction, "job", "owner", latest, later));
  await transactions.runExclusive((transaction) => jobs.commitEffect(transaction, "job", "hash", latest));
  await duplicate(transactions.runExclusive((transaction) => jobs.commitEffect(transaction, "job", "different-hash", latest)));
});

test("invalid JSON is rejected before repository SQL mutation", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const jobs = new LocalJobRepository();
  const before = database.statements.length;
  await assert.rejects(transactions.runExclusive((transaction) => jobs.enqueue(transaction, {
    id: "invalid", kind: "test", dedupeKey: "invalid", effectKey: "invalid", payload: { bad: undefined } as never, createdAt: timestamp,
  })), /valid JSON/);
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM local_jobs"))[0]!.total, 0);
  assert.equal(database.statements.slice(before).some((sql) => /INSERT INTO local_jobs/.test(sql)), false);
});

test("pending task replay requires the exact event, timestamp, and content fingerprint", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation-replay', ?, ?, ?)", timestamp, timestamp, timestamp);
  await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('source-replay', 'conversation-replay', 'source-replay', 'completed', ?, ?)", timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new PendingTaskRepository();
  await transactions.runExclusive((transaction) => repository.create(transaction, {
    id: "task-replay", conversationId: "conversation-replay", sourceTurnId: "source-replay", taskType: "tracker_create",
    status: "pending", riskLevel: "low", payload: { value: 1 }, missingSlots: ["slot"], expiresAt: later, createdAt: timestamp,
  }));
  const content = { payload: { value: 2 }, missingSlots: [] } as const;
  await transactions.runExclusive((transaction) => repository.transition(transaction, "task-replay", "supplement_complete_low_risk", later, content));
  await transactions.runExclusive((transaction) => repository.transition(transaction, "task-replay", "supplement_complete_low_risk", later, content));
  await duplicate(transactions.runExclusive((transaction) => repository.transition(transaction, "task-replay", "confirm_success", later)));
  await duplicate(transactions.runExclusive((transaction) => repository.transition(
    transaction, "task-replay", "supplement_complete_low_risk", later, { payload: { value: 3 }, missingSlots: [] },
  )));
  const [meta] = await database.getAllAsync<{ value_json: string }>("SELECT value_json FROM app_meta WHERE key = ?", "pending_task_event_fingerprint:task-replay");
  assert.match(JSON.parse(meta!.value_json), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(meta!.value_json, /value|slot/);
});

test("pending task instants reject malformed creation, invalid expiry, and zzzz stale locks", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation-time-task', ?, ?, ?)", timestamp, timestamp, timestamp);
  await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('source-time-task', 'conversation-time-task', 'source-time-task', 'completed', ?, ?)", timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new PendingTaskRepository();
  const input: CreatePendingTaskInput = {
    id: "task-time", conversationId: "conversation-time-task", sourceTurnId: "source-time-task", taskType: "tracker_create",
    status: "pending", riskLevel: "low", payload: {}, missingSlots: [], expiresAt: latest, createdAt: timestamp,
  };

  await assert.rejects(transactions.runExclusive((transaction) => repository.create(transaction, {
    ...input, createdAt: "2026-07-16T01:00:00Z",
  })), TypeError);
  await assert.rejects(transactions.runExclusive((transaction) => repository.create(transaction, {
    ...input, expiresAt: "not-an-instant",
  })), TypeError);
  await assert.rejects(transactions.runExclusive((transaction) => repository.create(transaction, {
    ...input, expiresAt: timestamp,
  })), TypeError);
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM pending_agent_tasks WHERE id = ?", input.id))[0]!.total, 0);

  await transactions.runExclusive((transaction) => repository.create(transaction, input));
  const before = (await database.getAllAsync<Record<string, unknown>>("SELECT * FROM pending_agent_tasks WHERE id = ?", input.id))[0]!;
  await assert.rejects(
    transactions.runExclusive((transaction) => repository.transition(transaction, input.id, "cancel", "zzzz")),
    TypeError,
  );
  assert.deepEqual((await database.getAllAsync<Record<string, unknown>>("SELECT * FROM pending_agent_tasks WHERE id = ?", input.id))[0]!, before);
  assert.equal((await transactions.runExclusive((transaction) => repository.transition(transaction, input.id, "cancel", later))).status, "cancelled");
});

test("two jobs sharing an effect can complete and replay against the original effect owner", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new LocalJobRepository();
  for (const id of ["effect-owner", "effect-observer"]) {
    await transactions.runExclusive((transaction) => repository.enqueue(transaction, {
      id, kind: "shared", dedupeKey: id, effectKey: "shared-effect", payload: { id }, createdAt: timestamp,
    }));
    await transactions.runExclusive((transaction) => repository.lease(transaction, id, `worker-${id}`, final, later));
  }

  await transactions.runExclusive((transaction) => repository.commitEffect(transaction, "effect-owner", "same-result", latest));
  const completed = await transactions.runExclusive((transaction) => repository.commitEffect(transaction, "effect-observer", "same-result", latest));
  assert.equal(completed.status, "succeeded");
  assert.deepEqual(await transactions.runExclusive((transaction) => repository.commitEffect(transaction, "effect-observer", "same-result", latest)), completed);
  assert.deepEqual({ ...(await database.getAllAsync<Record<string, unknown>>(
    "SELECT effect_key, job_id, result_hash, committed_at FROM committed_job_effects WHERE effect_key = 'shared-effect'",
  ))[0] }, {
    effect_key: "shared-effect", job_id: "effect-owner", result_hash: "same-result", committed_at: latest,
  });
  await duplicate(transactions.runExclusive((transaction) => repository.commitEffect(transaction, "effect-observer", "different-result", latest)));
  await duplicate(transactions.runExclusive((transaction) => repository.commitEffect(transaction, "effect-observer", "same-result", newest)));
  await stale(transactions.runExclusive((transaction) => repository.commitEffect(transaction, "effect-observer", "same-result", later)));
});

test("stale pending-task replay cannot rewind a newer correction", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation-stale', ?, ?, ?)", timestamp, timestamp, timestamp);
  await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('source-stale', 'conversation-stale', 'source-stale', 'completed', ?, ?)", timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new PendingTaskRepository();
  await transactions.runExclusive((transaction) => repository.create(transaction, {
    id: "task-stale", conversationId: "conversation-stale", sourceTurnId: "source-stale", taskType: "tracker_create",
    status: "pending", riskLevel: "high", payload: { version: 0 }, missingSlots: ["amount"], expiresAt: latest, createdAt: timestamp,
  }));
  const first = { payload: { version: 1 }, missingSlots: [] } as const;
  const correction = { payload: { version: 2 }, missingSlots: ["amount"] } as const;
  await transactions.runExclusive((transaction) => repository.transition(transaction, "task-stale", "supplement_complete_high_risk", later, first));
  await transactions.runExclusive((transaction) => repository.transition(transaction, "task-stale", "correction_incomplete", latest, correction));
  const before = (await database.getAllAsync<Record<string, unknown>>(
    "SELECT status, payload_json, missing_slots_json, completed_at, updated_at FROM pending_agent_tasks WHERE id = 'task-stale'",
  ))[0]!;
  await assert.rejects(
    transactions.runExclusive((transaction) => repository.transition(transaction, "task-stale", "supplement_complete_high_risk", later, first)),
    (error) => error instanceof RepositoryConflictError && error.code === "stale_write",
  );
  const after = (await database.getAllAsync<Record<string, unknown>>(
    "SELECT status, payload_json, missing_slots_json, completed_at, updated_at FROM pending_agent_tasks WHERE id = 'task-stale'",
  ))[0]!;
  assert.deepEqual(after, before);
});

test("turn transition replays cannot rewind newer state or semantic fields", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation-turn-stale', ?, ?, ?)", timestamp, timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new TurnMessageRepository();
  const enqueue = async (id: string): Promise<void> => {
    await transactions.runExclusive((transaction) => repository.enqueue(transaction, {
      turnId: id, conversationId: "conversation-turn-stale", idempotencyKey: id, userMessageId: `user-${id}`, content: id, requestedAt: timestamp,
    }));
  };
  const unchangedAfterStale = async (id: string, operation: Promise<unknown>): Promise<void> => {
    const before = (await database.getAllAsync<Record<string, unknown>>("SELECT * FROM chat_turns WHERE id = ?", id))[0]!;
    await stale(operation);
    const after = (await database.getAllAsync<Record<string, unknown>>("SELECT * FROM chat_turns WHERE id = ?", id))[0]!;
    assert.deepEqual(after, before);
  };

  await enqueue("turn-start-stale");
  await transactions.runExclusive((transaction) => repository.start(transaction, "turn-start-stale", later));
  await database.runAsync("UPDATE chat_turns SET updated_at = ? WHERE id = ?", latest, "turn-start-stale");
  await unchangedAfterStale("turn-start-stale", transactions.runExclusive((transaction) => repository.start(transaction, "turn-start-stale", later)));

  await enqueue("turn-fail-stale");
  await transactions.runExclusive((transaction) => repository.start(transaction, "turn-fail-stale", later));
  await transactions.runExclusive((transaction) => repository.fail(transaction, "turn-fail-stale", "first", latest));
  await transactions.runExclusive((transaction) => repository.retry(transaction, "turn-fail-stale", newest));
  await unchangedAfterStale("turn-fail-stale", transactions.runExclusive((transaction) => repository.fail(transaction, "turn-fail-stale", "first", latest)));

  await enqueue("turn-retry-stale");
  await transactions.runExclusive((transaction) => repository.start(transaction, "turn-retry-stale", later));
  await transactions.runExclusive((transaction) => repository.fail(transaction, "turn-retry-stale", "first", latest));
  await transactions.runExclusive((transaction) => repository.retry(transaction, "turn-retry-stale", newest));
  await transactions.runExclusive((transaction) => repository.start(transaction, "turn-retry-stale", final));
  await unchangedAfterStale("turn-retry-stale", transactions.runExclusive((transaction) => repository.retry(transaction, "turn-retry-stale", newest)));

  await enqueue("turn-cancel-stale");
  await transactions.runExclusive((transaction) => repository.cancel(transaction, "turn-cancel-stale", "first", later));
  await database.runAsync("UPDATE chat_turns SET error_code = 'newer', completed_at = ?, updated_at = ? WHERE id = ?", latest, latest, "turn-cancel-stale");
  await unchangedAfterStale("turn-cancel-stale", transactions.runExclusive((transaction) => repository.cancel(transaction, "turn-cancel-stale", "first", later)));

  await enqueue("turn-complete-stale");
  await transactions.runExclusive((transaction) => repository.start(transaction, "turn-complete-stale", later));
  const completion = { turnId: "turn-complete-stale", messageId: "assistant-turn-complete-stale", content: "first", completedAt: latest } as const;
  await transactions.runExclusive((transaction) => repository.completeAssistant(transaction, completion));
  await database.runAsync("UPDATE chat_turns SET completed_at = ?, updated_at = ? WHERE id = ?", newest, newest, "turn-complete-stale");
  await database.runAsync("UPDATE messages SET content = 'newer', created_at = ? WHERE id = ?", newest, completion.messageId);
  await unchangedAfterStale("turn-complete-stale", transactions.runExclusive((transaction) => repository.completeAssistant(transaction, completion)));
  const [message] = await database.getAllAsync<{ content: string; created_at: string }>("SELECT content, created_at FROM messages WHERE id = ?", completion.messageId);
  assert.deepEqual({ ...message }, { content: "newer", created_at: newest });
});

test("job transition replays cannot rewind newer leases, errors, schedules, or effects", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new LocalJobRepository();
  const enqueue = async (id: string): Promise<void> => {
    await transactions.runExclusive((transaction) => repository.enqueue(transaction, {
      id, kind: "stale", dedupeKey: id, effectKey: `effect-${id}`, payload: { id }, createdAt: timestamp,
    }));
  };
  const unchangedAfterStale = async (id: string, operation: Promise<unknown>): Promise<void> => {
    const before = (await database.getAllAsync<Record<string, unknown>>("SELECT * FROM local_jobs WHERE id = ?", id))[0]!;
    await stale(operation);
    const after = (await database.getAllAsync<Record<string, unknown>>("SELECT * FROM local_jobs WHERE id = ?", id))[0]!;
    assert.deepEqual(after, before);
  };

  await enqueue("job-lease-stale");
  await transactions.runExclusive((transaction) => repository.lease(transaction, "job-lease-stale", "first", final, later));
  await database.runAsync("UPDATE local_jobs SET lease_owner = 'newer', lease_expires_at = ?, updated_at = ? WHERE id = ?", final, latest, "job-lease-stale");
  await unchangedAfterStale("job-lease-stale", transactions.runExclusive((transaction) => repository.lease(transaction, "job-lease-stale", "first", final, later)));

  for (const method of ["requeue", "retry"] as const) {
    const id = `job-${method}-stale`;
    await enqueue(id);
    await transactions.runExclusive((transaction) => repository.lease(transaction, id, "worker", final, later));
    await transactions.runExclusive((transaction) => repository[method](transaction, id, latest, "first", latest));
    await database.runAsync("UPDATE local_jobs SET next_attempt_at = ?, last_error_code = 'newer', updated_at = ? WHERE id = ?", final, newest, id);
    await unchangedAfterStale(id, transactions.runExclusive((transaction) => repository[method](transaction, id, latest, "first", latest)));
  }

  await enqueue("job-fail-stale");
  await transactions.runExclusive((transaction) => repository.lease(transaction, "job-fail-stale", "worker", final, later));
  await transactions.runExclusive((transaction) => repository.fail(transaction, "job-fail-stale", "first", latest));
  await database.runAsync("UPDATE local_jobs SET last_error_code = 'newer', updated_at = ? WHERE id = ?", newest, "job-fail-stale");
  await unchangedAfterStale("job-fail-stale", transactions.runExclusive((transaction) => repository.fail(transaction, "job-fail-stale", "first", latest)));

  await enqueue("job-cancel-stale");
  await transactions.runExclusive((transaction) => repository.cancel(transaction, "job-cancel-stale", later));
  await database.runAsync("UPDATE local_jobs SET last_error_code = 'newer', updated_at = ? WHERE id = ?", latest, "job-cancel-stale");
  await unchangedAfterStale("job-cancel-stale", transactions.runExclusive((transaction) => repository.cancel(transaction, "job-cancel-stale", later)));

  await enqueue("job-commit-stale");
  await transactions.runExclusive((transaction) => repository.lease(transaction, "job-commit-stale", "worker", final, later));
  await transactions.runExclusive((transaction) => repository.commitEffect(transaction, "job-commit-stale", "first", latest));
  await database.runAsync("UPDATE local_jobs SET updated_at = ? WHERE id = ?", newest, "job-commit-stale");
  await database.runAsync("UPDATE committed_job_effects SET result_hash = 'newer', committed_at = ? WHERE job_id = ?", newest, "job-commit-stale");
  const [effectBefore] = await database.getAllAsync<Record<string, unknown>>("SELECT * FROM committed_job_effects WHERE job_id = ?", "job-commit-stale");
  await unchangedAfterStale("job-commit-stale", transactions.runExclusive((transaction) => repository.commitEffect(transaction, "job-commit-stale", "first", latest)));
  const [effectAfter] = await database.getAllAsync<Record<string, unknown>>("SELECT * FROM committed_job_effects WHERE job_id = ?", "job-commit-stale");
  assert.deepEqual(effectAfter, effectBefore);
});

test("turn and job event times require canonical ISO instants", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation-time', ?, ?, ?)", timestamp, timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const turns = new TurnMessageRepository();
  const jobs = new LocalJobRepository();
  await transactions.runExclusive((transaction) => turns.enqueue(transaction, {
    turnId: "turn-time", conversationId: "conversation-time", idempotencyKey: "turn-time", userMessageId: "message-time", content: "time", requestedAt: timestamp,
  }));
  await transactions.runExclusive((transaction) => jobs.enqueue(transaction, {
    id: "job-time", kind: "time", dedupeKey: "job-time", effectKey: "job-time", payload: {}, createdAt: timestamp,
  }));
  await assert.rejects(transactions.runExclusive((transaction) => turns.start(transaction, "turn-time", "2026-07-16T01:00:01Z")), TypeError);
  await assert.rejects(transactions.runExclusive((transaction) => jobs.lease(transaction, "job-time", "worker", later, "not-a-time")), TypeError);
});

test("pending, job, and message JSON round-trip prototype-named own keys", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync("INSERT INTO conversations(id, started_at, created_at, updated_at) VALUES ('conversation-json', ?, ?, ?)", timestamp, timestamp, timestamp);
  await database.runAsync("INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES ('source-json', 'conversation-json', 'source-json', 'completed', ?, ?)", timestamp, timestamp);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const value = JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"prototype":{"z":3}}');
  await transactions.runExclusive((transaction) => new PendingTaskRepository().create(transaction, {
    id: "task-json", conversationId: "conversation-json", sourceTurnId: "source-json", taskType: "tracker_create",
    status: "pending", riskLevel: "low", payload: value, missingSlots: [], expiresAt: later, createdAt: timestamp,
  }));
  await transactions.runExclusive((transaction) => new LocalJobRepository().enqueue(transaction, {
    id: "job-json", kind: "json", dedupeKey: "job-json", effectKey: "job-json", payload: value, createdAt: timestamp,
  }));
  await transactions.runExclusive((transaction) => new TurnMessageRepository().enqueue(transaction, {
    turnId: "turn-json", conversationId: "conversation-json", idempotencyKey: "turn-json", userMessageId: "message-json",
    content: "json", requestedAt: timestamp, metadata: value,
  }));
  const rows = await Promise.all([
    database.getAllAsync<{ value: string }>("SELECT payload_json AS value FROM pending_agent_tasks WHERE id = 'task-json'"),
    database.getAllAsync<{ value: string }>("SELECT payload_json AS value FROM local_jobs WHERE id = 'job-json'"),
    database.getAllAsync<{ value: string }>("SELECT metadata_json AS value FROM messages WHERE id = 'message-json'"),
  ]);
  for (const [row] of rows) {
    const parsed = JSON.parse(row!.value);
    assert.equal(Object.hasOwn(parsed, "__proto__"), true);
    assert.deepEqual(parsed.__proto__, { x: 1 });
    assert.notDeepEqual(parsed, {});
  }
});
