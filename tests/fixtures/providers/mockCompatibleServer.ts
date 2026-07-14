import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type RunningServer = Readonly<{
  baseUrl: string;
  observedCookieHeaders: () => readonly (string | undefined)[];
  waitForAbortRequest: () => Promise<void>;
  close: () => Promise<void>;
}>;

const ABORT_REQUEST_OBSERVATION_TIMEOUT_MS = 1_000;

function waitForObservation(observation: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for a validated abort request"));
    }, ABORT_REQUEST_OBSERVATION_TIMEOUT_MS);
    observation.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const value = JSON.parse(body) as Record<string, unknown>;
  if (value.stream !== true || !Array.isArray(value.messages) || typeof value.model !== "string") {
    throw new Error("Request is not the frozen Chat Completions stream shape");
  }
  if ("input" in value || "response" in value) throw new Error("Responses API fields are forbidden");
  const allowed = new Set(["model", "messages", "stream", "temperature", "tools", "tool_choice"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Unknown provider fields are forbidden");
  return value;
}

function event(content: string, finishReason: string | null): Buffer {
  return Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n`);
}

async function writeProfileA(response: ServerResponse): Promise<void> {
  response.write(": profile-a keepalive\n\n");
  response.write(event("profile-a ", null));
  response.write(event("ok", "stop"));
  response.end("data: [DONE]\n\n");
}

async function writeProfileB(response: ServerResponse): Promise<void> {
  const stream = Buffer.concat([event("profile-b ", null), event("宝宝 ok", "stop"), Buffer.from("data: [DONE]\n\n")]);
  const splitPoints = [1, 17, 43, 71, 89, 113, stream.length];
  let offset = 0;
  for (const point of splitPoints) {
    const end = Math.min(point, stream.length);
    if (end > offset) response.write(stream.subarray(offset, end));
    offset = end;
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  if (offset < stream.length) response.write(stream.subarray(offset));
  response.end();
}

export async function startMockCompatibleServer(port = 0): Promise<RunningServer> {
  const cookieHeaders: (string | undefined)[] = [];
  let resolveAbortRequest!: () => void;
  const abortRequestObserved = new Promise<void>((resolve) => {
    resolveAbortRequest = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      cookieHeaders.push(request.headers.cookie);
      if (request.headers.cookie !== undefined) throw new Error("Ambient Cookie headers are forbidden");
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      await readJson(request);
      if (request.url.startsWith("/abort/")) resolveAbortRequest();
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (request.url.startsWith("/abort/")) {
        setTimeout(() => {
          if (!response.destroyed) writeProfileA(response).catch(() => response.destroy());
        }, 2_000);
        return;
      }
      if (request.url.startsWith("/profile-a/")) await writeProfileA(response);
      else if (request.url.startsWith("/profile-b/")) await writeProfileB(response);
      else response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observedCookieHeaders: () => Object.freeze([...cookieHeaders]),
    waitForAbortRequest: () => waitForObservation(abortRequestObserved),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
