import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatCompletionsUrl,
  buildRequestHeaders,
  buildStreamingChatRequest,
  diagnosticHeaderNames,
  redactDiagnostic,
} from "../../../spikes/model-transport/src/url.ts";

test("UT-MODEL-001 normalizes only trailing base URL slashes", () => {
  assert.equal(
    buildChatCompletionsUrl("https://proxy.example.com/openai///", "chat/completions").toString(),
    "https://proxy.example.com/openai/chat/completions",
  );
  assert.throws(() => buildChatCompletionsUrl("https://user:pass@example.com/v1"), /credentials/);
  assert.throws(() => buildChatCompletionsUrl("https://example.com/v1", "../responses"), /parent|relative path/);
  assert.throws(() => buildChatCompletionsUrl("https://example.com/v1?leak=yes"), /queries/);
  assert.equal(buildChatCompletionsUrl("http://10.0.2.2:43117/profile", "chat/completions", true).origin, "http://10.0.2.2:43117");
  assert.throws(() => buildChatCompletionsUrl("http://192.168.1.5:43117", "chat/completions", true), /loopback/);
  for (const hostile of [
    "..\\responses", "%2e%2e/responses", "%252e%252e/responses",
    "safe%2f..%2fresponses", "safe%252f..%252fresponses", "safe%5c..%5cresponses", "%",
  ]) {
    assert.throws(() => buildChatCompletionsUrl("https://example.com/v1", hostile), /path|escape|separator/i);
  }
});

test("UT-MODEL-002 redacts secret values", () => {
  const output = redactDiagnostic("Authorization: Bearer sk-test api_key=private token=abc123 status=401");
  assert.equal(output.includes("sk-test"), false);
  assert.equal(output.includes("private"), false);
  assert.equal(output.includes("abc123"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("header ownership rejects overrides and diagnostics contain names only", () => {
  const bearer = buildRequestHeaders({ mode: "bearer", token: "sk-private" });
  assert.equal(bearer.Authorization, "Bearer sk-private");
  assert.deepEqual(diagnosticHeaderNames(bearer), {
    Accept: "[REDACTED]",
    Authorization: "[REDACTED]",
    "Content-Type": "[REDACTED]",
  });
  for (const name of ["Host", "content-length", "Authorization", "Accept", "Origin", "Referer"]) {
    assert.throws(() => buildRequestHeaders({ mode: "custom", headers: { [name]: "secret" } }), /forbidden/);
  }
  assert.throws(() => buildRequestHeaders({ mode: "custom", headers: { "X-Key": "value\r\nInjected: yes" } }), /invalid/);
  assert.deepEqual(buildRequestHeaders({ mode: "custom", headers: { "X-Provider-Key": "secret" } }), {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "X-Provider-Key": "secret",
  });
});

test("Chat Completions request builder forwards only frozen fields", () => {
  const input = {
    model: "model-a",
    messages: [{ role: "user" as const, content: "hello" }],
    temperature: 0.2,
    tools: [{ type: "function" }],
    toolChoice: "auto" as const,
    reasoning_effort: "high",
  };
  assert.deepEqual(buildStreamingChatRequest(input), {
    model: "model-a",
    messages: input.messages,
    stream: true,
    temperature: 0.2,
    tools: input.tools,
    tool_choice: "auto",
  });
});
