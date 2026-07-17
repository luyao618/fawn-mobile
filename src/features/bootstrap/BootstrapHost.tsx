import { type PropsWithChildren, useCallback, useEffect, useRef, useState } from "react";

import { BootstrapError } from "../../shared/ui/BootstrapError";
import { BootstrapPreparing } from "../../shared/ui/BootstrapPreparing";
import { isCleanupFailure } from "../../shared/errors/cleanupFailure";

export type BootstrapRuntime = { close(): Promise<void> };
export type Bootstrap = (signal: AbortSignal) => Promise<BootstrapRuntime>;

type BootstrapPhase = "pending" | "ready" | "retryable-error" | "cleanup-blocked";

export function BootstrapHost({ bootstrap, children }: PropsWithChildren<{ bootstrap: Bootstrap }>) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<BootstrapPhase>("pending");
  const cleanupChain = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    let runtime: BootstrapRuntime | undefined;
    let closing: Promise<void> | undefined;
    const closeRuntime = (openedRuntime: BootstrapRuntime): Promise<void> => {
      closing ??= Promise.resolve().then(() => openedRuntime.close());
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
    }).catch((error: unknown) => {
      if (active) setPhase(isCleanupFailure(error) ? "cleanup-blocked" : "retryable-error");
    });
    return () => {
      active = false;
      abortController.abort();
      const cleanup = startup.then(
        (openedRuntime) => closeRuntime(runtime ?? openedRuntime),
        (error: unknown) => {
          if (isCleanupFailure(error)) throw error;
        },
      );
      cleanupChain.current = cleanup;
      void cleanup.catch(() => undefined);
    };
  }, [attempt, bootstrap]);

  const retry = useCallback(() => {
    setPhase((current) => {
      if (current !== "retryable-error") return current;
      setAttempt((value) => value + 1);
      return "pending";
    });
  }, []);

  if (phase === "cleanup-blocked") {
    return (
      <BootstrapError
        body="为保护本机数据，请完全关闭并重新打开应用。"
        title="需要重新启动应用"
      />
    );
  }
  if (phase === "retryable-error") {
    return (
      <BootstrapError
        action={{ label: "重试打开本机数据", onPress: retry }}
        body="本机数据保持原样。可以关闭其他操作后重试，此操作不会上传错误信息。"
        title="无法打开本机数据"
      />
    );
  }
  if (phase !== "ready") return <BootstrapPreparing />;
  return children;
}
