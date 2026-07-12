import type { FaultRequest } from "./faultContract";

type E2EModule = typeof import("./FaultController.e2e");
type ImportE2E = () => Promise<E2EModule>;

const noOp = () => {};

export async function createFaultController(
  flavor: string | undefined,
  onFault: (request: FaultRequest) => void,
  importE2E: ImportE2E = () => import("./FaultController.e2e"),
  signal?: AbortSignal,
): Promise<() => void> {
  if (flavor !== "e2e") return noOp;
  const { installE2EFaultController } = await importE2E();
  return installE2EFaultController(onFault, signal);
}

export function installFaultController(
  onFault: (request: FaultRequest) => void,
  signal?: AbortSignal,
): Promise<() => void> {
  return createFaultController(process.env.EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR, onFault, undefined, signal);
}
