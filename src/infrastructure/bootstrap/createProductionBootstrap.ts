import type { AppRuntime, AppServices } from "../../application/bootstrap/appRuntime.ts";
import { recoverAndOpen, type StartupDatabaseHandle } from "../../application/bootstrap/recoverAndOpen.ts";
import { DataMutationCoordinator } from "../../application/data/DataMutationCoordinator.ts";
import { BabyProfileService } from "../../application/profile/babyProfileService.ts";
import { ExpoSqliteExclusiveTransactionAdapter } from "../db/exclusiveTransaction.ts";
import { applyUserDatabaseMigrations } from "../db/migrations/index.ts";
import { openConfiguredDatabase } from "../db/openDatabase.ts";
import { StartupRecoveryRepository } from "../db/repositories/startupRecoveryRepository.ts";
import { BabyProfileRepository } from "../db/repositories/babyProfileRepository.ts";
import { IntlDeviceCalendar } from "../time/deviceCalendar.ts";
import { RejectPendingAlbumRecovery } from "./albumRecoveryBoundary.ts";
import { isCleanupFailure, cleanupFailure, type CleanupFailure } from "../../shared/errors/cleanupFailure.ts";

export type ProductionBootstrap = (signal: AbortSignal) => Promise<AppRuntime<AppServices>>;

const noPendingRestoreJournal = { async recover() {} };

export function createProductionBootstrap(): ProductionBootstrap {
  const coordinator = new DataMutationCoordinator();
  const recovery = new StartupRecoveryRepository();
  const profiles = new BabyProfileRepository();
  const calendar = new IntlDeviceCalendar();
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
        clock: { now: () => new Date().toISOString() },
        services: {
          create(transactions, operations): AppServices {
            return Object.freeze({
              babyProfile: new BabyProfileService(
                transactions,
                coordinator,
                profiles,
                calendar,
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
