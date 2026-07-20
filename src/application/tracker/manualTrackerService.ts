import type { RuntimeOperationPort } from "../bootstrap/appRuntime.ts";
import type { ClockPort } from "../bootstrap/recoverAndOpen.ts";
import type { DataMutationCoordinator } from "../data/DataMutationCoordinator.ts";
import type { ExclusiveTransactionPort, QueryRunHandle } from "../data/ExclusiveTransactionPort.ts";
import { trackerMutationRequiresConfirmation } from "../../domain/tracker/confirmationPolicy.ts";
import type {
  TrackerCreateInputByDomain,
  TrackerDeletion,
  TrackerDomain,
  TrackerRecordByDomain,
  TrackerUpdateInputByDomain,
} from "../../domain/tracker/types.ts";
import {
  assertTrackerDomain,
  assertTrackerListLimit,
  canonicalTrackerInstant,
  normalizeTrackerCreateInput,
  normalizeTrackerUpdateInput,
  TrackerValidationError,
} from "../../domain/tracker/validation.ts";

export type ManualTrackerConflictCode = "stale_write" | "not_found";

export interface ManualTrackerConflictClassifierPort {
  classify(error: unknown): ManualTrackerConflictCode | null;
}

export class ManualTrackerConflictError extends Error {
  constructor(readonly code: ManualTrackerConflictCode) {
    super(`Manual tracker operation conflicted (${code})`);
    this.name = "ManualTrackerConflictError";
  }
}

export function isManualTrackerConflictError(value: unknown): value is ManualTrackerConflictError {
  return value instanceof ManualTrackerConflictError;
}

export interface TrackerStore {
  getById<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    id: string,
  ): Promise<TrackerRecordByDomain[D] | null>;

  list<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    limit: number,
  ): Promise<readonly TrackerRecordByDomain[D][]>;
}

export interface TrackerWriter {
  create<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    id: string,
    input: TrackerCreateInputByDomain[D],
    now: string,
  ): Promise<TrackerRecordByDomain[D]>;

  update<D extends TrackerDomain>(
    transaction: QueryRunHandle,
    domain: D,
    id: string,
    input: TrackerUpdateInputByDomain[D],
    expectedUpdatedAt: string,
    now: string,
  ): Promise<TrackerRecordByDomain[D]>;

  softDelete(
    transaction: QueryRunHandle,
    domain: TrackerDomain,
    id: string,
    expectedUpdatedAt: string,
    now: string,
  ): Promise<TrackerDeletion>;
}

export interface LocalIdGenerator {
  nextId(): string;
}

export type TrackerCreateSummary<D extends TrackerDomain = TrackerDomain> = Readonly<{
  action: "create";
  domain: D;
  input: TrackerCreateInputByDomain[D];
}>;

export type TrackerUpdateSummary<D extends TrackerDomain = TrackerDomain> = Readonly<{
  action: "update";
  domain: D;
  id: string;
  expectedUpdatedAt: string;
  input: TrackerUpdateInputByDomain[D];
}>;

export type TrackerDeleteSummary<D extends TrackerDomain = TrackerDomain> = Readonly<{
  action: "delete";
  domain: D;
  id: string;
  expectedUpdatedAt: string;
}>;

export type TrackerConfirmationResult<TSummary> = Readonly<{
  status: "confirmation_required";
  summary: TSummary;
}>;

export type TrackerRecordCompleted<TSummary, TRecord> = Readonly<{
  status: "completed";
  summary: TSummary;
  record: TRecord;
}>;

export type TrackerDeleteCompleted<TSummary> = Readonly<{
  status: "completed";
  summary: TSummary;
  deletion: TrackerDeletion;
}>;

export interface ManualTrackerServicePort {
  getById<D extends TrackerDomain>(domain: D, id: string): Promise<TrackerRecordByDomain[D] | null>;
  list<D extends TrackerDomain>(domain: D, limit: number): Promise<readonly TrackerRecordByDomain[D][]>;
  create<D extends TrackerDomain>(
    domain: D,
    input: TrackerCreateInputByDomain[D],
    confirmation?: "confirmed",
  ): Promise<
    | TrackerConfirmationResult<TrackerCreateSummary<D>>
    | TrackerRecordCompleted<TrackerCreateSummary<D>, TrackerRecordByDomain[D]>
  >;
  update<D extends TrackerDomain>(
    domain: D,
    id: string,
    input: TrackerUpdateInputByDomain[D],
    expectedUpdatedAt: string,
    confirmation?: "confirmed",
  ): Promise<
    | TrackerConfirmationResult<TrackerUpdateSummary<D>>
    | TrackerRecordCompleted<TrackerUpdateSummary<D>, TrackerRecordByDomain[D]>
  >;
  delete<D extends TrackerDomain>(
    domain: D,
    id: string,
    expectedUpdatedAt: string,
    confirmation?: "confirmed",
  ): Promise<TrackerConfirmationResult<TrackerDeleteSummary<D>> | TrackerDeleteCompleted<TrackerDeleteSummary<D>>>;
}

function trackerId(domain: TrackerDomain, value: unknown): string {
  if (typeof value !== "string") throw new TrackerValidationError(domain, "id", "Tracker id must be text");
  return value;
}

