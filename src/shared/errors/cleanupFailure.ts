const CLEANUP_FAILURE_MARKER = "fawn.cleanup-failure.v1";

export type CleanupFailure = AggregateError & Readonly<{
  cleanupFailure: typeof CLEANUP_FAILURE_MARKER;
}>;

export function cleanupFailure(errors: readonly unknown[], message: string): CleanupFailure {
  const failure = new AggregateError(errors, message) as CleanupFailure;
  Object.defineProperty(failure, "cleanupFailure", {
    configurable: false,
    enumerable: false,
    value: CLEANUP_FAILURE_MARKER,
    writable: false,
  });
  return failure;
}

export function isCleanupFailure(value: unknown): value is CleanupFailure {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "cleanupFailure");
  return descriptor?.value === CLEANUP_FAILURE_MARKER
    && descriptor.configurable === false
    && descriptor.enumerable === false
    && descriptor.writable === false;
}
