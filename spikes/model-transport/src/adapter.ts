import { STREAM_LIMITS, TransportError } from "./contracts.ts";
import type { ChatCompletionRequest, StreamResult, TransportRequestOptions } from "./contracts.ts";
import { parseChatCompletionSse } from "./sse.ts";
import { buildRequestHeaders } from "./url.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function statusCategory(status: number): "auth" | "rate_limit" | "server" | "unsupported_capability" {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "unsupported_capability";
}

function normalizePayload(payload: ChatCompletionRequest): ChatCompletionRequest {
  if (!payload || typeof payload !== "object" || payload.stream !== true || !payload.model?.trim() || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new TransportError("invalid_config", "Chat Completions stream payload is invalid");
  }
  const messages = payload.messages.map((message) => {
    if (!message || !["system", "user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string" || message.content.length === 0) {
      throw new TransportError("invalid_config", "Chat message is invalid");
    }
    return { role: message.role, content: message.content };
  });
  const normalized: {
    model: string;
    messages: typeof messages;
    stream: true;
    temperature?: number;
    tools?: readonly unknown[];
    tool_choice?: "auto" | "none";
  } = { model: payload.model, messages, stream: true };
  if (payload.temperature !== undefined) {
    if (!Number.isFinite(payload.temperature) || payload.temperature < 0 || payload.temperature > 2) {
      throw new TransportError("invalid_config", "Temperature is out of range");
    }
    normalized.temperature = payload.temperature;
  }
  if (payload.tools !== undefined) {
    if (!Array.isArray(payload.tools) || payload.tools.length === 0) throw new TransportError("invalid_config", "Tools must be a nonempty array");
    normalized.tools = payload.tools;
    normalized.tool_choice = payload.tool_choice ?? "auto";
  } else if (payload.tool_choice !== undefined) {
    throw new TransportError("invalid_config", "tool_choice requires tools");
  }
  return normalized;
}

async function* responseChunks(response: Response, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new TransportError("protocol", "Streaming response has no body");
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new TransportError("transport", "Streaming response read failed");
      }
      const { done, value } = result;
      if (done) return;
      if (value) yield value;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function parseOptions(signalOrOptions?: AbortSignal | TransportRequestOptions): TransportRequestOptions {
  return signalOrOptions && "aborted" in signalOrOptions ? { signal: signalOrOptions } : (signalOrOptions ?? {});
}

export async function streamChatCompletion(
  fetchImpl: FetchLike,
  url: URL,
  payload: ChatCompletionRequest,
  signalOrOptions?: AbortSignal | TransportRequestOptions,
): Promise<StreamResult> {
  const options = parseOptions(signalOrOptions);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "10.0.2.2"].includes(url.hostname))) {
    throw new TransportError("invalid_config", "Transport URL must use HTTPS or emulator/simulator loopback HTTP");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new TransportError("invalid_config", "Timeout must be a positive finite duration");
  }
  const normalizedPayload = normalizePayload(payload);
  const controller = new AbortController();
  let abortCause: "cancelled" | "timeout" | undefined;
  const abortOnce = (cause: "cancelled" | "timeout", reason: unknown) => {
    if (abortCause !== undefined) return;
    abortCause = cause;
    controller.abort(reason);
  };
  const relayAbort = () => abortOnce("cancelled", options.signal?.reason);
  if (options.signal?.aborted) relayAbort();
  else options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    abortOnce("timeout", new DOMException("Deadline exceeded", "TimeoutError"));
  }, options.timeoutMs);

  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: buildRequestHeaders(options.auth),
      body: JSON.stringify(normalizedPayload),
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new TransportError("protocol", "Redirects are forbidden", response.status);
    }
    if (!response.ok) {
      throw new TransportError(statusCategory(response.status), `Provider returned HTTP ${response.status}`, response.status);
    }
    if (!response.url) throw new TransportError("protocol", "Final response URL is required");
    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url);
    } catch {
      throw new TransportError("protocol", "Final response URL is invalid");
    }
    if (finalUrl.href !== url.href) throw new TransportError("protocol", "Final response URL changed");
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw new TransportError("protocol", "Streaming response content type is invalid");
    }
    return await parseChatCompletionSse(responseChunks(response, controller.signal), STREAM_LIMITS);
  } catch (error) {
    if (abortCause === "timeout") throw new TransportError("timeout", "Request deadline exceeded");
    if (abortCause === "cancelled") throw new TransportError("cancelled", "Request cancelled");
    if (error instanceof TransportError) throw error;
    throw new TransportError("transport", "Network request failed");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}
