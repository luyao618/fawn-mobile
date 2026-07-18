import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeOperationGate } from "../../../src/application/bootstrap/appRuntime.ts";
import { DataMutationBusyError, DataMutationCoordinator } from "../../../src/application/data/DataMutationCoordinator.ts";
import {
  BabyProfileService,
  type DeviceCalendarPort,
} from "../../../src/application/profile/babyProfileService.ts";
import {
  ModelSecretCoordinationMetadataError,
  ModelSettingsService,
  ModelSettingsUnavailableError,
} from "../../../src/application/settings/modelSettingsService.ts";
import { MODEL_INPUT_LIMITS } from "../../../src/domain/model/config.ts";
import { ExpoSqliteExclusiveTransactionAdapter } from "../../../src/infrastructure/db/exclusiveTransaction.ts";
import { createLogicalSnapshot, serializeLogicalSnapshot } from "../../../src/infrastructure/db/logicalSnapshot.ts";
import { BabyProfileRepository } from "../../../src/infrastructure/db/repositories/babyProfileRepository.ts";
import { ModelConfigRepository } from "../../../src/infrastructure/db/repositories/modelConfigRepository.ts";
import { RevisionedSecureStore, type SecureKeyValueStore } from "../../../src/infrastructure/secrets/revisionedSecureStore.ts";
import { SQLiteTestDatabase } from "../../support/sqliteTestDatabase.ts";

const timestamp = "2026-07-16T01:00:00.000Z";
const later = "2026-07-16T01:00:01.000Z";
const latest = "2026-07-16T01:00:02.000Z";
const apiSentinel = "SENTINEL_API_KEY_G022";
const headerSentinel = "SENTINEL_HEADER_VALUE_G022";

class PersistentFakeSecureStore implements SecureKeyValueStore {
  constructor(private readonly path: string) {}

  async getItemAsync(key: string): Promise<string | null> {
    this.assertKey(key);
    const values = this.values();
    return values[key] ?? null;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    this.assertKey(key);
    const values = this.values();
    values[key] = value;
    writeFileSync(this.path, JSON.stringify(values));
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.assertKey(key);
    const values = this.values();
    delete values[key];
    writeFileSync(this.path, JSON.stringify(values));
  }

  entries(): Readonly<Record<string, string>> {
    return this.values();
  }

  private values(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private assertKey(key: string): void {
    if (!/^[\w.-]+$/.test(key)) throw new Error("Invalid SecureStore key");
  }
}

class ControlledSecureStore implements SecureKeyValueStore {
  readonly failedDeletes = new Set<number>();
  readonly failedSets = new Set<number>();
  setFailureObserved = false;
  beforeGet?: (key: string) => Promise<void>;
  afterSet?: (revision: number) => Promise<void>;

  constructor(readonly persistent: PersistentFakeSecureStore) {}

  async getItemAsync(key: string): Promise<string | null> {
    await this.beforeGet?.(key);
    return this.persistent.getItemAsync(key);
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    await this.persistent.setItemAsync(key, value);
    const revision = Number(key.split(".").at(-1));
    if (this.failedSets.has(revision)) {
      this.setFailureObserved = true;
      throw new Error(`set failed for revision ${revision}`);
    }
    await this.afterSet?.(revision);
  }

  deleteItemAsync(key: string): Promise<void> {
    const revision = Number(key.split(".").at(-1));
    if (this.failedDeletes.has(revision)) throw new Error(`delete failed for revision ${revision}`);
    return this.persistent.deleteItemAsync(key);
  }
}

function service(
  database: SQLiteTestDatabase,
  secureStore: SecureKeyValueStore,
  configs = new ModelConfigRepository(),
  coordinator = new DataMutationCoordinator(),
): ModelSettingsService {
  return new ModelSettingsService(
    new ExpoSqliteExclusiveTransactionAdapter(database),
    coordinator,
    configs,
    new RevisionedSecureStore(secureStore),
  );
}

const bearerConfig = { displayName: "One", baseUrl: "https://example.test", modelId: "model-a", authMode: "bearer" as const };

test("revisioned SecureStore keys satisfy Expo validation and save, load, and delete", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-secure-key-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const fake = new PersistentFakeSecureStore(join(directory, "secure.json"));
  const store = new RevisionedSecureStore(fake);
  await store.save({ revision: 7, bearerToken: apiSentinel, headers: {} });
  assert.deepEqual(await store.load(7), { revision: 7, bearerToken: apiSentinel, headers: {} });
  assert.deepEqual(Object.keys(fake.entries()), ["fawn-mobile.model-secrets.v1.7"]);
  await store.delete(7);
  assert.equal(await store.load(7), null);
});

