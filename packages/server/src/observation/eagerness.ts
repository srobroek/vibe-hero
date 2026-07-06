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
 * Quiet-promotion delay: a pending offer is promoted to armed after this many
 * seconds without ANY new drained signal for the session (the turn likely
 * ended and the user is reading/thinking). Roughly two drain intervals.
 */
export const QUIET_PROMOTION_SECONDS = 90;

/** Resolve preset parameters, defaulting to `normal`. */
export const eagernessParams = (
  eagerness: OrganicEagerness | undefined,
): EagernessParams => EAGERNESS_PRESETS[eagerness ?? "normal"];
