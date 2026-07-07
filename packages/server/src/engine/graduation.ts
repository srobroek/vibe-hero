/**
 * @file PURE tier-graduation engine with hysteresis + dwell (T043, US-3).
 *
 * Decides whether a learner graduates to a higher tier, is demoted/flagged for
 * review, or stays put, given their current ability θ, their current graduated
 * tier, and a DWELL counter of how many *consecutive* recent graded items have
 * satisfied the same crossing condition. The hysteresis band (FR-008 / SC-014)
 * plus the dwell requirement together prevent a single fluke item — or ability
 * oscillating within ±margin of a boundary — from toggling the tier.
 *
 * This module is IO-FREE and time-free (invariant E5): it reads no clock, no
 * filesystem, no network, and never calls `Math.random`. All inputs are passed
 * explicitly; the same inputs always yield the same decision. Time-dependent
 * lapse/staleness lives in `./lapse.ts`; tools read the clock and pass it in.
 *
 * Rules (OD-005 / research.md):
 *   - PROMOTE to the next tier when θ ≥ (next boundary) + hysteresisMargin AND
 *     this promotion-crossing condition has held for `dwell` consecutive graded
 *     items (a single qualifying item is never enough — SC-014).
 *   - DEMOTE / flag for review when θ ≤ (boundary below the current tier) −
 *     hysteresisMargin. Demotion is immediate (no dwell): a confirmed drop below
 *     the lower band should surface the topic promptly rather than hide a lapse.
 *   - Otherwise NO change — in particular, ability anywhere inside the band
 *     `[boundaryBelow − margin, nextBoundary + margin]` leaves the tier alone.
 *
 * Dwell tracking (see {@link evaluateGraduation}): the caller persists a small
 * `dwell` counter on the AbilityEstimate. On each graded item the engine returns
 * the *next* dwell value: it increments while the promotion-crossing condition
 * holds and resets to 0 the moment an item fails to satisfy it. Promotion fires
 * only when the (incremented) counter reaches `ASSESSMENT_CONFIG.dwell`.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-007/008/008a/009,
 * SC-010/SC-014), research.md (OD-005), data-model.md (TierGraduation).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import type { Tier } from "../schemas/common.js";

/** A graduated tier, or `0` for "not yet graduated". */
export type TierOrZero = Tier | 0;

/**
 * Why the tier changed (or why review is due). Mirrors
 * `TierGraduation.lastChangeReason`; `null` when nothing changed this item.
 */
export type GraduationChangeReason =
  | "graduated"
  | "demoted"
  | "review_due"
  | null;

/** The inputs the pure graduation evaluation needs. */
export interface GraduationState {
  /** The learner's current ability estimate (θ) AFTER the latest Elo update. */
  readonly ability: number;
  /**
   * The tier the learner is currently graduated at (`0` = none yet). Drives
   * which boundaries bound the hysteresis band.
   */
  readonly currentTier: TierOrZero;
  /**
   * Consecutive graded items (BEFORE this one) for which the promotion-crossing
   * condition held. The engine increments this when the current item also
   * satisfies promotion, and resets it to 0 otherwise. Persisted on the
   * AbilityEstimate so dwell carries across `submit_answer` calls.
   */
  readonly dwell: number;
}

/** The decision returned by {@link evaluateGraduation} (pure, total). */
export interface GraduationDecision {
  /** Whether the tier (or review status) changed as a result of this item. */
  readonly changed: boolean;
  /** The new tier after applying the decision (unchanged when `changed` is false). */
  readonly tier: TierOrZero;
  /** The reason for the change, or `null` when nothing changed. */
  readonly reason: GraduationChangeReason;
  /**
   * The dwell counter to persist for the NEXT evaluation. Incremented while the
   * promotion-crossing condition holds; reset to 0 the moment it does not (and
   * after a promotion fires, so the next tier starts fresh).
   */
  readonly dwell: number;
  /**
   * When `reason === "demoted"`, whether the drop should be surfaced as
   * `due_for_review` (the spec demotes *to review* rather than silently
   * un-graduating — FR-009). Always `true` for a demotion; `false` otherwise.
   */
  readonly dueForReview: boolean;
}

/** Sorted tier ladder (`[100,200,300,400,500]`), typed as {@link Tier}. */
const TIERS: readonly Tier[] = ASSESSMENT_CONFIG.tierCenters as readonly Tier[];

/**
 * The boundary the learner must clear (plus margin) to graduate FROM
 * `currentTier` to the next one, or `undefined` if already at the top tier
 * (500) — there is nothing higher to promote into.
 *
 * Boundaries are `[150,250,350,450]`; the boundary above tier `T` is the one
 * sitting between `T` and the next center (e.g. above tier 300 ⇒ 350, the bar
 * into tier 400). For `currentTier === 0` (not graduated) the relevant boundary
 * is the first one (150), the bar into tier 100.
 */
const boundaryAbove = (currentTier: TierOrZero): number | undefined => {
  const { tierBoundaries } = ASSESSMENT_CONFIG;
  if (currentTier === 0) return tierBoundaries[0];
  const idx = TIERS.indexOf(currentTier);
  // idx is the index of the current center; the boundary into the NEXT tier is
  // at the same index in tierBoundaries (centers[i] → boundaries[i] → centers[i+1]).
  return tierBoundaries[idx];
};

/**
 * The boundary BELOW the current tier — the floor of the hysteresis band; a
 * drop of `margin` below it triggers demotion/review. `undefined` when the
 * learner is not graduated (`currentTier === 0`): there is no lower band, so a
 * non-graduate can never be demoted.
 *
 * The boundary below tier `T` sits between the previous center and `T` (e.g.
 * below tier 300 ⇒ 250, the bar that was crossed to enter tier 300).
 */
