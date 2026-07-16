import { RepositoryConflictError } from "./conflicts.ts";

type TimedEntity = "chat_turn" | "local_job";

export function assertCanonicalInstant(value: string): void {
  const instant = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(instant.getTime())
    || instant.toISOString() !== value
  ) {
    throw new TypeError("Event time must be a canonical ISO instant");
  }
}

export function assertFreshEventTime(
  value: string,
  currentValue: string,
  entity: TimedEntity,
  entityId: string,
  currentState: string,
): void {
  if (value <= currentValue) {
    throw new RepositoryConflictError(value === currentValue ? "duplicate" : "stale_write", entity, entityId, currentState);
  }
}
