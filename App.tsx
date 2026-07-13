import { type PropsWithChildren, useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { RootNavigator } from "./src/navigation/RootNavigator";
import { AppErrorBoundary } from "./src/shared/errors/AppErrorBoundary";
import { installFaultController } from "@for-mobile/fault-controller";
import type { FaultRequest } from "./src/testing/faultContract";

type InstallFaults = (
  onFault: (request: FaultRequest) => void,
  signal?: AbortSignal,
) => Promise<() => void>;

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("E2E fault controller setup failed", { cause: reason });
}

function FaultControllerHost({ installFaults, children }: PropsWithChildren<{ installFaults: InstallFaults }>) {
  const [setupError, setSetupError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    let dispose = () => {};
    const abortController = new AbortController();
    void installFaults(() => {}, abortController.signal).then((installedDispose) => {
      if (active) dispose = installedDispose;
      else installedDispose();
    }).catch((error: unknown) => {
      if (active) setSetupError(asError(error));
    });
    return () => {
      active = false;
      abortController.abort();
      dispose();
    };
  }, [installFaults]);
  if (setupError) throw setupError;
  return children;
}

export function AppComposition({ installFaults = installFaultController }: { installFaults?: InstallFaults }) {
  return (
    <AppErrorBoundary>
      <FaultControllerHost installFaults={installFaults}>
        <SafeAreaProvider>
          <RootNavigator />
        </SafeAreaProvider>
      </FaultControllerHost>
    </AppErrorBoundary>
  );
}

export default function App() {
  return <AppComposition />;
}
