import type { BootstrapTraceRecord as PublicBootstrapTraceRecord } from "@for-mobile/fault-controller";
import type { BootstrapTraceRecord as CanonicalBootstrapTraceRecord } from "../../../src/application/bootstrap/recoverAndOpen";
import { Linking } from "react-native";

import {
  installFaultController as installE2EFaultController,
  traceBootstrap as traceE2EBootstrap,
} from "../../../src/testing/FaultController.e2e";
import {
  installFaultController as installProductionFaultController,
  traceBootstrap as traceProductionBootstrap,
} from "../../../src/testing/FaultController.production";
import { FAULT_POINTS, canonicalFaultUrl, parseFaultUrl } from "../../../src/testing/faultContract";

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
  : false;
const publicBootstrapTraceTypeIsCanonical: Exact<PublicBootstrapTraceRecord, CanonicalBootstrapTraceRecord> = true;
void publicBootstrapTraceTypeIsCanonical;

const acceptsPublicBootstrapTraceRecord = (_record: PublicBootstrapTraceRecord): undefined => undefined;

acceptsPublicBootstrapTraceRecord({ kind: "start", attempt: 1 });
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "ready", outcome: "success", closeOutcome: "not-attempted" });
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "migrate", outcome: "failure", closeOutcome: "succeeded", failureCategory: "sqlite" });
// @ts-expect-error successful bootstrap traces exist only at ready
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "migrate", outcome: "success", closeOutcome: "not-attempted" });
// @ts-expect-error successful bootstrap traces never observe a close
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "ready", outcome: "success", closeOutcome: "succeeded" });
// @ts-expect-error successful bootstrap traces never carry a failure category
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "ready", outcome: "success", closeOutcome: "not-attempted", failureCategory: "sqlite" });
// @ts-expect-error successful bootstrap traces reject even an explicitly undefined failure category
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "ready", outcome: "success", closeOutcome: "not-attempted", failureCategory: undefined });
// @ts-expect-error failed bootstrap traces never use the ready stage
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "ready", outcome: "failure", closeOutcome: "succeeded", failureCategory: "sqlite" });
// @ts-expect-error failed bootstrap traces must observe the close attempt
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "migrate", outcome: "failure", closeOutcome: "not-attempted", failureCategory: "sqlite" });
// @ts-expect-error failed bootstrap traces require an allowlisted failure category
acceptsPublicBootstrapTraceRecord({ kind: "terminal", attempt: 1, stage: "migrate", outcome: "failure", closeOutcome: "succeeded" });

const NORMATIVE_FAULT_POINTS = [
  "turn.after_user_commit",
  "turn.after_response_commit",
  "job.after_lease",
  "backup.after_db_snapshot",
  "backup.after_album_copy",
  "restore.after_journal_prepared",
  "restore.after_live_db_closed",
  "restore.after_live_move_before_phase",
  "restore.after_live_moved",
  "restore.after_promote_before_phase",
  "restore.after_staged_promoted",
  "restore.after_verified",
  "restore.after_committed_before_cleanup",
] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => jest.restoreAllMocks());

test("canonical fault grammar equals the independently pinned ordered 13-point registry", () => {
  expect(FAULT_POINTS).toEqual(NORMATIVE_FAULT_POINTS);
  for (const point of NORMATIVE_FAULT_POINTS) expect(parseFaultUrl(canonicalFaultUrl(point))).toEqual({ point, mode: "crash_once" });
});

test.each([
  "http://fault?point=turn.after_user_commit&mode=crash_once",
  "formobile-test://other?point=turn.after_user_commit&mode=crash_once",
  "formobile-test://fault/?point=turn.after_user_commit&mode=crash_once",
  "formobile-test://user@fault?point=turn.after_user_commit&mode=crash_once",
  "formobile-test://fault:80?point=turn.after_user_commit&mode=crash_once",
  "formobile-test://fault?mode=crash_once&point=turn.after_user_commit",
  "formobile-test://fault?point=turn%2Eafter_user_commit&mode=crash_once",
  "formobile-test://fault?point=turn.after_user_commit&point=turn.after_user_commit&mode=crash_once",
  "formobile-test://fault?point=turn.after_user_commit&mode=crash_once&extra=1",
  "formobile-test://fault?point=turn.after_user_commit&mode=crash_once#fragment",
  "formobile-test://fault?point=unknown.point&mode=crash_once",
  "formobile-test://fault?point=turn.after_user_commit&mode=crash_always",
])("rejects noncanonical fault URI %s", (value) => expect(parseFaultUrl(value)).toBeNull());

