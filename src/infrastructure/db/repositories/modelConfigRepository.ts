import type { QueryRunHandle } from "../../../application/data/ExclusiveTransactionPort.ts";
import type { ModelConfig } from "../../../domain/model/config.ts";
import { MODEL_INPUT_LIMITS, normalizeModelConfig } from "../../../domain/model/config.ts";

export type StoredModelConfig = ModelConfig & Readonly<{ secretRevision: number; updatedAt: string }>;

type ModelConfigRow = Readonly<{
  display_name: string;
  base_url: string;
  chat_path: string;
  model_id: string;
  auth_mode: "bearer" | "custom";
  header_names_json: string;
  secret_revision: number;
  updated_at: string;
}>;

function fromRow(row: ModelConfigRow): StoredModelConfig {
  if (new TextEncoder().encode(row.header_names_json).byteLength > MODEL_INPUT_LIMITS.headerNamesJsonBytes) {
    throw new Error("Stored model configuration is invalid");
  }
  let headerNames: unknown;
  try {
    headerNames = JSON.parse(row.header_names_json);
  } catch {
    throw new Error("Stored model configuration is invalid");
  }
  if (
    !Array.isArray(headerNames)
    || headerNames.length > MODEL_INPUT_LIMITS.headerCount
    || headerNames.some((name) => typeof name !== "string" || name.length > MODEL_INPUT_LIMITS.headerNameLength)
  ) throw new Error("Stored model configuration is invalid");
  const config = normalizeModelConfig({
    displayName: row.display_name,
    baseUrl: row.base_url,
    chatPath: row.chat_path,
    modelId: row.model_id,
    authMode: row.auth_mode,
    headerNames,
  });
  if (!Number.isSafeInteger(row.secret_revision) || row.secret_revision < 1) {
    throw new Error("Stored model secret revision is invalid");
  }
  return Object.freeze({ ...config, secretRevision: row.secret_revision, updatedAt: row.updated_at });
}

function nonSecretFingerprint(config: ModelConfig): string {
  return JSON.stringify([
    config.baseUrl,
    config.chatPath,
    config.modelId,
    config.authMode,
    [...config.headerNames],
  ]);
}

export class ModelConfigRepository {
  async load(transaction: QueryRunHandle): Promise<StoredModelConfig | null> {
    const [row] = await transaction.query<ModelConfigRow>(
      "SELECT display_name, base_url, chat_path, model_id, auth_mode, header_names_json, secret_revision, updated_at FROM model_config WHERE singleton_id = ?",
      [1],
    );
    return row ? fromRow(row) : null;
  }

  async save(
    transaction: QueryRunHandle,
    config: ModelConfig,
    secretRevision: number,
    updatedAt: string,
  ): Promise<StoredModelConfig> {
    const previous = await this.load(transaction);
    if (previous && nonSecretFingerprint(previous) !== nonSecretFingerprint(config)) {
      await transaction.run("DELETE FROM model_capabilities");
    }
    await transaction.run(
      `INSERT INTO model_config(singleton_id, display_name, base_url, chat_path, model_id, auth_mode, header_names_json, secret_revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         display_name = excluded.display_name,
         base_url = excluded.base_url,
         chat_path = excluded.chat_path,
         model_id = excluded.model_id,
         auth_mode = excluded.auth_mode,
         header_names_json = excluded.header_names_json,
         secret_revision = excluded.secret_revision,
         updated_at = excluded.updated_at`,
      [1, config.displayName, config.baseUrl, config.chatPath, config.modelId, config.authMode, JSON.stringify(config.headerNames), secretRevision, updatedAt],
    );
    return Object.freeze({ ...config, secretRevision, updatedAt });
  }
}
