/**
 * @file Privacy boundary test for hook-payload extraction (FR-018, SC-008).
 *
 * Proves the observation layer never lets a raw `tool_input` / `tool_output`
 * field escape extraction. Construct a payload whose input/output contain
 * obvious secrets, run {@link extractSignals}, and assert:
 *  1. the derived signal has the expected privacy-safe fields, and
 *  2. the FULL serialized result contains NONE of the secret substrings.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-018, SC-008, Edge E4).
 */

import { describe, it, expect } from "vitest";
import {
  extractSignals,
  HookSource,
  type DerivedSignal,
} from "../../src/observation/hookEvents.js";

/** Secret substrings planted in raw payload fields; none may ever leak. */
const SECRETS = ["sk-SECRET123", "hunter2", "API_KEY", "password"] as const;

/** A realistic PostToolUse payload with secrets buried in input AND output. */
const payloadWithSecrets = (overrides?: {
  toolOutput?: unknown;
}): Record<string, unknown> => ({
  session_id: "sess-abc",
  transcript_path: "/Users/dev/.claude/projects/x/transcript.jsonl",
  cwd: "/Users/dev/secret-project",
  tool_name: "Bash",
  tool_use_id: "toolu_01XYZ",
  tool_input: {
    command: "export API_KEY=sk-SECRET123 && ./deploy.sh",
    description: "deploy with the password=hunter2 credential",
  },
  tool_output: overrides?.toolOutput ?? {
    stdout: "Connecting with password=hunter2 ... API_KEY=sk-SECRET123 OK",
    exit_code: 0,
  },
});

describe("extractSignals — privacy boundary (FR-018 / SC-008)", () => {
  const fixedNow = () => new Date("2026-06-29T12:00:00.000Z");

  it("returns the expected privacy-safe DerivedSignal", () => {
    const signals = extractSignals(payloadWithSecrets(), fixedNow);
    expect(signals).toHaveLength(1);

    const signal = signals[0] as DerivedSignal;
    expect(signal.toolName).toBe("Bash");
    expect(signal.toolUseId).toBe("toolu_01XYZ");
    expect(signal.timestamp).toBe("2026-06-29T12:00:00.000Z");
    expect(signal.success).toBe(true);

    // The narrow shape itself is part of the contract: exactly these keys.
    expect(Object.keys(signal).sort()).toEqual(
      ["success", "timestamp", "toolName", "toolUseId"].sort(),
    );
  });

  it("CRUCIAL: no raw payload field leaks into the serialized result", () => {
    const signals = extractSignals(payloadWithSecrets(), fixedNow);

    // Serialize the ENTIRE returned structure — this is what SC-008 inspects.
    const serialized = JSON.stringify(signals);

    for (const secret of SECRETS) {
      expect(
        serialized.includes(secret),
        `serialized DerivedSignal must not contain raw secret "${secret}"; got: ${serialized}`,
      ).toBe(false);
    }

    // And explicitly: no input/output keys survived either.
    expect(serialized).not.toContain("tool_input");
    expect(serialized).not.toContain("tool_output");
    expect(serialized).not.toContain("stdout");
    expect(serialized).not.toContain("command");
  });

  it("HookSource.record also leaks no raw payload field", () => {
    const source = new HookSource("claude-code", fixedNow);
    const events = source.record(payloadWithSecrets());

    const serialized = JSON.stringify(events);
    for (const secret of SECRETS) {
      expect(serialized.includes(secret)).toBe(false);
    }
    // The derived event is topic-free at extraction; attribution is downstream.
    expect(events).toHaveLength(1);
    expect(events[0]?.topicKeys).toEqual([]);
    expect(events[0]?.correlationId).toBe("toolu_01XYZ");
    expect(events[0]?.success).toBe(true);
  });

  it("negative case: an errored tool_output yields success=false", () => {
    // Three independent failure shapes, all must derive success=false.
    const byExitCode = extractSignals(
      payloadWithSecrets({ toolOutput: { stderr: "boom", exit_code: 1 } }),
      fixedNow,
    );
    expect(byExitCode[0]?.success).toBe(false);

    const byErrorField = extractSignals(
      payloadWithSecrets({ toolOutput: { error: "command not found" } }),
      fixedNow,
    );
    expect(byErrorField[0]?.success).toBe(false);

    const byIsError = extractSignals(
      payloadWithSecrets({ toolOutput: { is_error: true, stdout: "" } }),
      fixedNow,
    );
    expect(byIsError[0]?.success).toBe(false);

    // Even in the failure case, nothing raw leaks.
    const serialized = JSON.stringify([byExitCode, byErrorField, byIsError]);
    for (const secret of SECRETS) {
      expect(serialized.includes(secret)).toBe(false);
    }
  });

  it("defensive: malformed payloads yield no signal (no throw)", () => {
    expect(extractSignals(null)).toEqual([]);
    expect(extractSignals(undefined)).toEqual([]);
    expect(extractSignals("not an object")).toEqual([]);
    expect(extractSignals([1, 2, 3])).toEqual([]);
    // Missing tool_name ⇒ nothing actionable to attribute.
    expect(extractSignals({ tool_input: { x: "API_KEY" } })).toEqual([]);
  });
});