test("SecureStore bundles enforce the serialized byte boundary on save and load", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-secure-bounds-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const fake = new PersistentFakeSecureStore(join(directory, "secure.json"));
  const store = new RevisionedSecureStore(fake);
  const headers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`X-${index}`, index < 7 ? "v".repeat(MODEL_INPUT_LIMITS.headerValueLength) : ""]));
  const emptyLast = JSON.stringify({ version: 1, revision: 1, headers });
  headers["X-7"] = "v".repeat(MODEL_INPUT_LIMITS.secureStoreBundleBytes - new TextEncoder().encode(emptyLast).byteLength);
  const exact = JSON.stringify({ version: 1, revision: 1, headers });
  assert.equal(new TextEncoder().encode(exact).byteLength, MODEL_INPUT_LIMITS.secureStoreBundleBytes);
  await store.save({ revision: 1, headers });
  assert.deepEqual(await store.load(1), { revision: 1, bearerToken: undefined, headers });

  headers["X-7"] += "v";
  await assert.rejects(store.save({ revision: 2, headers }), /too large/);
  await fake.setItemAsync("fawn-mobile.model-secrets.v1.3", JSON.stringify({ version: 1, revision: 3, headers }));
  await assert.rejects(store.load(3), /unavailable or invalid/);
});

test("Expo adapter pins iOS writes to this-device-only unlocked accessibility", () => {
  const source = readFileSync(new URL("../../../src/infrastructure/secrets/expoSecureStoreAdapter.ts", import.meta.url), "utf8");
  assert.match(source, /keychainAccessible:\s*SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
});

async function captureConsole<T>(logs: string[], operation: () => Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return await operation();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test("settings survive restart while sentinel secrets stay out of SQLite, snapshots, errors, and logs", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "user.db");
  const securePath = join(directory, "secure.json");
  const secureStore = new PersistentFakeSecureStore(securePath);
  let database = new SQLiteTestDatabase(databasePath);
  await database.migrate();
  const logs: string[] = [];

  const saved = await captureConsole(logs, () => service(database, secureStore).save({
    displayName: " Local Model ",
    baseUrl: "https://example.test/v1///",
    modelId: "model-a",
    authMode: "custom",
    headerNames: ["X-Zeta", "X-Alpha"],
  }, { headers: { "X-Zeta": headerSentinel, "X-Alpha": apiSentinel } }, timestamp));
  assert.equal(saved.config.baseUrl, "https://example.test/v1");
  assert.deepEqual(saved.config.headerNames, ["X-Alpha", "X-Zeta"]);
  await database.closeAsync();

  database = new SQLiteTestDatabase(databasePath);
  context.after(() => database.closeAsync());
  const loaded = await captureConsole(logs, () => service(database, new PersistentFakeSecureStore(securePath)).load());
  assert(loaded);
  assert.equal(loaded.secrets.headers["X-Alpha"], apiSentinel);
  assert.equal(loaded.secrets.headers["X-Zeta"], headerSentinel);
  const rows = await database.getAllAsync<Record<string, unknown>>("SELECT * FROM model_config");
  const snapshot = serializeLogicalSnapshot(await createLogicalSnapshot(database));
  const databaseBytes = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString("utf8"))
    .join("");
  for (const exposed of [JSON.stringify(rows), snapshot, databaseBytes, JSON.stringify(logs)]) {
    assert.doesNotMatch(exposed, new RegExp(`${apiSentinel}|${headerSentinel}`));
  }

  const revision = rows[0]!.secret_revision as number;
  const [secureKey] = Object.keys(secureStore.entries());
  assert(secureKey);
  await secureStore.setItemAsync(secureKey, JSON.stringify({ version: 1, revision: revision + 1, headers: { "X-Alpha": apiSentinel, "X-Zeta": headerSentinel } }));
  await assert.rejects(service(database, secureStore).load(), ModelSettingsUnavailableError);
  await new RevisionedSecureStore(secureStore).delete(revision);
  await assert.rejects(service(database, secureStore).load(), (error) => {
    assert(error instanceof ModelSettingsUnavailableError);
    assert.doesNotMatch(String(error), new RegExp(`${apiSentinel}|${headerSentinel}`));
    return true;
  });
});

