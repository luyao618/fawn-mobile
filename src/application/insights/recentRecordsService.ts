import type { DeviceCalendarPort } from "../profile/babyProfileService.ts";
import type { ManualTrackerServicePort } from "../tracker/manualTrackerService.ts";
import type { TrackerDomain, TrackerRecordByDomain } from "../../domain/tracker/types.ts";
import { formatTrackerRecordSummary } from "../../features/tracker/trackerPresentation.ts";

const DOMAIN_LABELS: Readonly<Record<TrackerDomain, string>> = Object.freeze({
  growth: "生长",
  feeding: "喂养",
  sleep: "睡眠",
  diaper: "大小便",
  health: "健康",
});

export type RecentRecordItem = Readonly<{
  domain: TrackerDomain;
  id: string;
  domainLabel: string;
  primary: string;
  secondary: string;
  accessibilityLabel: string;
  occurredAt: string;
}>;

export interface RecentRecordsServicePort {
  list(limit: number): Promise<readonly RecentRecordItem[]>;
}

function occurredAt<D extends TrackerDomain>(domain: D, record: TrackerRecordByDomain[D]): string {
  switch (domain) {
    case "growth": return (record as TrackerRecordByDomain["growth"]).measurementDate;
    case "feeding": return (record as TrackerRecordByDomain["feeding"]).feedTime;
    case "sleep": return (record as TrackerRecordByDomain["sleep"]).sleepStart;
    case "diaper": return (record as TrackerRecordByDomain["diaper"]).diaperTime;
    case "health": return (record as TrackerRecordByDomain["health"]).recordDate;
  }
}

function item<D extends TrackerDomain>(
  domain: D,
  record: TrackerRecordByDomain[D],
  zone: string,
): RecentRecordItem {
  const summary = formatTrackerRecordSummary(domain, record, zone);
  if (summary.status === "invalid") throw new Error("A stored tracker record cannot be presented");
  const domainLabel = DOMAIN_LABELS[domain];
  return Object.freeze({
    domain,
    id: record.id,
    domainLabel,
    primary: summary.primary,
    secondary: summary.secondary,
    accessibilityLabel: `${domainLabel}记录，${summary.accessibilityLabel}`,
    occurredAt: occurredAt(domain, record),
  });
}

function sortTime(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error("A stored tracker record has an invalid event time");
  return parsed;
}

export class RecentRecordsService implements RecentRecordsServicePort {
  constructor(
    private readonly tracker: ManualTrackerServicePort,
    private readonly calendar: DeviceCalendarPort,
  ) {}

  async list(limit: number): Promise<readonly RecentRecordItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Recent record limit must be between 1 and 100");
    }
    const [growth, feeding, sleep, diaper, health] = await Promise.all([
      this.tracker.list("growth", limit),
      this.tracker.list("feeding", limit),
      this.tracker.list("sleep", limit),
      this.tracker.list("diaper", limit),
      this.tracker.list("health", limit),
    ]);
    const zone = this.calendar.current().timeZone;
    return Object.freeze([
      ...growth.map((record) => item("growth", record, zone)),
      ...feeding.map((record) => item("feeding", record, zone)),
      ...sleep.map((record) => item("sleep", record, zone)),
      ...diaper.map((record) => item("diaper", record, zone)),
      ...health.map((record) => item("health", record, zone)),
    ].sort((left, right) => {
      const timeOrder = sortTime(right.occurredAt) - sortTime(left.occurredAt);
      if (timeOrder !== 0) return timeOrder;
      const domainOrder = left.domain.localeCompare(right.domain);
      return domainOrder !== 0 ? domainOrder : left.id.localeCompare(right.id);
    }).slice(0, limit));
  }
}
