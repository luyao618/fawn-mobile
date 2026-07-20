import assert from "node:assert/strict";
import test from "node:test";

import type {
  TrackerCreateInputByDomain,
  TrackerDomain,
  TrackerUpdateInputByDomain,
} from "../../../src/domain/tracker/types.ts";
import { TrackerValidationError } from "../../../src/domain/tracker/validation.ts";
import { ExpoSqliteExclusiveTransactionAdapter } from "../../../src/infrastructure/db/exclusiveTransaction.ts";
import { RepositoryConflictError } from "../../../src/infrastructure/db/repositories/conflicts.ts";
import { TrackerRepository } from "../../../src/infrastructure/db/repositories/trackerRepository.ts";
import { SQLiteTestDatabase } from "../../support/sqliteTestDatabase.ts";
import { createTrackerTestHarness } from "../../support/trackerTestHarness.ts";

const domains = ["growth", "feeding", "sleep", "diaper", "health"] as const;

function createInput<D extends TrackerDomain>(
  _domain: D,
  values: TrackerUpdateInputByDomain[D],
  sourceMessageId: string | null,
): TrackerCreateInputByDomain[D] {
  return { ...values, sourceMessageId } as TrackerCreateInputByDomain[D];
}

test("manual service composes confirmation policy with real SQLite persistence", async () => {
  const harness = await createTrackerTestHarness();
  const { fixture, service } = harness;
  try {
    const entry = fixture.domains.feeding;
    const created = await service.create("feeding", createInput("feeding", entry.create, null));
    assert.equal(created.status, "completed");
    if (created.status !== "completed") assert.fail("Low-risk feeding create must complete");

    const original = created.record;
    const updatePending = await service.update("feeding", original.id, entry.update, original.updatedAt);
    assert.equal(updatePending.status, "confirmation_required");
    assert.deepEqual(await service.getById("feeding", original.id), original);

    const updated = await service.update(
      "feeding", original.id, entry.update, original.updatedAt, "confirmed",
    );
    assert.equal(updated.status, "completed");
    if (updated.status !== "completed") assert.fail("Confirmed feeding update must complete");
    assert.deepEqual(await service.getById("feeding", original.id), updated.record);

    const deletePending = await service.delete("feeding", original.id, updated.record.updatedAt);
    assert.equal(deletePending.status, "confirmation_required");
    assert.deepEqual(await service.getById("feeding", original.id), updated.record);

    const deleted = await service.delete(
      "feeding", original.id, updated.record.updatedAt, "confirmed",
    );
    assert.equal(deleted.status, "completed");
    assert.equal(await service.getById("feeding", original.id), null);
  } finally {
    await harness.cleanup();
  }
});

test("missing tracker source message fails the real foreign key and leaves no row", async () => {
  const harness = await createTrackerTestHarness();
  const { database, fixture, service } = harness;
  try {
    const entry = fixture.domains.feeding;
    await assert.rejects(
      service.create("feeding", createInput("feeding", entry.create, "missing-source-message")),
      (error) => error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message),
    );
    const rows = await database.getAllAsync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM feeding_records",
    );
    assert.equal(rows[0]?.count, 0);
  } finally {
    await harness.cleanup();
  }
});

test("five-domain records update, soft-delete, close, and reopen without losing source linkage", async () => {
  const harness = await createTrackerTestHarness();
  const { fixture, repository, transactions } = harness;
  try {
    for (const domain of domains) {
      const entry = fixture.domains[domain];
      const original = await transactions.runExclusive((transaction) => repository.create(
        transaction,
        domain,
        entry.id,
        createInput(domain, entry.create, fixture.sourceMessageId),
        fixture.createdAt,
      ));
      assert.equal(original.sourceMessageId, fixture.sourceMessageId);
      assert.equal(Object.isFrozen(original), true);
      await transactions.runExclusive((transaction) => repository.create(
        transaction,
        domain,
        `${entry.id}-active`,
        createInput(domain, entry.create, null),
        fixture.createdAt,
      ));
      const updated = await transactions.runExclusive((transaction) => repository.update(
        transaction,
        domain,
        entry.id,
        entry.update,
        original.updatedAt,
        fixture.createdAt,
      ));
      assert.equal(updated.sourceMessageId, fixture.sourceMessageId);
      assert.equal(updated.createdAt, original.createdAt);
      assert.equal(updated.updatedAt, "2026-07-20T01:00:00.001Z");
      const deletion = await transactions.runExclusive((transaction) => repository.softDelete(
        transaction,
        domain,
        entry.id,
        updated.updatedAt,
        fixture.deletedAt,
      ));
      assert.equal(deletion.updatedAt, deletion.deletedAt);
      assert.equal(await transactions.runExclusive((transaction) => repository.getById(transaction, domain, entry.id)), null);
    }
    assert.doesNotMatch(
      harness.database.statements.join("\n"),
      /\bDELETE\s+FROM\s+(?:growth|feeding|sleep|diaper|health)_records\b/i,
    );

    await harness.closeDatabase();
    const reopened = new SQLiteTestDatabase(harness.path);
    try {
      await reopened.migrate();
      const reopenedTransactions = new ExpoSqliteExclusiveTransactionAdapter(reopened);
      const reopenedRepository = new TrackerRepository();
      for (const domain of domains) {
        const entry = fixture.domains[domain];
        const active = await reopenedTransactions.runExclusive((transaction) => reopenedRepository.getById(
          transaction,
          domain,
          `${entry.id}-active`,
        ));
        assert.equal(active?.id, `${entry.id}-active`);
        assert.equal(await reopenedTransactions.runExclusive((transaction) => reopenedRepository.getById(
          transaction,
          domain,
          entry.id,
        )), null);
      }
      for (const table of ["growth_records", "feeding_records", "sleep_records", "diaper_records", "health_records"]) {
        const rows = await reopened.getAllAsync<{ updated_at: string; deleted_at: string }>(
          `SELECT updated_at, deleted_at FROM ${table} WHERE id NOT LIKE '%-active'`,
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.updated_at, rows[0]!.deleted_at);
      }
    } finally {
      await reopened.closeAsync();
    }
  } finally {
    await harness.cleanup();
  }
});