test("database failure removes only the fresh bundle and leaves the referenced settings loadable", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-failure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const secureStore = new PersistentFakeSecureStore(join(directory, "secure.json"));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const goodService = service(database, secureStore);
  await goodService.save({ displayName: "One", baseUrl: "https://example.test", modelId: "model-a", authMode: "bearer" }, { bearerToken: apiSentinel }, timestamp);
  const before = secureStore.entries();

  const failingConfigs = new ModelConfigRepository();
  const injected = Object.assign(Object.create(Object.getPrototypeOf(failingConfigs)) as ModelConfigRepository, failingConfigs, {
    async save(): Promise<never> { throw new Error("injected database failure"); },
  });
  await assert.rejects(
    service(database, secureStore, injected).save(
      { displayName: "Two", baseUrl: "https://example.test", modelId: "model-b", authMode: "bearer" },
      { bearerToken: headerSentinel }, timestamp,
    ),
    /injected database failure/,
  );
  assert.deepEqual(secureStore.entries(), before);
  assert.equal((await goodService.load())!.secrets.bearerToken, apiSentinel);
});

test("non-secret fingerprint changes invalidate capabilities while display-only changes preserve them", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-capabilities-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const secureStore = new PersistentFakeSecureStore(join(directory, "secure.json"));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const settings = service(database, secureStore);
  const base = { displayName: "One", baseUrl: "https://example.test", modelId: "model-a", authMode: "bearer" as const };
  await settings.save(base, { bearerToken: apiSentinel }, timestamp);
  await database.runAsync("INSERT INTO model_capabilities(config_fingerprint, probe_version, capability, status, probed_at) VALUES (?, ?, ?, ?, ?)", "fingerprint", 1, "text", "supported", timestamp);
  await settings.save({ ...base, displayName: "Renamed" }, { bearerToken: apiSentinel }, timestamp);
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM model_capabilities"))[0]!.total, 1);
  await settings.save({ ...base, modelId: "model-b" }, { bearerToken: apiSentinel }, timestamp);
  assert.equal((await database.getAllAsync<{ total: number }>("SELECT count(*) AS total FROM model_capabilities"))[0]!.total, 0);
});

test("durable revisions remain strictly monotonic across restart and concurrent saves", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-revisions-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "user.db");
  const persistent = new PersistentFakeSecureStore(join(directory, "secure.json"));
  let database = new SQLiteTestDatabase(databasePath);
  await database.migrate();
  await service(database, persistent).save(bearerConfig, { bearerToken: "first" }, timestamp);
  await database.closeAsync();

  database = new SQLiteTestDatabase(databasePath);
  context.after(() => database.closeAsync());
  const first = service(database, persistent).save({ ...bearerConfig, displayName: "Second" }, { bearerToken: "second" }, timestamp);
  const second = service(database, persistent).save({ ...bearerConfig, displayName: "Third" }, { bearerToken: "third" }, timestamp);
  await Promise.all([first, second]);
  const rows = await database.getAllAsync<{ secret_revision: number }>("SELECT secret_revision FROM model_config");
  const counter = await database.getAllAsync<{ value_json: string }>("SELECT value_json FROM app_meta WHERE key = 'model_secret_revision_counter'");
  assert.equal(rows[0]!.secret_revision, 4);
  assert.equal(counter[0]!.value_json, "4");
  assert.deepEqual(Object.keys(persistent.entries()), ["fawn-mobile.model-secrets.v1.4"]);
  assert.match((await service(database, persistent).load())!.secrets.bearerToken!, /second|third/);
});

