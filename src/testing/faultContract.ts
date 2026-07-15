import faultPoints from "./faultPoints.json";

export const FAULT_POINTS = Object.freeze([...faultPoints]);
export type FaultPoint = (typeof FAULT_POINTS)[number];
export type FaultRequest = { point: FaultPoint; mode: "crash_once" };

const allowed = new Set<string>(FAULT_POINTS);

export function canonicalFaultUrl(point: FaultPoint): string {
  if (!allowed.has(point)) throw new Error(`Unknown fault point: ${point}`);
  return `formobile-test://fault?point=${point}&mode=crash_once`;
}

export function parseFaultUrl(value: string): FaultRequest | null {
  const match = /^formobile-test:\/\/fault\?point=([a-z][a-z0-9_.]*)&mode=crash_once$/.exec(value);
  if (!match || !allowed.has(match[1])) return null;
  const request: FaultRequest = { point: match[1], mode: "crash_once" };
  return canonicalFaultUrl(request.point) === value ? request : null;
}
