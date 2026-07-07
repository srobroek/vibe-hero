/**
 * @file Unit tests for spool intake (observation/spool.ts).
 *
 * Tests:
 *  - parseSpoolLine: valid + malformed line tolerance.
 *  - claimSpools: rename claiming, orphan reclaim by age, deletes after read.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseSpoolLine, claimSpools } from "../../src/observation/spool.js";

// ---------------------------------------------------------------------------
// parseSpoolLine
// ---------------------------------------------------------------------------

describe("parseSpoolLine — valid lines", () => {
  it("parses a minimal pre line", () => {
    const line = JSON.stringify({
      kind: "pre",
      session: "sess-abc",
      ts: 1720000000,
      tool: "Bash",
      id: "toolu_01",
    });
    const result = parseSpoolLine(line);
    expect(result).toBeDefined();
    expect(result?.kind).toBe("pre");
    expect(result?.session).toBe("sess-abc");
    expect(result?.ts).toBe(1720000000);
    expect(result?.tool).toBe("Bash");
    expect(result?.id).toBe("toolu_01");
  });

  it("parses a post line with input and path", () => {
    const line = JSON.stringify({
      kind: "post",
      session: "sess-xyz",
      ts: 1720000001,
      tool: "Edit",
      id: "toolu_02",
      path: "/home/user/file.ts",
    });
    const result = parseSpoolLine(line);
    expect(result?.kind).toBe("post");
    expect(result?.path).toBe("/home/user/file.ts");
  });

  it("parses an event line (SubagentStop)", () => {
    const line = JSON.stringify({
      kind: "event",
      session: "sess-abc",
      ts: 1720000002,
      event: "SubagentStop",
    });
    const result = parseSpoolLine(line);
    expect(result?.kind).toBe("event");
    expect(result?.event).toBe("SubagentStop");
  });

  it("passes through unknown fields (passthrough schema)", () => {
    const line = JSON.stringify({
      kind: "post",
      session: "s",
      ts: 0,
      unknownField: "preserved",
    });
    const result = parseSpoolLine(line);
    expect(result).toBeDefined();
    // passthrough means the field survives
    expect((result as Record<string, unknown>)["unknownField"]).toBe("preserved");
  });
});

describe("parseSpoolLine — malformed line tolerance", () => {
  it("returns undefined for empty string", () => {
    expect(parseSpoolLine("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseSpoolLine("   \n  ")).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseSpoolLine("{not json}")).toBeUndefined();
    expect(parseSpoolLine("just text")).toBeUndefined();
  });

  it("returns undefined when kind is invalid", () => {
    const line = JSON.stringify({ kind: "invalid", session: "s", ts: 0 });
    expect(parseSpoolLine(line)).toBeUndefined();
  });

  it("returns undefined when session is missing", () => {
    const line = JSON.stringify({ kind: "pre", ts: 0 });
    expect(parseSpoolLine(line)).toBeUndefined();
  });

  it("returns undefined when ts is not an integer", () => {
    const line = JSON.stringify({ kind: "pre", session: "s", ts: "not-a-number" });
    expect(parseSpoolLine(line)).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(parseSpoolLine(JSON.stringify(null))).toBeUndefined();
  });

  it("trims leading/trailing whitespace before parsing", () => {
    const line =
      "  " +
      JSON.stringify({ kind: "post", session: "s", ts: 0 }) +
      "  ";
    const result = parseSpoolLine(line);
    expect(result?.kind).toBe("post");
  });
});

// ---------------------------------------------------------------------------
// claimSpools
// ---------------------------------------------------------------------------

describe("claimSpools — basic claim", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vh-spool-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] when directory does not exist", async () => {
    const nonExistent = path.join(dir, "no-such-dir");
    const result = await claimSpools(nonExistent);
    expect(result).toEqual([]);
  });

  it("returns [] when directory is empty", async () => {
    const result = await claimSpools(dir);
    expect(result).toEqual([]);
  });

  it("claims a spool file and returns its parsed lines", async () => {
    const sid = "test-session";
    const spoolFile = path.join(dir, `${sid}.jsonl`);
    const line1 = JSON.stringify({ kind: "pre", session: sid, ts: 1720000000, tool: "Bash", id: "u1" });
    const line2 = JSON.stringify({ kind: "post", session: sid, ts: 1720000001, tool: "Bash", id: "u1" });
    await writeFile(spoolFile, `${line1}\n${line2}\n`, { encoding: "utf8", mode: 0o600 });

    const result = await claimSpools(dir);

    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe(sid);
    expect(result[0]?.lines).toHaveLength(2);
    expect(result[0]?.lines[0]?.kind).toBe("pre");
    expect(result[0]?.lines[1]?.kind).toBe("post");
  });

  it("deletes the spool file after reading", async () => {
    const sid = "del-session";
    const spoolFile = path.join(dir, `${sid}.jsonl`);
    await writeFile(spoolFile, JSON.stringify({ kind: "event", session: sid, ts: 0 }) + "\n", "utf8");

    await claimSpools(dir);

    // The original file is gone; the .draining-* file is also cleaned up
    expect(existsSync(spoolFile)).toBe(false);
  });

  it("skips malformed lines but still returns the valid ones", async () => {
    const sid = "mixed-session";
    const spoolFile = path.join(dir, `${sid}.jsonl`);
    const good = JSON.stringify({ kind: "event", session: sid, ts: 42, event: "SubagentStop" });
    await writeFile(spoolFile, `{invalid}\n${good}\n`, "utf8");

    const result = await claimSpools(dir);

    expect(result).toHaveLength(1);
    // Only the valid line survives
    expect(result[0]?.lines).toHaveLength(1);
    expect(result[0]?.lines[0]?.kind).toBe("event");
  });

  it("claims multiple spool files independently", async () => {
    for (const sid of ["sess-a", "sess-b", "sess-c"]) {
      const line = JSON.stringify({ kind: "event", session: sid, ts: 0 });
      await writeFile(path.join(dir, `${sid}.jsonl`), line + "\n", "utf8");
    }

    const result = await claimSpools(dir);
    const sessionIds = result.map((r) => r.sessionId).sort();
    expect(sessionIds).toEqual(["sess-a", "sess-b", "sess-c"]);
  });

  it("ignores files that don't match the spool naming pattern", async () => {
    // e.g. profile.json, some-other-file.txt — should be skipped
    await writeFile(path.join(dir, "profile.json"), "{}", "utf8");
    await writeFile(path.join(dir, "random.txt"), "text", "utf8");

    const result = await claimSpools(dir);
    expect(result).toEqual([]);
  });
});

describe("claimSpools — orphan reclaim", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vh-orphan-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reclaims an orphaned .draining-* file older than 5 min", async () => {
    const sid = "orphan-session";
    // Write an orphaned draining file (simulate crashed drainer)
    const drainingFile = path.join(dir, `${sid}.jsonl.draining-99999`);
    const line = JSON.stringify({ kind: "event", session: sid, ts: 0, event: "SessionEnd" });
    await writeFile(drainingFile, line + "\n", "utf8");

    // Backdate the mtime to 6 minutes ago (> ORPHAN_RECLAIM_MS = 5 min)
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(drainingFile, sixMinAgo, sixMinAgo);

    const result = await claimSpools(dir);

    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe(sid);
    expect(result[0]?.lines).toHaveLength(1);
    expect(result[0]?.lines[0]?.event).toBe("SessionEnd");
  });

  it("does NOT reclaim a .draining-* file that is still recent (< 5 min)", async () => {
    const sid = "young-orphan";
    const drainingFile = path.join(dir, `${sid}.jsonl.draining-99998`);
    await writeFile(drainingFile, JSON.stringify({ kind: "event", session: sid, ts: 0 }) + "\n", "utf8");
    // File is just created → mtime is now → should NOT be reclaimed

    const result = await claimSpools(dir);
    expect(result).toEqual([]);
  });
});
