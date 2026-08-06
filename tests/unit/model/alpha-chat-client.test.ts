import assert from "node:assert/strict";
import test from "node:test";

import type { LoadedModelSettings } from "../../../src/application/settings/modelSettingsService.ts";
import { AlphaChatClientError, ChatCompletionsClient } from "../../../src/infrastructure/model/chatCompletionsClient.ts";

function settings(): LoadedModelSettings {
  return {
    config: {
      displayName: "默认模型",
      baseUrl: "https://provider.example/v1",
      chatPath: "chat/completions",
      modelId: "alpha-model",
      authMode: "bearer",
      headerNames: [],
    },
    secrets: { revision: 1, bearerToken: "private-token", headers: {} },
    updatedAt: "2026-08-05T00:00:00.000Z",
    cleanupPendingRevisions: [],
  };
}

test("alpha chat sends the minimal non-stream payload and returns text", async () => {
  let requestUrl = "";
  const client = new ChatCompletionsClient(async (input, init) => {
    requestUrl = input;
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer private-token");
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: "alpha-model",
      messages: [{ role: "user", content: "你好" }],
      stream: false,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: "  收到  " } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  assert.equal(await client.complete(settings(), [{ role: "user", content: "你好" }]), "收到");
  assert.equal(requestUrl, "https://provider.example/v1/chat/completions");
});

test("alpha chat rejects redirects and never includes the bearer token in errors", async () => {
  const client = new ChatCompletionsClient(async () => new Response(null, {
    status: 302,
    headers: { Location: "https://other.example/chat/completions" },
  }));
  await assert.rejects(
    client.complete(settings(), [{ role: "user", content: "你好" }]),
    (error: unknown) => error instanceof AlphaChatClientError && !error.message.includes("private-token"),
  );
});

test("alpha chat rejects malformed or empty provider answers", async () => {
  const client = new ChatCompletionsClient(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  await assert.rejects(
    client.complete(settings(), [{ role: "user", content: "你好" }]),
    (error: unknown) => error instanceof AlphaChatClientError && error.code === "protocol",
  );
});
