import { Linking } from "react-native";

import { installFaultController as installE2EFaultController } from "../../../src/testing/FaultController.e2e";
import { installFaultController as installProductionFaultController } from "../../../src/testing/FaultController.production";
import { FAULT_POINTS, canonicalFaultUrl, parseFaultUrl } from "../../../src/testing/faultContract";

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
