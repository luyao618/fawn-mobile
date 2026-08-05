import { createContext, type PropsWithChildren, useContext } from "react";

import type { ModelSettingsServicePort } from "../../../application/settings/modelSettingsService";

const ModelSettingsServiceContext = createContext<ModelSettingsServicePort | null>(null);

export function ModelSettingsServiceProvider({
  children,
  service,
}: PropsWithChildren<{ service: ModelSettingsServicePort }>) {
  return <ModelSettingsServiceContext.Provider value={service}>{children}</ModelSettingsServiceContext.Provider>;
}

export function useOptionalModelSettingsService(): ModelSettingsServicePort | null {
  return useContext(ModelSettingsServiceContext);
}

export function useModelSettingsService(): ModelSettingsServicePort {
  const service = useOptionalModelSettingsService();
  if (!service) throw new Error("Model settings are unavailable before application readiness");
  return service;
}
