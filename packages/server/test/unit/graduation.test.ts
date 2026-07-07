/**
 * @file Unit tests for the PURE graduation + lapse engines (T045, US-3).
 *
 * Proves the anti-flip-flop guarantees the spec leans on:
 *   - hysteresis prevents flip-flop: ability oscillating within ±margin of a
 *     boundary never toggles the tier (SC-014 / FR-008);
 *   - dwell blocks single-fluke promotion: one qualifying item is insufficient;
 *     `ASSESSMENT_CONFIG.dwell` CONSECUTIVE qualifying items are required, and a
 *     single non-qualifying item resets the streak (SC-014);
 *   - demotion fires only below `boundaryBelow − margin` (not merely below the
 *     boundary), and not at all for the floor tier (100) / ungraduated (0);
 *   - lapse (OD-003): exponential decay reduces effective ability over calendar
 *     time and triggers review at the right lower band, gated by the staleness
 *     window.
 *
 * Both engines are PURE (E5): no clock/IO; `now` is injected for lapse.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-008/008a/009, SC-014),
 * research.md (OD-005 / OD-003), config.ts (ASSESSMENT_CONFIG).
 */

import { describe, it, expect } from "vitest";

import { ASSESSMENT_CONFIG } from "../../src/config.js";
import {
  evaluateGraduation,
  type GraduationDecision,
} from "../../src/engine/graduation.js";
import {
  daysBetween,
  effectiveAbility,
  isDueForReview,
} from "../../src/engine/lapse.js";
import type {
  AbilityEstimate,
  TierGraduation,
} from "../../src/schemas/profile.js";

const { hysteresisMargin, dwell, stalenessWindowDays, decayHalfLifeDays } =
  ASSESSMENT_CONFIG;

// Tier 300 band, from config: promotion bar into tier 400 = 350 + 30 = 380;
// demotion floor below tier 300 = 250 − 30 = 220.
const PROMOTE_BAR_300 = 350 + hysteresisMargin; // 380
const DEMOTE_FLOOR_300 = 250 - hysteresisMargin; // 220

/**
 * Drive a *sequence* of graded-item abilities through {@link evaluateGraduation},
 * threading the dwell counter exactly as `submit_answer` does. Returns every
 * decision so a test can assert when (if ever) a change fires.
 */
const runSequence = (
  startTier: GraduationDecision["tier"],
  abilities: readonly number[],
): GraduationDecision[] => {
  let tier = startTier;
  let dwellCounter = 0;
  const decisions: GraduationDecision[] = [];
  for (const ability of abilities) {
    const decision = evaluateGraduation({ ability, currentTier: tier, dwell: dwellCounter });
    decisions.push(decision);
    tier = decision.tier;
    dwellCounter = decision.dwell;
  }
  return decisions;
};

describe("evaluateGraduation — dwell blocks single-fluke promotion (SC-014)", () => {
  it("does NOT promote on a single qualifying item (dwell unmet)", () => {
    // One item above the promotion bar — insufficient (dwell defaults to 2).
    const decision = evaluateGraduation({
      ability: PROMOTE_BAR_300 + 5,
      currentTier: 300,
      dwell: 0,
    });
    expect(decision.changed).toBe(false);
    expect(decision.tier).toBe(300);
    expect(decision.reason).toBeNull();
    // The streak is remembered (incremented), not reset.
    expect(decision.dwell).toBe(1);
  });

  it("promotes only after `dwell` CONSECUTIVE qualifying items", () => {
    const above = PROMOTE_BAR_300 + 5;
    const decisions = runSequence(300, Array.from({ length: dwell }, () => above));
    // All but the last are no-change (dwell building up).
    for (let i = 0; i < dwell - 1; i++) {
      expect(decisions[i]!.changed).toBe(false);
    }
    const last = decisions[dwell - 1]!;
    expect(last.changed).toBe(true);
    expect(last.reason).toBe("graduated");
    expect(last.tier).toBe(400);
    // Dwell resets after a promotion so the new tier starts fresh.
    expect(last.dwell).toBe(0);
  });

  it("resets the streak when a non-qualifying item interrupts the run", () => {
    const above = PROMOTE_BAR_300 + 5;
    // qualify, qualify-broken-by-an-in-band-item, qualify → no promotion yet
    // because the interrupting item reset the consecutive counter.
    const decisions = runSequence(300, [above, 360 /* in-band, not above bar */, above]);
    expect(decisions[0]!.dwell).toBe(1);
    expect(decisions[1]!.changed).toBe(false);
    expect(decisions[1]!.dwell).toBe(0); // reset by the in-band item
    expect(decisions[2]!.changed).toBe(false); // only 1 consecutive again
    expect(decisions[2]!.dwell).toBe(1);
  });
});

