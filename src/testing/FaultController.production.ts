import type { FaultRequest } from "./faultContract";

const noOp = () => {};

export async function installFaultController(
  _onFault: (request: FaultRequest) => void,
  _signal?: AbortSignal,
): Promise<() => void> {
  return noOp;
}
