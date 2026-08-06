import type { LoadedModelSettings } from "../../application/settings/modelSettingsService.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;

export type AlphaProviderMessage = Readonly<{
  role: "system" | "user";
  content: string;
}>;

export type AlphaChatClientErrorCode = "auth" | "rate_limit" | "server" | "protocol" | "network";

export class AlphaChatClientError extends Error {
  constructor(readonly code: AlphaChatClientErrorCode) {
    super(`Alpha chat request failed (${code})`);
    this.name = "AlphaChatClientError";
  }
}

export interface AlphaChatClientPort {
  complete(settings: LoadedModelSettings, messages: readonly AlphaProviderMessage[]): Promise<string>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function endpoint(settings: LoadedModelSettings): URL {
  const baseUrl = new URL(settings.config.baseUrl);
  const url = new URL(`${settings.config.baseUrl.replace(/\/+$/, "")}/${settings.config.chatPath}`);
  if (url.protocol !== "https:" || url.origin !== baseUrl.origin) throw new AlphaChatClientError("protocol");
  return url;
}

function errorForStatus(status: number): AlphaChatClientError {
  if (status === 401 || status === 403) return new AlphaChatClientError("auth");
  if (status === 429) return new AlphaChatClientError("rate_limit");
  if (status >= 500) return new AlphaChatClientError("server");
  return new AlphaChatClientError("protocol");
}

function answerFrom(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AlphaChatClientError("protocol");
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length < 1 || !choices[0] || typeof choices[0] !== "object" || Array.isArray(choices[0])) {
    throw new AlphaChatClientError("protocol");
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new AlphaChatClientError("protocol");
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string" || content.trim().length === 0) throw new AlphaChatClientError("protocol");
  return content.trim();
}

export class ChatCompletionsClient implements AlphaChatClientPort {
  constructor(private readonly fetchImpl: FetchLike) {}

  async complete(settings: LoadedModelSettings, messages: readonly AlphaProviderMessage[]): Promise<string> {
    if (!settings.secrets.bearerToken || messages.length === 0 || messages.some((message) => !message.content.trim())) {
      throw new AlphaChatClientError("protocol");
    }
    const url = endpoint(settings);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${settings.secrets.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: settings.config.modelId, messages, stream: false }),
      });
    } catch {
      throw new AlphaChatClientError("network");
    }
    if (response.status >= 300 && response.status < 400) throw new AlphaChatClientError("protocol");
    if (!response.ok) throw errorForStatus(response.status);
    if (response.url) {
      let finalUrl: URL;
      try {
        finalUrl = new URL(response.url);
      } catch {
        throw new AlphaChatClientError("protocol");
      }
      if (finalUrl.href !== url.href) throw new AlphaChatClientError("protocol");
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) throw new AlphaChatClientError("protocol");
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new AlphaChatClientError("network");
    }
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new AlphaChatClientError("protocol");
    try {
      return answerFrom(JSON.parse(text));
    } catch (error) {
      if (error instanceof AlphaChatClientError) throw error;
      throw new AlphaChatClientError("protocol");
    }
  }
}
