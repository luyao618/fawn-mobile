import { MODEL_INPUT_LIMITS, validateSecretStorageBounds, type ModelSecretBundle } from "../../domain/model/config.ts";

export interface SecureKeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const KEY_PREFIX = "fawn-mobile.model-secrets.v1.";

function keyForRevision(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Secret revision is invalid");
  return `${KEY_PREFIX}${revision}`;
}

export class RevisionedSecureStore {
  constructor(private readonly store: SecureKeyValueStore) {}

  async save(bundle: ModelSecretBundle): Promise<void> {
    validateSecretStorageBounds(bundle);
    const serialized = JSON.stringify({
      version: 1,
      revision: bundle.revision,
      bearerToken: bundle.bearerToken,
      headers: bundle.headers,
    });
    if (new TextEncoder().encode(serialized).byteLength > MODEL_INPUT_LIMITS.secureStoreBundleBytes) {
      throw new Error("Model credentials are too large");
    }
    await this.store.setItemAsync(keyForRevision(bundle.revision), serialized);
  }

  async load(revision: number): Promise<ModelSecretBundle | null> {
    const serialized = await this.store.getItemAsync(keyForRevision(revision));
    if (serialized === null) return null;
    try {
      if (new TextEncoder().encode(serialized).byteLength > MODEL_INPUT_LIMITS.secureStoreBundleBytes) throw new Error();
      const value: unknown = JSON.parse(serialized);
      if (!value || typeof value !== "object") throw new Error();
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.some((key) => !["version", "revision", "bearerToken", "headers"].includes(key))) throw new Error();
      if (record.version !== 1 || record.revision !== revision || !record.headers || typeof record.headers !== "object" || Array.isArray(record.headers)) {
        throw new Error();
      }
      if (record.bearerToken !== undefined && typeof record.bearerToken !== "string") throw new Error();
      const headers = record.headers as Record<string, unknown>;
      if (Object.values(headers).some((item) => typeof item !== "string")) throw new Error();
      const bundle = Object.freeze({
        revision,
        bearerToken: record.bearerToken as string | undefined,
        headers: Object.freeze({ ...headers } as Record<string, string>),
      });
      validateSecretStorageBounds(bundle);
      return bundle;
    } catch {
      throw new Error("Stored model credentials are unavailable or invalid");
    }
  }

  delete(revision: number): Promise<void> {
    return this.store.deleteItemAsync(keyForRevision(revision));
  }
}
