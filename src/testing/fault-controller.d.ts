declare module "@for-mobile/fault-controller" {
  import type { FaultRequest } from "./faultContract";

  export function installFaultController(
    onFault: (request: FaultRequest) => void,
    signal?: AbortSignal,
  ): Promise<() => void>;
}