describe("evaluateGraduation — hysteresis prevents flip-flop (SC-014)", () => {
  it("does NOT toggle when ability oscillates within ±margin of the upper boundary", () => {
    // Oscillate around the 350 boundary but stay BELOW the promotion bar (380):
    // 340 ↔ 375, repeatedly. Never reaches boundary+margin, so never promotes.
    const decisions = runSequence(300, [340, 375, 340, 375, 379, 340, 375]);
    for (const d of decisions) {
      expect(d.changed).toBe(false);
      expect(d.tier).toBe(300);
    }
  });

  it("does NOT demote when ability dips below the boundary but stays within margin", () => {
    // Tier 300's lower boundary is 250; demotion only below 220. Dip to 240/230
    // (below boundary, inside the margin band) must NOT demote.
    const decisions = runSequence(300, [240, 230, 245, 235]);
    for (const d of decisions) {
      expect(d.changed).toBe(false);
      expect(d.tier).toBe(300);
    }
  });

  it("a single dip into the band then back up never changes the tier", () => {
    // Up near the bar (but not held for dwell), down into the lower band, back up.
    const decisions = runSequence(300, [
      PROMOTE_BAR_300 + 2, // qualifies once (dwell→1)
      240, // resets dwell, no demote (above 220 floor)
      PROMOTE_BAR_300 + 2, // qualifies once again (dwell→1)
    ]);
    expect(decisions.every((d) => !d.changed)).toBe(true);
    expect(decisions.every((d) => d.tier === 300)).toBe(true);
  });
});

describe("evaluateGraduation — demotion only below boundary − margin (FR-009)", () => {
  it("demotes/flags for review when ability falls at/under the demotion floor", () => {
    const decision = evaluateGraduation({
      ability: DEMOTE_FLOOR_300, // exactly the floor (220) → demote (≤)
      currentTier: 300,
      dwell: 0,
    });
    expect(decision.changed).toBe(true);
    expect(decision.reason).toBe("demoted");
    expect(decision.tier).toBe(200); // steps down one tier
    expect(decision.dueForReview).toBe(true);
    expect(decision.dwell).toBe(0);
  });

  it("does NOT demote just below the boundary (still inside the margin band)", () => {
    const decision = evaluateGraduation({
      ability: DEMOTE_FLOOR_300 + 1, // 221 — above the floor → no demote
      currentTier: 300,
      dwell: 0,
    });
    expect(decision.changed).toBe(false);
    expect(decision.tier).toBe(300);
  });

  it("never demotes the floor tier (100 has no lower boundary)", () => {
    const decision = evaluateGraduation({
      ability: 0, // far below everything
      currentTier: 100,
      dwell: 0,
    });
    expect(decision.changed).toBe(false);
    expect(decision.tier).toBe(100);
  });

  it("never demotes an ungraduated learner (tier 0)", () => {
    const decision = evaluateGraduation({ ability: 0, currentTier: 0, dwell: 0 });
    expect(decision.changed).toBe(false);
    expect(decision.tier).toBe(0);
  });
});

