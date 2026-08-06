import { createContext, type PropsWithChildren, useContext } from "react";

import type { RecentRecordsServicePort } from "../../application/insights/recentRecordsService";

const RecentRecordsServiceContext = createContext<RecentRecordsServicePort | null>(null);

export function RecentRecordsServiceProvider({
  children,
  service,
}: PropsWithChildren<{ service: RecentRecordsServicePort }>) {
  return <RecentRecordsServiceContext.Provider value={service}>{children}</RecentRecordsServiceContext.Provider>;
}

export function useRecentRecordsService(): RecentRecordsServicePort {
  const service = useContext(RecentRecordsServiceContext);
  if (!service) throw new Error("Recent records are unavailable before application readiness");
  return service;
}
