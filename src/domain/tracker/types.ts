export type TrackerDomain = "growth" | "feeding" | "sleep" | "diaper" | "health";

export type GrowthValues = Readonly<{
  measurementDate: string;
  weightG: number | null;
  heightCm: number | null;
  headCm: number | null;
  weightPercentile: number | null;
  heightPercentile: number | null;
  headPercentile: number | null;
  notes: string | null;
}>;

export type FeedingValues = Readonly<{
  feedTime: string;
  feedType: "breast" | "formula" | "solid";
  amountMl: number | null;
  durationMin: number | null;
  notes: string | null;
}>;

export type SleepValues = Readonly<{
  sleepStart: string;
  sleepEnd: string | null;
  sleepType: "nap" | "night";
  nightWakings: number;
  notes: string | null;
}>;

export type DiaperValues = Readonly<{
  diaperTime: string;
  diaperType: "poop" | "pee" | "mixed";
  notes: string | null;
}>;

export type HealthValues = Readonly<{
  recordDate: string;
  recordType: "vaccination" | "illness" | "checkup";
  title: string;
  description: string | null;
}>;

export interface TrackerValuesByDomain {
  readonly growth: GrowthValues;
  readonly feeding: FeedingValues;
  readonly sleep: SleepValues;
  readonly diaper: DiaperValues;
  readonly health: HealthValues;
}

export type TrackerCreateInput<D extends TrackerDomain> = TrackerValuesByDomain[D] & Readonly<{
  sourceMessageId: string | null;
}>;

export type TrackerUpdateInput<D extends TrackerDomain> = TrackerValuesByDomain[D];

export type TrackerRecord<D extends TrackerDomain> = TrackerValuesByDomain[D] & Readonly<{
  id: string;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export interface TrackerCreateInputByDomain {
  readonly growth: TrackerCreateInput<"growth">;
  readonly feeding: TrackerCreateInput<"feeding">;
  readonly sleep: TrackerCreateInput<"sleep">;
  readonly diaper: TrackerCreateInput<"diaper">;
  readonly health: TrackerCreateInput<"health">;
}

export interface TrackerUpdateInputByDomain {
  readonly growth: TrackerUpdateInput<"growth">;
  readonly feeding: TrackerUpdateInput<"feeding">;
  readonly sleep: TrackerUpdateInput<"sleep">;
  readonly diaper: TrackerUpdateInput<"diaper">;
  readonly health: TrackerUpdateInput<"health">;
}

export interface TrackerRecordByDomain {
  readonly growth: TrackerRecord<"growth">;
  readonly feeding: TrackerRecord<"feeding">;
  readonly sleep: TrackerRecord<"sleep">;
  readonly diaper: TrackerRecord<"diaper">;
  readonly health: TrackerRecord<"health">;
}

export type TrackerDeletion = Readonly<{
  domain: TrackerDomain;
  id: string;
  updatedAt: string;
  deletedAt: string;
}>;
