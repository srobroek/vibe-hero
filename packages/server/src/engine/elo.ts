/**
 * @file PURE Elo ability-estimation engine (T010, OD-005 / research.md).
 *
 * Single-learner Elo: a learner's continuous `ability` (θ) is updated online
 * against FIXED, authored item difficulties (d). Item difficulty is INPUT DATA
 * and is never mutated here — only the learner's ability moves (invariant E3).
 *
 * This module is IO-FREE and time-free (invariant E5): it never reads the
 * clock, filesystem, or network. Any time-dependent behaviour (decay,
 * staleness) lives elsewhere and passes time in explicitly.
 *
 * Formulas (OD-005):
 *   E  = 1 / (1 + 10^((d − θ) / S))          // expected score
 *   K  = provisional (64) while itemsSeen < settleAfterItems (15), else 24
 *   θ' = θ + K · (score − E)                  // score ∈ [0,1] partial credit
 *
 * Source of truth: specs/001-vibe-hero-mvp/research.md (OD-005);
 * constants in ../config.ts (ASSESSMENT_CONFIG).
 */

import { ASSESSMENT_CONFIG } from "../config.js";

/**
 * Expected score (win probability) of a learner with ability `ability` (θ)
 * facing an item of difficulty `itemDifficulty` (d), under the logistic Elo
 * model: `E = 1 / (1 + 10^((d − θ) / scale))`.
 *
 * Monotonically increasing in `(θ − d)`: a higher relative ability yields a
 * higher expected score. When `θ === d` the expectation is exactly `0.5`.
 *
 * @param ability - The learner's current ability estimate (θ).
 * @param itemDifficulty - The item's FIXED authored difficulty (d). Read-only.
 * @param scale - Logistic scale `S` (default {@link ASSESSMENT_CONFIG.scale}).
 * @returns The expected score in the open interval (0, 1).
 */
export const expectedScore = (
  ability: number,
  itemDifficulty: number,
  scale: number = ASSESSMENT_CONFIG.scale,
): number => 1 / (1 + 10 ** ((itemDifficulty - ability) / scale));

/**
 * The learning-rate `K` for the next update. High while the estimate is
 * provisional (cold start) so it converges quickly, then smaller once settled
 * to damp single-question noise.
 *
 * @param itemsSeen - Count of graded items already incorporated for this
 *   (topic × tool) estimate.
 * @returns {@link ASSESSMENT_CONFIG.kProvisional} when
 *   `itemsSeen < ASSESSMENT_CONFIG.settleAfterItems`, otherwise
 *   {@link ASSESSMENT_CONFIG.kSettled}.
 */
export const kFactor = (itemsSeen: number): number =>
  itemsSeen < ASSESSMENT_CONFIG.settleAfterItems
    ? ASSESSMENT_CONFIG.kProvisional
    : ASSESSMENT_CONFIG.kSettled;

/** The result of an ability update: the new ability and incremented count. */
export interface AbilityUpdate {
  /** The updated ability estimate θ'. */
  readonly value: number;
  /** `itemsSeen` after incorporating this graded item (input + 1). */
  readonly itemsSeen: number;
}

/**
 * Apply one graded item to a learner's ability estimate (PURE).
 *
 * Computes `θ' = θ + K · (score − E)` where `E = expectedScore(θ, d)` and
 * `K = kFactor(itemsSeen)`, then increments `itemsSeen`. The `score` is partial
 * credit in `[0, 1]` (e.g. 1 = fully correct, 0 = fully wrong, intermediate for
 * a partially-met free-form rubric).
 *
 * The fixed-difficulty invariant (E3) holds: `itemDifficulty` is read only and
 * never returned or mutated — this function moves ONLY the learner's ability.
 *
 * A correct answer (`score > E`) raises θ; a wrong one (`score < E`) lowers it.
 * Because the update is proportional to `(score − E)`, a correct answer on a
 * HARDER item (lower E) raises θ more than the same correct answer on an EASIER
 * item (higher E).
 *
 * @param ability - The learner's current ability estimate (θ).
 * @param itemsSeen - Graded items already incorporated (≥ 0).
 * @param itemDifficulty - The item's FIXED authored difficulty (d). Read-only.
 * @param score - Partial-credit outcome in `[0, 1]`.
 * @returns The new ability and `itemsSeen + 1`.
 */
export const updateAbility = (
  ability: number,
  itemsSeen: number,
  itemDifficulty: number,
  score: number,
): AbilityUpdate => {
  const expected = expectedScore(ability, itemDifficulty);
  const k = kFactor(itemsSeen);
  return {
    value: ability + k * (score - expected),
    itemsSeen: itemsSeen + 1,
  };
};
