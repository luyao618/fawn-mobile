import assert from "node:assert/strict";
import test from "node:test";

import { streamChatCompletion } from "../../../spikes/model-transport/src/adapter.ts";
import { TransportError } from "../../../spikes/model-transport/src/contracts.ts";
import { startMockCompatibleServer } from "../../fixtures/providers/mockCompatibleServer.ts";

const payload = {
  model: "synthetic-model",
  messages: [{ role: "user", content: "synthetic transport probe" }],
  stream: true,
  temperature: 0.2,
} as const;

const sse = (content: string) => new TextEncoder().encode(
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
);

function responseAt(input: string | URL | Request, body: BodyInit | null, init?: ResponseInit): Response {
  const response = new Response(body, init);
  const value = input instanceof Request ? input.url : input.toString();
  Object.defineProperty(response, "url", { value });
  return response;
}

function chunkedFetch(bytes: Uint8Array, sizes: readonly number[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    let offset = 0;
    let index = 0;
    return responseAt(input, new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, offset + sizes[index % sizes.length]);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
        index += 1;
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
}

test("two mock-compatible profiles stream through the same adapter", async () => {
  const first = await streamChatCompletion(
    chunkedFetch(sse("profile-a ok"), [64]),
    new URL("https://provider.example/profile-a/chat/completions"),
    payload,
  );
  const second = await streamChatCompletion(
    chunkedFetch(sse("profile-b 宝宝 ok"), [1, 2, 5, 3]),
    new URL("https://provider.example/profile-b/chat/completions"),
    payload,
  );
  assert.equal(first.content, "profile-a ok");
  assert.equal(second.content, "profile-b 宝宝 ok");
});

test("two real local mock profiles and delayed abort use the same adapter", async (t) => {
  const server = await startMockCompatibleServer();
  t.after(server.close);
  const first = await streamChatCompletion(fetch, new URL(`${server.baseUrl}/profile-a/chat/completions`), payload);
  const second = await streamChatCompletion(fetch, new URL(`${server.baseUrl}/profile-b/chat/completions`), payload);
  assert.equal(first.content, "profile-a ok");
  assert.equal(second.content, "profile-b 宝宝 ok");
  assert.deepEqual(server.observedCookieHeaders(), [undefined, undefined]);
  const controller = new AbortController();
  const request = streamChatCompletion(fetch, new URL(`${server.baseUrl}/abort/chat/completions`), payload, controller.signal);
  const readiness = server.waitForAbortRequest();
  const prematureSettlement = request.then(
    () => { throw new Error("Abort request resolved before server observation"); },
    () => { throw new Error("Abort request rejected before server observation"); },
  );
  await Promise.race([readiness, prematureSettlement]);
  await readiness;
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, (error: unknown) => error instanceof TransportError && error.category === "cancelled");
  assert.deepEqual(server.observedCookieHeaders(), [undefined, undefined, undefined]);
});

test("missing abort request observation fails within a bounded timeout", async (t) => {
  const server = await startMockCompatibleServer();
  t.after(server.close);
  await assert.rejects(server.waitForAbortRequest(), /Timed out waiting for a validated abort request/);
});

test("UT-MODEL-004 AbortController produces the cancelled category", async () => {
  const controller = new AbortController();
  const abortingFetch = (async (input: string, init: RequestInit) => responseAt(input,
    new ReadableStream<Uint8Array>({
      start(streamController) {
        init.signal?.addEventListener("abort", () => streamController.error(new DOMException("Aborted", "AbortError")));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )) as typeof fetch;
  const request = streamChatCompletion(
    abortingFetch,
    new URL("https://provider.example/abort/chat/completions"),
    payload,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(request, (error: unknown) => error instanceof TransportError && error.category === "cancelled");
});


function delayedAbortRejection(delayMs: number): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      setTimeout(() => reject(init.signal?.reason), delayMs);
    }, { once: true });
  })) as typeof fetch;
}

test("cancellation remains the first cause when timeout precedes delayed native rejection", async () => {
  const controller = new AbortController();
  const request = streamChatCompletion(
    delayedAbortRejection(40),
    new URL("https://provider.example/race/chat/completions"),
    payload,
    { signal: controller.signal, timeoutMs: 20 },
  );
  setTimeout(() => controller.abort(new DOMException("Cancelled", "AbortError")), 5);
  await assert.rejects(request, (error: unknown) => error instanceof TransportError && error.category === "cancelled");
});

