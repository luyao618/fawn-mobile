import type { ExclusiveTransactionPort } from "../data/ExclusiveTransactionPort.ts";
import type { BabyProfileServicePort } from "../profile/babyProfileService.ts";
import type { ManualTrackerServicePort } from "../tracker/manualTrackerService.ts";

export interface AppServices {
  readonly babyProfile: BabyProfileServicePort;
}

export interface ReadyAppServices extends AppServices {
  readonly tracker: ManualTrackerServicePort;
}

export interface RuntimeOperationPort {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface AppServicesFactory<TServices> {
  create(transactions: ExclusiveTransactionPort, operations: RuntimeOperationPort): TServices;
}

export interface AppRuntime<TServices = AppServices> {
  readonly services: TServices;
  close(): Promise<void>;
}

export class RuntimeClosingError extends Error {
  constructor() {
    super("Application services are unavailable because runtime close has begun");
    this.name = "RuntimeClosingError";
  }
}

export class RuntimeOperationGate implements RuntimeOperationPort {
  private state: "open" | "closing" | "closed" = "open";
  private activeOperations = 0;
  private resolveDrain: (() => void) | undefined;
  private closing: Promise<void> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== "open") return Promise.reject(new RuntimeClosingError());
    this.activeOperations += 1;
    let result: Promise<T>;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      this.finishOperation();
      return Promise.reject(error);
    }
    return result.finally(() => this.finishOperation());
  }

  close(closeResource: () => Promise<void>): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closing";
    this.closing = (async () => {
      try {
        if (this.activeOperations > 0) {
          await new Promise<void>((resolve) => { this.resolveDrain = resolve; });
        }
        await closeResource();
      } finally {
        this.state = "closed";
        this.resolveDrain = undefined;
      }
    })();
    return this.closing;
  }

  private finishOperation(): void {
    this.activeOperations -= 1;
    if (this.activeOperations === 0) {
      this.resolveDrain?.();
      this.resolveDrain = undefined;
    }
  }
}
