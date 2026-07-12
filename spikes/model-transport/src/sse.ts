import { createParser } from "eventsource-parser";

import { STREAM_LIMITS, TransportError } from "./contracts.ts";
import type { StreamLimits, StreamResult, ToolCall } from "./contracts.ts";

type MutableToolCall = {
  index: number;
  id?: string;
  name?: string;
  argumentsText: string;
};

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

function protocol(message: string): never {
  throw new TransportError("protocol", message);
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function mergeStableField(target: MutableToolCall, field: "id" | "name", value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) protocol(`Tool ${field} is invalid`);
  if (target[field] !== undefined && target[field] !== value) protocol(`Tool ${field} conflict`);
  target[field] = value;
}

function validateUsage(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) protocol("Usage metadata is invalid");
  for (const metric of Object.values(value)) {
    if (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)) {
      protocol("Usage metadata must contain only nonnegative numbers");
    }
  }
}

export async function parseChatCompletionSse(
  chunks: AsyncIterable<Uint8Array>,
  limits: StreamLimits = STREAM_LIMITS,
): Promise<StreamResult> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const tools = new Map<number, MutableToolCall>();
  let content = "";
  let finishReason: string | null = null;
  let responseBytes = 0;
  let doneCount = 0;
  let parserFailure: TransportError | undefined;

  const fail = (message: string): void => {
    parserFailure ??= new TransportError("protocol", message);
  };

  const parser = createParser({
    maxBufferSize: limits.maxParserBufferCharacters,
    onError(error) {
      fail(`SSE parser rejected input: ${error.type}`);
    },
    onRetry() {
      fail("SSE retry fields are unsupported");
    },
    onEvent(event) {
      if (parserFailure) return;
      try {
        if (event.event !== undefined) protocol("SSE event fields are unsupported");
        if (event.id !== undefined) protocol("SSE id fields are unsupported");
        if (byteLength(event.data) > limits.maxEventBytes) protocol("SSE event exceeds byte limit");
        if (event.data === "") return;
        if (event.data === "[DONE]") {
          doneCount += 1;
          if (doneCount !== 1) protocol("Duplicate [DONE]");
          return;
        }
        if (doneCount !== 0) protocol("Data followed [DONE]");

        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          protocol("Malformed SSE JSON");
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) protocol("SSE payload must be an object");
        const payloadObject = payload as Record<string, unknown>;
        if (!hasOnlyKeys(payloadObject, new Set(["id", "object", "created", "model", "system_fingerprint", "choices", "usage"]))) {
          protocol("SSE payload contains unsupported fields");
        }
        validateUsage(payloadObject.usage);
        const choices = payloadObject.choices;
        if (!Array.isArray(choices) || choices.length !== 1 || !choices[0] || typeof choices[0] !== "object" || Array.isArray(choices[0])) {
          protocol("SSE payload must contain exactly one first choice");
        }
        const choice = choices[0] as Record<string, unknown>;
        if (!hasOnlyKeys(choice, new Set(["index", "delta", "finish_reason"]))) protocol("SSE choice contains unsupported fields");
        if (choice.index !== undefined && choice.index !== 0) protocol("Only choice index zero is supported");
        if (!choice.delta || typeof choice.delta !== "object" || Array.isArray(choice.delta)) protocol("SSE choice delta is invalid");
        const delta = choice.delta as Record<string, unknown>;
        if (!hasOnlyKeys(delta, new Set(["content", "tool_calls"]))) protocol("SSE delta contains unsupported fields");

        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string") protocol("Content fragment is not a string");
          if (byteLength(delta.content) > limits.maxContentFragmentBytes) protocol("Content fragment exceeds byte limit");
          content += delta.content;
          if (byteLength(content) > limits.maxContentBytes) protocol("Aggregated content exceeds byte limit");
        }

        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) protocol("Tool fragments must be an array");
          for (const raw of delta.tool_calls) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) protocol("Tool fragment is invalid");
            const fragment = raw as Record<string, unknown>;
            if (!hasOnlyKeys(fragment, new Set(["index", "id", "type", "function"]))) protocol("Tool fragment contains unsupported fields");
            if (!Number.isInteger(fragment.index) || (fragment.index as number) < 0) protocol("Tool index is invalid");
            if (fragment.type !== undefined && fragment.type !== "function") protocol("Only function tool calls are supported");
            const index = fragment.index as number;
            let tool = tools.get(index);
            if (!tool) {
              if (tools.size >= limits.maxToolCalls) protocol("Tool count exceeds limit");
              tool = { index, argumentsText: "" };
              tools.set(index, tool);
            }
            mergeStableField(tool, "id", fragment.id);
            if (fragment.function !== undefined) {
              if (!fragment.function || typeof fragment.function !== "object" || Array.isArray(fragment.function)) protocol("Tool function is invalid");
              const fn = fragment.function as Record<string, unknown>;
              if (!hasOnlyKeys(fn, new Set(["name", "arguments"]))) protocol("Tool function contains unsupported fields");
              mergeStableField(tool, "name", fn.name);
              if (fn.arguments !== undefined) {
                if (typeof fn.arguments !== "string") protocol("Tool arguments fragment is invalid");
                tool.argumentsText += fn.arguments;
                if (byteLength(tool.argumentsText) > limits.maxToolArgumentBytes) protocol("Tool arguments exceed byte limit");
              }
            }
          }
        }

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== "string" || choice.finish_reason.length === 0) protocol("Finish reason is invalid");
          if (finishReason !== null && finishReason !== choice.finish_reason) protocol("Finish reason conflict");
          finishReason = choice.finish_reason;
        }
      } catch (error) {
        parserFailure = error instanceof TransportError ? error : new TransportError("protocol", "Invalid SSE event");
      }
    },
  });

  try {
    for await (const chunk of chunks) {
      responseBytes += chunk.length;
      if (responseBytes > limits.maxResponseBytes) protocol("Streaming response exceeds byte limit");
      parser.feed(decoder.decode(chunk, { stream: true }));
      if (parserFailure) throw parserFailure;
    }
    parser.feed(decoder.decode());
    parser.reset({ consume: true });
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError("protocol", "Invalid UTF-8 or SSE framing");
  }
  if (parserFailure) throw parserFailure;
  if (doneCount !== 1) protocol("Premature EOF before [DONE]");

  const toolCalls: ToolCall[] = Array.from(tools.values())
    .sort((left, right) => left.index - right.index)
    .map((tool) => {
      if (!tool.id || !tool.name) protocol("Incomplete tool call");
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(tool.argumentsText);
      } catch {
        protocol("Invalid final tool arguments JSON");
      }
      if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
        protocol("Final tool arguments must be a JSON object");
      }
      return { index: tool.index, id: tool.id, name: tool.name, argumentsText: tool.argumentsText, arguments: argumentsValue };
    });
  if (new Set(toolCalls.map((tool) => tool.id)).size !== toolCalls.length) protocol("Tool IDs must be unique");
  if (content.length === 0 && toolCalls.length === 0) protocol("Completed response has no content or tool call");
  return { content, finishReason, toolCalls, responseBytes };
}
