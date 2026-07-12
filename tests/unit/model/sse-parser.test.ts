import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STREAM_LIMITS, TransportError } from "../../../spikes/model-transport/src/contracts.ts";
import { parseChatCompletionSse } from "../../../spikes/model-transport/src/sse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(here, `../../fixtures/providers/chat-completions/${name}`);
const encode = (value: string) => new TextEncoder().encode(value);

async function* splitEvery(bytes: Uint8Array, sizes: readonly number[]): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = sizes[index % sizes.length];
    yield bytes.slice(offset, offset + size);
    offset += size;
    index += 1;
  }
}

test("UT-MODEL-003 handles comments, keep-alives, split JSON and split UTF-8", async () => {
  const bytes = new Uint8Array(await readFile(fixture("profile-a.sse")));
  const result = await parseChatCompletionSse(splitEvery(bytes, [1, 2, 5, 3]));
  assert.equal(result.content, "hello 宝宝");
  assert.equal(result.finishReason, "stop");
});

test("UT-MODEL-011 merges split tool fragments", async () => {
  const bytes = new Uint8Array(await readFile(fixture("profile-b.sse")));
  const result = await parseChatCompletionSse(splitEvery(bytes, [7, 1, 13]));
  assert.deepEqual(result.toolCalls[0].arguments, {
    feed_type: "formula",
    feed_time: "2026-07-11T10:00:00Z",
    amount_ml: 90,
  });
});

test("UT-MODEL-003 rejects malformed JSON and premature EOF", async () => {
  for (const name of ["malformed-json.sse", "premature-eof.sse"]) {
    const bytes = new Uint8Array(await readFile(fixture(name)));
    await assert.rejects(parseChatCompletionSse(splitEvery(bytes, [4])), TransportError);
  }
});

test("UT-MODEL-003 rejects invalid UTF-8", async () => {
  async function* invalid(): AsyncGenerator<Uint8Array> {
    yield Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a]);
  }
  await assert.rejects(parseChatCompletionSse(invalid()), /Invalid UTF-8/);
});

test("strict limits reject oversized response, event and content fragments", async () => {
  const cases = [
    { input: `data: ${"x".repeat(100)}\n\n`, limits: { ...STREAM_LIMITS, maxResponseBytes: 20 } },
    { input: `data: ${"x".repeat(100)}\n\n`, limits: { ...STREAM_LIMITS, maxEventBytes: 20 } },
    {
      input: `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(100) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      limits: { ...STREAM_LIMITS, maxContentFragmentBytes: 20 },
    },
  ];
  for (const item of cases) {
    await assert.rejects(parseChatCompletionSse(splitEvery(encode(item.input), [11]), item.limits), TransportError);
  }
});

test("strict grammar rejects event, id, retry, unknown field, and multiple choices", async () => {
  const valid = JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
  const cases = [
    `event: message\ndata: ${valid}\n\ndata: [DONE]\n\n`,
    `id: 7\ndata: ${valid}\n\ndata: [DONE]\n\n`,
    `retry: 1000\ndata: ${valid}\n\ndata: [DONE]\n\n`,
    `wat: unsupported\ndata: ${valid}\n\ndata: [DONE]\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }, { delta: { content: "b" } }] })}\n\ndata: [DONE]\n\n`,
    `data: ${JSON.stringify({ input: "responses-shape", choices: [{ delta: { content: "a" } }] })}\n\ndata: [DONE]\n\n`,
  ];
  for (const input of cases) await assert.rejects(parseChatCompletionSse(splitEvery(encode(input), [1, 3, 8])), TransportError);
});

test("exactly one DONE is terminal and trailing comments remain harmless", async () => {
  const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`;
  const valid = await parseChatCompletionSse(splitEvery(encode(`${event}data: [DONE]\n\n: trailing comment\n\n`), [2]));
  assert.equal(valid.content, "ok");
  for (const suffix of ["data: [DONE]\n\n", `${event}`]) {
    await assert.rejects(parseChatCompletionSse(splitEvery(encode(`${event}data: [DONE]\n\n${suffix}`), [5])), TransportError);
  }
});

test("aggregate content, parser buffer, tool count, and tool arguments remain bounded", async () => {
  const contentEvent = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
  await assert.rejects(
    parseChatCompletionSse(splitEvery(encode(`${contentEvent("12345")}${contentEvent("67890")}data: [DONE]\n\n`), [7]), { ...STREAM_LIMITS, maxContentBytes: 8 }),
    /Aggregated content/,
  );
  await assert.rejects(
    parseChatCompletionSse(splitEvery(encode(`data: ${"x".repeat(80)}`), [9]), { ...STREAM_LIMITS, maxParserBufferCharacters: 20 }),
    TransportError,
  );
  const twoTools = JSON.stringify({ choices: [{ delta: { tool_calls: [
    { index: 0, id: "a", function: { name: "one", arguments: "{}" } },
    { index: 1, id: "b", function: { name: "two", arguments: "{}" } },
  ] }, finish_reason: "tool_calls" }] });
  await assert.rejects(
    parseChatCompletionSse(splitEvery(encode(`data: ${twoTools}\n\ndata: [DONE]\n\n`), [17]), { ...STREAM_LIMITS, maxToolCalls: 1 }),
    /Tool count/,
  );
  const longArgs = JSON.stringify({ choices: [{ delta: { tool_calls: [
    { index: 0, id: "a", function: { name: "one", arguments: JSON.stringify({ x: "123456" }) } },
  ] }, finish_reason: "tool_calls" }] });
  await assert.rejects(
    parseChatCompletionSse(splitEvery(encode(`data: ${longArgs}\n\ndata: [DONE]\n\n`), [13]), { ...STREAM_LIMITS, maxToolArgumentBytes: 5 }),
    /Tool arguments/,
  );
});

test("tool identity is stable and final arguments are JSON objects", async () => {
  const stream = (events: readonly unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const conflict = stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: "{}" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "b" }] }, finish_reason: "tool_calls" }] },
  ]);
  await assert.rejects(parseChatCompletionSse(splitEvery(encode(conflict), [11])), /Tool id conflict/);
  for (const argumentsText of ["not-json", "[]", "null"]) {
    const input = stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: argumentsText } }] }, finish_reason: "tool_calls" }] }]);
    await assert.rejects(parseChatCompletionSse(splitEvery(encode(input), [19])), TransportError);
  }
});
