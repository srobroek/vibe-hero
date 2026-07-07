/**
 * @file Observation source abstraction (FR-015/016).
 *
 * Observation is **trigger-only**: a source yields derived, privacy-safe
 * {@link ObservationEvent}s that say *a topic was exercised*, used solely to
 * populate offer candidates. Observation NEVER scores (FR-005, SC-003) and
 * NEVER persists raw prompts, tool inputs, or tool outputs (FR-018, SC-008).
 *
 * The {@link ObservationSource} interface is the seam (FR-016) behind which any
 * provenance can live — the spool-drain intake (./drain.ts, which replaced
 * the former HookSource wrapper), a future transcript-backfill source, or
 * the always-available {@link SelfReportSource} manual path. The rest of the
 * system depends only on this interface, so adding a source needs no redesign.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-015..018),
 * specs/001-vibe-hero-mvp/data-model.md (§ ObservationEvent),
 * specs/001-vibe-hero-mvp/research.md (§ Observation & hook correlation).
 */

import {
  type ObservationEvent,
  ObservationEventSchema,
} from "../schemas/profile.js";
import { type AbilityKey, type ToolId, abilityKey } from "../schemas/common.js";

/**
 * A provenance of derived observation signals (FR-016).
 *
 * Two complementary entry points so every concrete source fits, regardless of
 * how its raw signal arrives:
 *
 * - {@link poll} — for sources that accumulate signals out-of-band (e.g. a hook
 *   writing to a buffer, or a transcript reader) and are *drained* on demand.
 *   Returns and clears whatever has been observed since the last poll.
 * - {@link record} — for sources handed a single raw payload synchronously
 *   (e.g. one hook invocation, or an explicit self-report) and asked to derive
 *   events from it immediately.
 *
 * A concrete source MAY implement only the entry point natural to it; the other
 * defaults to yielding nothing. Both return only privacy-safe
 * {@link ObservationEvent}s — never raw payload fields (FR-018).
 */
export interface ObservationSource {
  /**
   * Stable identifier for the source kind, for diagnostics/telemetry routing.
   * Examples: `"self-report"`, `"claude-code-hook"`, `"transcript-backfill"`.
   */
  readonly kind: string;

  /**
   * Drain accumulated derived events. Implementations that push via
   * {@link record} (or have no buffer) return an empty array.
   *
   * @returns the privacy-safe events observed since the previous poll.
   */
  poll(): Promise<readonly ObservationEvent[]>;

  /**
   * Derive zero or more privacy-safe events from a single raw payload.
   *
   * Implementations MUST treat `raw` as untrusted `unknown`, validate
   * defensively, and copy ONLY derived signals — never `tool_input`,
   * `tool_output`, or any nested raw content (FR-018).
   *
   * @param raw - an untrusted, source-specific payload.
   * @returns the privacy-safe events derived from `raw` (possibly empty).
   */
  record(raw: unknown): readonly ObservationEvent[];
}

/**
 * Explicit input for the manual self-report path. The user (or the host agent
 * on their behalf) states outright that one or more topics were exercised; no
 * telemetry is involved, so this path ALWAYS works (FR-016, SC-011).
 */
export interface SelfReport {
  /** The host tool the activity belongs to. */
  readonly tool: ToolId;
  /**
   * The topic ability keys the user reports exercising (e.g. produced from
   * {@link abilityKey}). At least one is expected; an empty list yields no
   * event.
   */
  readonly topicKeys: readonly AbilityKey[];
  /**
   * Whether the reported activity succeeded. Self-report defaults to `true`
   * (the user is asserting they did the thing); pass `false` to report a
   * failed/abandoned attempt. Note: success is trigger metadata only and never
   * affects scoring (FR-005).
   */
  readonly success?: boolean;
  /**
   * Optional correlation id for this report. Defaults to a generated
   * `self-report:<timestamp>` token; self-report has no upstream id to align
   * with (FR-017 correlation applies to hook↔transcript, not this path).
   */
  readonly correlationId?: string;
}

/**
 * Manual, always-available observation source (FR-016, SC-011).
 *
 * Produces an {@link ObservationEvent} from an explicit {@link SelfReport} with
 * no telemetry whatsoever — the canonical fallback when no hook/transcript
 * source is present (Edge: "No telemetry available"). Because the input is
 * already a set of derived `topicKeys`, there is nothing raw to leak; the event
 * is still re-validated against {@link ObservationEventSchema} before it leaves.
 *
 * @example
 * const src = new SelfReportSource();
 * const events = src.record({
 *   tool: "claude-code",
 *   topicKeys: [abilityKey({ kind: "tool", tool: "claude-code" }, "subagents")],
 * });
 */
export class SelfReportSource implements ObservationSource {
  public readonly kind = "self-report";

  /**
   * @param now - clock for the event timestamp / default correlation id,
   *   injectable for deterministic tests. Defaults to `Date.now`-backed
   *   {@link Date}.
   */
  public constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Self-report is push-only via {@link record}; there is no buffer to drain.
   */
  public poll(): Promise<readonly ObservationEvent[]> {
    return Promise.resolve([]);
  }

  /**
   * Derive a single {@link ObservationEvent} from an explicit {@link SelfReport}.
   *
   * Returns an empty array when the report names no topics. The returned event
   * carries only derived fields and is schema-validated before return.
   *
   * @param raw - expected to satisfy {@link SelfReport}; validated defensively.
   * @throws {Error} if `raw` is not a well-formed self-report.
   */
  public record(raw: unknown): readonly ObservationEvent[] {
    const report = this.parseReport(raw);
    if (report.topicKeys.length === 0) {
      return [];
    }
    const timestamp = this.now().toISOString();
    const event: ObservationEvent = {
      tool: report.tool,
      topicKeys: [...report.topicKeys],
      success: report.success ?? true,
      timestamp,
      correlationId: report.correlationId ?? `self-report:${timestamp}`,
    };
    // Re-validate the derived event; this is the privacy boundary's final
    // checkpoint (the schema has no fields for raw payload content).
    return [ObservationEventSchema.parse(event)];
  }

  /** Defensive structural validation of an untrusted self-report payload. */
  private parseReport(raw: unknown): SelfReport {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("SelfReportSource.record: expected a SelfReport object");
    }
    const obj = raw as Record<string, unknown>;
    const tool = obj["tool"];
    const topicKeys = obj["topicKeys"];
    if (typeof tool !== "string") {
      throw new Error("SelfReportSource.record: 'tool' must be a ToolId string");
    }
    if (!Array.isArray(topicKeys)) {
      throw new Error(
        "SelfReportSource.record: 'topicKeys' must be an array of AbilityKey",
      );
    }
    const success = obj["success"];
    const correlationId = obj["correlationId"];
    return {
      tool: tool as ToolId,
      topicKeys: topicKeys as AbilityKey[],
      ...(typeof success === "boolean" ? { success } : {}),
      ...(typeof correlationId === "string" && correlationId.length > 0
        ? { correlationId }
        : {}),
    };
  }
}
