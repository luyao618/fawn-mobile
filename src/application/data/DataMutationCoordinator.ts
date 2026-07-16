export type MaintenanceKind = "migration" | "backup" | "restore" | "album";
export type MutationMode = "user-writes" | "maintenance-pending" | "maintenance";

export type MutationCoordinatorState = Readonly<{
  mode: MutationMode;
  activeUserWrites: number;
  waitingMaintenance: number;
}>;

export class DataMutationBusyError extends Error {
  constructor(message: "User writes are paused for maintenance" | "Maintenance admission is busy") {
    super(message);
    this.name = "DataMutationBusyError";
  }
}

export class DataMutationCoordinator {
  private activeUserWrites = 0;
  private waitingMaintenance = 0;
  private maintenanceActive = false;
  private drainUserWrites: (() => void) | undefined;

  constructor(private readonly maintenanceDrainTimeoutMs = 30_000) {
    if (!Number.isFinite(maintenanceDrainTimeoutMs) || maintenanceDrainTimeoutMs < 0) {
      throw new RangeError("Maintenance drain timeout must be a non-negative finite number");
    }
  }

  state(): MutationCoordinatorState {
    return Object.freeze({
      mode: this.maintenanceActive ? "maintenance" : this.waitingMaintenance > 0 ? "maintenance-pending" : "user-writes",
      activeUserWrites: this.activeUserWrites,
      waitingMaintenance: this.waitingMaintenance,
    });
  }

  async runUserWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (this.waitingMaintenance > 0 || this.maintenanceActive) {
      throw new DataMutationBusyError("User writes are paused for maintenance");
    }
    this.activeUserWrites += 1;
    try {
      return await operation();
    } finally {
      this.activeUserWrites -= 1;
      if (this.activeUserWrites === 0) {
        this.drainUserWrites?.();
        this.drainUserWrites = undefined;
      }
    }
  }

  async runMaintenance<T>(_kind: MaintenanceKind, operation: () => Promise<T>): Promise<T> {
    if (this.waitingMaintenance > 0 || this.maintenanceActive) {
      throw new DataMutationBusyError("Maintenance admission is busy");
    }
    this.waitingMaintenance += 1;
    try {
      await this.waitForUserWritesToDrain();
      this.waitingMaintenance -= 1;
      this.maintenanceActive = true;
      try {
        return await operation();
      } finally {
        this.maintenanceActive = false;
      }
    } finally {
      if (!this.maintenanceActive && this.waitingMaintenance > 0) this.waitingMaintenance -= 1;
    }
  }

  private async waitForUserWritesToDrain(): Promise<void> {
    if (this.activeUserWrites === 0) {
      await Promise.resolve();
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => { this.drainUserWrites = resolve; }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new DataMutationBusyError("Maintenance admission is busy")), this.maintenanceDrainTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.drainUserWrites = undefined;
    }
  }
}
