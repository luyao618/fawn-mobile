import { createContext, type PropsWithChildren, useContext } from "react";

import type { BabyProfileServicePort } from "../../application/profile/babyProfileService";

const BabyProfileServiceContext = createContext<BabyProfileServicePort | null>(null);

export function BabyProfileServiceProvider({
  service,
  children,
}: PropsWithChildren<{ service: BabyProfileServicePort }>) {
  return (
    <BabyProfileServiceContext.Provider value={service}>
      {children}
    </BabyProfileServiceContext.Provider>
  );
}

export function useBabyProfileService(): BabyProfileServicePort {
  const service = useContext(BabyProfileServiceContext);
  if (!service) throw new Error("Baby profile service is unavailable before application readiness");
  return service;
}
