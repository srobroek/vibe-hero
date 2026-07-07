/**
 * @file Lightweight in-process timing instrumentation.
 *
 * vibe-hero is a long-lived stdio MCP server, so the cheapest useful profiler
 * is stage-level wall-clock timing emitted as structured log events: it costs
 * nothing when disabled, needs no external tooling, and pinpoints WHICH stage
 * (catalog load, profile IO, lock wait, handler) dominates a slow tool call.
 *
 * ## Enabling
 *
 * - `VIBE_HERO_PROFILE=1` → per-stage timing events at `info` level plus an
 *   aggregate summary on shutdown, without the full `VIBE_HERO_DEBUG` firehose.
 * - `VIBE_HERO_DEBUG=1` → timing events ride along at `info` level too.
 *
 * ## When you need a real profiler instead
 *
 * Stage timing answers "which stage is slow". For "which function is slow"
 * use a sampling profiler around the same entrypoint — no code changes needed:
 *
 *   node --cpu-prof --cpu-prof-dir=/tmp/vh-prof dist/index.js
 *
 * (point the MCP host's `command` at that wrapper, then open the `.cpuprofile`
 * in Chrome DevTools or speedscope.app). `0x` and `clinic flame` work the same
 * way. This module deliberately stays a thin `performance.now()` wrapper so it
 * never distorts what those tools measure.
 */

import { performance } from "node:perf_hooks";

import { logger, debugEnabled } from "./log.js";

/** Is stage timing explicitly on (`VIBE_HERO_PROFILE` truthy)? */
const RAW_PROFILE = process.env["VIBE_HERO_PROFILE"];
const PROFILE_ON =
  RAW_PROFILE !== undefined &&
  RAW_PROFILE !== "" &&
  RAW_PROFILE !== "0" &&
  RAW_PROFILE !== "false";

/** Is timing collection active (profile flag or debug logging)? */
export const perfEnabled = (): boolean => PROFILE_ON || debugEnabled();

/** Aggregate stats for one stage label. */
export interface StageStats {
  readonly stage: string;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/** Running aggregates, keyed by stage label. Reset via {@link resetPerfStats}. */
const stats = new Map<string, { count: number; totalMs: number; maxMs: number }>();

/** Record one measurement and emit a structured timing event. */
const record = (stage: string, ms: number): void => {
  const entry = stats.get(stage) ?? { count: 0, totalMs: 0, maxMs: 0 };
  entry.count += 1;
  entry.totalMs += ms;
  if (ms > entry.maxMs) entry.maxMs = ms;
  stats.set(stage, entry);
  logger.info({ perf: true, stage, ms: Math.round(ms * 100) / 100 }, "perf");
};

/**
 * Time an async (or sync) stage. Zero-overhead pass-through when timing is
 * disabled. The stage label should be stable and low-cardinality
 * (e.g. `"tool:submit_answer"`, `"catalog:resolve"`, `"profile:update"`).
 */
export const timed = async <T>(
  stage: string,
  fn: () => T | Promise<T>,
): Promise<T> => {
  if (!perfEnabled()) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    record(stage, performance.now() - t0);
  }
};

/** Snapshot the aggregate stats, sorted by total time descending. */
export const perfSummary = (): StageStats[] =>
  [...stats.entries()]
    .map(([stage, s]) => ({
      stage,
      count: s.count,
      totalMs: Math.round(s.totalMs * 100) / 100,
      maxMs: Math.round(s.maxMs * 100) / 100,
      meanMs: Math.round((s.totalMs / s.count) * 100) / 100,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);

/** Clear all aggregates (test seam). */
export const resetPerfStats = (): void => {
  stats.clear();
};

/** Log the aggregate summary (called on shutdown when timing is active). */
export const logPerfSummary = (): void => {
  if (!perfEnabled() || stats.size === 0) return;
  logger.info({ perf: true, summary: perfSummary() }, "perf summary");
};