test("cleanup cannot delete a reservation between SecureStore write and SQLite publication", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-reservation-race-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const controlled = new ControlledSecureStore(new PersistentFakeSecureStore(join(directory, "secure.json")));
  let releaseWrite!: () => void;
  let observeWrite!: () => void;
  const writeObserved = new Promise<void>((resolve) => { observeWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseWrite = resolve; });
  controlled.afterSet = async () => {
    observeWrite();
    await release;
  };
  const saving = service(database, controlled).save(bearerConfig, { bearerToken: "reserved" }, timestamp);
  await writeObserved;
  assert.deepEqual(Object.keys(controlled.persistent.entries()), ["fawn-mobile.model-secrets.v1.1"]);
  const cleanup = await service(database, controlled).cleanupUnreferencedSecrets(16, timestamp);
  assert.deepEqual(cleanup.deletedRevisions, []);
  assert.deepEqual(Object.keys(controlled.persistent.entries()), ["fawn-mobile.model-secrets.v1.1"]);
  releaseWrite();
  assert.equal((await saving).secrets.revision, 1);
});

test("cleanup holds user-write admission across reference check, secret deletion, and metadata update", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-cleanup-admission-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const coordinator = new DataMutationCoordinator();
  const controlled = new ControlledSecureStore(new PersistentFakeSecureStore(join(directory, "secure.json")));
  const settings = service(database, controlled, new ModelConfigRepository(), coordinator);
  await settings.save(bearerConfig, { bearerToken: "old" }, timestamp);
  controlled.failedDeletes.add(1);
  await settings.save({ ...bearerConfig, displayName: "new" }, { bearerToken: "new" }, later);
  controlled.failedDeletes.clear();
  let deletionEntered!: () => void;
  let releaseDeletion!: () => void;
  const entered = new Promise<void>((resolve) => { deletionEntered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseDeletion = resolve; });
  const originalDelete = controlled.deleteItemAsync.bind(controlled);
  controlled.deleteItemAsync = async (key) => {
    if (key.endsWith(".1")) {
      deletionEntered();
      await gate;
    }
    return originalDelete(key);
  };
  const cleanup = settings.cleanupUnreferencedSecrets(1, latest);
  await entered;
  const maintenance = coordinator.runMaintenance("restore", async () => {
    const [row] = await database.getAllAsync<{ secret_revision: number }>("SELECT secret_revision FROM model_config");
    assert.equal(row!.secret_revision, 2);
  });
  await assert.rejects(settings.save({ ...bearerConfig, displayName: "repoint" }, { bearerToken: "third" }, latest), DataMutationBusyError);
  assert.deepEqual(coordinator.state(), { mode: "maintenance-pending", activeUserWrites: 1, waitingMaintenance: 1 });
  releaseDeletion();
  await cleanup;
  await maintenance;
  assert.deepEqual(Object.keys(controlled.persistent.entries()), ["fawn-mobile.model-secrets.v1.2"]);
});

test("restart reconciliation abandons and removes stale durable reservations", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-stale-reservation-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const persistent = new PersistentFakeSecureStore(join(directory, "secure.json"));
  await new RevisionedSecureStore(persistent).save({ revision: 99, bearerToken: "abandoned", headers: {} });
  for (const [key, value] of [
    ["model_secret_revision_counter", 99],
    ["model_secret_cleanup_cursor", 98],
    ["model_secret_cleanup_pending", []],
    ["model_secret_reservations", [99]],
  ] as const) {
    await database.runAsync("INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)", key, JSON.stringify(value), timestamp);
  }
  const cleanup = await service(database, persistent).cleanupUnreferencedSecrets(1, timestamp);
  assert.deepEqual(cleanup.deletedRevisions, [99]);
  assert.deepEqual(cleanup.pendingRevisions, []);
  assert.deepEqual(persistent.entries(), {});
  const metadata = await database.getAllAsync<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM app_meta WHERE key IN ('model_secret_cleanup_pending', 'model_secret_reservations') ORDER BY key",
  );
  assert.deepEqual(Object.fromEntries(metadata.map((row) => [row.key, JSON.parse(row.value_json)])), {
    model_secret_cleanup_pending: [],
    model_secret_reservations: [],
  });
});

