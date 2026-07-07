/**
 * @file Organic-arming eagerness presets.
 *
 * Maps the setup skill's `organicEagerness` preference (often / normal /
 * rarely) to the threshold parameters the drain pipeline uses to turn
 * accumulated evidence into a pending offer, and pending offers into armed
 * ones. Pure data + one lookup — no IO.
 *
 * Semantics (agreed design):
 *  - `threshold`       — evidence weight that must accumulate for one topic
 *                        within the rolling window before it becomes pending.
 *  - `windowSeconds`   — rolling evidence window; entries older than this are
 *                        pruned and pending offers expire with it.
 *  - `cooldownSeconds` — per-preset offer cooldown (overrides the legacy
 *                        default; the env var still wins when set).
 *  - `bypass`          — whether ⚡ event-trigger bypasses (seam signals with
 *                        `bypass: true`) may arm immediately.
 *  - `bypassNeedsPriorEvidence` — when true, a bypass only fires if the topic
 *                        already has ≥1 evidence entry this session.
 *
 * `offerCadence` remains orthogonal: cadence governs how often offers may
 * SURFACE, eagerness governs how quickly evidence ARMS one.
 */

import type { OrganicEagerness } from "../schemas/profile.js";

/** Threshold parameters for one eagerness preset. */
export interface EagernessParams {
  readonly threshold: number;
  readonly windowSeconds: number;
  readonly cooldownSeconds: number;
  readonly bypass: boolean;
  readonly bypassNeedsPriorEvidence: boolean;
}

/** Preset table (agreed in design review). */
export const EAGERNESS_PRESETS: Record<OrganicEagerness, EagernessParams> = {
  often: {
    threshold: 2,
    windowSeconds: 45 * 60,
    cooldownSeconds: 10 * 60,
    bypass: true,
    bypassNeedsPriorEvidence: false,
  },
  normal: {
    threshold: 3,
    windowSeconds: 30 * 60,
    cooldownSeconds: 15 * 60,
    bypass: true,
    bypassNeedsPriorEvidence: true,
  },
  rarely: {
    threshold: 5,
    windowSeconds: 30 * 60,
    cooldownSeconds: 30 * 60,
    bypass: false,
    bypassNeedsPriorEvidence: true,
  },
};

/**
 * Default quiet-promotion delay: a pending offer is promoted to armed after
 * this many seconds without ANY new drained signal for the session (the turn
 * likely ended and the user is reading/thinking). 60s filters mid-turn
 * model-thinking pauses (typically 10-30s) while still catching real
 * reading pauses before the user's next prompt.
 */
export const QUIET_PROMOTION_SECONDS = 60;

/** Bounds for the quiet-promotion override (below 5s is noise; above 30min
 * outlives the evidence window). */
export const MIN_QUIET_PROMOTION_SECONDS = 5;
export const MAX_QUIET_PROMOTION_SECONDS = 30 * 60;

/**
 * Resolve the quiet-promotion delay, honoring
 * `VIBE_HERO_QUIET_PROMOTION_SECONDS` when set (clamped to
 * [{@link MIN_QUIET_PROMOTION_SECONDS}, {@link MAX_QUIET_PROMOTION_SECONDS}]).
 * Falls back to {@link QUIET_PROMOTION_SECONDS} when unset or unparseable.
 */
export const quietPromotionSeconds = (): number => {
  const raw = process.env["VIBE_HERO_QUIET_PROMOTION_SECONDS"];
  if (raw === undefined || raw === "") return QUIET_PROMOTION_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return QUIET_PROMOTION_SECONDS;
  return Math.min(
    Math.max(Math.trunc(n), MIN_QUIET_PROMOTION_SECONDS),
    MAX_QUIET_PROMOTION_SECONDS,
  );
};

/** Resolve preset parameters, defaulting to `normal`. */
export const eagernessParams = (
  eagerness: OrganicEagerness | undefined,
): EagernessParams => EAGERNESS_PRESETS[eagerness ?? "normal"];
