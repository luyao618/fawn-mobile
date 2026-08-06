import assert from "node:assert/strict";
import test from "node:test";

import { AlphaChatFailure, AlphaChatService } from "../../../src/application/chat/alphaChatService.ts";
import type { RecentRecordItem } from "../../../src/application/insights/recentRecordsService.ts";
import type { LoadedModelSettings } from "../../../src/application/settings/modelSettingsService.ts";
import type { AlphaProviderMessage } from "../../../src/infrastructure/model/chatCompletionsClient.ts";

const loaded: LoadedModelSettings = {
  config: {
    displayName: "默认模型", baseUrl: "https://provider.example/v1", chatPath: "chat/completions",
    modelId: "alpha-model", authMode: "bearer", headerNames: [],
  },
  secrets: { revision: 1, bearerToken: "secret", headers: {} },
  updatedAt: "2026-08-05T00:00:00.000Z",
  cleanupPendingRevisions: [],
};

test("alpha chat builds bounded baby and recent-record context", async () => {
  const records: RecentRecordItem[] = Array.from({ length: 20 }, (_, index) => ({
    domain: "feeding",
    id: `feeding-${String(index)}`,
    domainLabel: "喂养",
    primary: `2026年8月${String(index + 1)}日`,
    secondary: "配方奶 · 量 90 毫升",
    accessibilityLabel: "喂养记录",
    occurredAt: `2026-08-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
  }));
  let capturedMessages: readonly AlphaProviderMessage[] = [];
  let requestedLimit = 0;
  const service = new AlphaChatService(
    { load: async () => loaded, save: async () => loaded, clear: async () => ({ deletedRevisions: [], failedRevisions: [], pendingRevisions: [] }) },
    {
      load: async () => ({
        profile: {
          name: "小鹿", sex: "female", birthDate: "2026-07-05", birthWeightG: null,
          birthHeightCm: null, birthHeadCm: null, isPremature: false, gestationalWeeks: null,
          createdAt: "2026-07-05T00:00:00.000Z", updatedAt: "2026-07-05T00:00:00.000Z",
        },
        exactAge: { status: "known", localDate: "2026-08-05", timeZone: "Asia/Shanghai", ageDays: 31, completedMonths: 1, remainingDays: 0 },
      }),
      save: async () => { throw new Error("not used"); },
    },
    { list: async (limit) => { requestedLimit = limit; return records; } },
    { complete: async (_settings, messages) => { capturedMessages = messages; return "请继续观察宝宝状态。"; } },
  );

  assert.deepEqual(await service.send(" 最近喂养怎么样？ "), {
    content: "请继续观察宝宝状态。",
    modelId: "alpha-model",
    contextRecordCount: 20,
  });
  assert.equal(requestedLimit, 20);
  assert.match(capturedMessages[0]?.content ?? "", /宝宝: 小鹿; 当前年龄: 1个月0天/);
  assert.equal(capturedMessages[0]?.content.match(/- 喂养:/g)?.length, 20);
  assert.deepEqual(capturedMessages[1], { role: "user", content: "最近喂养怎么样？" });
});

test("alpha chat requires model settings and a bounded question", async () => {
  const service = new AlphaChatService(
    { load: async () => null, save: async () => loaded, clear: async () => ({ deletedRevisions: [], failedRevisions: [], pendingRevisions: [] }) },
    { load: async () => { throw new Error("not used"); }, save: async () => { throw new Error("not used"); } },
    { list: async () => { throw new Error("not used"); } },
    { complete: async () => { throw new Error("not used"); } },
  );
  await assert.rejects(service.send("你好"), (error: unknown) => error instanceof AlphaChatFailure && error.code === "not_configured");
  await assert.rejects(service.send(" "), (error: unknown) => error instanceof AlphaChatFailure && error.code === "invalid_question");
});