describe("evaluateGraduation — first graduation + top tier", () => {
  it("PLACES an ungraduated learner at the ability-supported tier (185 → 200)", () => {
    // boundaryAbove(0) = 150 ⇒ bar = 180. Ability 185 sits in tier 200's band
    // (tiers 100 and 200 share the 150 entry boundary), so the first
    // graduation places at 200 rather than stepping through 100.
    const decisions = runSequence(0, Array.from({ length: dwell }, () => 185));
    const last = decisions[dwell - 1]!;
    expect(last.changed).toBe(true);
    expect(last.reason).toBe("graduated");
    expect(last.tier).toBe(200);
  });

  it("places a mid-scale starter (θ≈310) at tier 300, not via 100/200 ceremonies", () => {
    const decisions = runSequence(0, Array.from({ length: dwell }, () => 310));
    const last = decisions[dwell - 1]!;
    expect(last.changed).toBe(true);
    expect(last.tier).toBe(300);
  });

  it("placement is capped by measured ability, subsequent promotion steps one rung", () => {
    // Place at 300 (θ=310), then promotion from 300 requires the 380 bar.
    const placed = runSequence(0, Array.from({ length: dwell }, () => 310));
    expect(placed[dwell - 1]!.tier).toBe(300);
    const after = runSequence(300, Array.from({ length: dwell }, () => 385));
    expect(after[dwell - 1]!.changed).toBe(true);
    expect(after[dwell - 1]!.tier).toBe(400); // one rung, never a jump to 500
  });

  it("never promotes beyond the top tier (500)", () => {
    // No boundary above 500 ⇒ always no-change regardless of how high θ is.
    const decisions = runSequence(500, [999, 999, 999]);
    for (const d of decisions) {
      expect(d.changed).toBe(false);
      expect(d.tier).toBe(500);
    }
  });
});

describe("effectiveAbility — exponential decay toward the tier center (OD-003)", () => {
  it("equals the stored ability at zero days (no decay)", () => {
    expect(effectiveAbility(380, 300, 0)).toBeCloseTo(380, 9);
  });

  it("relaxes toward the tier center as days increase (monotone for θ > center)", () => {
    const center = 300;
    const last = 380;
    const samples = [0, 15, 30, 60, 120, 240].map((d) =>
      effectiveAbility(last, center, d),
    );
    for (let i = 1; i < samples.length; i++) {
      // Strictly decreasing toward the center (θ_last is above center).
      expect(samples[i]!).toBeLessThan(samples[i - 1]!);
      expect(samples[i]!).toBeGreaterThan(center);
    }
  });

  it("tends to the tier center as days → ∞", () => {
    expect(effectiveAbility(380, 300, 100000)).toBeCloseTo(300, 3);
  });

  it("rises toward the center from BELOW when θ_last < center", () => {
    const below = effectiveAbility(220, 300, 60);
    expect(below).toBeGreaterThan(220);
    expect(below).toBeLessThan(300);
  });

  it("treats negative days as zero (no decay, clamped)", () => {
    expect(effectiveAbility(380, 300, -10)).toBeCloseTo(380, 9);
  });

  it("matches the closed-form exp(−days/H) at one half-life span", () => {
    const center = 300;
    const last = 400;
    const days = decayHalfLifeDays;
    const expected = center + (last - center) * Math.exp(-1);
    expect(effectiveAbility(last, center, days)).toBeCloseTo(expected, 9);
  });
});

