import type { RuntimeOperationPort } from "../bootstrap/appRuntime.ts";
import type { DataMutationCoordinator } from "../data/DataMutationCoordinator.ts";
import type { ExclusiveTransactionPort, QueryRunHandle } from "../data/ExclusiveTransactionPort.ts";
import { calculateExactAge, type ExactAge } from "../../domain/baby/age.ts";
import { localDateAtInstant } from "../../domain/baby/localDate.ts";
import {
  normalizeBabyProfileInput,
  type BabyProfile,
  type BabyProfileInput,
} from "../../domain/baby/profile.ts";

export type DeviceCalendarSnapshot = Readonly<{
  instant: string;
  timeZone: string;
}>;

export interface DeviceCalendarPort {
  current(): DeviceCalendarSnapshot;
}

export interface BabyProfileStore {
  load(transaction: QueryRunHandle): Promise<BabyProfile | null>;
  save(
    transaction: QueryRunHandle,
    input: BabyProfileInput,
    expectedUpdatedAt: string | null,
    updatedAt: string,
  ): Promise<BabyProfile>;
}

export type BabyProfileSnapshot = Readonly<{
  profile: BabyProfile;
  exactAge: ExactAge;
}>;

export type OptionalBabyProfileSnapshot = Readonly<{
  profile: BabyProfile | null;
  exactAge: ExactAge;
}>;

export interface BabyProfileServicePort {
  load(): Promise<OptionalBabyProfileSnapshot>;
  save(input: BabyProfileInput, expectedUpdatedAt: string | null): Promise<BabyProfileSnapshot>;
}

function snapshot(
  profile: BabyProfile | null,
  calendar: DeviceCalendarSnapshot,
): OptionalBabyProfileSnapshot {
  return Object.freeze({
    profile,
    exactAge: calculateExactAge(profile?.birthDate ?? null, calendar.instant, calendar.timeZone),
  });
}

export class BabyProfileService implements BabyProfileServicePort {
  constructor(
    private readonly transactions: ExclusiveTransactionPort,
    private readonly coordinator: DataMutationCoordinator,
    private readonly store: BabyProfileStore,
    private readonly calendar: DeviceCalendarPort,
    private readonly operations: RuntimeOperationPort,
  ) {}

  load(): Promise<OptionalBabyProfileSnapshot> {
    return this.operations.run(async () => {
      const calendar = this.calendar.current();
      localDateAtInstant(calendar.instant, calendar.timeZone);
      const profile = await this.transactions.runExclusive((transaction) => this.store.load(transaction));
      return snapshot(profile, calendar);
    });
  }

  save(input: BabyProfileInput, expectedUpdatedAt: string | null): Promise<BabyProfileSnapshot> {
    return this.operations.run(async () => {
      const calendar = this.calendar.current();
      const today = localDateAtInstant(calendar.instant, calendar.timeZone);
      const normalized = normalizeBabyProfileInput(input, today);
      return this.coordinator.runUserWrite(async () => {
        const profile = await this.transactions.runExclusive((transaction) => this.store.save(
          transaction,
          normalized,
          expectedUpdatedAt,
          calendar.instant,
        ));
        return snapshot(profile, calendar) as BabyProfileSnapshot;
      });
    });
  }
}
