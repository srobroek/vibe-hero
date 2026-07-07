/**
 * @file Privacy boundary tests for the observation layer (FR-018, SC-008).
 *
 * Architecture after the spool refactor:
 *  - Raw strings (inputText / filePath) ride on ObservedSignal in transit only.
 *  - matchSignalHits() is the boundary: it consumes raw strings and returns
 *    SignalHit[] which carry ONLY derived data (key, title, weight, phase…).
 *  - applyDrainBatch() returns OrganicSession evidence entries with no raw strings.
 *  - writeArmCache() writes JSON that contains title + sessionId but no raw commands.
 *
 * This file proves that none of these derived outputs leak raw content.
 */

import { describe, it, expect } from "vitest";
import { matchSignalHits } from "../../src/observation/offers.js";
import { applyDrainBatch } from "../../src/observation/arming.js";
import { writeArmCache, armCachePath } from "../../src/observation/armCache.js";
import { eagernessParams } from "../../src/observation/eagerness.js";
import { armSession } from "../../src/observation/offers.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Topic } from "../../src/schemas/content.js";
import type { ObservedSignal } from "../../src/observation/offers.js";

// ---------------------------------------------------------------------------
// Fixture topic for matching
// ---------------------------------------------------------------------------

/** A minimal Topic fixture with an inputPattern trigger to exercise the raw-string path. */
const FIXTURE_TOPIC: Topic = {
  id: "hooks",
  class: { kind: "tool", tool: "claude-code" },
  title: "Claude Code Hooks",
  summary: "Configuring and using hooks.",
  triggerSignals: [
    {
      tool: "claude-code",
      match: { toolName: "Bash" },
      weight: 1,
      phase: "during",
      bypass: false,
    },
    {
      tool: "claude-code",
      match: { inputPattern: "SECRET|API_KEY|password" },
      weight: 1,
      phase: "seam",
      bypass: false,
    },
    {
      tool: "claude-code",
      match: { pathPattern: "\\.secret$" },
      weight: 1,
      phase: "during",
      bypass: false,
    },
  ],
  items: [],
};

/** Secret strings that must never appear in derived output. */
const SECRETS = ["sk-SECRET123", "hunter2", "API_KEY", "password"] as const;

// ---------------------------------------------------------------------------
// 1. matchSignalHits output (SignalHit[]) contains no inputText/filePath values
// ---------------------------------------------------------------------------

describe("matchSignalHits — privacy boundary (FR-018)", () => {
  it("SignalHit[] contains no inputText or filePath values even when signals carried them", () => {
    const signals: ObservedSignal[] = [
      {
        toolName: "Bash",
        inputText: "export API_KEY=sk-SECRET123 && ./deploy.sh --password=hunter2",
        success: true,
        toolUseId: "toolu_01",
      },
      {
        toolName: "Edit",
        filePath: "/home/user/.secret",
        success: false,
        toolUseId: "toolu_02",
      },
    ];

    const hits = matchSignalHits([FIXTURE_TOPIC], "claude-code", signals);

    // Hits must have been produced (matcher ran)
    expect(hits.length).toBeGreaterThan(0);

    // Serialize the entire result — nothing raw must survive
    const serialized = JSON.stringify(hits);
    for (const secret of SECRETS) {
      expect(
        serialized.includes(secret),
        `SignalHit[] must not contain raw secret "${secret}"; got: ${serialized}`,
      ).toBe(false);
    }

    // inputText and filePath keys must not appear at all
    expect(serialized).not.toContain("inputText");
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain(".secret");

    // Derived fields ARE present
    for (const hit of hits) {
      expect(Object.keys(hit).sort()).toEqual(
        expect.arrayContaining(["key", "title", "weight", "phase", "bypass", "success", "correlationId"]),
      );
      expect("inputText" in hit).toBe(false);
      expect("filePath" in hit).toBe(false);
    }
  });

  it("FAILURE_WEIGHT_MULTIPLIER doubles weight on failed signals; hit still has no raw content", () => {
    const signals: ObservedSignal[] = [
      { toolName: "Bash", inputText: "API_KEY=secret123", success: false },
    ];
    const hits = matchSignalHits([FIXTURE_TOPIC], "claude-code", signals);
    const bashHit = hits.find((h) => h.phase === "during");
    expect(bashHit).toBeDefined();
    // weight=1 × FAILURE_WEIGHT_MULTIPLIER=2 → 2
    expect(bashHit?.weight).toBe(2);
    // No raw content
    const serialized = JSON.stringify(hits);
    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain("inputText");
  });
});

