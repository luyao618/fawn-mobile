import type { ExclusiveTransactionPort, QueryRunHandle } from "../data/ExclusiveTransactionPort.ts";
import { DataMutationCoordinator } from "../data/DataMutationCoordinator.ts";
import type { ModelConfig, ModelConfigInput, ModelSecretBundle } from "../../domain/model/config.ts";
import { normalizeModelConfig, validateSecretBundle } from "../../domain/model/config.ts";

export interface ModelConfigStore {
  load(transaction: QueryRunHandle): Promise<(ModelConfig & Readonly<{ secretRevision: number; updatedAt: string }>) | null>;
  save(
    transaction: QueryRunHandle,
    config: ModelConfig,
    secretRevision: number,
    updatedAt: string,
  ): Promise<ModelConfig & Readonly<{ secretRevision: number; updatedAt: string }>>;
}

export interface ModelSecretStore {
  save(bundle: ModelSecretBundle): Promise<void>;
  load(revision: number): Promise<ModelSecretBundle | null>;
  delete(revision: number): Promise<void>;
}

export type ModelSecretInput = Readonly<{ bearerToken?: string; headers?: Readonly<Record<string, string>> }>;
export type LoadedModelSettings = Readonly<{
  config: ModelConfig;
  secrets: ModelSecretBundle;
  updatedAt: string;
  cleanupPendingRevisions: readonly number[];
}>;

export type SecretCleanupResult = Readonly<{
  deletedRevisions: readonly number[];
  failedRevisions: readonly number[];
  pendingRevisions: readonly number[];
}>;

export class ModelSettingsUnavailableError extends Error {
  constructor() {
    super("Model settings are unavailable or inconsistent");
    this.name = "ModelSettingsUnavailableError";
  }
}

export class ModelSecretCoordinationMetadataError extends Error {
  constructor() {
    super("Model secret coordination metadata is invalid");
    this.name = "ModelSecretCoordinationMetadataError";
  }
}

const REVISION_COUNTER_KEY = "model_secret_revision_counter";
const CLEANUP_PENDING_KEY = "model_secret_cleanup_pending";
const CLEANUP_CURSOR_KEY = "model_secret_cleanup_cursor";
const RESERVATIONS_KEY = "model_secret_reservations";
const MAX_SAVE_ATTEMPTS = 8;
const MAX_SECRET_REVISION = 1_000_000;
const MAX_PENDING_REVISIONS = 100;
const MAX_COORDINATION_VALUE_LENGTH = 8_192;
const activeSecretReservations = new Set<number>();

type MetaRow = Readonly<{ value_json: string }>;

type CoordinationState = Readonly<{
  currentRevision: number | undefined;
  counter: number;
  cursor: number;
  pending: number[];
  reservations: number[];
}>;

function parseMetadata(value: string): unknown {
  if (new TextEncoder().encode(value).byteLength > MAX_COORDINATION_VALUE_LENGTH) {
    throw new ModelSecretCoordinationMetadataError();
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new ModelSecretCoordinationMetadataError();
  }
}

function validRevision(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= MAX_SECRET_REVISION;
}

function appendPendingRevision(pending: readonly number[], revision: number): number[] {
  const result = [...new Set([...pending, revision])].sort((left, right) => left - right);
  if (result.length > MAX_PENDING_REVISIONS) throw new Error("Too many model secret revisions are pending cleanup");
  return result;
}

async function meta(transaction: QueryRunHandle, key: string): Promise<string | undefined> {
  const [row] = await transaction.query<MetaRow>("SELECT value_json FROM app_meta WHERE key = ?", [key]);
  return row?.value_json;
}

