import { TransportError } from "./contracts.ts";
import type { ChatCompletionRequest, ChatMessage, ProviderAuth } from "./contracts.ts";

const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "origin",
  "referer",
  "content-type",
  "accept",
  "authorization",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOCAL_CLEAR_TEXT_HOSTS = new Set(["127.0.0.1", "localhost", "10.0.2.2"]);

export function buildChatCompletionsUrl(
  baseUrl: string,
  chatPath = "chat/completions",
  allowLocalCleartext = false,
): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new TransportError("invalid_config", "Base URL must be absolute");
  }
  if (base.username || base.password || base.hash) {
    throw new TransportError("invalid_config", "Base URL credentials and fragments are forbidden");
  }
  if (base.protocol !== "https:" && !(allowLocalCleartext && base.protocol === "http:")) {
    throw new TransportError("invalid_config", "HTTPS is required unless local cleartext is enabled");
  }
  if (base.protocol === "http:" && !LOCAL_CLEAR_TEXT_HOSTS.has(base.hostname)) {
    throw new TransportError("invalid_config", "Local cleartext is limited to simulator and emulator loopback hosts");
  }
  if (base.search) {
    throw new TransportError("invalid_config", "Base URL queries are forbidden");
  }
  if (
    !chatPath ||
    chatPath.startsWith("/") ||
    chatPath.includes("\\") ||
    chatPath.includes("?") ||
    chatPath.includes("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(chatPath)
  ) {
    throw new TransportError("invalid_config", "Chat path must be a safe relative path");
  }
  let decodedPath = chatPath;
  for (let depth = 0; depth < 4; depth += 1) {
    if (/%(?:2f|5c)/i.test(decodedPath)) {
      throw new TransportError("invalid_config", "Encoded path separators are forbidden");
    }
    let next: string;
    try {
      next = decodeURIComponent(decodedPath);
    } catch {
      throw new TransportError("invalid_config", "Chat path contains malformed escapes");
    }
    if (next.includes("\\") || next.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new TransportError("invalid_config", "Chat path must not contain parent or separator escapes");
    }
    if (next === decodedPath) break;
    decodedPath = next;
    if (depth === 3 && /%[0-9a-f]{2}/i.test(decodedPath)) {
      throw new TransportError("invalid_config", "Chat path encoding is too deeply nested");
    }
  }
  const normalizedBase = base.toString().replace(/\/+$/, "");
  const result = new URL(`${normalizedBase}/${chatPath}`);
  const basePath = `${new URL(`${normalizedBase}/`).pathname.replace(/\/+$/, "")}/`;
  if (result.origin !== base.origin || !result.pathname.startsWith(basePath)) {
    throw new TransportError("invalid_config", "Chat path escapes the configured base path");
  }
  return result;
}

export function buildRequestHeaders(auth: ProviderAuth = { mode: "none" }): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  if (auth.mode === "none") return Object.freeze(headers);
  if (auth.mode === "bearer") {
    if (!auth.token || /[\r\n]/.test(auth.token)) {
      throw new TransportError("invalid_config", "Bearer credential is invalid");
    }
    headers.Authorization = `Bearer ${auth.token}`;
    return Object.freeze(headers);
  }
  for (const [name, value] of Object.entries(auth.headers)) {
    const normalized = name.toLowerCase();
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(normalized)) {
      throw new TransportError("invalid_config", `Custom header is forbidden: ${redactDiagnostic(name)}`);
    }
    if (!value || /[\r\n]/.test(value)) {
      throw new TransportError("invalid_config", `Custom header value is invalid for ${redactDiagnostic(name)}`);
    }
    headers[name] = value;
  }
  return Object.freeze(headers);
}

export function diagnosticHeaderNames(headers: Readonly<Record<string, string>>): Readonly<Record<string, "[REDACTED]">> {
  return Object.freeze(Object.fromEntries(Object.keys(headers).sort().map((name) => [name, "[REDACTED]" as const])) as Record<string, "[REDACTED]">);
}

export function buildStreamingChatRequest(input: Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  tools?: readonly unknown[];
  toolChoice?: "auto" | "none";
}>): ChatCompletionRequest {
  if (!input.model.trim() || input.messages.length === 0) {
    throw new TransportError("invalid_config", "Model and at least one message are required");
  }
  for (const message of input.messages) {
    if (!message.content || !["system", "user", "assistant", "tool"].includes(message.role)) {
      throw new TransportError("invalid_config", "Chat message is invalid");
    }
  }
  if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) {
    throw new TransportError("invalid_config", "Temperature is out of range");
  }
  const request: {
    model: string;
    messages: readonly ChatMessage[];
    stream: true;
    temperature?: number;
    tools?: readonly unknown[];
    tool_choice?: "auto" | "none";
  } = { model: input.model, messages: input.messages, stream: true };
  if (input.temperature !== undefined) request.temperature = input.temperature;
  if (input.tools?.length) {
    request.tools = input.tools;
    request.tool_choice = input.toolChoice ?? "auto";
  }
  return Object.freeze(request);
}

const SECRET_PATTERN = /(authorization|api[-_]?key|token|secret|password)\s*[:=]\s*([^\s,;]+)/gi;

export function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(SECRET_PATTERN, "$1=[REDACTED]");
}
