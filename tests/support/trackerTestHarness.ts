import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeOperationGate } from "../../src/application/bootstrap/appRuntime.ts";
import type { ClockPort } from "../../src/application/bootstrap/recoverAndOpen.ts";
import { DataMutationCoordinator } from "../../src/application/data/DataMutationCoordinator.ts";
import { ManualTrackerService, type LocalIdGenerator } from "../../src/application/tracker/manualTrackerService.ts";
import type {
  TrackerDomain,
  TrackerUpdateInputByDomain,
} from "../../src/domain/tracker/types.ts";
import { ExpoSqliteExclusiveTransactionAdapter } from "../../src/infrastructure/db/exclusiveTransaction.ts";
import { TrackerRepository } from "../../src/infrastructure/db/repositories/trackerRepository.ts";
import { SQLiteTestDatabase } from "./sqliteTestDatabase.ts";

export type ManualTrackerFixture = Readonly<{
  timeZone: string;
  sourceMessageId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string;
  domains: Readonly<{
    [D in TrackerDomain]: Readonly<{
      id: string;
      create: TrackerUpdateInputByDomain[D];
      update: TrackerUpdateInputByDomain[D];
    }>;
  }>;
}>;

export class QueuedClock implements ClockPort {
  constructor(private readonly values: string[]) {}

  now(): string {
    const value = this.values.shift();
    if (!value) throw new Error("Tracker test clock queue is empty");
    return value;
  }
}

export class QueuedLocalIdGenerator implements LocalIdGenerator {
  constructor(private readonly values: string[]) {}

  nextId(): string {
    const value = this.values.shift();
    if (!value) throw new Error("Tracker test id queue is empty");
    return value;
  }
}

export async function loadManualTrackerFixture(): Promise<ManualTrackerFixture> {
  const source = await readFile(
    new URL("../fixtures/tracker/manual-tracker-v1.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(source) as ManualTrackerFixture;
}

export async function seedTrackerSourceMessage(
  database: SQLiteTestDatabase,
  sourceMessageId: string,
  now: string,
): Promise<void> {
  await database.runAsync(
    "INSERT INTO conversations(id, title, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    "tracker-conversation", "Synthetic tracker fixture", now, now, now,
  );
  await database.runAsync(
    `INSERT INTO chat_turns(id, conversation_id, idempotency_key, status, requested_at, completed_at, updated_at)
     VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
    "tracker-turn", "tracker-conversation", "tracker-fixture-turn", now, now, now,
  );
  await database.runAsync(
    `INSERT INTO messages(id, conversation_id, turn_id, role, ordinal, content, message_type, created_at)
     VALUES (?, ?, ?, 'user', 0, ?, 'text', ?)`,
    sourceMessageId, "tracker-conversation", "tracker-turn", "synthetic tracker source", now,
  );
}

export async function createTrackerTestHarness(): Promise<Readonly<{
  directory: string;
  path: string;
  database: SQLiteTestDatabase;
  transactions: ExpoSqliteExclusiveTransactionAdapter;
  repository: TrackerRepository;
  service: ManualTrackerService;
  operations: RuntimeOperationGate;
  fixture: ManualTrackerFixture;
  closeDatabase(): Promise<void>;
  cleanup(): Promise<void>;
}>> {
  const fixture = await loadManualTrackerFixture();
  const directory = await mkdtemp(join(tmpdir(), "fawn-tracker-"));
  const path = join(directory, "user.db");
  const database = new SQLiteTestDatabase(path);
  await database.migrate();
  await seedTrackerSourceMessage(database, fixture.sourceMessageId, fixture.createdAt);
  const transactions = new ExpoSqliteExclusiveTransactionAdapter(database);
  const repository = new TrackerRepository();
  const operations = new RuntimeOperationGate();
  const service = new ManualTrackerService(
    transactions,
    new DataMutationCoordinator(),
    repository,
    repository,
    new QueuedClock(Array(20).fill(fixture.createdAt)),
    new QueuedLocalIdGenerator(Object.values(fixture.domains).map((entry) => entry.id)),
    operations,
  );
  let closed = false;
  return Object.freeze({
    directory,
    path,
    database,
    transactions,
    repository,
    service,
    operations,
    fixture,
    async closeDatabase(): Promise<void> {
      if (!closed) {
        closed = true;
        await database.closeAsync();
      }
    },
    async cleanup(): Promise<void> {
      if (!closed) {
        closed = true;
        await database.closeAsync();
      }
      await rm(directory, { recursive: true, force: true });
    },
  });
}
