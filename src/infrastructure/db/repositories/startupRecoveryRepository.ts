import type { QueryRunHandle } from "../../../application/data/ExclusiveTransactionPort.ts";

const INTERRUPTED_TURN_ERROR = "startup_interrupted";

type CountRow = Readonly<{ total: number }>;

async function count(transaction: QueryRunHandle, sql: string, parameters: readonly string[] = []): Promise<number> {
  const [row] = await transaction.query<CountRow>(sql, parameters);
  return row?.total ?? 0;
}

function assertZero(total: number, message: string): void {
  if (total !== 0) throw new Error(message);
}

export class StartupRecoveryRepository {
  async recoverExpiredLeases(transaction: QueryRunHandle, now: string): Promise<void> {
    await transaction.run(
      `UPDATE local_jobs
       SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = NULL, updated_at = ?
       WHERE status = 'leased' AND lease_expires_at <= ?
         AND EXISTS (SELECT 1 FROM committed_job_effects effect WHERE effect.effect_key = local_jobs.effect_key)`,
      [now, now],
    );
    await transaction.run(
      `UPDATE local_jobs
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = ?, last_error_code = 'lease_expired', updated_at = ?
       WHERE status = 'leased' AND lease_expires_at <= ?
         AND NOT EXISTS (SELECT 1 FROM committed_job_effects effect WHERE effect.effect_key = local_jobs.effect_key)`,
      [now, now, now],
    );
  }

  async assertInterruptedTurnsConsistent(transaction: QueryRunHandle): Promise<void> {
    assertZero(await count(
      transaction,
      `SELECT count(*) AS total FROM chat_turns turn_row
       JOIN messages message ON message.turn_id = turn_row.id AND message.conversation_id = turn_row.conversation_id
       WHERE turn_row.status = 'generating' AND message.role = 'assistant'`,
    ), "Interrupted generating turn already owns an assistant message");
  }

  async failInterruptedTurns(transaction: QueryRunHandle, now: string): Promise<void> {
    await transaction.run(
      `UPDATE chat_turns SET status = 'failed', error_code = ?, completed_at = ?, updated_at = ?
       WHERE status = 'generating'`,
      [INTERRUPTED_TURN_ERROR, now, now],
    );
  }

  async expireStaleTasks(transaction: QueryRunHandle, now: string): Promise<void> {
    await transaction.run(
      `UPDATE pending_agent_tasks SET status = 'expired', updated_at = ?
       WHERE status IN ('pending', 'awaiting_confirmation') AND expires_at <= ?`,
      [now, now],
    );
  }

  async validateCoreInvariants(transaction: QueryRunHandle, now: string): Promise<void> {
    assertZero(await count(transaction, "SELECT count(*) AS total FROM pragma_foreign_key_check"), "Startup recovery found foreign-key violations");
    await this.assertInterruptedTurnsConsistent(transaction);
    assertZero(await count(
      transaction,
      "SELECT count(*) AS total FROM chat_turns WHERE status = 'generating'",
    ), "Startup recovery left an interrupted generating turn");
    assertZero(await count(
      transaction,
      "SELECT count(*) AS total FROM local_jobs WHERE status = 'leased' AND lease_expires_at <= ?",
      [now],
    ), "Startup recovery left an expired lease");
    assertZero(await count(
      transaction,
      "SELECT count(*) AS total FROM pending_agent_tasks WHERE status IN ('pending', 'awaiting_confirmation') AND expires_at <= ?",
      [now],
    ), "Startup recovery left a stale pending task");
  }
}