const boundaryBelow = (currentTier: TierOrZero): number | undefined => {
  const { tierBoundaries } = ASSESSMENT_CONFIG;
  if (currentTier === 0) return undefined;
  const idx = TIERS.indexOf(currentTier);
  // centers[i] is bounded below by boundaries[i-1].
  return idx > 0 ? tierBoundaries[idx - 1] : undefined;
};

/** The tier one step above `currentTier`, or `undefined` at the top (500). */
const nextTier = (currentTier: TierOrZero): Tier | undefined => {
  if (currentTier === 0) return TIERS[0];
  const idx = TIERS.indexOf(currentTier);
  return TIERS[idx + 1];
};

/**
 * PLACEMENT (first graduation only): the highest tier whose entry bar the
 * ability clears. A brand-new learner starts at the mid-scale Elo prior (300),
 * which sits above the bars into the low tiers — walking the ladder rung by
 * rung from there hands out ceremonial promotions through tiers the learner
 * was never below (live finding: two "graduations" inside one first quiz).
 * Instead, the FIRST graduation places the learner at the tier their measured
 * ability actually supports; every subsequent promotion still climbs one rung
 * with full dwell + hysteresis.
 *
 * Pure. Returns 0 when ability does not even clear the bar into tier 100
 * (callers never hit this: the promotion condition from ungraduated is that
 * same bar).
 */
export const placementTier = (ability: number): TierOrZero => {
  const { hysteresisMargin, tierBoundaries } = ASSESSMENT_CONFIG;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    // Entry bar into TIERS[i]: the boundary below it (+margin). Tier 100's
    // entry bar is the first boundary — same bar the ungraduated promotion
    // condition uses.
    const bar = (i === 0 ? tierBoundaries[0] : tierBoundaries[i - 1]) as number;
    if (ability >= bar + hysteresisMargin) return TIERS[i] as Tier;
  }
  return 0;
};

/**
 * Decide the graduation outcome for one graded item (PURE, total).
 *
 * Evaluation order, given ability θ, `currentTier`, and the prior `dwell`:
 *
 *  1. **Promotion check** — if there is a tier above and
 *     `θ ≥ boundaryAbove + hysteresisMargin`, the promotion-crossing condition
 *     holds: the dwell counter is incremented. When it reaches
 *     `ASSESSMENT_CONFIG.dwell`, promote (reason `"graduated"`, dwell reset to
 *     0). If it has not yet reached `dwell`, NO change is reported but the
 *     incremented counter is returned so the streak is remembered.
 *  2. **Demotion check** — else, if the learner is graduated and
 *     `θ ≤ boundaryBelow − hysteresisMargin`, demote/flag for review (reason
 *     `"demoted"`, `dueForReview: true`, tier steps down one). Demotion does not
 *     require dwell and resets the counter to 0.
 *  3. **No change** — otherwise the tier holds (ability is inside the band or
 *     promotion has insufficient dwell). The dwell counter resets to 0 because
 *     this item did NOT satisfy the promotion-crossing condition.
 *
 * Because promotion needs `dwell` consecutive qualifying items and demotion
 * needs a clear `margin` below the lower boundary, ability oscillating inside
 * the band never toggles the tier (SC-014).
 *
 * @param state - {@link GraduationState}: current ability, tier, and prior dwell.
 * @returns A {@link GraduationDecision}; `changed: false` leaves tier untouched.
 */
export const evaluateGraduation = (
  state: GraduationState,
): GraduationDecision => {
  const { ability, currentTier, dwell } = state;
  const { hysteresisMargin, dwell: dwellTarget } = ASSESSMENT_CONFIG;

  // --- 1. Promotion -------------------------------------------------------
  const promoteBar = boundaryAbove(currentTier);
  const target = nextTier(currentTier);
  if (
    promoteBar !== undefined &&
    target !== undefined &&
    ability >= promoteBar + hysteresisMargin
  ) {
    const nextDwell = dwell + 1;
    if (nextDwell >= dwellTarget) {
      // Streak satisfied → graduate, reset dwell for the new tier. First
      // graduation PLACES at the ability-supported tier (see placementTier);
      // later promotions step exactly one rung.
      const granted =
        currentTier === 0 ? (placementTier(ability) as Tier) : target;
      return {
        changed: true,
        tier: granted,
        reason: "graduated",
        dwell: 0,
        dueForReview: false,
      };
    }
    // Crossing held but dwell not yet met: remember the streak, no change.
    return {
      changed: false,
      tier: currentTier,
      reason: null,
      dwell: nextDwell,
      dueForReview: false,
    };
  }

  // --- 2. Demotion / review (only when graduated) -------------------------
  const demoteFloor = boundaryBelow(currentTier);
  if (
    currentTier !== 0 &&
    demoteFloor !== undefined &&
    ability <= demoteFloor - hysteresisMargin
  ) {
    const idx = TIERS.indexOf(currentTier);
    const lower: TierOrZero = idx > 0 ? (TIERS[idx - 1] as Tier) : 0;
    return {
      changed: true,
      tier: lower,
      reason: "demoted",
      dwell: 0,
      dueForReview: true,
    };
  }

  // --- 3. No change (inside the band, or promotion lacked dwell) ----------
  // This item did not satisfy promotion, so the consecutive streak resets.
  return {
    changed: false,
    tier: currentTier,
    reason: null,
    dwell: 0,
    dueForReview: false,
  };
};
