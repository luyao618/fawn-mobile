import { Linking } from "react-native";

import type {
  BootstrapTraceCloseOutcome,
  BootstrapTraceFailureCategory,
  BootstrapTraceRecord,
  BootstrapTraceStage,
} from "../application/bootstrap/recoverAndOpen";
import { parseFaultUrl, type FaultRequest } from "./faultContract";

export const E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL = "FOR_MOBILE_E2E_FAULT_CONTROLLER_REAL_V1";
export const E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL = "FOR_MOBILE_E2E_BOOTSTRAP_TRACE_V1";

const MAX_BOOTSTRAP_ATTEMPTS = 32;
const traceSession = Math.random().toString(36).slice(2, 14).padEnd(12, "0");
const traceAttempts = new Map<number, "started" | "terminal">();
const traceFailureStages = new Set<Exclude<BootstrapTraceStage, "ready">>(["open-configure", "migrate", "post-migrate"]);
const traceFailureCloseOutcomes = new Set<Exclude<BootstrapTraceCloseOutcome, "not-attempted">>(["unobserved", "succeeded", "failed"]);
const traceFailureCategories = new Set<BootstrapTraceFailureCategory>(["abort", "cleanup", "sqlite-open", "sqlite", "aggregate", "uncoded"]);
let traceSequence = 0;

export function traceBootstrap(record: BootstrapTraceRecord): void {
  const attempt = record.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_BOOTSTRAP_ATTEMPTS) return;
  let output: Readonly<Record<string, unknown>>;
  if (record.kind === "start") {
    if (traceAttempts.has(attempt)) return;
    traceAttempts.set(attempt, "started");
    output = Object.freeze({ schemaVersion: 1, session: traceSession, sequence: ++traceSequence, attempt, kind: "start" });
  } else if (record.kind === "terminal") {
    if (traceAttempts.get(attempt) !== "started"
      || !((record.outcome === "success"
          && record.stage === "ready"
          && record.closeOutcome === "not-attempted"
          && !("failureCategory" in record))
        || (record.outcome === "failure"
          && traceFailureStages.has(record.stage)
          && traceFailureCloseOutcomes.has(record.closeOutcome)
          && traceFailureCategories.has(record.failureCategory)))) return;
    traceAttempts.set(attempt, "terminal");
    const terminal = {
      schemaVersion: 1,
      session: traceSession,
      sequence: ++traceSequence,
      attempt,
      kind: "terminal",
      stage: record.stage,
      outcome: record.outcome,
      closeOutcome: record.closeOutcome,
    } as Record<string, unknown>;
    if (record.outcome === "failure") terminal.failureCategory = record.failureCategory;
    output = Object.freeze(terminal);
  } else {
    return;
  }
  try {
    console.info(`${E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL} ${JSON.stringify(output)}`);
  } catch {
    // Diagnostics must never alter bootstrap behavior.
  }
}

const noOp = () => {};

export async function installFaultController(
  onFault: (request: FaultRequest) => void,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) return noOp;
  let active = true;
  let removed = false;
  const handleUrl = ({ url }: { url: string }) => {
    if (!active || signal?.aborted) return;
    const request = parseFaultUrl(url);
    if (request) onFault(request);
  };
  const subscription = Linking.addEventListener("url", handleUrl);
  const dispose = () => {
    if (removed) return;
    active = false;
    removed = true;
    signal?.removeEventListener("abort", dispose);
    subscription.remove();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    const url = await Linking.getInitialURL();
    if (url) handleUrl({ url });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
