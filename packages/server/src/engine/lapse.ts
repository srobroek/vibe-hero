/**
 * @file PURE knowledge-lapse / staleness engine (T044, US-3, OD-003).
 *
 * Implements the "staleness threshold + exponential ability decay" review model
 * (research.md OD-003) without any separate per-item scheduler: it reuses the
 * Elo ability already stored on the profile and decays it toward the tier center
 * over calendar time, then asks whether a previously-graduated topic has gone
 * stale enough to surface for review (FR-009 / FR-010).
 *
 * The decay is PURE math; the only "time" input is `daysSinceLast` /
 * explicit timestamps, which the CALLER computes from an injected `now` (E5 —
 * the engine itself never reads the clock). Tools read `new Date()` and pass it
 * in; the engine stays deterministic and unit-testable.
 *
 * Model (research.md OD-003):
 *   θ_effective(t) = tier_center + (θ_last − tier_center) · exp(−daysSinceLast / H)
 *   H = decayHalfLifeDays (60d; tier-tunable)
 *   due_for_review  ⟺  daysSinceLast ≥ stalenessWindowDays
 *                      AND θ_effective < (tier_boundary_below + hysteresisMargin)
 *
 * A correct review resets the clock (lastAssessedAt) and restores ability; a
 * wrong review lets normal Elo demote — both handled by the submit path, not
 * here. This module only *detects* the due-for-review condition.
 *
 * Source of truth: specs/001-vibe-hero-mvp/research.md (OD-003), spec.md
 * FR-009/FR-010, config.ts (decayHalfLifeDays, stalenessWindowDays).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import type { Tier } from "../schemas/common.js";
import type { AbilityEstimate, TierGraduation } from "../schemas/profile.js";

/** Milliseconds in one day (UTC), for date-difference math. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Sorted tier ladder (`[100,200,300,400,500]`), typed as {@link Tier}. */
const TIERS: readonly Tier[] = ASSESSMENT_CONFIG.tierCenters as readonly Tier[];

/**
 * Whole/fractional days between two ISO timestamps (`now − then`), clamped at 0
 * so a clock skew or future `lastAssessedAt` never yields a negative age. PURE:
 * both instants are passed in; the engine reads no clock itself.
 *
 * @param then - The earlier ISO datetime (e.g. `lastAssessedAt`).
 * @param now - The reference ISO datetime (injected by the caller).
 * @returns Days elapsed, ≥ 0.
 */
export const daysBetween = (then: string, now: string): number => {
  const thenMs = Date.parse(then);
  const nowMs = Date.parse(now);
  if (Number.isNaN(thenMs) || Number.isNaN(nowMs)) return 0;
  return Math.max(0, (nowMs - thenMs) / MS_PER_DAY);
};

/**
 * The center ability of a tier (e.g. tier 300 → 300). For `currentTier === 0`
 * (not graduated) decay has no meaningful center, so we fall back to the
 * cold-start ability — but lapse only ever runs on graduated topics, so this
 * branch is defensive.
 */
const tierCenter = (currentTier: Tier | 0): number =>
  currentTier === 0 ? ASSESSMENT_CONFIG.startingAbility : currentTier;

/**
 * The boundary BELOW a graduated tier — the floor used in the due-for-review
 * test (`θ_effective < boundaryBelow + margin`). Below tier `T` sits the
 * boundary between the previous center and `T` (e.g. below 300 ⇒ 250). For tier
 * 100 (the lowest) there is no lower boundary; we use `0` so the only way a
 * tier-100 topic goes due is by decaying below the margin near the floor.
 */
const boundaryBelow = (currentTier: Tier): number => {
  const idx = TIERS.indexOf(currentTier);
  const { tierBoundaries } = ASSESSMENT_CONFIG;
  return idx > 0 ? (tierBoundaries[idx - 1] ?? 0) : 0;
};

/**
 * Exponentially-decayed effective ability (PURE).
 *
 * `θ_effective = tierCenter + (θ_last − tierCenter) · exp(−daysSinceLast / H)`.
 *
 * Ability relaxes toward the tier center as time passes: a learner who graduated
 * *well above* center decays downward, and one who was *just* above center barely
 * moves. At `daysSinceLast = 0` the result equals `θ_last`; as days → ∞ it tends
 * to `tierCenter`. Negative `daysSinceLast` is treated as 0 (no decay).
 *
 * @param lastAbility - The stored ability at last assessment (θ_last).
 * @param center - The tier center to decay toward (see {@link tierCenter}).
 * @param daysSinceLast - Days since the last assessment (≥ 0).
 * @param halfLifeDays - Decay constant `H` in days
 *   (default {@link ASSESSMENT_CONFIG.decayHalfLifeDays}).
 * @returns The decayed effective ability.
 */
export const effectiveAbility = (
  lastAbility: number,
  center: number,
  daysSinceLast: number,
  halfLifeDays: number = ASSESSMENT_CONFIG.decayHalfLifeDays,
): number => {
  const days = Math.max(0, daysSinceLast);
  const decay = Math.exp(-days / halfLifeDays);
  return center + (lastAbility - center) * decay;
};

/**
 * Whether a graduated topic is now due for review (PURE; clock injected as
 * `now`). Implements OD-003:
 *
 *   `daysSinceLast ≥ stalenessWindowDays`
 *   AND `effectiveAbility < (boundaryBelow(currentTier) + hysteresisMargin)`
 *
 * Returns `false` for an ungraduated topic (`currentTier === 0`) — there is
 * nothing to lapse from — and for a topic already flagged `due_for_review`
 * (idempotent: it is already surfaced, so re-flagging is a no-op decision).
 *
 * The two-part test means a topic only surfaces when it is BOTH stale (enough
 * time has passed) AND its decayed ability has fallen near/under the tier's
 * lower band. A frequently-practiced or comfortably-above-center topic never
 * goes due.
 *
 * @param graduation - The topic's graduation state (tier + status).
 * @param ability - The stored ability estimate (its `value` and
 *   `lastAssessedAt` drive decay + staleness).
 * @param now - The reference ISO datetime, injected by the caller (E5).
 * @returns `true` iff the topic should be surfaced for review.
 */
export const isDueForReview = (
  graduation: TierGraduation,
  ability: AbilityEstimate,
  now: string,
): boolean => {
  if (graduation.currentTier === 0) return false;
  if (graduation.status === "due_for_review") return false;

  const daysSinceLast = daysBetween(ability.lastAssessedAt, now);
  if (daysSinceLast < ASSESSMENT_CONFIG.stalenessWindowDays) return false;

  const center = tierCenter(graduation.currentTier);
  const effective = effectiveAbility(ability.value, center, daysSinceLast);
  const floor =
    boundaryBelow(graduation.currentTier) + ASSESSMENT_CONFIG.hysteresisMargin;
  return effective < floor;
};