describe("daysBetween — pure date math (clock injected)", () => {
  it("computes whole days between two ISO timestamps", () => {
    expect(
      daysBetween("2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z"),
    ).toBeCloseTo(30, 9);
  });

  it("clamps to zero when `now` precedes `then`", () => {
    expect(
      daysBetween("2026-02-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    ).toBe(0);
  });
});

describe("isDueForReview — staleness window + decayed-ability band (OD-003 / FR-009)", () => {
  const gradAt300: TierGraduation = {
    currentTier: 300,
    status: "current",
    graduatedAt: "2026-01-01T00:00:00.000Z",
    lastChangeReason: "graduated",
  };

  /** An ability estimate last assessed at a fixed instant, at a chosen value. */
  const ability = (value: number, lastAssessedAt: string): AbilityEstimate => ({
    value,
    itemsSeen: 20,
    lastAssessedAt,
    lastItemIds: [],
    dwell: 0,
  });

  it("is NOT due before the staleness window elapses (even if ability is low)", () => {
    // Only 10 days since last assessment (< 30): never due regardless of decay.
    const now = "2026-01-11T00:00:00.000Z";
    const est = ability(260, "2026-01-01T00:00:00.000Z");
    expect(isDueForReview(gradAt300, est, now)).toBe(false);
  });

  it("is NOT due when comfortably above the lower band, even when stale", () => {
    // 200 days stale, but θ_last = center (300) ⇒ decays to ~300, well above
    // the tier-300 lower band (250 + 30 = 280). Not due.
    const now = "2026-07-20T00:00:00.000Z";
    const est = ability(300, "2026-01-01T00:00:00.000Z");
    expect(daysBetween(est.lastAssessedAt, now)).toBeGreaterThanOrEqual(
      stalenessWindowDays,
    );
    expect(isDueForReview(gradAt300, est, now)).toBe(false);
  });

  it("becomes due once stale AND decayed below the lower band (250 + margin = 280)", () => {
    // Realistic lapse zone for tier 300: θ_last in [demotion floor 220, band
    // 280). The Elo ability drifted DOWN after graduation but not far enough to
    // demote in-session; it now sits at 230, below the 280 review band. ~50 days
    // stale: effective = 300 + (230−300)·exp(−50/60) ≈ 269.6 (< 280). Due.
    const now = "2026-02-20T00:00:00.000Z"; // ~50 days after Jan 1
    const est = ability(230, "2026-01-01T00:00:00.000Z");
    const days = daysBetween(est.lastAssessedAt, now);
    expect(days).toBeGreaterThanOrEqual(stalenessWindowDays);
    const eff = effectiveAbility(230, 300, days);
    expect(eff).toBeLessThan(250 + hysteresisMargin); // confirms the band fires
    expect(isDueForReview(gradAt300, est, now)).toBe(true);
  });

  it("recovers (NOT due) once decay relaxes a below-band ability back over the bar", () => {
    // The flip side: the SAME below-band θ_last (230) decays toward center 300,
    // so after enough time the effective ability climbs back ABOVE the 280 band
    // and the topic is no longer due. At ~150 days: 300 + (230−300)·exp(−150/60)
    // ≈ 294.3 (> 280). The decay model self-heals as the learner is presumed to
    // regress toward the tier's typical competence.
    const now = "2026-05-31T00:00:00.000Z"; // ~150 days after Jan 1
    const est = ability(230, "2026-01-01T00:00:00.000Z");
    const days = daysBetween(est.lastAssessedAt, now);
    const eff = effectiveAbility(230, 300, days);
    expect(eff).toBeGreaterThan(250 + hysteresisMargin);
    expect(isDueForReview(gradAt300, est, now)).toBe(false);
  });

  it("is idempotent: a topic already due_for_review is not re-flagged", () => {
    // This very (ability, now) WOULD be due for a `current` topic (proved
    // above), so a `false` here is solely the already-flagged short-circuit.
    const already: TierGraduation = { ...gradAt300, status: "due_for_review" };
    const now = "2026-02-20T00:00:00.000Z";
    const est = ability(230, "2026-01-01T00:00:00.000Z");
    expect(isDueForReview({ ...gradAt300 }, est, now)).toBe(true); // sanity: would be due
    expect(isDueForReview(already, est, now)).toBe(false); // but skipped when already flagged
  });

  it("never lapses an ungraduated topic (tier 0)", () => {
    const ungraduated: TierGraduation = {
      currentTier: 0,
      status: "current",
      graduatedAt: "2026-01-01T00:00:00.000Z",
      lastChangeReason: "graduated",
    };
    const now = "2026-12-31T00:00:00.000Z";
    const est = ability(100, "2026-01-01T00:00:00.000Z");
    expect(isDueForReview(ungraduated, est, now)).toBe(false);
  });
});
