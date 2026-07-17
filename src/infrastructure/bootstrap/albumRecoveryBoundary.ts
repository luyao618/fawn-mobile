import type { AlbumRecoveryPort, StartupDatabaseHandle } from "../../application/bootstrap/recoverAndOpen.ts";

export class RejectPendingAlbumRecovery implements AlbumRecoveryPort {
  async reconcile(database: StartupDatabaseHandle): Promise<void> {
    await database.transactions.runExclusive(async (transaction) => {
      const [row] = await transaction.query<{ total: number }>(
        "SELECT count(*) AS total FROM photos WHERE import_state != 'committed'",
      );
      if ((row?.total ?? 0) !== 0) throw new Error("Album reconciliation is required before startup");
    });
  }
}
