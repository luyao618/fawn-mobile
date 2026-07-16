import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_INPUT_LIMITS,
  normalizeHeaderNames,
  normalizeModelConfig,
  validateSecretBundle,
} from "../../../src/domain/model/config.ts";
import { ModelConfigRepository } from "../../../src/infrastructure/db/repositories/modelConfigRepository.ts";
import { migratedTestDatabase } from "../../support/sqliteTestDatabase.ts";

test("custom model headers preserve provider restrictions and reject proxy credentials and forwarding", () => {
  const reserved = [
    "Accept", "Authorization", "Connection", "Content-Length", "Content-Type", "Host", "Origin", "Referer", "Transfer-Encoding",
    "Cookie", "Proxy-Authenticate", "Proxy-Authorization", "Proxy-Connection", "Forwarded", "Via",
    "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", "Client-IP", "True-Client-IP", "CF-Connecting-IP",
  ];
  for (const name of reserved) {
    assert.throws(() => normalizeHeaderNames([name]), /invalid or reserved/, name);
  }
  assert.deepEqual(normalizeHeaderNames(["X-Provider-Key", "Provider-Version"]), ["Provider-Version", "X-Provider-Key"]);
});

test("model configuration and credentials accept limits and reject oversized fields", () => {
  const exact = normalizeModelConfig({
    displayName: "d".repeat(MODEL_INPUT_LIMITS.displayNameLength),
    baseUrl: `https://example.test/${"b".repeat(MODEL_INPUT_LIMITS.baseUrlLength - 21)}`,
    chatPath: "p".repeat(MODEL_INPUT_LIMITS.chatPathLength),
    modelId: "m".repeat(MODEL_INPUT_LIMITS.modelIdLength),
    authMode: "custom",
    headerNames: Array.from({ length: MODEL_INPUT_LIMITS.headerCount }, (_, index) => `X-${index}-${"h".repeat(MODEL_INPUT_LIMITS.headerNameLength - String(index).length - 3)}`),
  });
  assert.equal(exact.displayName.length, MODEL_INPUT_LIMITS.displayNameLength);
  assert.equal(exact.baseUrl.length, MODEL_INPUT_LIMITS.baseUrlLength);
  assert.equal(exact.chatPath.length, MODEL_INPUT_LIMITS.chatPathLength);
  assert.equal(exact.modelId.length, MODEL_INPUT_LIMITS.modelIdLength);
  assert.equal(exact.headerNames.length, MODEL_INPUT_LIMITS.headerCount);
  assert.doesNotThrow(() => validateSecretBundle(exact, {
    revision: 1,
    headers: Object.fromEntries(exact.headerNames.map((name) => [name, "v".repeat(MODEL_INPUT_LIMITS.headerValueLength)])),
  }));

  const base = { displayName: "d", baseUrl: "https://example.test", chatPath: "chat", modelId: "m", authMode: "bearer" as const };
  for (const input of [
    { ...base, displayName: "d".repeat(MODEL_INPUT_LIMITS.displayNameLength + 1) },
    { ...base, baseUrl: `https://example.test/${"b".repeat(MODEL_INPUT_LIMITS.baseUrlLength)}` },
    { ...base, chatPath: "p".repeat(MODEL_INPUT_LIMITS.chatPathLength + 1) },
    { ...base, modelId: "m".repeat(MODEL_INPUT_LIMITS.modelIdLength + 1) },
  ]) assert.throws(() => normalizeModelConfig(input));
  assert.throws(() => normalizeHeaderNames(Array(MODEL_INPUT_LIMITS.headerCount + 1).fill("X-Duplicate")), /Too many/);
  assert.throws(() => normalizeHeaderNames([`X-${"h".repeat(MODEL_INPUT_LIMITS.headerNameLength)}`]), /invalid or reserved/);

  const bearerConfig = normalizeModelConfig(base);
  assert.doesNotThrow(() => validateSecretBundle(bearerConfig, {
    revision: 1, bearerToken: "t".repeat(MODEL_INPUT_LIMITS.bearerTokenLength), headers: {},
  }));
  assert.throws(() => validateSecretBundle(bearerConfig, {
    revision: 1, bearerToken: "t".repeat(MODEL_INPUT_LIMITS.bearerTokenLength + 1), headers: {},
  }));
  const customConfig = normalizeModelConfig({ ...base, authMode: "custom", headerNames: ["X-Key"] });
  assert.throws(() => validateSecretBundle(customConfig, {
    revision: 1, headers: { "X-Key": "v".repeat(MODEL_INPUT_LIMITS.headerValueLength + 1) },
  }));
});

test("restored model header JSON is byte-bounded and structurally validated before normalization", async (context) => {
  const database = await migratedTestDatabase();
  context.after(() => database.closeAsync());
  await database.runAsync(
    "INSERT INTO model_config(singleton_id, display_name, base_url, chat_path, model_id, auth_mode, header_names_json, secret_revision, updated_at) VALUES (1, 'Restored', 'https://example.test', 'chat', 'model', 'custom', '[]', 1, '2026-07-16T01:00:00.000Z')",
  );
  const repository = new ModelConfigRepository();
  const corruptValues = [
    `${" ".repeat(MODEL_INPUT_LIMITS.headerNamesJsonBytes)}[`,
    "not-json",
    "{}",
    "[1]",
    JSON.stringify(Array.from({ length: MODEL_INPUT_LIMITS.headerCount + 1 }, (_, index) => `X-${index}`)),
    JSON.stringify([`X-${"h".repeat(MODEL_INPUT_LIMITS.headerNameLength)}`]),
  ];
  for (const value of corruptValues) {
    await database.runAsync("UPDATE model_config SET header_names_json = ? WHERE singleton_id = 1", value);
    await assert.rejects(repository.load(database), /Stored model configuration is invalid|Too many custom header names|invalid or reserved/);
  }

  const exact = Array.from(
    { length: MODEL_INPUT_LIMITS.headerCount },
    (_, index) => `X-${index}-${"h".repeat(MODEL_INPUT_LIMITS.headerNameLength - String(index).length - 3)}`,
  );
  await database.runAsync("UPDATE model_config SET header_names_json = ? WHERE singleton_id = 1", JSON.stringify(exact));
  assert.deepEqual((await repository.load(database))!.headerNames, [...exact].sort((left, right) => left.localeCompare(right)));
});
