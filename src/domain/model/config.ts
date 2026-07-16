export type ModelAuthMode = "bearer" | "custom";

export type ModelConfigInput = Readonly<{
  displayName: string;
  baseUrl: string;
  chatPath?: string;
  modelId: string;
  authMode: ModelAuthMode;
  headerNames?: readonly string[];
}>;

export type ModelConfig = Readonly<{
  displayName: string;
  baseUrl: string;
  chatPath: string;
  modelId: string;
  authMode: ModelAuthMode;
  headerNames: readonly string[];
}>;

export type ModelSecretBundle = Readonly<{
  revision: number;
  bearerToken?: string;
  headers: Readonly<Record<string, string>>;
}>;

export class ModelConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigValidationError";
  }
}

export const MODEL_INPUT_LIMITS = Object.freeze({
  displayNameLength: 128,
  baseUrlLength: 2_048,
  chatPathLength: 1_024,
  modelIdLength: 256,
  headerCount: 32,
  headerNameLength: 128,
  headerNamesJsonBytes: 4_193,
  headerValueLength: 8_192,
  bearerTokenLength: 16_384,
  secureStoreBundleBytes: 65_536,
});

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set([
  "accept", "authorization", "connection", "content-length", "content-type", "cookie",
  "cf-connecting-ip", "client-ip", "fastly-client-ip", "forwarded", "host", "origin",
  "proxy-authenticate", "proxy-authorization", "proxy-connection", "referer", "te", "trailer",
  "transfer-encoding", "true-client-ip", "upgrade", "via", "x-real-ip",
]);

function requiredText(value: string, label: string, maximumLength: number): string {
  if (typeof value !== "string") throw new ModelConfigValidationError(`${label} is required`);
  const normalized = value.trim();
  if (!normalized) throw new ModelConfigValidationError(`${label} is required`);
  if (normalized.length > maximumLength) throw new ModelConfigValidationError(`${label} is too long`);
  return normalized;
}

export function normalizeBaseUrl(value: string): string {
  const input = requiredText(value, "Base URL", MODEL_INPUT_LIMITS.baseUrlLength);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ModelConfigValidationError("Base URL must be absolute");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new ModelConfigValidationError("Base URL must be HTTPS without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeChatPath(value = "chat/completions"): string {
  const path = requiredText(value, "Chat path", MODEL_INPUT_LIMITS.chatPathLength);
  if (path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new ModelConfigValidationError("Chat path must be a safe relative path");
  }
  let decoded = path;
  for (let depth = 0; depth < 4; depth += 1) {
    if (/%(?:2f|5c)/i.test(decoded)) throw new ModelConfigValidationError("Chat path contains an encoded separator");
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new ModelConfigValidationError("Chat path contains malformed escapes");
    }
    if (next.includes("\\") || next.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new ModelConfigValidationError("Chat path must not escape its base path");
    }
    if (next === decoded) return path;
    decoded = next;
  }
  throw new ModelConfigValidationError("Chat path encoding is too deeply nested");
}

export function normalizeHeaderNames(values: readonly string[] = []): readonly string[] {
  if (!Array.isArray(values) || values.length > MODEL_INPUT_LIMITS.headerCount) {
    throw new ModelConfigValidationError("Too many custom header names");
  }
  const names = new Map<string, string>();
  for (const rawName of values) {
    if (typeof rawName !== "string") throw new ModelConfigValidationError("A custom header name is invalid or reserved");
    const name = rawName.trim();
    const normalized = name.toLowerCase();
    if (name.length > MODEL_INPUT_LIMITS.headerNameLength || !HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(normalized) || normalized.startsWith("x-forwarded-")) {
      throw new ModelConfigValidationError("A custom header name is invalid or reserved");
    }
    if (names.has(normalized)) throw new ModelConfigValidationError("Custom header names must be unique");
    names.set(normalized, name);
  }
  return Object.freeze([...names.values()].sort((left, right) => left.localeCompare(right)));
}

export function normalizeModelConfig(input: ModelConfigInput): ModelConfig {
  if (input.authMode !== "bearer" && input.authMode !== "custom") {
    throw new ModelConfigValidationError("Authentication mode is invalid");
  }
  const headerNames = normalizeHeaderNames(input.headerNames);
  if (input.authMode === "bearer" && headerNames.length > 0) {
    throw new ModelConfigValidationError("Bearer authentication cannot declare custom headers");
  }
  return Object.freeze({
    displayName: requiredText(input.displayName, "Display name", MODEL_INPUT_LIMITS.displayNameLength),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    chatPath: normalizeChatPath(input.chatPath),
    modelId: requiredText(input.modelId, "Model ID", MODEL_INPUT_LIMITS.modelIdLength),
    authMode: input.authMode,
    headerNames,
  });
}

export function validateSecretBundle(config: ModelConfig, bundle: ModelSecretBundle): ModelSecretBundle {
  validateSecretStorageBounds(bundle);
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 1) {
    throw new ModelConfigValidationError("Secret revision is invalid");
  }
  if (config.authMode === "bearer") {
    if (!bundle.bearerToken || /[\r\n]/.test(bundle.bearerToken) || Object.keys(bundle.headers).length > 0) {
      throw new ModelConfigValidationError("Bearer credentials are invalid");
    }
  } else {
    if (bundle.bearerToken !== undefined) throw new ModelConfigValidationError("Custom authentication cannot include a bearer credential");
    const names = normalizeHeaderNames(Object.keys(bundle.headers));
    if (JSON.stringify(names) !== JSON.stringify(config.headerNames)) {
      throw new ModelConfigValidationError("Secret header names do not match model configuration");
    }
    if (Object.values(bundle.headers).some((value) => !value || /[\r\n]/.test(value))) {
      throw new ModelConfigValidationError("A secret header value is invalid");
    }
  }
  return Object.freeze({ revision: bundle.revision, bearerToken: bundle.bearerToken, headers: Object.freeze({ ...bundle.headers }) });
}

export function validateSecretStorageBounds(bundle: ModelSecretBundle): void {
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 1) {
    throw new ModelConfigValidationError("Secret revision is invalid");
  }
  if (bundle.bearerToken !== undefined && (
    typeof bundle.bearerToken !== "string"
    || bundle.bearerToken.length > MODEL_INPUT_LIMITS.bearerTokenLength
    || /[\r\n]/.test(bundle.bearerToken)
  )) throw new ModelConfigValidationError("Bearer credentials are invalid");
  if (!bundle.headers || typeof bundle.headers !== "object" || Array.isArray(bundle.headers) || Object.getPrototypeOf(bundle.headers) !== Object.prototype) {
    throw new ModelConfigValidationError("Custom credentials are invalid");
  }
  const names = Object.keys(bundle.headers);
  normalizeHeaderNames(names);
  if (names.length > MODEL_INPUT_LIMITS.headerCount || Object.values(bundle.headers).some((value) => (
    typeof value !== "string"
    || value.length > MODEL_INPUT_LIMITS.headerValueLength
    || /[\r\n]/.test(value)
  ))) throw new ModelConfigValidationError("A secret header value is invalid");
}
