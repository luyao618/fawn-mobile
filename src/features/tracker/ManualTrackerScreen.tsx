import { useEffect } from "react";

import { AppFrame } from "../../shared/ui/AppFrame";
import { EmptyState } from "../../shared/ui/EmptyState";
import { useManualTrackerService } from "./ManualTrackerServiceContext";

export function ManualTrackerScreen() {
  const service = useManualTrackerService();

  useEffect(() => {
    void service.list("growth", 100).catch(() => undefined);
  }, [service]);

  return (
    <AppFrame localOnly title="记录">
      <EmptyState description="正在读取本机记录。" title="生长记录" />
    </AppFrame>
  );
}
