import { createContext, type PropsWithChildren, useContext } from "react";

import type { ManualTrackerServicePort } from "../../application/tracker/manualTrackerService";

const ManualTrackerServiceContext = createContext<ManualTrackerServicePort | null>(null);

export function ManualTrackerServiceProvider({
  service,
  children,
}: PropsWithChildren<{ service: ManualTrackerServicePort }>) {
  return (
    <ManualTrackerServiceContext.Provider value={service}>
      {children}
    </ManualTrackerServiceContext.Provider>
  );
}

export function useManualTrackerService(): ManualTrackerServicePort {
  const service = useContext(ManualTrackerServiceContext);
  if (!service) throw new Error("Manual tracker service is unavailable before application readiness");
  return service;
}
