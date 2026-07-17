import { type PropsWithChildren, useCallback, useEffect, useRef, useState } from "react";

import { BootstrapError } from "../../shared/ui/BootstrapError";
import { BootstrapPreparing } from "../../shared/ui/BootstrapPreparing";

export type BootstrapRuntime = { close(): Promise<void> };
export type Bootstrap = (signal: AbortSignal) => Promise<BootstrapRuntime>;

type BootstrapPhase = "pending" | "ready" | "error";

export function BootstrapHost({ bootstrap, children }: PropsWithChildren<{ bootstrap: Bootstrap }>) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<BootstrapPhase>("pending");
  const cleanupChain = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    let runtime: BootstrapRuntime | undefined;
    let closing: Promise<void> | undefined;
    const closeRuntime = (openedRuntime: BootstrapRuntime): Promise<void> => {
      closing ??= openedRuntime.close();
      return closing;
    };
    const abortController = new AbortController();
    const startup = cleanupChain.current.then(() => bootstrap(abortController.signal));
    void startup.then(async (openedRuntime) => {
      if (!active) {
        await closeRuntime(openedRuntime);
        return;
      }
      runtime = openedRuntime;
      setPhase("ready");
    }).catch(() => {
      if (active) setPhase("error");
    });
    return () => {
      active = false;
      abortController.abort();
      cleanupChain.current = startup.then(
        (openedRuntime) => closeRuntime(runtime ?? openedRuntime),
        () => undefined,
      );
    };
  }, [attempt, bootstrap]);

  const retry = useCallback(() => {
    setPhase((current) => {
      if (current !== "error") return current;
      setAttempt((value) => value + 1);
      return "pending";
    });
  }, []);

  if (phase === "error") {
    return (
      <BootstrapError
        body="本机数据保持原样。可以关闭其他操作后重试，此操作不会上传错误信息。"
        onRetry={retry}
        retryLabel="重试打开本机数据"
        title="无法打开本机数据"
      />
    );
  }
  if (phase !== "ready") return <BootstrapPreparing />;
  return children;
}
