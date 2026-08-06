import assert from "node:assert/strict";
import test from "node:test";

import { RecentRecordsService } from "../../../src/application/insights/recentRecordsService.ts";
import type { ManualTrackerServicePort } from "../../../src/application/tracker/manualTrackerService.ts";

function tracker(): ManualTrackerServicePort {
  const list: ManualTrackerServicePort["list"] = async (domain) => {
    switch (domain) {
      case "growth": return [{
        id: "growth-1", measurementDate: "2026-08-01", weightG: 5200, heightCm: null,
        headCm: null, weightPercentile: null, heightPercentile: null, headPercentile: null,
        notes: null, sourceMessageId: null, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
      }] as never;
      case "feeding": return [{
        id: "feeding-1", feedTime: "2026-08-03T01:30:00.000Z", feedType: "formula",
        amountMl: 90, durationMin: null, notes: null, sourceMessageId: null,
        createdAt: "2026-08-03T01:30:00.000Z", updatedAt: "2026-08-03T01:30:00.000Z",
      }] as never;
      case "health": return [{
        id: "health-1", recordDate: "2026-08-02", recordType: "checkup",
        title: "常规复查", description: null, sourceMessageId: null,
        createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
      }] as never;
      default: return [];
    }
  };
  return {
    getById: async () => null,
    list,
    create: async () => { throw new Error("not used"); },
    update: async () => { throw new Error("not used"); },
    delete: async () => { throw new Error("not used"); },
  };
}

test("recent records merge five domains and sort newest first", async () => {
  const service = new RecentRecordsService(tracker(), {
    current: () => ({ instant: "2026-08-05T00:00:00.000Z", timeZone: "Asia/Shanghai" }),
  });
  const items = await service.list(50);
  assert.deepEqual(items.map((item) => `${item.domain}:${item.id}`), [
    "feeding:feeding-1",
    "health:health-1",
    "growth:growth-1",
  ]);
  assert.deepEqual(
    { domainLabel: items[0]?.domainLabel, secondary: items[0]?.secondary },
    { domainLabel: "喂养", secondary: "配方奶 · 量 90 毫升" },
  );
});

test("recent records reject unbounded list requests", async () => {
  const service = new RecentRecordsService(tracker(), {
    current: () => ({ instant: "2026-08-05T00:00:00.000Z", timeZone: "Asia/Shanghai" }),
  });
  await assert.rejects(service.list(0), RangeError);
  await assert.rejects(service.list(101), RangeError);
});
