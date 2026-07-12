export type TransportErrorCategory =
  | "invalid_config"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "transport"
  | "protocol"
  | "unsupported_capability"
  | "server"
  | "cancelled";

export class TransportError extends Error {
  constructor(
    readonly category: TransportErrorCategory,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export type StreamLimits = Readonly<{
  maxResponseBytes: number;
  maxParserBufferCharacters: number;
  maxEventBytes: number;
  maxContentFragmentBytes: number;
  maxContentBytes: number;
  maxToolArgumentBytes: number;
  maxToolCalls: number;
}>;

export const STREAM_LIMITS: StreamLimits = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxParserBufferCharacters: 128 * 1024,
  maxEventBytes: 64 * 1024,
  maxContentFragmentBytes: 16 * 1024,
  maxContentBytes: 256 * 1024,
  maxToolArgumentBytes: 64 * 1024,
  maxToolCalls: 32,
});

export type ToolCall = Readonly<{
  index: number;
  id: string;
  name: string;
  argumentsText: string;
  arguments: unknown;
}>;

export type StreamResult = Readonly<{
  content: string;
  finishReason: string | null;
  toolCalls: readonly ToolCall[];
  responseBytes: number;
}>;

export type ChatMessage = Readonly<{
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}>;

export type ChatCompletionRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  stream: true;
  temperature?: number;
  tools?: readonly unknown[];
  tool_choice?: "auto" | "none";
}>;

export type ProviderAuth =
  | Readonly<{ mode: "none" }>
  | Readonly<{ mode: "bearer"; token: string }>
  | Readonly<{ mode: "custom"; headers: Readonly<Record<string, string>> }>;

export type TransportRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  auth?: ProviderAuth;
}>;
