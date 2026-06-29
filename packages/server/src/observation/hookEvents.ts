/**
 * @file Hook-payload → derived-signal extraction (FR-018, SC-008).
 *
 * Privacy boundary. A Claude Code `PostToolUse` hook payload carries
 * `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`,
 * `tool_output` (a.k.a. `tool_response`), and `tool_use_id` (research.md
 * § Observation). The user's raw prompts, command lines, file contents, and
 * tool outputs live inside `tool_input` / `tool_output`.
 *
 * {@link extractSignals} reads ONLY the privacy-safe fields — `tool_name`,
 * derived `success`, a `timestamp`, and `tool_use_id` — and MUST NEVER copy,
 * return, or persist `tool_input` or `tool_output` (or any nested raw content).
 * `success` is *derived* from the shape of the output (exit code / error
 * presence) WITHOUT retaining the output itself. The payload is untrusted
 * `unknown` and is validated defensively.
 *
 * This module does NOT do topic matching: a {@link DerivedSignal} carries no
 * `topicKeys`. Mapping signals → topics against `TriggerSignal` declarations
 * happens later in `record_observation`. Keeping extraction topic-free makes
 * the privacy contract — "no raw field ever leaves this function" — auditable
 * in one place (see test/unit/privacy.test.ts).
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-015..018, E4),
 * specs/001-vibe-hero-mvp/research.md (§ Observation & hook correlation).
 */

import {
  type ObservationEvent,
  ObservationEventSchema,
} from "../schemas/profile.js";
import { type AbilityKey, type ToolId } from "../schemas/common.js";
import { type ObservationSource } from "./source.js";

/**
 * The privacy-safe projection of a single hook event. Deliberately NARROW:
 * exactly the four fields the offer engine needs, and nothing derived from the
 * raw input/output content.
 *
 * Note there is no `topicKeys` here — topic attribution is a later step
 * (`record_observation`) and is intentionally out of scope for extraction.
 */
export interface DerivedSignal {
  /** The host tool name reported by the hook (e.g. `"Bash"`, `"Edit"`). */
  readonly toolName: string;
  /**
   * Whether the tool call succeeded, *derived* from the output shape (exit
   * code / error presence) without retaining the output. Trigger metadata
   * only — never a scoring signal (FR-005).
   */
  readonly success: boolean;
  /** ISO-8601 extraction timestamp. */
  readonly timestamp: string;
  /**
   * The hook's `tool_use_id`, the shared id that aligns a hook event with the
   * transcript's `tool_use`/`tool_result` blocks for deterministic correlation
   * (FR-017). `undefined` when the payload omits it.
   */
  readonly toolUseId: string | undefined;
}

