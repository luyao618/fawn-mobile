import type { AppRuntime, AppServices, ReadyAppServices } from "../../application/bootstrap/appRuntime.ts";
import { recoverAndOpen, type StartupDatabaseHandle } from "../../application/bootstrap/recoverAndOpen.ts";
import { DataMutationCoordinator } from "../../application/data/DataMutationCoordinator.ts";
import { BabyProfileService } from "../../application/profile/babyProfileService.ts";
import { ManualTrackerService, type LocalIdGenerator } from "../../application/tracker/manualTrackerService.ts";
import { ExpoSqliteExclusiveTransactionAdapter } from "../db/exclusiveTransaction.ts";
import { applyUserDatabaseMigrations } from "../db/migrations/index.ts";
import { openConfiguredDatabase } from "../db/openDatabase.ts";
import { StartupRecoveryRepository } from "../db/repositories/startupRecoveryRepository.ts";
import { BabyProfileRepository } from "../db/repositories/babyProfileRepository.ts";
import { TrackerRepository } from "../db/repositories/trackerRepository.ts";
import { IntlDeviceCalendar } from "../time/deviceCalendar.ts";
import { RejectPendingAlbumRecovery } from "./albumRecoveryBoundary.ts";
import { isCleanupFailure, cleanupFailure, type CleanupFailure } from "../../shared/errors/cleanupFailure.ts";

export type ProductionBootstrap<TServices extends AppServices = AppServices> = (
  signal: AbortSignal,
) => Promise<AppRuntime<TServices>>;

const noPendingRestoreJournal = { async recover() {} };
const processNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

class ProcessLocalIdGenerator implements LocalIdGenerator {
  private counter = 0;

  nextId(): string {
    this.counter += 1;
    return `tracker-${processNonce}-${Date.now().toString(36)}-${this.counter.toString(36)}`;
  }
}

export function createProductionBootstrap(): ProductionBootstrap<ReadyAppServices> {
  const coordinator = new DataMutationCoordinator();
  const recovery = new StartupRecoveryRepository();
  const profiles = new BabyProfileRepository();
  const trackers = new TrackerRepository();
  const calendar = new IntlDeviceCalendar();
  const clock = { now: () => new Date().toISOString() };
  const trackerIds = new ProcessLocalIdGenerator();
  let blocked: CleanupFailure | undefined;
  let pendingCleanup: Promise<void> | undefined;
  return async (signal) => {
    if (pendingCleanup) await pendingCleanup;
    if (blocked) throw blocked;
    try {
      const runtime = await recoverAndOpen({
        coordinator,
        restore: noPendingRestoreJournal,
        database: {
          async openConfigured(): Promise<StartupDatabaseHandle> {
            const database = await openConfiguredDatabase();
            return {
              transactions: new ExpoSqliteExclusiveTransactionAdapter(database),
              async migrate() { await applyUserDatabaseMigrations(database); },
              async close() { await database.closeAsync(); },
            };
          },
        },
        album: new RejectPendingAlbumRecovery(),
        recovery,
        clock,
        services: {
          create(transactions, operations): ReadyAppServices {
            return Object.freeze({
              babyProfile: new BabyProfileService(
                transactions,
                coordinator,
                profiles,
                calendar,
                operations,
              ),
              tracker: new ManualTrackerService(
                transactions,
                coordinator,
                trackers,
                trackers,
                clock,
                trackerIds,
                operations,
              ),
            });
          },
        },
      }, signal);
      let closing: Promise<void> | undefined;
      return Object.freeze({
        services: runtime.services,
        close(): Promise<void> {
          closing ??= runtime.close().catch((error: unknown) => {
            const failure = isCleanupFailure(error)
              ? error
              : cleanupFailure([error], "Closing the production database failed");
            blocked = failure;
            throw failure;
          });
          pendingCleanup = closing;
          void closing.finally(() => {
            if (pendingCleanup === closing) pendingCleanup = undefined;
          }).catch(() => undefined);
          return closing;
        },
      });
    } catch (error) {
      if (isCleanupFailure(error)) blocked = error;
      throw error;
    }
  };
}
