/**
 * @file Unit tests for the env-tunable drain interval (observation/drain.ts).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DRAIN_INTERVAL_MS,
  MAX_DRAIN_INTERVAL_MS,
  MIN_DRAIN_INTERVAL_MS,
  drainIntervalMs,
} from "../../src/observation/drain.js";

const ENV = "VIBE_HERO_DRAIN_INTERVAL_MS";

afterEach(() => {
  delete process.env[ENV];
});

describe("drainIntervalMs", () => {
  it("defaults to 30s when unset", () => {
    delete process.env[ENV];
    expect(drainIntervalMs()).toBe(DEFAULT_DRAIN_INTERVAL_MS);
  });

  it("honors a valid override", () => {
    process.env[ENV] = "5000";
    expect(drainIntervalMs()).toBe(5_000);
  });

  it("clamps below the minimum", () => {
    process.env[ENV] = "1";
    expect(drainIntervalMs()).toBe(MIN_DRAIN_INTERVAL_MS);
  });

  it("clamps above the maximum", () => {
    process.env[ENV] = String(60 * 60 * 1_000);
    expect(drainIntervalMs()).toBe(MAX_DRAIN_INTERVAL_MS);
  });

  it("falls back to the default on garbage / non-positive values", () => {
    for (const bad of ["abc", "-5", "0", "NaN"]) {
      process.env[ENV] = bad;
      expect(drainIntervalMs()).toBe(DEFAULT_DRAIN_INTERVAL_MS);
    }
  });

  it("truncates fractional values", () => {
    process.env[ENV] = "1500.9";
    expect(drainIntervalMs()).toBe(1_500);
  });
});