export class ManualTrackerService implements ManualTrackerServicePort {
  constructor(
    private readonly transactions: ExclusiveTransactionPort,
    private readonly coordinator: DataMutationCoordinator,
    private readonly store: TrackerStore,
    private readonly writer: TrackerWriter,
    private readonly conflicts: ManualTrackerConflictClassifierPort,
    private readonly clock: ClockPort,
    private readonly ids: LocalIdGenerator,
    private readonly operations: RuntimeOperationPort,
  ) {}

  private async translatePersistenceConflict<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code = this.conflicts.classify(error);
      if (code !== null) throw new ManualTrackerConflictError(code);
      throw error;
    }
  }

  getById<D extends TrackerDomain>(domain: D, id: string): Promise<TrackerRecordByDomain[D] | null> {
    return this.operations.run(async () => {
      assertTrackerDomain(domain);
      const normalizedId = trackerId(domain, id);
      return this.transactions.runExclusive((transaction) => this.store.getById(transaction, domain, normalizedId));
    });
  }

  list<D extends TrackerDomain>(domain: D, limit: number): Promise<readonly TrackerRecordByDomain[D][]> {
    return this.operations.run(async () => {
      assertTrackerDomain(domain);
      assertTrackerListLimit(limit);
      return this.transactions.runExclusive((transaction) => this.store.list(transaction, domain, limit));
    });
  }

  create<D extends TrackerDomain>(
    domain: D,
    input: TrackerCreateInputByDomain[D],
    confirmation?: "confirmed",
  ): Promise<
    | TrackerConfirmationResult<TrackerCreateSummary<D>>
    | TrackerRecordCompleted<TrackerCreateSummary<D>, TrackerRecordByDomain[D]>
  > {
    return this.operations.run(async () => {
      assertTrackerDomain(domain);
      const normalized = normalizeTrackerCreateInput(domain, input);
      const summary = Object.freeze({ action: "create" as const, domain, input: normalized });
      if (trackerMutationRequiresConfirmation("create", domain) && confirmation !== "confirmed") {
        return Object.freeze({ status: "confirmation_required" as const, summary });
      }
      return this.coordinator.runUserWrite(async () => this.transactions.runExclusive(async (transaction) => {
        const id = trackerId(domain, this.ids.nextId());
        const now = canonicalTrackerInstant(domain, "createdAt", this.clock.now());
        const record = await this.writer.create(transaction, domain, id, normalized, now);
        return Object.freeze({ status: "completed" as const, summary, record });
      }));
    });
  }

  update<D extends TrackerDomain>(
    domain: D,
    id: string,
    input: TrackerUpdateInputByDomain[D],
    expectedUpdatedAt: string,
    confirmation?: "confirmed",
  ): Promise<
    | TrackerConfirmationResult<TrackerUpdateSummary<D>>
    | TrackerRecordCompleted<TrackerUpdateSummary<D>, TrackerRecordByDomain[D]>
  > {
    return this.operations.run(async () => {
      assertTrackerDomain(domain);
      const normalizedId = trackerId(domain, id);
      const normalizedExpected = canonicalTrackerInstant(domain, "expectedUpdatedAt", expectedUpdatedAt);
      const normalized = normalizeTrackerUpdateInput(domain, input);
      const summary = Object.freeze({
        action: "update" as const,
        domain,
        id: normalizedId,
        expectedUpdatedAt: normalizedExpected,
        input: normalized,
      });
      if (confirmation !== "confirmed") {
        return Object.freeze({ status: "confirmation_required" as const, summary });
      }
      return this.coordinator.runUserWrite(async () => this.transactions.runExclusive(async (transaction) => {
        const now = canonicalTrackerInstant(domain, "updatedAt", this.clock.now());
        const record = await this.translatePersistenceConflict(
          () => this.writer.update(
            transaction,
            domain,
            normalizedId,
            normalized,
            normalizedExpected,
            now,
          ),
        );
        return Object.freeze({ status: "completed" as const, summary, record });
      }));
    });
  }

  delete<D extends TrackerDomain>(
    domain: D,
    id: string,
    expectedUpdatedAt: string,
    confirmation?: "confirmed",
  ): Promise<TrackerConfirmationResult<TrackerDeleteSummary<D>> | TrackerDeleteCompleted<TrackerDeleteSummary<D>>> {
    return this.operations.run(async () => {
      assertTrackerDomain(domain);
      const normalizedId = trackerId(domain, id);
      const normalizedExpected = canonicalTrackerInstant(domain, "expectedUpdatedAt", expectedUpdatedAt);
      const summary = Object.freeze({
        action: "delete" as const,
        domain,
        id: normalizedId,
        expectedUpdatedAt: normalizedExpected,
      });
      if (confirmation !== "confirmed") {
        return Object.freeze({ status: "confirmation_required" as const, summary });
      }
      return this.coordinator.runUserWrite(async () => this.transactions.runExclusive(async (transaction) => {
        const now = canonicalTrackerInstant(domain, "updatedAt", this.clock.now());
        const deletion = await this.translatePersistenceConflict(
          () => this.writer.softDelete(
            transaction,
            domain,
            normalizedId,
            normalizedExpected,
            now,
          ),
        );
        return Object.freeze({ status: "completed" as const, summary, deletion });
      }));
    });
  }
}
