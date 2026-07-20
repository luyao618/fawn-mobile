import type { TrackerDomain } from "./types.ts";

export type TrackerMutationAction = "create" | "update" | "delete";

export function trackerMutationRequiresConfirmation(
  action: TrackerMutationAction,
  domain: TrackerDomain,
): boolean {
  return action !== "create" || domain === "health";
}
