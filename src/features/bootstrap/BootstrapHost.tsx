import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { AppRuntime, AppServices } from "../../application/bootstrap/appRuntime";
import { BootstrapError } from "../../shared/ui/BootstrapError";
import { BootstrapPreparing } from "../../shared/ui/BootstrapPreparing";
import { isCleanupFailure } from "../../shared/errors/cleanupFailure";

export type BootstrapRuntime<TServices = AppServices> = AppRuntime<TServices>;
export type Bootstrap<TServices = AppServices> = (signal: AbortSignal) => Promise<BootstrapRuntime<TServices>>;

type BootstrapPhase = "pending" | "ready" | "retryable-error" | "cleanup-blocked";
type SettledBootstrap<TServices> = Readonly<{
  attempt: number;
  bootstrap: Bootstrap<TServices>;
  phase: Exclude<BootstrapPhase, "pending">;
  runtime?: BootstrapRuntime<TServices>;
}>;

export function BootstrapHost<TServices>({
  bootstrap,
  children,
}: {
  bootstrap: Bootstrap<TServices>;
  children: (services: TServices) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<SettledBootstrap<TServices> | null>(null);
  const cleanupChain = useRef(Promise.resolve());
  const retrying = useRef(false);
  const current = settled?.attempt === attempt && settled.bootstrap === bootstrap ? settled : null;
  const phase: BootstrapPhase = current?.phase ?? "pending";

  useEffect(() => {
    let active = true;
    let runtime: BootstrapRuntime<TServices> | undefined;
    let closing: Promise<void> | undefined;
    const closeRuntime = (openedRuntime: BootstrapRuntime<TServices>): Promise<void> => {
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
      retrying.current = false;
      setSettled({ attempt, bootstrap, phase: "ready", runtime: openedRuntime });
    }).catch((error: unknown) => {
      if (active) {
        retrying.current = false;
        setSettled({
          attempt,
          bootstrap,
          phase: isCleanupFailure(error) ? "cleanup-blocked" : "retryable-error",
        });
      }
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
    if (retrying.current || phase !== "retryable-error") return;
    retrying.current = true;
    setAttempt((value) => value + 1);
  }, [phase]);

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
  if (phase !== "ready" || !current?.runtime) return <BootstrapPreparing />;
  return children(current.runtime.services);
}