// ---------------------------------------------------------------------------
// 2. applyDrainBatch evidence entries contain only derived fields
// ---------------------------------------------------------------------------

describe("applyDrainBatch — evidence entries are raw-free (FR-018)", () => {
  it("returned OrganicSession evidence entries have no inputText/filePath", () => {
    const signals: ObservedSignal[] = [
      {
        toolName: "Bash",
        inputText: "export API_KEY=sk-SECRET123 && curl https://api.example.com",
        success: true,
        toolUseId: "toolu_abc",
      },
    ];
    const hits = matchSignalHits([FIXTURE_TOPIC], "claude-code", signals);
    expect(hits.length).toBeGreaterThan(0);

    const params = eagernessParams("normal");
    const { state } = applyDrainBatch(
      { evidence: [] },
      hits,
      params,
      new Date("2026-07-01T12:00:00.000Z"),
    );

    const serialized = JSON.stringify(state);
    for (const secret of SECRETS) {
      expect(serialized.includes(secret)).toBe(false);
    }
    expect(serialized).not.toContain("inputText");
    expect(serialized).not.toContain("filePath");

    // Each evidence entry has only derived fields
    for (const entry of state.evidence) {
      expect(Object.keys(entry).sort()).toEqual(
        expect.arrayContaining(["key", "weight", "phase", "success", "timestamp", "correlationId"]),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. writeArmCache output JSON contains no raw command strings
// ---------------------------------------------------------------------------

describe("writeArmCache — cache file is raw-free (FR-018)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-priv-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("arm cache JSON contains no raw command strings; contains only title/sessionId/derived fields", async () => {
    const SID = "priv-test-session";
    // Override VIBE_HERO_HOME so the cache is written into our tmp dir
    const origHome = process.env["VIBE_HERO_HOME"];
    process.env["VIBE_HERO_HOME"] = home;
    try {
      const arm = armSession(
        "tool:claude-code|hooks",
        "Claude Code Hooks",
        new Date("2026-07-01T12:00:00.000Z"),
      );

      await writeArmCache(SID, arm);

      const cacheFile = armCachePath(SID);
      const content = await readFile(cacheFile, "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Must contain sessionId and armedTitle (safe derived data)
      expect(parsed["sessionId"]).toBe(SID);
      expect(parsed["armedKey"]).toBe("tool:claude-code|hooks");
      expect(parsed["armedTitle"]).toBe("Claude Code Hooks");
      // context is built by buildOfferContext — check it exists and has provenance marker
      expect(typeof parsed["context"]).toBe("string");
      expect(parsed["context"] as string).toContain("vibe-hero hook");

      // No raw command strings
      const serialized = JSON.stringify(parsed);
      for (const secret of SECRETS) {
        expect(serialized.includes(secret)).toBe(false);
      }
      expect(serialized).not.toContain("inputText");
      expect(serialized).not.toContain("filePath");
    } finally {
      if (origHome === undefined) delete process.env["VIBE_HERO_HOME"];
      else process.env["VIBE_HERO_HOME"] = origHome;
    }
  });

  it("armed=false arm (armedKey undefined) writes context: null, still no raw strings", async () => {
    const SID = "priv-cleared-session";
    const origHome = process.env["VIBE_HERO_HOME"];
    process.env["VIBE_HERO_HOME"] = home;
    try {
      // Arm cleared state: no armedKey
      await writeArmCache(SID, { lastOfferAt: new Date().toISOString() });

      const cacheFile = armCachePath(SID);
      const content = await readFile(cacheFile, "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;

      expect(parsed["armedKey"]).toBeNull();
      expect(parsed["context"]).toBeNull();
    } finally {
      if (origHome === undefined) delete process.env["VIBE_HERO_HOME"];
      else process.env["VIBE_HERO_HOME"] = origHome;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Defensive: malformed signals yield no output without throwing
// ---------------------------------------------------------------------------

describe("matchSignalHits — defensive / empty inputs", () => {
  it("empty signals array returns []", () => {
    expect(matchSignalHits([FIXTURE_TOPIC], "claude-code", [])).toEqual([]);
  });

  it("empty topics array returns []", () => {
    const signals: ObservedSignal[] = [{ toolName: "Bash" }];
    expect(matchSignalHits([], "claude-code", signals)).toEqual([]);
  });

  it("wrong tool id returns [] (no cross-tool leakage)", () => {
    const signals: ObservedSignal[] = [{ toolName: "Bash" }];
    expect(matchSignalHits([FIXTURE_TOPIC], "codex", signals)).toEqual([]);
  });
});