test("load retries when publication changes the SQLite pointer during SecureStore read", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-read-consistency-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const controlled = new ControlledSecureStore(new PersistentFakeSecureStore(join(directory, "secure.json")));
  const settings = service(database, controlled);
  await settings.save(bearerConfig, { bearerToken: "old" }, timestamp);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const readEntered = new Promise<void>((resolve) => { entered = resolve; });
  let blocked = false;
  controlled.beforeGet = async (key) => {
    if (!blocked && key.endsWith(".1")) {
      blocked = true;
      entered();
      await gate;
    }
  };
  const loading = settings.load();
  await readEntered;
  await service(database, controlled).save({ ...bearerConfig, displayName: "New" }, { bearerToken: "new" }, timestamp);
  release();
  const loaded = await loading;
  assert.equal(loaded!.config.displayName, "New");
  assert.equal(loaded!.secrets.bearerToken, "new");
});

test("post-publication delete failure remains durable and reconciliation is bounded", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-cleanup-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const controlled = new ControlledSecureStore(new PersistentFakeSecureStore(join(directory, "secure.json")));
  const settings = service(database, controlled);
  await settings.save(bearerConfig, { bearerToken: "old" }, timestamp);
  controlled.failedDeletes.add(1);
  const saved = await settings.save({ ...bearerConfig, displayName: "New" }, { bearerToken: "new" }, timestamp);
  assert.deepEqual(saved.cleanupPendingRevisions, [1]);
  const failed = await settings.cleanupUnreferencedSecrets(1, timestamp);
  assert.deepEqual(failed.failedRevisions, [1]);
  assert.deepEqual(failed.pendingRevisions, [1]);
  controlled.failedDeletes.clear();
  const cleaned = await service(database, controlled).cleanupUnreferencedSecrets(1, timestamp);
  assert.deepEqual(cleaned.deletedRevisions, [1]);
  assert.deepEqual(cleaned.pendingRevisions, []);
  assert.deepEqual(Object.keys(controlled.persistent.entries()), ["fawn-mobile.model-secrets.v1.2"]);
});

test("first-save publication and delete failure survives restart and removes the orphan without a current config", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-first-orphan-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "user.db");
  const controlled = new ControlledSecureStore(new PersistentFakeSecureStore(join(directory, "secure.json")));
  let database = new SQLiteTestDatabase(databasePath);
  await database.migrate();
  controlled.failedSets.add(1);
  controlled.failedDeletes.add(1);
  await assert.rejects(
    service(database, controlled).save(bearerConfig, { bearerToken: "orphan" }, timestamp),
    (error) => error instanceof AggregateError
      && error.errors.length === 2
      && String(error.errors[0]).includes("set failed")
      && String(error.errors[1]).includes("delete failed"),
  );
  assert.deepEqual(Object.keys(controlled.persistent.entries()), ["fawn-mobile.model-secrets.v1.1"]);
  assert.deepEqual(
    JSON.parse((await database.getAllAsync<{ value_json: string }>("SELECT value_json FROM app_meta WHERE key = 'model_secret_cleanup_pending'"))[0]!.value_json),
    [1],
  );
  assert.equal((await database.getAllAsync("SELECT * FROM model_config")).length, 0);
  await database.closeAsync();

  controlled.failedSets.clear();
  controlled.failedDeletes.clear();
  database = new SQLiteTestDatabase(databasePath);
  context.after(() => database.closeAsync());
  const cleaned = await service(database, controlled).cleanupUnreferencedSecrets(1, timestamp);
  assert.deepEqual(cleaned.deletedRevisions, [1]);
  assert.deepEqual(cleaned.pendingRevisions, []);
  assert.deepEqual(controlled.persistent.entries(), {});
});

