/**
 * Tunable assessment configuration (OD-005, research.md).
 * Pure data — no logic, no imports. All engine modules read from here.
 * Change values here; nothing is hard-coded across the codebase.
 */

export const ASSESSMENT_CONFIG = {
  // --- Elo logistic scale -------------------------------------------------
  // S=400 matches standard chess Elo: a 400-point gap → ~91% win expectation.
  scale: 400,

  // Starting ability for a fresh (topic × tool) estimate — mid-scale.
  startingAbility: 300,

  // Item difficulty seeds by tag; authored at content creation, NEVER updated
  // at runtime (two-way Elo would corrupt the scale with a single learner).
  difficultySeeds: {
    easy: 200,
    medium: 300,
    hard: 400,
  },

  // --- K-factor (learning rate) -------------------------------------------
  // High K while provisional to converge quickly from a cold start.
  kProvisional: 64,
  // Smaller K once settled — reduces noise from individual questions.
  kSettled: 24,
  // Number of graded items after which the estimate is considered settled.
  settleAfterItems: 15,

  // --- Tier centers and boundaries ----------------------------------------
  // Five tiers spread across the 0–600 ability range.
  tierCenters: [100, 200, 300, 400, 500] as const,
  // Boundaries sit halfway between adjacent centers.
  tierBoundaries: [150, 250, 350, 450] as const,

  // --- Hysteresis + dwell (anti-flip-flop, FR-008 / SC-014) ---------------
  // Promote at boundary+30; demote/review only below boundary-30.
  hysteresisMargin: 30,
  // Crossing must hold for this many consecutive graded items before acting.
  dwell: 2,

  // --- Spaced-review / lapse model (OD-003) --------------------------------
  // Exponential ability-decay half-life in days (tier-tunable; e.g. 90 for
  // tier 500 where knowledge is harder-won and decays more slowly).
  decayHalfLifeDays: 60,
  // Topic is due for review when days_since_last >= this threshold.
  stalenessWindowDays: 30,

  // --- Item selection (OD-005 table) --------------------------------------
  // Target difficulty = min(θ + targetOffset, nextBoundary + hysteresisMargin).
  targetOffset: 50,
  // ± window around the target difficulty in which items are eligible.
  selectWindow: 60,
  // One anchor item must fall within ±anchorWindow of the current ability θ.
  anchorWindow: 20,

  // --- Offer / decline suppression (FR-020b) ------------------------------
  // After this many consecutive declines across sessions, mute offers globally.
  declineMuteThreshold: 3,
  // Cross-session backoff base delay (hours) after the first decline.
  backoffBaseHours: 24,
  // Exponential factor applied per additional consecutive decline.
  backoffFactor: 2,

  // --- Free-form judging (OD-002) -----------------------------------------
  // Minimum fraction of criteria that must be met for a free-form pass.
  freeFormPassThreshold: 0.6,

  // --- Quiz length (FR-022) -----------------------------------------------
  // Default number of items per quiz session; configurable 3–5 by the user.
  defaultQuizLength: 4,
} as const;

/** Inferred type of the assessment configuration object. */
export type AssessmentConfig = typeof ASSESSMENT_CONFIG;
