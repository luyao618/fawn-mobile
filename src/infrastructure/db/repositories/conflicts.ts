export type RepositoryConflictCode = "duplicate" | "illegal_transition" | "not_found" | "stale_write";

export class RepositoryConflictError extends Error {
  constructor(
    readonly code: RepositoryConflictCode,
    readonly entity: "chat_turn" | "pending_agent_task" | "local_job" | "model_config",
    readonly entityId: string,
    readonly currentState?: string,
  ) {
    super(`${entity} operation conflicted (${code})`);
    this.name = "RepositoryConflictError";
  }
}