test("create replay is identical-only and tombstones cannot be reused", async () => {
  const harness = await createTrackerTestHarness();
  const { fixture, repository, transactions } = harness;
  try {
    const entry = fixture.domains.feeding;
    const input = createInput("feeding", entry.create, fixture.sourceMessageId);
    const first = await transactions.runExclusive((transaction) => repository.create(
      transaction, "feeding", entry.id, input, fixture.createdAt,
    ));
    const replay = await transactions.runExclusive((transaction) => repository.create(
      transaction, "feeding", entry.id, input, fixture.updatedAt,
    ));
    assert.deepEqual(replay, first);
    await assert.rejects(
      transactions.runExclusive((transaction) => repository.create(
        transaction, "feeding", entry.id, createInput("feeding", entry.update, fixture.sourceMessageId), fixture.updatedAt,
      )),
      (error) => error instanceof RepositoryConflictError && error.code === "duplicate",
    );
    await transactions.runExclusive((transaction) => repository.softDelete(
      transaction, "feeding", entry.id, first.updatedAt, fixture.deletedAt,
    ));
    await assert.rejects(
      transactions.runExclusive((transaction) => repository.create(
        transaction, "feeding", entry.id, input, fixture.updatedAt,
      )),
      (error) => error instanceof RepositoryConflictError && error.code === "duplicate",
    );
  } finally {
    await harness.cleanup();
  }
});

test("conditional mutations distinguish stale, missing, and deleted records", async () => {
  const harness = await createTrackerTestHarness();
  const { fixture, repository, transactions } = harness;
  try {
    const entry = fixture.domains.diaper;
    const record = await transactions.runExclusive((transaction) => repository.create(
      transaction, "diaper", entry.id, createInput("diaper", entry.create, null), fixture.createdAt,
    ));
    await assert.rejects(
      transactions.runExclusive((transaction) => repository.update(
        transaction, "diaper", entry.id, entry.update, fixture.updatedAt, fixture.updatedAt,
      )),
      (error) => error instanceof RepositoryConflictError
        && error.code === "stale_write"
        && error.currentState === record.updatedAt,
    );
    await assert.rejects(
      transactions.runExclusive((transaction) => repository.softDelete(
        transaction, "diaper", "missing", fixture.createdAt, fixture.deletedAt,
      )),
      (error) => error instanceof RepositoryConflictError && error.code === "not_found",
    );
    await transactions.runExclusive((transaction) => repository.softDelete(
      transaction, "diaper", entry.id, record.updatedAt, fixture.deletedAt,
    ));
    await assert.rejects(
      transactions.runExclusive((transaction) => repository.update(
        transaction, "diaper", entry.id, entry.update, fixture.deletedAt, fixture.updatedAt,
      )),
      (error) => error instanceof RepositoryConflictError && error.code === "not_found",
    );
  } finally {
    await harness.cleanup();
  }
});

test("active lists are frozen, bounded, and deterministic recent-first by time then id", async () => {
  const harness = await createTrackerTestHarness();
  const { fixture, repository, transactions } = harness;
  try {
    const base = fixture.domains.feeding.create;
    for (const [id, feedTime] of [
      ["feeding-a", "2026-07-20T00:00:00.000Z"],
      ["feeding-b", "2026-07-20T01:00:00.000Z"],
      ["feeding-c", "2026-07-20T01:00:00.000Z"],
    ] as const) {
      await transactions.runExclusive((transaction) => repository.create(
        transaction,
        "feeding",
        id,
        createInput("feeding", { ...base, feedTime }, null),
        fixture.createdAt,
      ));
    }
    const listed = await transactions.runExclusive((transaction) => repository.list(transaction, "feeding", 2));
    assert.deepEqual(listed.map((record) => record.id), ["feeding-c", "feeding-b"]);
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(listed.every(Object.isFrozen), true);
    await assert.rejects(transactions.runExclusive((transaction) => repository.list(transaction, "feeding", 0)), RangeError);
  } finally {
    await harness.cleanup();
  }
});

test("active restored rows fail closed when portable cross-field validation detects corruption", async () => {
  const harness = await createTrackerTestHarness();
  const { fixture, repository, transactions, database } = harness;
  try {
    await database.runAsync(
      `INSERT INTO sleep_records(
        id, sleep_start, sleep_end, sleep_type, night_wakings, notes,
        source_message_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, 'night', 0, NULL, NULL, ?, ?, NULL)`,
      "corrupt-sleep",
      "2026-07-20T01:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
      fixture.createdAt,
      fixture.createdAt,
    );
    await assert.rejects(
      transactions.runExclusive((transaction) => repository.getById(transaction, "sleep", "corrupt-sleep")),
      (error) => error instanceof TrackerValidationError && error.field === "sleepEnd",
    );
  } finally {
    await harness.cleanup();
  }
});
