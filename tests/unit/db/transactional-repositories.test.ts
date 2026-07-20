import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ExpoSqliteExclusiveTransactionAdapter,
  type ExpoExclusiveDatabase,
  type ExpoTransactionDatabase,
} from "../../../src/infrastructure/db/exclusiveTransaction.ts";
import type { QueryRunHandle } from "../../../src/application/data/ExclusiveTransactionPort.ts";
import { LocalJobRepository } from "../../../src/infrastructure/db/repositories/localJobRepository.ts";
import { PendingTaskRepository } from "../../../src/infrastructure/db/repositories/pendingTaskRepository.ts";
import { RepositoryConflictError } from "../../../src/infrastructure/db/repositories/conflicts.ts";
import { TurnMessageRepository } from "../../../src/infrastructure/db/repositories/turnMessageRepository.ts";
import { TrackerRepository } from "../../../src/infrastructure/db/repositories/trackerRepository.ts";
import type {
  TrackerCreateInputByDomain,
  TrackerDomain,
  TrackerUpdateInputByDomain,
} from "../../../src/domain/tracker/types.ts";
import { migratedTestDatabase } from "../../support/sqliteTestDatabase.ts";
import {
  loadManualTrackerFixture,
  seedTrackerSourceMessage,
  type ManualTrackerFixture,
} from "../../support/trackerTestHarness.ts";

const timestamp = "2026-07-16T01:00:00.000Z";
const later = "2026-07-16T01:00:01.000Z";
const latest = "2026-07-16T01:00:02.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function seedConversation(database: Awaited<ReturnType<typeof migratedTestDatabase>>, id = "conversation-1"): Promise<void> {
  await database.runAsync(
    "INSERT INTO conversations(id, title, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    id, "Test", timestamp, timestamp, timestamp,
  );
}

