import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AppComposition } from "../../App";
import type { AppRuntime } from "../../src/application/bootstrap/recoverAndOpen";
import type { Bootstrap } from "../../src/features/bootstrap/BootstrapHost";
import type { FaultRequest } from "../../src/testing/faultContract";

jest.mock("react-native-safe-area-context", () => {
  const { View: MockView } = jest.requireActual("react-native");
  return { SafeAreaProvider: ({ children }: { children: ReactNode }) => <MockView>{children}</MockView> };
});

const mockBootstrap = jest.fn<Promise<AppRuntime>, [AbortSignal]>();

jest.mock("../../src/infrastructure/bootstrap/createProductionBootstrap", () => ({
  createProductionBootstrap: () => (signal: AbortSignal) => mockBootstrap(signal),
}));

jest.mock("../../src/navigation/RootNavigator", () => {
  const { BootstrapHost: MockBootstrapHost } = jest.requireActual("../../src/features/bootstrap/BootstrapHost");
  const { Text: MockText } = jest.requireActual("react-native");
  return {
    RootNavigator: ({ bootstrap }: { bootstrap: Bootstrap }) => (
      <MockBootstrapHost bootstrap={bootstrap}><MockText>navigator-ready</MockText></MockBootstrapHost>
    ),
  };
});

const runtime = (close = jest.fn(async () => {})): AppRuntime => ({ close });
const successfulInstallFaults = async () => () => {};

beforeEach(() => {
  mockBootstrap.mockReset().mockResolvedValue(runtime());
});
const flushStartup = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test("app composition mounts the build-flavor controller with an abort signal and cleans it up", async () => {
  const dispose = jest.fn();
  const installFaults = jest.fn(async (_onFault: (request: FaultRequest) => void, _signal?: AbortSignal) => dispose);
  const view = render(<AppComposition installFaults={installFaults} />);
  await flushStartup();
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
  await flushStartup();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("synthetic E2E setup failure")).toBeNull();
  consoleError.mockRestore();
});

test("bootstrap gates navigation and retries locally without exposing failure details", async () => {
  const fetchMock = jest.spyOn(global, "fetch");
  const close = jest.fn(async () => {});
  mockBootstrap
    .mockRejectedValueOnce(new Error("private database path"))
    .mockResolvedValueOnce(runtime(close));
  render(<AppComposition installFaults={successfulInstallFaults} />);
  expect(screen.queryByText("navigator-ready")).toBeNull();
  expect(screen.getByLabelText("正在准备本机数据")).toBeTruthy();
  await flushStartup();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByText("private database path")).toBeNull();

  fireEvent.press(screen.getByRole("button", { name: "重试打开本机数据" }));
  expect(screen.queryByText("navigator-ready")).toBeNull();
  await flushStartup();
  expect(screen.getByText("navigator-ready")).toBeTruthy();
  expect(mockBootstrap).toHaveBeenCalledTimes(2);
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockRestore();
});

test("bootstrap ignores repeated retry taps and closes the ready runtime once on unmount", async () => {
  const close = jest.fn(async () => {});
  mockBootstrap
    .mockRejectedValueOnce(new Error("first"))
    .mockResolvedValueOnce(runtime(close));
  const view = render(<AppComposition installFaults={successfulInstallFaults} />);
  await flushStartup();
  const retry = screen.getByRole("button", { name: "重试打开本机数据" });
  fireEvent.press(retry);
  fireEvent.press(retry);
  await flushStartup();
  expect(mockBootstrap).toHaveBeenCalledTimes(2);
  view.unmount();
  await flushStartup();
  expect(close).toHaveBeenCalledTimes(1);
});

test("a startup that resolves after unmount is aborted and closed", async () => {
  let resolve!: (value: AppRuntime) => void;
  const pending = new Promise<AppRuntime>((done) => { resolve = done; });
  const close = jest.fn(async () => {});
  mockBootstrap.mockImplementation((_signal: AbortSignal) => pending);
  const view = render(<AppComposition installFaults={successfulInstallFaults} />);
  await flushStartup();
  const signal = mockBootstrap.mock.calls[0]?.[0];
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(runtime(close)));
  expect(close).toHaveBeenCalledTimes(1);
});