test("standalone production controller is a true no-op", async () => {
  const onFault = jest.fn();
  const dispose = await installProductionFaultController(onFault, AbortSignal.abort());
  dispose();
  expect(onFault).not.toHaveBeenCalled();
});

test("native listener installation throws instead of being silently swallowed", async () => {
  jest.spyOn(Linking, "addEventListener").mockImplementation(() => { throw new Error("synthetic listener failure"); });
  await expect(installE2EFaultController(jest.fn())).rejects.toThrow("synthetic listener failure");
});

test("initial URL rejection removes the listener and rejects setup", async () => {
  const remove = jest.fn();
  jest.spyOn(Linking, "addEventListener").mockReturnValue({ remove } as never);
  jest.spyOn(Linking, "getInitialURL").mockRejectedValue(new Error("synthetic initial URL failure"));
  await expect(installE2EFaultController(jest.fn())).rejects.toThrow("synthetic initial URL failure");
  expect(remove).toHaveBeenCalledTimes(1);
});

test("active canonical initial URL is parsed and delivered exactly once", async () => {
  const remove = jest.fn();
  const point = NORMATIVE_FAULT_POINTS[0];
  jest.spyOn(Linking, "addEventListener").mockReturnValue({ remove } as never);
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(canonicalFaultUrl(point));
  const onFault = jest.fn();
  const cleanup = await installE2EFaultController(onFault);
  expect(onFault).toHaveBeenCalledTimes(1);
  expect(onFault).toHaveBeenCalledWith({ point, mode: "crash_once" });
  cleanup();
  expect(remove).toHaveBeenCalledTimes(1);
});

test("abort during pending initial URL removes the listener and suppresses post-disposal delivery", async () => {
  const initial = deferred<string | null>();
  const remove = jest.fn();
  jest.spyOn(Linking, "getInitialURL").mockReturnValue(initial.promise);
  jest.spyOn(Linking, "addEventListener").mockReturnValue({ remove } as never);
  const onFault = jest.fn();
  const abortController = new AbortController();
  const installing = installE2EFaultController(onFault, abortController.signal);
  abortController.abort();
  initial.resolve(canonicalFaultUrl(NORMATIVE_FAULT_POINTS[0]));
  const cleanup = await installing;
  cleanup();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(onFault).not.toHaveBeenCalled();
});

test("installed URL callback cannot deliver after cleanup", async () => {
  let listener!: ({ url }: { url: string }) => void;
  const remove = jest.fn();
  jest.spyOn(Linking, "addEventListener").mockImplementation((_event, callback) => {
    listener = callback as typeof listener;
    return { remove } as never;
  });
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  const onFault = jest.fn();
  const cleanup = await installE2EFaultController(onFault);
  cleanup();
  listener({ url: canonicalFaultUrl(NORMATIVE_FAULT_POINTS[0]) });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(onFault).not.toHaveBeenCalled();
});

test("production fault-controller alias exposes no bootstrap trace sink", () => {
  expect(traceProductionBootstrap).toBeUndefined();
});

