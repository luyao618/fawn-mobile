import type { QueryRunHandle } from "../../../application/data/ExclusiveTransactionPort.ts";
import type { BabyProfileStore } from "../../../application/profile/babyProfileService.ts";
import {
  sameBabyProfileInput,
  validatePersistedBabyProfileInput,
  type BabyProfile,
  type BabyProfileInput,
} from "../../../domain/baby/profile.ts";
import { RepositoryConflictError } from "./conflicts.ts";
import { assertCanonicalInstant } from "./eventTime.ts";

type BabyProfileRow = Readonly<{
  singleton_id: number;
  name: string | null;
  sex: "male" | "female" | null;
  birth_date: string | null;
  birth_weight_g: number | null;
  birth_height_cm: number | null;
  birth_head_cm: number | null;
  is_premature: number;
  gestational_weeks: number | null;
  created_at: string;
  updated_at: string;
}>;

function fromRow(row: BabyProfileRow): BabyProfile {
  if (row.singleton_id !== 1 || (row.is_premature !== 0 && row.is_premature !== 1)) {
    throw new Error("Stored baby profile is invalid");
  }
  const input = validatePersistedBabyProfileInput({
    name: row.name,
    sex: row.sex,
    birthDate: row.birth_date,
    birthWeightG: row.birth_weight_g,
    birthHeightCm: row.birth_height_cm,
    birthHeadCm: row.birth_head_cm,
    isPremature: row.is_premature === 1,
    gestationalWeeks: row.gestational_weeks,
  });
  assertCanonicalInstant(row.created_at);
  assertCanonicalInstant(row.updated_at);
  if (row.created_at > row.updated_at) throw new Error("Stored baby profile timestamps are invalid");
  return Object.freeze({ ...input, createdAt: row.created_at, updatedAt: row.updated_at });
}

function nextUpdatedAt(requested: string, current: string): string {
  assertCanonicalInstant(requested);
  if (requested > current) return requested;
  const next = new Date(new Date(current).getTime() + 1).toISOString();
  assertCanonicalInstant(next);
  return next;
}

export class BabyProfileRepository implements BabyProfileStore {
  async load(transaction: QueryRunHandle): Promise<BabyProfile | null> {
    const rows = await transaction.query<BabyProfileRow>(
      `SELECT singleton_id, name, sex, birth_date, birth_weight_g, birth_height_cm, birth_head_cm,
              is_premature, gestational_weeks, created_at, updated_at
       FROM baby_profile WHERE singleton_id = ?`,
      [1],
    );
    if (rows.length > 1) throw new Error("Stored baby profile singleton is corrupt");
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async save(
    transaction: QueryRunHandle,
    input: BabyProfileInput,
    expectedUpdatedAt: string | null,
    requestedUpdatedAt: string,
  ): Promise<BabyProfile> {
    if (expectedUpdatedAt !== null) assertCanonicalInstant(expectedUpdatedAt);
    assertCanonicalInstant(requestedUpdatedAt);
    const current = await this.load(transaction);
    if (current && sameBabyProfileInput(current, input)) return current;

    if (!current) {
      if (expectedUpdatedAt !== null) {
        throw new RepositoryConflictError("not_found", "baby_profile", "1");
      }
      await transaction.run(
        `INSERT INTO baby_profile(
          singleton_id, name, sex, birth_date, birth_weight_g, birth_height_cm, birth_head_cm,
          is_premature, gestational_weeks, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          1,
          input.name,
          input.sex,
          input.birthDate,
          input.birthWeightG,
          input.birthHeightCm,
          input.birthHeadCm,
          input.isPremature ? 1 : 0,
          input.gestationalWeeks,
          requestedUpdatedAt,
          requestedUpdatedAt,
        ],
      );
      return Object.freeze({ ...input, createdAt: requestedUpdatedAt, updatedAt: requestedUpdatedAt });
    }

    if (expectedUpdatedAt !== current.updatedAt) {
      throw new RepositoryConflictError("stale_write", "baby_profile", "1", current.updatedAt);
    }
    const updatedAt = nextUpdatedAt(requestedUpdatedAt, current.updatedAt);
    const result = await transaction.run(
      `UPDATE baby_profile SET
        name = ?, sex = ?, birth_date = ?, birth_weight_g = ?, birth_height_cm = ?, birth_head_cm = ?,
        is_premature = ?, gestational_weeks = ?, updated_at = ?
       WHERE singleton_id = ? AND updated_at = ?`,
      [
        input.name,
        input.sex,
        input.birthDate,
        input.birthWeightG,
        input.birthHeightCm,
        input.birthHeadCm,
        input.isPremature ? 1 : 0,
        input.gestationalWeeks,
        updatedAt,
        1,
        current.updatedAt,
      ],
    );
    if (result.changes !== 1) {
      throw new RepositoryConflictError("stale_write", "baby_profile", "1", current.updatedAt);
    }
    return Object.freeze({ ...input, createdAt: current.createdAt, updatedAt });
  }
}
