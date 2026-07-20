import type {
  ManualTrackerConflictClassifierPort,
  ManualTrackerConflictCode,
} from "../../../application/tracker/manualTrackerService.ts";
import { RepositoryConflictError } from "./conflicts.ts";

export class RepositoryTrackerConflictClassifier implements ManualTrackerConflictClassifierPort {
  classify(error: unknown): ManualTrackerConflictCode | null {
    if (!(error instanceof RepositoryConflictError)) return null;
    if (error.code === "stale_write" || error.code === "not_found") return error.code;
    return null;
  }
}
