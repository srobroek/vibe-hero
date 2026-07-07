/**
 * @file Unit tests for the stage-timing instrumentation (perf.ts).
 *
 * `perfEnabled` is env-derived at module load, so these tests exercise the
 * enabled path via `VIBE_HERO_PROFILE` set in the test environment (see
 * `vi.stubEnv` + dynamic import) and the pass-through path with it unset.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("perf stage timing", () => {
  it("passes through and records aggregates when profiling is enabled", async () => {
    vi.stubEnv("VIBE_HERO_PROFILE", "1");
    const perf = await import("../../src/perf.js");
    perf.resetPerfStats();

    const result = await perf.timed("stage:test", () => 42);
    expect(result).toBe(42);

    const asyncResult = await perf.timed("stage:test", async () => "ok");
    expect(asyncResult).toBe("ok");

    const summary = perf.perfSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ stage: "stage:test", count: 2 });
    expect(summary[0]!.totalMs).toBeGreaterThanOrEqual(0);
    expect(summary[0]!.maxMs).toBeGreaterThanOrEqual(summary[0]!.meanMs);
  });

  it("records the stage even when the wrapped fn throws", async () => {
    vi.stubEnv("VIBE_HERO_PROFILE", "1");
    const perf = await import("../../src/perf.js");
    perf.resetPerfStats();

    await expect(
      perf.timed("stage:boom", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(perf.perfSummary()).toHaveLength(1);
    expect(perf.perfSummary()[0]).toMatchObject({ stage: "stage:boom", count: 1 });
  });

  it("is a zero-recording pass-through when disabled", async () => {
    vi.stubEnv("VIBE_HERO_PROFILE", "");
    vi.stubEnv("VIBE_HERO_DEBUG", "");
    delete process.env["VIBE_HERO_LOG_LEVEL"];
    const perf = await import("../../src/perf.js");
    perf.resetPerfStats();

    expect(await perf.timed("stage:off", () => 7)).toBe(7);
    expect(perf.perfSummary()).toHaveLength(0);
  });
});