test("publication, deletion, and cleanup-pending persistence failures preserve all three errors", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-triple-error-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const controlled = new ControlledSecureStore(new PersistentFakeSecureStore(join(directory, "secure.json")));
  controlled.failedSets.add(1);
  controlled.failedDeletes.add(1);
  const failingTransactions = new ExpoSqliteExclusiveTransactionAdapter({
    withExclusiveTransactionAsync: (operation) => database.withExclusiveTransactionAsync((transaction) => operation({
      getAllAsync: transaction.getAllAsync.bind(transaction),
      runAsync: async (sql, ...parameters) => {
        if (controlled.setFailureObserved && parameters[0] === "model_secret_cleanup_pending") {
          throw new Error("pending persistence failed");
        }
        return transaction.runAsync(sql, ...parameters);
      },
    })),
  });
  const settings = new ModelSettingsService(
    failingTransactions,
    new DataMutationCoordinator(),
    new ModelConfigRepository(),
    new RevisionedSecureStore(controlled),
  );
  await assert.rejects(settings.save(bearerConfig, { bearerToken: "orphan" }, timestamp), (error) => (
    error instanceof AggregateError
    && error.errors.length === 3
    && String(error.errors[0]).includes("set failed")
    && String(error.errors[1]).includes("delete failed")
    && String(error.errors[2]).includes("pending persistence failed")
  ));
});

test("partial or malformed coordination metadata fails closed without erasing high-water or orphan state", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-metadata-invalid-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const persistent = new PersistentFakeSecureStore(join(directory, "secure.json"));
  const settings = service(database, persistent);
  await settings.save(bearerConfig, { bearerToken: "current" }, timestamp);
  await new RevisionedSecureStore(persistent).save({ revision: 99, bearerToken: "orphan", headers: {} });

  await database.runAsync("UPDATE app_meta SET value_json = '99' WHERE key = 'model_secret_revision_counter'");
  await database.runAsync("UPDATE app_meta SET value_json = 'not-json' WHERE key = 'model_secret_cleanup_cursor'");
  await database.runAsync("UPDATE app_meta SET value_json = '[99]' WHERE key = 'model_secret_cleanup_pending'");
  const metadataBefore = await database.getAllAsync<Record<string, unknown>>(
    "SELECT key, value_json, updated_at FROM app_meta WHERE key LIKE 'model_secret_%' ORDER BY key",
  );
  const secretsBefore = persistent.entries();

  await assert.rejects(settings.cleanupUnreferencedSecrets(1, timestamp), ModelSecretCoordinationMetadataError);
  await assert.rejects(
    settings.save({ ...bearerConfig, displayName: "Rejected" }, { bearerToken: "next" }, later),
    ModelSecretCoordinationMetadataError,
  );
  assert.deepEqual(await database.getAllAsync<Record<string, unknown>>(
    "SELECT key, value_json, updated_at FROM app_meta WHERE key LIKE 'model_secret_%' ORDER BY key",
  ), metadataBefore);
  assert.deepEqual(persistent.entries(), secretsBefore);

  await database.runAsync("DELETE FROM app_meta WHERE key = 'model_secret_cleanup_cursor'");
  const partialBefore = await database.getAllAsync<Record<string, unknown>>(
    "SELECT key, value_json, updated_at FROM app_meta WHERE key LIKE 'model_secret_%' ORDER BY key",
  );
  await assert.rejects(settings.cleanupUnreferencedSecrets(1, timestamp), ModelSecretCoordinationMetadataError);
  assert.deepEqual(await database.getAllAsync<Record<string, unknown>>(
    "SELECT key, value_json, updated_at FROM app_meta WHERE key LIKE 'model_secret_%' ORDER BY key",
  ), partialBefore);
});

test("full coordination metadata omission initializes from the current SQLite revision", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-metadata-omitted-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new SQLiteTestDatabase(join(directory, "user.db"));
  context.after(() => database.closeAsync());
  await database.migrate();
  const persistent = new PersistentFakeSecureStore(join(directory, "secure.json"));
  const settings = service(database, persistent);
  await settings.save(bearerConfig, { bearerToken: "current" }, timestamp);

  await database.runAsync("DELETE FROM app_meta WHERE key LIKE 'model_secret_%'");
  const saved = await service(database, persistent).save(
    { ...bearerConfig, displayName: "Next" },
    { bearerToken: "next" },
    later,
  );
  assert.equal(saved.secrets.revision, 2);
  assert.deepEqual(Object.keys(persistent.entries()), ["fawn-mobile.model-secrets.v1.2"]);
  const metadata = await database.getAllAsync<{ key: string; value_json: string }>(
    "SELECT key, value_json FROM app_meta WHERE key LIKE 'model_secret_%' ORDER BY key",
  );
  assert.deepEqual(Object.fromEntries(metadata.map((row) => [row.key, JSON.parse(row.value_json)])), {
    model_secret_cleanup_cursor: 2,
    model_secret_cleanup_pending: [],
    model_secret_reservations: [],
    model_secret_revision_counter: 2,
  });
});

