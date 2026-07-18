import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RuntimeOperationGate } from "../../../src/application/bootstrap/appRuntime.ts";
import { DataMutationCoordinator } from "../../../src/application/data/DataMutationCoordinator.ts";
import {
  BabyProfileService,
  type BabyProfileStore,
  type DeviceCalendarPort,
  type DeviceCalendarSnapshot,
} from "../../../src/application/profile/babyProfileService.ts";
import type { BabyProfileInput } from "../../../src/domain/baby/profile.ts";
import { ExpoSqliteExclusiveTransactionAdapter } from "../../../src/infrastructure/db/exclusiveTransaction.ts";
import { BabyProfileRepository } from "../../../src/infrastructure/db/repositories/babyProfileRepository.ts";
import { RepositoryConflictError } from "../../../src/infrastructure/db/repositories/conflicts.ts";
import { migratedTestDatabase } from "../../support/sqliteTestDatabase.ts";

const partialProfile: BabyProfileInput = Object.freeze({
  name: "小鹿",
  sex: null,
  birthDate: null,
  birthWeightG: null,
  birthHeightCm: null,
  birthHeadCm: null,
  isPremature: false,
  gestationalWeeks: null,
});

const fullProfile: BabyProfileInput = Object.freeze({
  name: "测试宝宝",
  sex: "female",
  birthDate: "2024-02-29",
  birthWeightG: 3_200,
  birthHeightCm: 50.5,
  birthHeadCm: 34.2,
  isPremature: true,
  gestationalWeeks: 36,
});

class QueueCalendar implements DeviceCalendarPort {
  constructor(private readonly snapshots: DeviceCalendarSnapshot[]) {}

  current(): DeviceCalendarSnapshot {
    const snapshot = this.snapshots.shift();
    if (!snapshot) throw new Error("No test calendar snapshot remains");
    return snapshot;
  }
}

function snapshot(instant: string, timeZone = "Asia/Shanghai"): DeviceCalendarSnapshot {
  return Object.freeze({ instant, timeZone });
}

function createService(
  database: Awaited<ReturnType<typeof migratedTestDatabase>>,
  snapshots: DeviceCalendarSnapshot[],
  store: BabyProfileStore = new BabyProfileRepository(),
  coordinator = new DataMutationCoordinator(),
  operations = new RuntimeOperationGate(),
): BabyProfileService {
  return new BabyProfileService(
    new ExpoSqliteExclusiveTransactionAdapter(database),
    coordinator,
    store,
    new QueueCalendar(snapshots),
    operations,
  );
}

test("profile service creates once, preserves created_at, and makes identical saves replay-safe", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const service = createService(database, [
    snapshot("2026-07-18T01:00:00.000Z"),
    snapshot("2026-07-18T01:00:01.000Z"),
    snapshot("2026-07-18T01:00:02.000Z"),
    snapshot("2026-07-18T01:00:03.000Z"),
    snapshot("2026-07-18T01:00:04.000Z"),
  ]);

  const first = await service.save(partialProfile, null);
  assert.equal(first.profile.createdAt, "2026-07-18T01:00:00.000Z");
  assert.equal(first.profile.updatedAt, "2026-07-18T01:00:00.000Z");
  assert.equal(first.exactAge.status, "unknown");

  const identical = await service.save(partialProfile, first.profile.updatedAt);
  assert.deepEqual(identical.profile, first.profile);

  const changed = await service.save(fullProfile, first.profile.updatedAt);
  assert.equal(changed.profile.createdAt, first.profile.createdAt);
  assert.equal(changed.profile.updatedAt, "2026-07-18T01:00:02.000Z");
  assert.equal(changed.exactAge.status, "known");

  const replay = await service.save(fullProfile, first.profile.updatedAt);
  assert.deepEqual(replay.profile, changed.profile);

  await assert.rejects(
    service.save({ ...fullProfile, name: "冲突写入" }, first.profile.updatedAt),
    (error) => error instanceof RepositoryConflictError && error.code === "stale_write",
  );
  const rows = await database.getAllAsync<Record<string, unknown>>(
    "SELECT singleton_id, name, birth_date, created_at, updated_at FROM baby_profile",
  );
  assert.deepEqual(rows.map((row) => ({ ...row })), [{
    singleton_id: 1,
    name: "测试宝宝",
    birth_date: "2024-02-29",
    created_at: "2026-07-18T01:00:00.000Z",
    updated_at: "2026-07-18T01:00:02.000Z",
  }]);
});

test("profile service rolls back a failed writer before a concurrent writer commits", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const repository = new BabyProfileRepository();
  const coordinator = new DataMutationCoordinator();
  let entered!: () => void;
  let release!: () => void;
  const writeEntered = new Promise<void>((resolve) => { entered = resolve; });
  const mayFail = new Promise<void>((resolve) => { release = resolve; });
  const failingStore: BabyProfileStore = {
    load: (transaction) => repository.load(transaction),
    async save(transaction, profile, expectedUpdatedAt, updatedAt) {
      await repository.save(transaction, profile, expectedUpdatedAt, updatedAt);
      entered();
      await mayFail;
      throw new Error("fail after profile write");
    },
  };
  const first = createService(
    database,
    [snapshot("2026-07-18T02:00:00.000Z")],
    failingStore,
    coordinator,
  ).save({ ...partialProfile, name: "回滚哨兵" }, null);
  await writeEntered;
  const second = createService(
    database,
    [snapshot("2026-07-18T02:00:01.000Z")],
    repository,
    coordinator,
  ).save({ ...partialProfile, name: "最终宝宝" }, null);
  release();
  await assert.rejects(first, /fail after profile write/);
  const committed = await second;
  assert.equal(committed.profile.name, "最终宝宝");
  assert.deepEqual(
    (await database.getAllAsync<{ name: string }>("SELECT name FROM baby_profile")).map((row) => row.name),
    ["最终宝宝"],
  );
});

test("repository decoding fails closed on corrupt restored rows and future birthdays", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync(
    `INSERT INTO baby_profile(
      singleton_id, name, sex, birth_date, birth_weight_g, birth_height_cm, birth_head_cm,
      is_premature, gestational_weeks, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    1, "坏数据", "female", "2024-02-30", 3_200, 50.5, 34.2, 1, 36,
    "2026-07-18T03:00:00.000Z", "2026-07-18T03:00:00.000Z",
  );
  await assert.rejects(
    createService(database, [snapshot("2026-07-18T03:00:01.000Z")]).load(),
    /local date/i,
  );

  await database.runAsync("UPDATE baby_profile SET birth_date = ? WHERE singleton_id = ?", "2027-01-01", 1);
  await assert.rejects(
    createService(database, [snapshot("2026-07-18T03:00:02.000Z")]).load(),
    /future/i,
  );
});

test("baby-profile SQL is bound and the repository never owns transaction control", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  const sentinel = "宝宝'); DROP TABLE baby_profile; --";
  await createService(database, [snapshot("2026-07-18T04:00:00.000Z")]).save({
    ...partialProfile,
    name: sentinel,
  }, null);
  assert.equal((await database.getAllAsync<{ name: string }>("SELECT name FROM baby_profile"))[0]!.name, sentinel);
  assert.equal((await database.getAllAsync<{ total: number }>(
    "SELECT count(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'baby_profile'",
  ))[0]!.total, 1);
  assert.equal(database.statements.some((statement) => statement.includes(sentinel)), false);

  const source = readFileSync(
    new URL("../../../src/infrastructure/db/repositories/babyProfileRepository.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
  assert.doesNotMatch(source, /INSERT\s+OR\s+REPLACE/i);
});