test("exclusive transactions rollback failures and serialize concurrent writers", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);

  await assert.rejects(transactions.runExclusive(async (transaction) => {
    await transaction.run("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", ["rollback", "{}", timestamp]);
    throw new Error("injected failure");
  }), /injected failure/);
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM app_meta"))[0]!.total, 0);

  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = transactions.runExclusive(async (transaction) => {
    order.push("first-start");
    await transaction.run("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", ["first", "{}", timestamp]);
    await firstMayFinish;
    order.push("first-end");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = transactions.runExclusive(async (transaction) => {
    order.push("second-start");
    await transaction.run("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", ["second", "{}", timestamp]);
    order.push("second-end");
  });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("transaction handles reject after both commit and rollback", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  let committed!: QueryRunHandle;
  const returned = await transactions.runExclusive(async (transaction) => {
    committed = transaction;
    return transaction;
  });
  await assert.rejects(committed.query("SELECT 1"), /no longer active/);
  await assert.rejects(returned.run("SELECT 1"), /no longer active/);

  let rolledBack!: QueryRunHandle;
  await assert.rejects(transactions.runExclusive(async (transaction) => {
    rolledBack = transaction;
    throw new Error("rollback");
  }), /rollback/);
  await assert.rejects(rolledBack.query("SELECT 1"), /no longer active/);
});

test("exclusive transactions await unawaited runs and queries before native commit", async () => {
  const run = deferred<Readonly<{ changes: number; lastInsertRowId: number }>>();
  const query = deferred<object[]>();
  const order: string[] = [];
  const native: ExpoExclusiveDatabase = {
    async withExclusiveTransactionAsync(operation) {
      const transaction: ExpoTransactionDatabase = {
        runAsync: async () => run.promise,
        getAllAsync: async <T>() => query.promise as Promise<T[]>,
      };
      await operation(transaction);
      order.push("commit");
    },
  };
  const completing = new ExpoSqliteExclusiveTransactionAdapter(native).runExclusive((transaction) => {
    void transaction.run("INSERT");
    void transaction.query("SELECT");
    order.push("callback-returned");
    return Promise.resolve("done");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["callback-returned"]);
  run.resolve({ changes: 1, lastInsertRowId: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["callback-returned"]);
  query.resolve([]);
  assert.equal(await completing, "done");
  assert.deepEqual(order, ["callback-returned", "commit"]);
});

test("late unawaited transaction rejection rolls back instead of committing", async () => {
  const query = deferred<object[]>();
  const order: string[] = [];
  const native: ExpoExclusiveDatabase = {
    async withExclusiveTransactionAsync(operation) {
      try {
        await operation({
          runAsync: async () => ({ changes: 1, lastInsertRowId: 1 }),
          getAllAsync: async <T>() => query.promise as Promise<T[]>,
        });
        order.push("commit");
      } catch (error) {
        order.push("rollback");
        throw error;
      }
    },
  };
  const completing = new ExpoSqliteExclusiveTransactionAdapter(native).runExclusive((transaction) => {
    void transaction.query("SELECT delayed failure");
    return Promise.resolve();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  query.reject(new Error("late query failure"));
  await assert.rejects(completing, /late query failure/);
  assert.deepEqual(order, ["rollback"]);
});

test("immediate unawaited SQL rejections stay handled while the application callback is blocked", async () => {
  for (const rejectedOperation of ["run", "query"] as const) {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const order: string[] = [];
    const native: ExpoExclusiveDatabase = {
      async withExclusiveTransactionAsync(operation) {
        try {
          await operation({
            runAsync: () => Promise.reject(new Error("immediate run failure")),
            getAllAsync: () => Promise.reject(new Error("immediate query failure")),
          });
          order.push("commit");
        } catch (error) {
          order.push("rollback");
          throw error;
        }
      },
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const completing = new ExpoSqliteExclusiveTransactionAdapter(native).runExclusive(async (transaction) => {
        if (rejectedOperation === "run") void transaction.run("INSERT");
        else void transaction.query("SELECT");
        await blocked;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      release();
      await assert.rejects(completing, new RegExp(`immediate ${rejectedOperation} failure`));
      assert.deepEqual(order, ["rollback"]);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("turn/message transitions are conditional, replay-safe, and assistant completion is atomic", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await seedConversation(database);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new TurnMessageRepository();

  await transactions.runExclusive((transaction) => repository.enqueue(transaction, {
    turnId: "turn-1", conversationId: "conversation-1", idempotencyKey: "idem-1", userMessageId: "user-1", content: "hello", requestedAt: timestamp,
  }));
  await assert.rejects(
    transactions.runExclusive((transaction) => repository.completeAssistant(transaction, {
      turnId: "turn-1", messageId: "assistant-illegal", content: "no", completedAt: later,
    })),
    (error) => error instanceof RepositoryConflictError && error.code === "illegal_transition",
  );
  await transactions.runExclusive((transaction) => repository.start(transaction, "turn-1", later));
  await assert.rejects(transactions.runExclusive(async (transaction) => {
    await repository.completeAssistant(transaction, { turnId: "turn-1", messageId: "assistant-rollback", content: "rolled back", completedAt: latest });
    throw new Error("after completion");
  }), /after completion/);
  assert.equal((await database.getAllAsync<{ status: string }>("SELECT status FROM chat_turns WHERE id = 'turn-1'"))[0]!.status, "generating");
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM messages WHERE role = 'assistant'"))[0]!.total, 0);

  await transactions.runExclusive((transaction) => repository.completeAssistant(transaction, {
    turnId: "turn-1", messageId: "assistant-1", content: "done", completedAt: latest, metadata: { z: 1, a: 2 },
  }));
  const replay = await transactions.runExclusive((transaction) => repository.completeAssistant(transaction, {
    turnId: "turn-1", messageId: "assistant-1", content: "done", completedAt: latest, metadata: { z: 1, a: 2 },
  }));
  assert.equal(replay.status, "completed");
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM messages WHERE role = 'assistant'"))[0]!.total, 1);
});

test("pending tasks and jobs enforce legal transitions with idempotent terminal replay and one effect", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await seedConversation(database);
  await database.runAsync(
    "INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)",
    "source-turn", "conversation-1", "source-idem", timestamp, timestamp,
  );
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const tasks = new PendingTaskRepository();
  const jobs = new LocalJobRepository();

  await transactions.runExclusive((transaction) => tasks.create(transaction, {
    id: "task-1", conversationId: "conversation-1", sourceTurnId: "source-turn", taskType: "tracker_create", status: "pending", riskLevel: "high", payload: { b: 2, a: 1 }, missingSlots: ["amount"], expiresAt: latest, createdAt: timestamp,
  }));
  await assert.rejects(
    transactions.runExclusive((transaction) => tasks.transition(transaction, "task-1", "confirm_success", later)),
    (error) => error instanceof RepositoryConflictError && error.code === "illegal_transition",
  );
  await transactions.runExclusive((transaction) => tasks.transition(transaction, "task-1", "supplement_complete_high_risk", later, {
    payload: { b: 2, a: 1 }, missingSlots: [],
  }));
  await transactions.runExclusive((transaction) => tasks.transition(transaction, "task-1", "confirm_success", latest));
  const taskReplay = await transactions.runExclusive((transaction) => tasks.transition(transaction, "task-1", "confirm_success", latest));
  assert.equal(taskReplay.status, "completed");

  for (const id of ["job-1", "job-2"]) {
    await transactions.runExclusive((transaction) => jobs.enqueue(transaction, {
      id, kind: "test", dedupeKey: `dedupe-${id}`, effectKey: "shared-effect", payload: { id }, createdAt: timestamp,
    }));
    await transactions.runExclusive((transaction) => jobs.lease(transaction, id, "worker", latest, later));
    await transactions.runExclusive((transaction) => jobs.commitEffect(transaction, id, "result", latest));
  }
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM committed_job_effects"))[0]!.total, 1);
  assert.deepEqual(
    (await database.getAllAsync<{ status: string }>("SELECT status FROM local_jobs ORDER BY id")).map((row) => row.status),
    ["succeeded", "succeeded"],
  );
});

function trackerCreateInput<D extends TrackerDomain>(
  input: TrackerUpdateInputByDomain[D],
  sourceMessageId: string,
): TrackerCreateInputByDomain[D] {
  return { ...input, sourceMessageId } as TrackerCreateInputByDomain[D];
}

async function proveTrackerRollback<D extends TrackerDomain>(
  domain: D,
  entry: ManualTrackerFixture["domains"][D],
  fixture: ManualTrackerFixture,
  transactions: ExpoSqliteExclusiveTransactionAdapter,
  repository: TrackerRepository,
): Promise<void> {
  const rollbackId = `${entry.id}-create-rollback`;
  await assert.rejects(transactions.runExclusive(async (transaction) => {
    await repository.create(
      transaction,
      domain,
      rollbackId,
      trackerCreateInput(entry.create, fixture.sourceMessageId),
      fixture.createdAt,
    );
    throw new Error(`${domain} create fault`);
  }), new RegExp(`${domain} create fault`));
  assert.equal(await transactions.runExclusive((transaction) => repository.getById(transaction, domain, rollbackId)), null);
  await transactions.runExclusive((transaction) => repository.create(
    transaction,
    domain,
    rollbackId,
    trackerCreateInput(entry.create, fixture.sourceMessageId),
    fixture.createdAt,
  ));

  const original = await transactions.runExclusive((transaction) => repository.create(
    transaction,
    domain,
    entry.id,
    trackerCreateInput(entry.create, fixture.sourceMessageId),
    fixture.createdAt,
  ));
  await assert.rejects(transactions.runExclusive(async (transaction) => {
    await repository.update(
      transaction,
      domain,
      entry.id,
      entry.update,
      original.updatedAt,
      fixture.updatedAt,
    );
    throw new Error(`${domain} update fault`);
  }), new RegExp(`${domain} update fault`));
  assert.deepEqual(
    await transactions.runExclusive((transaction) => repository.getById(transaction, domain, entry.id)),
    original,
  );
  const updated = await transactions.runExclusive((transaction) => repository.update(
    transaction,
    domain,
    entry.id,
    entry.update,
    original.updatedAt,
    fixture.updatedAt,
  ));

  await assert.rejects(transactions.runExclusive(async (transaction) => {
    await repository.softDelete(
      transaction,
      domain,
      entry.id,
      updated.updatedAt,
      fixture.deletedAt,
    );
    throw new Error(`${domain} delete fault`);
  }), new RegExp(`${domain} delete fault`));
  assert.deepEqual(
    await transactions.runExclusive((transaction) => repository.getById(transaction, domain, entry.id)),
    updated,
  );
  await transactions.runExclusive((transaction) => repository.softDelete(
    transaction,
    domain,
    entry.id,
    updated.updatedAt,
    fixture.deletedAt,
  ));
  assert.equal(await transactions.runExclusive((transaction) => repository.getById(transaction, domain, entry.id)), null);
}

test("tracker create, update, and delete faults rollback for every domain before the next writer commits", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const fixture = await loadManualTrackerFixture();
  await seedTrackerSourceMessage(database, fixture.sourceMessageId, fixture.createdAt);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new TrackerRepository();

  await proveTrackerRollback("growth", fixture.domains.growth, fixture, transactions, repository);
  await proveTrackerRollback("feeding", fixture.domains.feeding, fixture, transactions, repository);
  await proveTrackerRollback("sleep", fixture.domains.sleep, fixture, transactions, repository);
  await proveTrackerRollback("diaper", fixture.domains.diaper, fixture, transactions, repository);
  await proveTrackerRollback("health", fixture.domains.health, fixture, transactions, repository);
});

test("transaction repositories contain no transaction-control SQL and receive handles per call", () => {
  for (const file of ["turnMessageRepository.ts", "pendingTaskRepository.ts", "localJobRepository.ts", "modelConfigRepository.ts", "babyProfileRepository.ts", "trackerRepository.ts"]) {
    const source = readFileSync(new URL(`../../../src/infrastructure/db/repositories/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
    assert.doesNotMatch(source, /private readonly (?:transaction|database|handle)/i);
  }
});
