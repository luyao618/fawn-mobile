import { act, render, screen } from "@testing-library/react-native";

import { AppComposition } from "../../App";
import type { FaultRequest } from "../../src/testing/faultContract";

jest.mock("../../src/navigation/RootNavigator", () => ({ RootNavigator: () => null }));

test("app composition mounts the build-flavor controller with an abort signal and cleans it up", async () => {
  const dispose = jest.fn();
  const installFaults = jest.fn(async (_onFault: (request: FaultRequest) => void, _signal?: AbortSignal) => dispose);
  const view = render(<AppComposition installFaults={installFaults} />);
  await act(async () => {});
  expect(installFaults).toHaveBeenCalledTimes(1);
  expect(installFaults.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  const signal = installFaults.mock.calls[0]?.[1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("app composition aborts and disposes a controller that resolves after unmount", async () => {
  let resolve!: (dispose: () => void) => void;
  const pending = new Promise<() => void>((done) => { resolve = done; });
  const installFaults = jest.fn((_onFault: (request: FaultRequest) => void, _signal?: AbortSignal) => pending);
  const dispose = jest.fn();
  const view = render(<AppComposition installFaults={installFaults} />);
  const signal = installFaults.mock.calls[0]?.[1];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(dispose));
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("async E2E setup failures enter the explicit error path inside AppErrorBoundary", async () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  const installFaults = jest.fn(async (_onFault: (request: FaultRequest) => void, _signal?: AbortSignal) => { throw new Error("synthetic E2E setup failure"); });
  render(<AppComposition installFaults={installFaults} />);
  await act(async () => {});
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("synthetic E2E setup failure")).toBeNull();
  consoleError.mockRestore();
});