test("timeout remains the first cause when cancellation precedes delayed native rejection", async () => {
  const controller = new AbortController();
  const request = streamChatCompletion(
    delayedAbortRejection(40),
    new URL("https://provider.example/race/chat/completions"),
    payload,
    { signal: controller.signal, timeoutMs: 5 },
  );
  setTimeout(() => controller.abort(new DOMException("Cancelled", "AbortError")), 20);
  await assert.rejects(request, (error: unknown) => error instanceof TransportError && error.category === "timeout");
});

test("redirects are protocol errors", async () => {
  const redirectFetch = async (input: string | URL | Request) => responseAt(input, null, { status: 302, headers: { Location: "https://other.example/" } });
  await assert.rejects(
    streamChatCompletion(redirectFetch, new URL("https://provider.example/v1/chat/completions"), payload),
    (error: unknown) => error instanceof TransportError && error.category === "protocol",
  );
});

test("manual redirect, exact payload, headers, and changed final URL fail closed", async () => {
  let capturedInit: RequestInit | undefined;
  const inspectingFetch = (async (input: string, init: RequestInit) => {
    capturedInit = init;
    return responseAt(input, sse("ok"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Final-URL": "https://evil.example/" },
    });
  }) as typeof fetch;
  await streamChatCompletion(
    inspectingFetch,
    new URL("https://provider.example/v1/chat/completions"),
    { ...payload, reasoning_effort: "high" } as typeof payload,
    { auth: { mode: "bearer", token: "secret" } },
  );
  assert(capturedInit);
  assert.equal(capturedInit.redirect, "manual");
  assert.equal(capturedInit.credentials, "omit");
  assert.equal(new Headers(capturedInit.headers).has("Cookie"), false);
  assert.equal((capturedInit.headers as Record<string, string>).Authorization, "Bearer secret");
  assert.equal("reasoning_effort" in JSON.parse(capturedInit.body as string), false);

  for (const finalUrl of [
    "https://provider.example/escaped/chat/completions",
    "https://evil.example/chat/completions",
  ]) {
    const changedFinalUrlFetch = (async () => {
      const response = new Response(sse("ok"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      Object.defineProperty(response, "url", { value: finalUrl });
      return response;
    }) as typeof fetch;
    await assert.rejects(
      streamChatCompletion(changedFinalUrlFetch, new URL("https://provider.example/v1/chat/completions"), payload),
      (error: unknown) => error instanceof TransportError && error.category === "protocol",
    );
  }
  for (const finalUrl of ["", "not a url"]) {
    const invalidFinalUrlFetch = (async () => {
      const response = new Response(sse("ok"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      Object.defineProperty(response, "url", { value: finalUrl });
      return response;
    }) as typeof fetch;
    await assert.rejects(
      streamChatCompletion(invalidFinalUrlFetch, new URL("https://provider.example/v1/chat/completions"), payload),
      (error: unknown) => error instanceof TransportError && error.category === "protocol",
    );
  }
});

test("mid-stream native read failures remain secret-safe transport errors", async () => {
  let reads = 0;
  const failingFetch = (async (input: string | URL | Request) => responseAt(input, new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      if (reads === 1) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
      } else {
        controller.error(new Error("Bearer mid-stream-secret"));
      }
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  await assert.rejects(
    streamChatCompletion(failingFetch, new URL("https://provider.example/v1/chat/completions"), payload),
    (error: unknown) => error instanceof TransportError
      && error.category === "transport"
      && error.message === "Streaming response read failed"
      && !error.message.includes("secret"),
  );
});

test("status, timeout, content type, and transport failures use fixed categories", async () => {
  const cases: Array<[number, string]> = [[401, "auth"], [403, "auth"], [429, "rate_limit"], [500, "server"], [422, "unsupported_capability"]];
  for (const [status, category] of cases) {
    await assert.rejects(
      streamChatCompletion(async (input) => responseAt(input, null, { status }), new URL("https://provider.example/v1/chat/completions"), payload),
      (error: unknown) => error instanceof TransportError && error.category === category,
    );
  }
  await assert.rejects(
    streamChatCompletion(async (input) => responseAt(input, "json", { headers: { "Content-Type": "application/json" } }), new URL("https://provider.example/v1/chat/completions"), payload),
    (error: unknown) => error instanceof TransportError && error.category === "protocol",
  );
  await assert.rejects(
    streamChatCompletion((_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }), new URL("https://provider.example/v1/chat/completions"), payload, { timeoutMs: 10 }),
    (error: unknown) => error instanceof TransportError && error.category === "timeout",
  );
  await assert.rejects(
    streamChatCompletion(async () => { throw new Error("Bearer secret"); }, new URL("https://provider.example/v1/chat/completions"), payload),
    (error: unknown) => error instanceof TransportError && error.category === "transport" && !error.message.includes("secret"),
  );
});