async function putMeta(transaction: QueryRunHandle, key: string, value: unknown, updatedAt: string): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_COORDINATION_VALUE_LENGTH) throw new Error("Model secret coordination metadata is too large");
  await transaction.run(
    `INSERT INTO app_meta(key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [key, serialized, updatedAt],
  );
}

async function coordinationState(
  transaction: QueryRunHandle,
  currentRevision: number | undefined,
  updatedAt: string,
  repair = true,
): Promise<CoordinationState> {
  if (currentRevision !== undefined && !validRevision(currentRevision, 1)) {
    throw new Error("Current model secret revision is outside the supported range");
  }
  const [counterValue, cursorValue, pendingValue, reservationsValue] = await Promise.all([
    meta(transaction, REVISION_COUNTER_KEY),
    meta(transaction, CLEANUP_CURSOR_KEY),
    meta(transaction, CLEANUP_PENDING_KEY),
    meta(transaction, RESERVATIONS_KEY),
  ]);
  const values = [counterValue, cursorValue, pendingValue, reservationsValue];
  if (values.every((value) => value === undefined)) {
    const initialized = { currentRevision, counter: currentRevision ?? 0, cursor: 0, pending: [], reservations: [] };
    if (repair) {
      await putMeta(transaction, REVISION_COUNTER_KEY, initialized.counter, updatedAt);
      await putMeta(transaction, CLEANUP_CURSOR_KEY, initialized.cursor, updatedAt);
      await putMeta(transaction, CLEANUP_PENDING_KEY, initialized.pending, updatedAt);
      await putMeta(transaction, RESERVATIONS_KEY, initialized.reservations, updatedAt);
    }
    return initialized;
  }
  if (
    counterValue === undefined
    || cursorValue === undefined
    || pendingValue === undefined
    || reservationsValue === undefined
  ) throw new ModelSecretCoordinationMetadataError();
  const parsedCounter = parseMetadata(counterValue);
  const parsedCursor = parseMetadata(cursorValue);
  const parsedPending = parseMetadata(pendingValue);
  const parsedReservations = parseMetadata(reservationsValue);
  const counter = parsedCounter;
  const cursor = parsedCursor;
  const pending = parsedPending;
  const reservations = parsedReservations;
  const validPending = Array.isArray(pending)
    && pending.length <= MAX_PENDING_REVISIONS
    && pending.every((revision) => validRevision(revision, 1))
    && new Set(pending).size === pending.length;
  const validReservations = Array.isArray(reservations)
    && reservations.length <= MAX_PENDING_REVISIONS
    && reservations.every((revision) => validRevision(revision, 1))
    && new Set(reservations).size === reservations.length;
  const valid = validRevision(counter, 0)
    && counter >= (currentRevision ?? 0)
    && validRevision(cursor, 0)
    && cursor <= counter
    && validPending
    && validReservations
    && pending.length + reservations.length <= MAX_PENDING_REVISIONS
    && pending.every((revision) => revision <= counter && revision !== currentRevision)
    && reservations.every((revision) => revision <= counter)
    && new Set([...pending, ...reservations]).size === pending.length + reservations.length;
  if (valid) {
    const abandoned = reservations.filter((revision) => revision !== currentRevision && !activeSecretReservations.has(revision));
    const normalizedPending = [...new Set([...pending, ...abandoned])]
      .filter((revision) => revision !== currentRevision)
      .sort((left, right) => left - right);
    const normalizedReservations = reservations
      .filter((revision) => revision !== currentRevision && activeSecretReservations.has(revision))
      .sort((left, right) => left - right);
    if (normalizedPending.length + normalizedReservations.length > MAX_PENDING_REVISIONS) {
      throw new Error("Too many model secret revisions require reconciliation");
    }
    if (repair && (
      JSON.stringify(pending) !== JSON.stringify(normalizedPending)
      || JSON.stringify(reservations) !== JSON.stringify(normalizedReservations)
    )) {
      await putMeta(transaction, CLEANUP_PENDING_KEY, normalizedPending, updatedAt);
      await putMeta(transaction, RESERVATIONS_KEY, normalizedReservations, updatedAt);
    }
    return { currentRevision, counter, cursor, pending: normalizedPending, reservations: normalizedReservations };
  }
  throw new ModelSecretCoordinationMetadataError();
}

class PublicationConflictError extends Error {}

export class ModelSettingsService {
  constructor(
    private readonly transactions: ExclusiveTransactionPort,
    private readonly coordinator: DataMutationCoordinator,
    private readonly configs: ModelConfigStore,
    private readonly secrets: ModelSecretStore,
  ) {}

  async save(input: ModelConfigInput, secretInput: ModelSecretInput, updatedAt: string): Promise<LoadedModelSettings> {
    const config = normalizeModelConfig(input);
    const validatedSecretInput = validateSecretBundle(config, {
      revision: 1,
      bearerToken: secretInput.bearerToken,
      headers: secretInput.headers ?? {},
    });
    return this.coordinator.runUserWrite(async () => {
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
        let activeRevision: number | undefined;
        let reservation: Readonly<{ revision: number; expectedRevision: number | undefined }>;
        try {
          reservation = await this.transactions.runExclusive(async (transaction) => {
            const current = await this.configs.load(transaction);
            const state = await coordinationState(transaction, current?.secretRevision, updatedAt);
            if (state.pending.length + state.reservations.length >= MAX_PENDING_REVISIONS) {
              throw new Error("Too many model secret revisions require reconciliation");
            }
            const revision = state.counter + 1;
            if (!validRevision(revision, 1)) throw new Error("Model secret revision counter is exhausted");
            await putMeta(transaction, REVISION_COUNTER_KEY, revision, updatedAt);
            await putMeta(transaction, RESERVATIONS_KEY, [...state.reservations, revision], updatedAt);
            activeSecretReservations.add(revision);
            activeRevision = revision;
            return { revision, expectedRevision: current?.secretRevision };
          });
        } catch (error) {
          if (activeRevision !== undefined) activeSecretReservations.delete(activeRevision);
          throw error;
        }

        const bundle: ModelSecretBundle = Object.freeze({
          revision: reservation.revision,
          bearerToken: validatedSecretInput.bearerToken,
          headers: validatedSecretInput.headers,
        });
        try {
          await this.secrets.save(bundle);
        } catch (error) {
          await this.recoverFailedPublication(error, reservation.revision, updatedAt, "Model credentials were not written and credential cleanup failed");
          throw error;
        }
        let stored: ModelConfig & Readonly<{ secretRevision: number; updatedAt: string }>;
        try {
          stored = await this.transactions.runExclusive(async (transaction) => {
            const current = await this.configs.load(transaction);
            if (current?.secretRevision !== reservation.expectedRevision) throw new PublicationConflictError();
            const state = await coordinationState(transaction, current?.secretRevision, updatedAt);
            if (!state.reservations.includes(reservation.revision)) throw new PublicationConflictError();
            const saved = await this.configs.save(transaction, config, reservation.revision, updatedAt);
            const pending = reservation.expectedRevision === undefined
              ? state.pending
              : appendPendingRevision(state.pending, reservation.expectedRevision);
            await putMeta(transaction, RESERVATIONS_KEY, state.reservations.filter((revision) => revision !== reservation.revision), updatedAt);
            await putMeta(transaction, CLEANUP_PENDING_KEY, pending, updatedAt);
            return saved;
          });
          activeSecretReservations.delete(reservation.revision);
        } catch (error) {
          await this.recoverFailedPublication(error, reservation.revision, updatedAt, "Model settings were not saved and credential cleanup failed");
          if (error instanceof PublicationConflictError) continue;
          throw error;
        }
        const cleanup = await this.cleanupUnreferencedSecretsAlreadyAdmitted(16, updatedAt);
        return Object.freeze({
          config,
          secrets: bundle,
          updatedAt: stored.updatedAt,
          cleanupPendingRevisions: cleanup.pendingRevisions,
        });
      }
      throw new Error("Model settings publication conflicted too many times");
    });
  }

  async load(): Promise<LoadedModelSettings | null> {
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const stored = await this.transactions.runExclusive((transaction) => this.configs.load(transaction));
      if (!stored) return null;
      try {
        const bundle = await this.secrets.load(stored.secretRevision);
        const current = await this.transactions.runExclusive((transaction) => this.configs.load(transaction));
        if (current?.secretRevision !== stored.secretRevision) continue;
        if (!bundle) throw new ModelSettingsUnavailableError();
        const config: ModelConfig = Object.freeze({
          displayName: stored.displayName,
          baseUrl: stored.baseUrl,
          chatPath: stored.chatPath,
          modelId: stored.modelId,
          authMode: stored.authMode,
          headerNames: stored.headerNames,
        });
        return Object.freeze({
          config,
          secrets: validateSecretBundle(config, bundle),
          updatedAt: stored.updatedAt,
          cleanupPendingRevisions: await this.pendingCleanupRevisions(),
        });
      } catch (error) {
        if (error instanceof ModelSettingsUnavailableError) throw error;
        throw new ModelSettingsUnavailableError();
      }
    }
    throw new ModelSettingsUnavailableError();
  }

  async cleanupUnreferencedSecrets(limit = 16, updatedAt = new Date().toISOString()): Promise<SecretCleanupResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Cleanup limit must be between 1 and 100");
    return this.coordinator.runUserWrite(() => this.cleanupUnreferencedSecretsAlreadyAdmitted(limit, updatedAt));
  }

  private async cleanupUnreferencedSecretsAlreadyAdmitted(limit: number, updatedAt: string): Promise<SecretCleanupResult> {
    const state = await this.transactions.runExclusive(async (transaction) => {
      const current = await this.configs.load(transaction);
      return coordinationState(transaction, current?.secretRevision, updatedAt);
    });
    const candidates = [...new Set([
      ...state.pending,
      ...Array.from({ length: Math.max(0, Math.min(limit, state.counter - state.cursor)) }, (_, index) => state.cursor + index + 1),
    ])].filter((revision) => (
      revision <= state.counter
      && revision !== state.currentRevision
      && !state.reservations.includes(revision)
      && !activeSecretReservations.has(revision)
    )).slice(0, limit);
    const deleted: number[] = [];
    const failed: number[] = [];
    for (const revision of candidates) {
      try {
        if (await this.deleteIfUnreferenced(revision)) deleted.push(revision);
      } catch {
        failed.push(revision);
      }
    }
    await this.transactions.runExclusive(async (transaction) => {
      const current = await this.configs.load(transaction);
      const state = await coordinationState(transaction, current?.secretRevision, updatedAt);
      const stillPending = state.pending
        .filter((revision) => !deleted.includes(revision) && revision !== current?.secretRevision)
        .sort((left, right) => left - right);
      await putMeta(transaction, CLEANUP_PENDING_KEY, stillPending, updatedAt);
      let cursor = state.cursor;
      while (deleted.includes(cursor + 1) || cursor + 1 === current?.secretRevision) cursor += 1;
      await putMeta(transaction, CLEANUP_CURSOR_KEY, cursor, updatedAt);
    });
    return Object.freeze({
      deletedRevisions: Object.freeze(deleted),
      failedRevisions: Object.freeze(failed),
      pendingRevisions: await this.pendingCleanupRevisions(),
    });
  }

  private async pendingCleanupRevisions(): Promise<readonly number[]> {
    return this.transactions.runExclusive(async (transaction) => {
      const current = await this.configs.load(transaction);
      const state = await coordinationState(transaction, current?.secretRevision, new Date().toISOString(), false);
      return Object.freeze(state.pending);
    });
  }

  private async deleteIfUnreferenced(revision: number): Promise<boolean> {
    const unreferenced = await this.transactions.runExclusive(async (transaction) => {
      const current = await this.configs.load(transaction);
      const state = await coordinationState(transaction, current?.secretRevision, new Date().toISOString());
      return revision <= state.counter
        && current?.secretRevision !== revision
        && !state.reservations.includes(revision)
        && !activeSecretReservations.has(revision);
    });
    if (!unreferenced) return false;
    await this.secrets.delete(revision);
    return true;
  }

  private async recoverFailedPublication(primaryError: unknown, revision: number, updatedAt: string, message: string): Promise<void> {
    let cleanupError: unknown;
    try {
      const current = await this.transactions.runExclusive((transaction) => this.configs.load(transaction));
      if (current?.secretRevision !== revision) await this.secrets.delete(revision);
    } catch (error) {
      cleanupError = error;
    }
    let persistenceError: unknown;
    try {
      await this.transactions.runExclusive(async (transaction) => {
        const current = await this.configs.load(transaction);
        const state = await coordinationState(transaction, current?.secretRevision, updatedAt);
        const reservations = state.reservations.filter((item) => item !== revision);
        const pending = cleanupError !== undefined && revision <= state.counter && revision !== current?.secretRevision
          ? appendPendingRevision(state.pending, revision)
          : state.pending.filter((item) => item !== revision);
        await putMeta(transaction, RESERVATIONS_KEY, reservations, updatedAt);
        await putMeta(transaction, CLEANUP_PENDING_KEY, pending, updatedAt);
      });
    } catch (error) {
      persistenceError = error;
    } finally {
      activeSecretReservations.delete(revision);
    }
    const errors = [primaryError];
    if (cleanupError !== undefined) errors.push(cleanupError);
    if (persistenceError !== undefined) errors.push(persistenceError);
    if (errors.length > 1) {
      throw new AggregateError(errors, message);
    }
  }
}