test("E2E bootstrap tracing emits bounded whitelist-only records with one session and monotonic sequence", () => {
  const output = jest.spyOn(console, "info").mockImplementation(() => {});
  traceE2EBootstrap({
    kind: "start",
    attempt: 1,
    message: "private message",
    stack: "private stack",
    path: "/private/database.db",
    code: "RAW_CODE",
  } as never);
  traceE2EBootstrap({
    kind: "terminal",
    attempt: 1,
    stage: "migrate",
    outcome: "failure",
    closeOutcome: "succeeded",
    failureCategory: "sqlite",
    cause: new Error("private cause"),
    sql: "SELECT secret FROM rows",
    url: "https://secret.invalid",
  } as never);
  traceE2EBootstrap({ kind: "start", attempt: 1 });
  traceE2EBootstrap({ kind: "terminal", attempt: 1, stage: "ready", outcome: "success", closeOutcome: "not-attempted" });
  traceE2EBootstrap({ kind: "start", attempt: 33 });
  expect(output).toHaveBeenCalledTimes(2);

  const records = output.mock.calls.map(([line]) => {
    expect(typeof line).toBe("string");
    expect(line).toMatch(/^FOR_MOBILE_E2E_BOOTSTRAP_TRACE_V1 /);
    return JSON.parse(String(line).slice("FOR_MOBILE_E2E_BOOTSTRAP_TRACE_V1 ".length));
  });
  expect(records).toEqual([
    { schemaVersion: 1, session: expect.stringMatching(/^[a-z0-9]{12}$/), sequence: 1, attempt: 1, kind: "start" },
    {
      schemaVersion: 1,
      session: records[0]?.session,
      sequence: 2,
      attempt: 1,
      kind: "terminal",
      stage: "migrate",
      outcome: "failure",
      closeOutcome: "succeeded",
      failureCategory: "sqlite",
    },
  ]);
});

test("E2E bootstrap trace console failure is synchronously contained", () => {
  const output = jest.spyOn(console, "info").mockImplementation(() => { throw new Error("synthetic console failure"); });
  expect(() => traceE2EBootstrap({ kind: "start", attempt: 2 })).not.toThrow();
  expect(output).toHaveBeenCalledTimes(1);
});

test("E2E bootstrap tracing rejects alternate kinds and enforces the terminal truth table", () => {
  const output = jest.spyOn(console, "info").mockImplementation(() => {});
  let attempt = 3;
  const acceptedSuccess = () => ({
    kind: "terminal",
    attempt,
    stage: "ready",
    outcome: "success",
    closeOutcome: "not-attempted",
  } as const);
  const rejectThenAccept = (record: Record<string, unknown>) => {
    traceE2EBootstrap({ kind: "start", attempt });
    const afterStart = output.mock.calls.length;
    traceE2EBootstrap({ ...record, attempt } as never);
    expect(output).toHaveBeenCalledTimes(afterStart);
    traceE2EBootstrap(acceptedSuccess());
    expect(output).toHaveBeenCalledTimes(afterStart + 1);
    attempt += 1;
  };

  for (const kind of ["heartbeat", "ready", "failure", ""]) {
    rejectThenAccept({ kind, stage: "ready", outcome: "success", closeOutcome: "not-attempted" });
  }
  for (const stage of ["open-configure", "migrate", "post-migrate"]) {
    rejectThenAccept({ kind: "terminal", stage, outcome: "success", closeOutcome: "not-attempted" });
  }
  for (const closeOutcome of ["unobserved", "succeeded", "failed"]) {
    rejectThenAccept({ kind: "terminal", stage: "ready", outcome: "success", closeOutcome });
  }
  rejectThenAccept({ kind: "terminal", stage: "ready", outcome: "success", closeOutcome: "not-attempted", failureCategory: "sqlite" });
  rejectThenAccept({ kind: "terminal", stage: "ready", outcome: "failure", closeOutcome: "succeeded", failureCategory: "sqlite" });
  rejectThenAccept({ kind: "terminal", stage: "migrate", outcome: "failure", closeOutcome: "not-attempted", failureCategory: "sqlite" });
  rejectThenAccept({ kind: "terminal", stage: "migrate", outcome: "failure", closeOutcome: "succeeded" });
  rejectThenAccept({ kind: "terminal", stage: "migrate", outcome: "failure", closeOutcome: "succeeded", failureCategory: "foreign" });

  traceE2EBootstrap({ kind: "start", attempt });
  traceE2EBootstrap(acceptedSuccess());
  attempt += 1;
  for (const stage of ["open-configure", "migrate", "post-migrate"] as const) {
    for (const closeOutcome of ["unobserved", "succeeded", "failed"] as const) {
      traceE2EBootstrap({ kind: "start", attempt });
      traceE2EBootstrap({ kind: "terminal", attempt, stage, outcome: "failure", closeOutcome, failureCategory: "uncoded" });
      attempt += 1;
    }
  }
  expect(attempt).toBeLessThanOrEqual(32);
});
