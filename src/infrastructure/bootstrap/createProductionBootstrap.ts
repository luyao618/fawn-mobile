import { recoverAndOpen, type AppRuntime, type StartupDatabaseHandle } from "../../application/bootstrap/recoverAndOpen.ts";
import { DataMutationCoordinator } from "../../application/data/DataMutationCoordinator.ts";
import { ExpoSqliteExclusiveTransactionAdapter } from "../db/exclusiveTransaction.ts";
import { applyUserDatabaseMigrations } from "../db/migrations/index.ts";
import { openConfiguredDatabase } from "../db/openDatabase.ts";
import { StartupRecoveryRepository } from "../db/repositories/startupRecoveryRepository.ts";
import { RejectPendingAlbumRecovery } from "./albumRecoveryBoundary.ts";

export type ProductionBootstrap = (signal: AbortSignal) => Promise<AppRuntime>;

const noPendingRestoreJournal = { async recover() {} };

export function createProductionBootstrap(): ProductionBootstrap {
  const coordinator = new DataMutationCoordinator();
  const recovery = new StartupRecoveryRepository();
  return (signal) => recoverAndOpen({
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
  }, signal);
}
