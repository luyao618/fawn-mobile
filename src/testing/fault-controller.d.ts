declare module "@for-mobile/fault-controller" {
  import type { FaultRequest } from "./faultContract";

  // eslint-disable-next-line no-restricted-syntax -- A type query keeps this ambient module canonical without turning it into a missing-module augmentation.
  export type BootstrapTraceRecord = import("../application/bootstrap/recoverAndOpen").BootstrapTraceRecord;
  // eslint-disable-next-line no-restricted-syntax -- A type query keeps this ambient module canonical without turning it into a missing-module augmentation.
  export const traceBootstrap: import("../application/bootstrap/recoverAndOpen").BootstrapTraceSink | undefined;

  export function installFaultController(
    onFault: (request: FaultRequest) => void,
    signal?: AbortSignal,
  ): Promise<() => void>;
}