/** Narrow `value` to a plain object record, else `undefined`. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read a string field if present and non-empty, else `undefined`. */
const readString = (
  obj: Record<string, unknown>,
  key: string,
): string | undefined => {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

/**
 * Derive success from the tool output WITHOUT copying it.
 *
 * Heuristics, in order (any matched branch decides):
 * 1. an explicit boolean `success` flag,
 * 2. a numeric `exit_code` / `exitCode` (`0` ⇒ success),
 * 3. presence of an `error` / `is_error` / `isError` marker (⇒ failure),
 * 4. otherwise assume success (absence of an error signal).
 *
 * Only a boolean is ever returned; no field of `rawOutput` is retained.
 *
 * @param rawOutput - the untrusted `tool_output` / `tool_response` value.
 */
const deriveSuccess = (rawOutput: unknown): boolean => {
  const out = asRecord(rawOutput);
  if (out === undefined) {
    // No structured output (or a bare scalar/array): nothing signals failure.
    return true;
  }

  if (typeof out["success"] === "boolean") {
    return out["success"];
  }

  const exit = out["exit_code"] ?? out["exitCode"];
  if (typeof exit === "number") {
    return exit === 0;
  }

  const isError = out["is_error"] ?? out["isError"];
  if (typeof isError === "boolean") {
    return !isError;
  }

  const err = out["error"];
  if (err !== undefined && err !== null && err !== false && err !== "") {
    return false;
  }

  return true;
};

/**
 * Extract privacy-safe {@link DerivedSignal}s from an untrusted hook payload.
 *
 * Reads ONLY `tool_name`, a derived `success`, a `timestamp`, and
 * `tool_use_id`. NEVER reads, copies, returns, or persists `tool_input` or
 * `tool_output`/`tool_response` (FR-018, SC-008). A payload missing `tool_name`
 * yields no signal (nothing actionable to attribute).
 *
 * @param hookPayload - an untrusted `PostToolUse` hook payload.
 * @param now - clock for the extraction timestamp, injectable for tests.
 *   Defaults to `Date.now`-backed {@link Date}.
 * @returns zero or one derived signal (array for forward-compatibility with
 *   batched payloads).
 */
export const extractSignals = (
  hookPayload: unknown,
  now: () => Date = () => new Date(),
): DerivedSignal[] => {
  const payload = asRecord(hookPayload);
  if (payload === undefined) {
    return [];
  }

  const toolName = readString(payload, "tool_name");
  if (toolName === undefined) {
    return [];
  }

  // `tool_output` is the documented field; some hook versions / docs use
  // `tool_response`. We read it ONLY to derive a boolean and immediately drop
  // the reference — its content is never copied into the result.
  const success = deriveSuccess(
    payload["tool_output"] ?? payload["tool_response"],
  );

  const signal: DerivedSignal = {
    toolName,
    success,
    timestamp: now().toISOString(),
    toolUseId: readString(payload, "tool_use_id"),
  };
  return [signal];
};

/**
 * {@link ObservationSource} wrapper over the Claude Code hook (FR-016).
 *
 * Buffers derived events as hook payloads arrive (via {@link record}) and
 * drains them on {@link poll}. Topic attribution is NOT done here: because a
 * {@link DerivedSignal} has no topics, this wrapper produces a *minimal*
 * {@link ObservationEvent} with an empty `topicKeys` array — the downstream
 * `record_observation` step matches signals to topics against `TriggerSignal`
 * declarations and fills in the real keys. Keeping that out of the privacy
 * boundary preserves the single-responsibility extraction contract.
 *
 * The buffer holds only already-derived, privacy-safe events; no raw payload is
 * ever retained.
 */
export class HookSource implements ObservationSource {
  public readonly kind = "claude-code-hook";

  private readonly buffer: ObservationEvent[] = [];

  /**
   * @param tool - the host tool these hook events belong to (Claude Code in
   *   v1). Stamped onto each derived {@link ObservationEvent}.
   * @param now - clock for timestamps, injectable for deterministic tests.
   */
  public constructor(
    private readonly tool: ToolId = "claude-code",
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Drain and clear the buffered derived events. */
  public poll(): Promise<readonly ObservationEvent[]> {
    const drained = this.buffer.splice(0, this.buffer.length);
    return Promise.resolve(drained);
  }

  /**
   * Derive privacy-safe events from one hook payload, buffer them, and return
   * them. The returned events carry an empty `topicKeys` (filled downstream).
   *
   * @param raw - an untrusted `PostToolUse` hook payload.
   */
  public record(raw: unknown): readonly ObservationEvent[] {
    const events = extractSignals(raw, this.now).map((signal) =>
      this.toEvent(signal),
    );
    this.buffer.push(...events);
    return events;
  }

  /**
   * Project a {@link DerivedSignal} into a minimal {@link ObservationEvent}.
   * `topicKeys` is intentionally empty here (attribution is downstream). The
   * `tool_use_id` becomes the correlation id when present, else a synthetic
   * `hook:<timestamp>` token (FR-017 correlation needs the real id; absence is
   * tolerated). Re-validated against the schema, which has no raw-content field.
   */
  private toEvent(signal: DerivedSignal): ObservationEvent {
    const topicKeys: AbilityKey[] = [];
    const event: ObservationEvent = {
      tool: this.tool,
      topicKeys,
      success: signal.success,
      timestamp: signal.timestamp,
      correlationId: signal.toolUseId ?? `hook:${signal.timestamp}`,
    };
    return ObservationEventSchema.parse(event);
  }
}
