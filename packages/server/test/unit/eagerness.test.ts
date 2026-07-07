/**
 * @file Unit tests for organic-arming eagerness presets (observation/eagerness.ts).
 */

import { describe, it, expect } from "vitest";
import {
  EAGERNESS_PRESETS,
  QUIET_PROMOTION_SECONDS,
  eagernessParams,
  type EagernessParams,
} from "../../src/observation/eagerness.js";
import type { OrganicEagerness } from "../../src/schemas/profile.js";

// ---------------------------------------------------------------------------
// Preset table
// ---------------------------------------------------------------------------

describe("EAGERNESS_PRESETS", () => {
  const presets: OrganicEagerness[] = ["often", "normal", "rarely"];

  it.each(presets)("%s preset has all required numeric fields positive", (preset) => {
    const p = EAGERNESS_PRESETS[preset];
    expect(p.threshold).toBeGreaterThan(0);
    expect(p.windowSeconds).toBeGreaterThan(0);
    expect(p.cooldownSeconds).toBeGreaterThan(0);
  });

  it("often < normal < rarely for threshold (more eager = lower bar)", () => {
    expect(EAGERNESS_PRESETS.often.threshold).toBeLessThan(EAGERNESS_PRESETS.normal.threshold);
    expect(EAGERNESS_PRESETS.normal.threshold).toBeLessThan(EAGERNESS_PRESETS.rarely.threshold);
  });

  it("often ≥ normal ≥ rarely for windowSeconds (more eager = same or larger window)", () => {
    expect(EAGERNESS_PRESETS.often.windowSeconds).toBeGreaterThanOrEqual(
      EAGERNESS_PRESETS.normal.windowSeconds,
    );
    expect(EAGERNESS_PRESETS.normal.windowSeconds).toBeGreaterThanOrEqual(
      EAGERNESS_PRESETS.rarely.windowSeconds,
    );
  });

  it("often < normal < rarely for cooldownSeconds (more eager = shorter cooldown)", () => {
    expect(EAGERNESS_PRESETS.often.cooldownSeconds).toBeLessThan(
      EAGERNESS_PRESETS.normal.cooldownSeconds,
    );
    expect(EAGERNESS_PRESETS.normal.cooldownSeconds).toBeLessThan(
      EAGERNESS_PRESETS.rarely.cooldownSeconds,
    );
  });

  it("often has bypass=true, bypassNeedsPriorEvidence=false", () => {
    expect(EAGERNESS_PRESETS.often.bypass).toBe(true);
    expect(EAGERNESS_PRESETS.often.bypassNeedsPriorEvidence).toBe(false);
  });

  it("normal has bypass=true, bypassNeedsPriorEvidence=true", () => {
    expect(EAGERNESS_PRESETS.normal.bypass).toBe(true);
    expect(EAGERNESS_PRESETS.normal.bypassNeedsPriorEvidence).toBe(true);
  });

  it("rarely has bypass=false", () => {
    expect(EAGERNESS_PRESETS.rarely.bypass).toBe(false);
  });

  it("exact preset values match agreed design", () => {
    const often = EAGERNESS_PRESETS.often;
    expect(often.threshold).toBe(2);
    expect(often.windowSeconds).toBe(45 * 60);
    expect(often.cooldownSeconds).toBe(10 * 60);

    const normal = EAGERNESS_PRESETS.normal;
    expect(normal.threshold).toBe(3);
    expect(normal.windowSeconds).toBe(30 * 60);
    expect(normal.cooldownSeconds).toBe(15 * 60);

    const rarely = EAGERNESS_PRESETS.rarely;
    expect(rarely.threshold).toBe(5);
    expect(rarely.windowSeconds).toBe(30 * 60);
    expect(rarely.cooldownSeconds).toBe(30 * 60);
  });
});

// ---------------------------------------------------------------------------
// QUIET_PROMOTION_SECONDS
// ---------------------------------------------------------------------------

describe("QUIET_PROMOTION_SECONDS", () => {
  it("is a positive number", () => {
    expect(QUIET_PROMOTION_SECONDS).toBeGreaterThan(0);
  });

  it("equals 90 (agreed design value)", () => {
    expect(QUIET_PROMOTION_SECONDS).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// eagernessParams lookup
// ---------------------------------------------------------------------------

describe("eagernessParams", () => {
  it("returns the correct preset for each named eagerness", () => {
    for (const key of ["often", "normal", "rarely"] as OrganicEagerness[]) {
      const params: EagernessParams = eagernessParams(key);
      expect(params).toEqual(EAGERNESS_PRESETS[key]);
    }
  });

  it("defaults to normal when eagerness is undefined", () => {
    expect(eagernessParams(undefined)).toEqual(EAGERNESS_PRESETS.normal);
  });
});