test("rollback plus cleanup failure preserves both errors and later restart removes the orphan", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-settings-orphan-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "user.db");
  const controlled = new ControlledSecureStore(new PersistentFakeSecureStore(join(directory, "secure.json")));
  let database = new SQLiteTestDatabase(databasePath);
  await database.migrate();
  await service(database, controlled).save(bearerConfig, { bearerToken: "current" }, timestamp);
  controlled.failedDeletes.add(2);
  const failingConfigs = new ModelConfigRepository();
  const injected = Object.assign(Object.create(Object.getPrototypeOf(failingConfigs)) as ModelConfigRepository, failingConfigs, {
    async save(): Promise<never> { throw new Error("publication rollback"); },
  });
  await assert.rejects(
    service(database, controlled, injected).save({ ...bearerConfig, displayName: "Broken" }, { bearerToken: "orphan" }, timestamp),
    (error) => error instanceof AggregateError
      && error.errors.length === 2
      && String(error.errors[0]).includes("publication rollback")
      && String(error.errors[1]).includes("delete failed"),
  );
  assert.deepEqual(Object.keys(controlled.persistent.entries()).sort(), [
    "fawn-mobile.model-secrets.v1.1", "fawn-mobile.model-secrets.v1.2",
  ]);
  await database.closeAsync();
  controlled.failedDeletes.clear();
  database = new SQLiteTestDatabase(databasePath);
  context.after(() => database.closeAsync());
  await service(database, controlled).save({ ...bearerConfig, displayName: "Recovered" }, { bearerToken: "recovered" }, timestamp);
  assert.deepEqual(Object.keys(controlled.persistent.entries()), ["fawn-mobile.model-secrets.v1.3"]);
});

test("IT-001/profile reopens the singleton with its local date unchanged and recomputes exact age", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-profile-reopen-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "user.db");
  const calendar = (instant: string, timeZone: string): DeviceCalendarPort => ({
    current: () => Object.freeze({ instant, timeZone }),
  });
  const profileService = (database: SQLiteTestDatabase, instant: string, timeZone: string) => new BabyProfileService(
    new ExpoSqliteExclusiveTransactionAdapter(database),
    new DataMutationCoordinator(),
    new BabyProfileRepository(),
    calendar(instant, timeZone),
    new RuntimeOperationGate(),
  );

  let database = new SQLiteTestDatabase(path);
  await database.migrate();
  const saved = await profileService(database, "2024-02-29T12:00:00.000Z", "Asia/Shanghai").save({
    name: "重启测试宝宝",
    sex: "female",
    birthDate: "2024-02-29",
    birthWeightG: 3_200,
    birthHeightCm: 50.5,
    birthHeadCm: 34.2,
    isPremature: true,
    gestationalWeeks: 36,
  }, null);
  assert.equal(saved.profile.createdAt, "2024-02-29T12:00:00.000Z");
  await database.closeAsync();

  database = new SQLiteTestDatabase(path);
  context.after(() => database.closeAsync());
  await database.migrate();
  const reopened = await profileService(
    database,
    "2025-02-28T20:00:00.000Z",
    "America/Los_Angeles",
  ).load();
  assert(reopened.profile);
  assert.equal(reopened.profile.birthDate, "2024-02-29");
  assert.deepEqual(reopened.profile, saved.profile);
  assert.deepEqual(reopened.exactAge.status === "known" ? {
    ageDays: reopened.exactAge.ageDays,
    completedMonths: reopened.exactAge.completedMonths,
    remainingDays: reopened.exactAge.remainingDays,
  } : null, { ageDays: 365, completedMonths: 12, remainingDays: 0 });
  assert.equal((await database.getAllAsync<{ birth_date: string }>(
    "SELECT birth_date FROM baby_profile WHERE singleton_id = ?",
    1,
  ))[0]!.birth_date, "2024-02-29");
});
