/**
 * @file Unit tests for drain-time pre/post correlation (observation/drain.ts).
 *
 * Tests correlateLines:
 *  - post consumes its pre; signal produced is success=true.
 *  - dangling pre times out to success=false after PRE_DANGLE_TIMEOUT_MS.
 *  - pre without id is ignored (cannot correlate).
 */

import { describe, it, expect } from "vitest";
import { correlateLines, PRE_DANGLE_TIMEOUT_MS } from "../../src/observation/drain.js";
import type { SpoolLine } from "../../src/observation/spool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = Date.now();

const pre = (id: string, tool = "Bash", input?: string): SpoolLine => ({
  kind: "pre",
  session: "s",
  ts: Math.floor(NOW_MS / 1000),
  tool,
  id,
  ...(input !== undefined ? { input } : {}),
});

const post = (id: string, tool = "Bash", path?: string): SpoolLine => ({
  kind: "post",
  session: "s",
  ts: Math.floor(NOW_MS / 1000),
  tool,
  id,
  ...(path !== undefined ? { path } : {}),
});

const event = (eventName: string): SpoolLine => ({
  kind: "event",
  session: "s",
  ts: Math.floor(NOW_MS / 1000),
  event: eventName,
});

// ---------------------------------------------------------------------------
// Post consumes pre
// ---------------------------------------------------------------------------

describe("correlateLines — post consumes pre", () => {
  it("a post produces a success=true signal and removes the dangling pre", () => {
    const pending = new Map();
    const signals = correlateLines([pre("u1"), post("u1")], pending, NOW_MS);

    // Should produce exactly ONE signal (from the post)
    expect(signals).toHaveLength(1);
    expect(signals[0]?.success).toBe(true);
    expect(signals[0]?.toolName).toBe("Bash");
    // Pre was consumed
    expect(pending.size).toBe(0);
  });

  it("post carries tool path (filePath) through to the signal", () => {
    const pending = new Map();
    // pre comes in first; then post with a path
    pending.set("u-path", {
      line: { kind: "pre", session: "s", ts: 0, tool: "Edit", id: "u-path" },
      heldSinceMs: NOW_MS,
    });
    const signals = correlateLines(
      [{ kind: "post", session: "s", ts: 0, tool: "Edit", id: "u-path", path: "/some/file.ts" }],
      pending,
      NOW_MS,
    );
    expect(signals[0]?.filePath).toBe("/some/file.ts");
    expect(signals[0]?.success).toBe(true);
  });

  it("post without matching pre still produces a success=true signal", () => {
    // Post arrives without a matching pre (pre may have been processed previously)
    const pending = new Map();
    const signals = correlateLines([post("unmatched")], pending, NOW_MS);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.success).toBe(true);
  });

  it("multiple independent pre/post pairs each produce one signal", () => {
    const pending = new Map();
    const signals = correlateLines(
      [pre("a"), pre("b"), post("b"), post("a")],
      pending,
      NOW_MS,
    );
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.success)).toBe(true);
    expect(pending.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dangling pre times out to success=false
// ---------------------------------------------------------------------------

describe("correlateLines — dangling pre timeout", () => {
  it("dangling pre exceeding PRE_DANGLE_TIMEOUT_MS emits success=false signal", () => {
    const pending = new Map();
    const staleMs = NOW_MS - PRE_DANGLE_TIMEOUT_MS - 1_000; // stale

    pending.set("stale-u", {
      line: pre("stale-u", "Bash", "some command"),
      heldSinceMs: staleMs,
    });

    const signals = correlateLines([], pending, NOW_MS);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.success).toBe(false);
    expect(signals[0]?.toolName).toBe("Bash");
    // Pre was evicted from pending
    expect(pending.size).toBe(0);
  });

  it("dangling pre within timeout is NOT yet emitted", () => {
    const pending = new Map();
    const recentMs = NOW_MS - 1_000; // just 1s ago, well within timeout

    pending.set("fresh-u", {
      line: pre("fresh-u"),
      heldSinceMs: recentMs,
    });

    const signals = correlateLines([], pending, NOW_MS);
    expect(signals).toHaveLength(0);
    expect(pending.size).toBe(1); // still held
  });

  it("input text rides along to the failure signal (transit-only)", () => {
    const pending = new Map();
    pending.set("cmd-u", {
      line: { ...pre("cmd-u"), input: "secret-command" },
      heldSinceMs: NOW_MS - PRE_DANGLE_TIMEOUT_MS - 1,
    });

    const signals = correlateLines([], pending, NOW_MS);
    expect(signals[0]?.success).toBe(false);
    expect(signals[0]?.inputText).toBe("secret-command");
  });
});

// ---------------------------------------------------------------------------
// Pre without id is ignored
// ---------------------------------------------------------------------------

describe("correlateLines — pre without id is ignored", () => {
  it("a pre line with no id field is not stored in pending", () => {
    const pending = new Map();
    // id is undefined (not present)
    const noIdPre: SpoolLine = { kind: "pre", session: "s", ts: 0, tool: "Bash" };
    const signals = correlateLines([noIdPre], pending, NOW_MS);

    // Ignored — no signal, nothing in pending
    expect(signals).toHaveLength(0);
    expect(pending.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event lines are their own signals
// ---------------------------------------------------------------------------

describe("correlateLines — event lines", () => {
  it("an event line produces a success=true signal with event field", () => {
    const pending = new Map();
    const signals = correlateLines([event("SubagentStop")], pending, NOW_MS);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.success).toBe(true);
    expect(signals[0]?.event).toBe("SubagentStop");
  });

  it("event lines do not affect the pending map", () => {
    const pending = new Map();
    pending.set("existing", {
      line: pre("existing"),
      heldSinceMs: NOW_MS,
    });
    correlateLines([event("SessionEnd")], pending, NOW_MS);
    expect(pending.size).toBe(1); // untouched
  });
});
