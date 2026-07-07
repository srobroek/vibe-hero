/**
 * @file Integration test for drainOnce: spool → correlate → match → arm.
 *
 * Seeds a spool directory under a tmp VIBE_HERO_HOME, writes spool lines for
 * 3 Task posts + a SubagentStop event, seeds a configured profile, calls
 * drainOnce with injected deps, then asserts:
 *  - arm cache file exists with armedKey and context mentioning the topic title
 *  - profile.organicSessions updated
 *  - spool file deleted
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { drainOnce } from "../../src/observation/drain.js";
import { armCachePath } from "../../src/observation/armCache.js";
import { updateProfile, loadProfile } from "../../src/profile/store.js";
import type { Topic } from "../../src/schemas/content.js";
import type { ToolId } from "../../src/schemas/common.js";

// ---------------------------------------------------------------------------
// Fixture topic — Task tool trigger + SubagentStop seam bypass
// ---------------------------------------------------------------------------

const TOPIC_KEY = "tool:claude-code|subagents";
const TOPIC_TITLE = "Subagents";

const FIXTURE_TOPIC: Topic = {
  id: "subagents",
  class: { kind: "tool", tool: "claude-code" },
  title: TOPIC_TITLE,
  summary: "Delegating work to subagents via the Task tool.",
  triggerSignals: [
    {
      tool: "claude-code",
      match: { toolName: "Task" },
      weight: 1.0,
      phase: "during",
      bypass: false,
    },
    {
      tool: "claude-code",
      match: { event: "SubagentStop" },
      weight: 0.5,
      phase: "seam",
      bypass: true, // ⚡ bypass on SubagentStop
    },
  ],
  items: [],
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("drainOnce — full spool → arm integration", () => {
  let home: string;
  const SID = "drain-e2e-session";

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-drain-e2e-"));
    process.env["VIBE_HERO_HOME"] = home;
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";

    // Seed the profile with a configured + organic-ready config
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          toolsLearning: ["claude-code" as const],
          offerCadence: "per_topic" as const,
          proactiveOffers: true,
          quizLength: 4 as const,
          organicEagerness: "normal" as const,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
      home,
    );
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_HOME"];
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    await rm(home, { recursive: true, force: true });
  });

  it("arms a topic after 3 Task posts + a SubagentStop bypass, spool file deleted", async () => {
    // --- Seed two spool files across two drain ticks ---
    //
    // Drain ordering note: applyDrainBatch processes threshold-crossing and seam
    // promotion in a single pass where threshold creates `pending` (step 6) AFTER
    // seam-promotion checks `pending` (step 5). A seam that arrives in the SAME
    // batch as the threshold-crossing hits therefore does not promote immediately;
    // it takes a second drain tick. We model this naturally with two spool files:
    //   Tick 1: 3 Task posts → weight ≥ threshold → pending created.
    //   Tick 2: SubagentStop seam → pending exists → armed.
    const spoolDir = path.join(home, "spool");
    await mkdir(spoolDir, { recursive: true });

    const ts = Math.floor(Date.now() / 1000);

    // Tick 1: accumulate evidence above threshold
    const spoolFile1 = path.join(spoolDir, `${SID}.jsonl`);
    const tick1Lines = [
      JSON.stringify({ kind: "post", session: SID, ts, tool: "Task", id: "u1" }),
      JSON.stringify({ kind: "post", session: SID, ts, tool: "Task", id: "u2" }),
      JSON.stringify({ kind: "post", session: SID, ts, tool: "Task", id: "u3" }),
    ];
    await writeFile(spoolFile1, tick1Lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });

    const fixedNow1 = new Date("2026-07-01T14:00:00.000Z");
    const deps = {
      loadTopics: async (): Promise<readonly Topic[]> => [FIXTURE_TOPIC],
      tool: (): ToolId | undefined => "claude-code",
      now: (): Date => fixedNow1,
    };
    await drainOnce(deps);

    // Tick 2: seam event → promotes the pending offer → arms
    const spoolFile2 = path.join(spoolDir, `${SID}.jsonl`);
    const tick2Lines = [
      JSON.stringify({ kind: "event", session: SID, ts: ts + 5, event: "SubagentStop" }),
    ];
    await writeFile(spoolFile2, tick2Lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });

    const fixedNow2 = new Date("2026-07-01T14:00:10.000Z");
    await drainOnce({ ...deps, now: (): Date => fixedNow2 });

    // writeArmCache is fire-and-forget inside drainOnce (void); wait for it.
    const cacheFile = armCachePath(SID);
    const deadline = Date.now() + 2_000;
    while (!existsSync(cacheFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // --- Assertions ---

    // 1. Arm cache file exists with armedKey
    expect(existsSync(cacheFile), `arm cache file should exist at ${cacheFile}`).toBe(true);

    const cacheJson = JSON.parse(await readFile(cacheFile, "utf8")) as {
      sessionId: string;
      armedKey: string | null;
      armedTitle: string | null;
      context: string | null;
    };
    expect(cacheJson.sessionId).toBe(SID);
    expect(cacheJson.armedKey).toBe(TOPIC_KEY);
    expect(cacheJson.armedTitle).toBe(TOPIC_TITLE);

    // Context must mention the topic title
    expect(cacheJson.context).not.toBeNull();
    expect(cacheJson.context).toContain(TOPIC_TITLE);
    // Context has provenance marker
    expect(cacheJson.context).toMatch(/vibe-hero hook/i);

    // 2. profile.organicSessions updated for this session
    const profile = await loadProfile(home);
    const session = profile.organicSessions[SID];
    expect(session).toBeDefined();
    // Evidence should have been accumulated (may be pruned if all consumed,
    // but the session entry itself must exist)
    // armedKey is set in offerArms
    expect(profile.offerArms[SID]?.armedKey).toBe(TOPIC_KEY);

    // 3. Spool files deleted after each drain tick
    expect(existsSync(spoolFile1)).toBe(false);
    expect(existsSync(spoolFile2)).toBe(false);
  });

  it("is silent (no arm cache) when proactiveOffers=false", async () => {
    // Override config to disable proactive offers
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          ...p.config!,
          proactiveOffers: false,
        },
      }),
      home,
    );

    const spoolDir = path.join(home, "spool");
    await mkdir(spoolDir, { recursive: true });
    const ts = Math.floor(Date.now() / 1000);
    const lines = [
      JSON.stringify({ kind: "post", session: SID, ts, tool: "Task", id: "u1" }),
      JSON.stringify({ kind: "post", session: SID, ts, tool: "Task", id: "u2" }),
      JSON.stringify({ kind: "post", session: SID, ts, tool: "Task", id: "u3" }),
      JSON.stringify({ kind: "event", session: SID, ts, event: "SubagentStop" }),
    ];
    const spoolFile = path.join(spoolDir, `${SID}.jsonl`);
    await writeFile(spoolFile, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });

    await drainOnce({
      loadTopics: async () => [FIXTURE_TOPIC],
      tool: () => "claude-code",
      now: () => new Date("2026-07-01T14:00:00.000Z"),
    });

    // No arm cache
    expect(existsSync(armCachePath(SID))).toBe(false);
    // Spool still deleted
    expect(existsSync(spoolFile)).toBe(false);
  });

  it("is silent when offerCadence=off", async () => {
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          ...p.config!,
          offerCadence: "off" as const,
        },
      }),
      home,
    );

    const spoolDir = path.join(home, "spool");
    await mkdir(spoolDir, { recursive: true });
    const ts = Math.floor(Date.now() / 1000);
    const spoolFile = path.join(spoolDir, `${SID}.jsonl`);
    await writeFile(
      spoolFile,
      [
        JSON.stringify({ kind: "event", session: SID, ts, event: "SubagentStop" }),
      ].join("\n") + "\n",
      "utf8",
    );

    await drainOnce({
      loadTopics: async () => [FIXTURE_TOPIC],
      tool: () => "claude-code",
      now: () => new Date(),
    });

    expect(existsSync(armCachePath(SID))).toBe(false);
  });

  it("never throws even when loadTopics rejects", async () => {
    const spoolDir = path.join(home, "spool");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(
      path.join(spoolDir, `${SID}.jsonl`),
      JSON.stringify({ kind: "event", session: SID, ts: 0 }) + "\n",
      "utf8",
    );

    await expect(
      drainOnce({
        loadTopics: async () => { throw new Error("catalog load failed"); },
        tool: () => "claude-code",
        now: () => new Date(),
      }),
    ).resolves.toBeUndefined(); // must not throw
  });
});
