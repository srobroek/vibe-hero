/**
 * @file US-1 observation → offer integration test (T034/T036/T038).
 *
 * Proves the proactive-offer path end-to-end against a real temp profile home
 * and a real temp catalog (no mocks), driving the actual `record_observation`,
 * `get_offer`, and `record_offer_response` handlers:
 *
 *   - record_observation matches a derived tool signal to a topic via its
 *     TriggerSignals and returns it as an offer candidate (FR-015) AND — the
 *     SC-003 invariant — leaves abilities / graduations / quizHistory BYTE-FOR-
 *     BYTE unchanged (usage scores nothing, FR-005).
 *   - get_offer surfaces an offer for an accumulated candidate; a `decline`
 *     response makes the next get_offer THIS session return suppressed:"declined"
 *     (within-session anti-nag, FR-020).
 *   - per_session cadence: once one offer has surfaced, a second distinct
 *     candidate is suppressed:"cadence" the same session (≤1 offer/session,
 *     FR-020a).
 *   - offerCadence "off" ⇒ get_offer always returns suppressed:"offers_off"
 *     (FR-020a).
 *   - cross-session: after `declineMuteThreshold` consecutive declines the
 *     backoff sets a global `mutedUntil` (offers globally muted, FR-020b).
 *
 * The bundled v1 catalog has no trigger signals wired for this, so the test
 * seeds its own catalog dir (two tool-scoped topics, each with a distinct
 * TriggerSignal) and injects it via the tools' `catalogLoader` seam — leaving
 * the shared bundled snapshot (and other suites) untouched. Each test uses its
 * own `VIBE_HERO_HOME` under `os.tmpdir()` via the store's `dirOverride` seam.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (record_observation / get_offer / record_offer_response), spec.md FR-005 /
 * FR-015 / FR-019 / FR-020 / FR-020a / FR-020b / SC-003, data-model.md
 * (§ OfferLedger), src/config.ts (ASSESSMENT_CONFIG.declineMuteThreshold).
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ASSESSMENT_CONFIG } from "../../src/config.js";
import { loadCatalogFromDir } from "../../src/catalog/loader.js";
import { makeRecordObservationTool } from "../../src/tools/recordObservation.js";
import {
  makeGetOfferTool,
  makeRecordOfferResponseTool,
} from "../../src/tools/offers.js";
import { profilePath, updateProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import type {
  GetOfferResult,
  RecordObservationResult,
} from "../../src/schemas/tools.js";

/** The two fixture topic keys (tool-scoped, claude-code). */
const SUBAGENTS_KEY = abilityKey(
  { kind: "tool", tool: "claude-code" },
  "subagents",
);
const BASH_KEY = abilityKey({ kind: "tool", tool: "claude-code" }, "shell-use");

/**
 * Two tool-scoped fixture topics, each with ONE deterministic item and a single
 * TriggerSignal: `subagents` triggers on the `Task` tool, `shell-use` on `Bash`.
 * One item each is enough — offers never quiz here; the trigger signals are what
 * matter for matching.
 */
const SUBAGENTS_YAML = `
id: subagents
class:
  kind: tool
  tool: claude-code
title: Subagents
summary: Delegating work to subagents via the Task tool.
triggerSignals:
  - tool: claude-code
    match:
      toolName: Task
items:
  - id: sub-1
    tier: 100
    bloom: remember
    difficulty: 200
    type: multiple_choice
    prompt: Which tool spawns a subagent?
    choices:
      - id: a
        text: Task
      - id: b
        text: Bash
    answerKey:
      kind: choice
      correctChoiceId: a
    guidance: The Task tool spawns a subagent.
`;

const SHELL_YAML = `
id: shell-use
class:
  kind: tool
  tool: claude-code
title: Shell Use
summary: Running shell commands safely with the Bash tool.
triggerSignals:
  - tool: claude-code
    match:
      toolName: Bash
items:
  - id: sh-1
    tier: 100
    bloom: remember
    difficulty: 200
    type: short_answer
    prompt: "Name the tool that runs shell commands."
    answerKey:
      kind: keyword
      anyOf:
        - bash
      normalize: both
    guidance: The Bash tool runs shell commands.
`;

/** A valid config that clears the setup gate, parameterized by cadence. */
const seedConfig = (
  offerCadence: "off" | "per_session" | "per_topic",
  proactiveOffers = true,
) => {
  const now = "2026-06-01T00:00:00.000Z";
  return {
    toolsLearning: ["claude-code" as const],
    offerCadence,
    proactiveOffers,
    quizLength: 4,
    createdAt: now,
    updatedAt: now,
  };
};

describe("US-1 observation → offer path (T034/T036 / FR-020 / SC-003)", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-offers-"));
    catalogDir = await mkdtemp(path.join(tmpdir(), "vibe-hero-offers-cat-"));
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await writeFile(path.join(toolDir, "shell-use.yaml"), SHELL_YAML, "utf8");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  /** A catalog loader bound to this test's fixture dir. */
  const fixtureLoader = () => loadCatalogFromDir(catalogDir);

  /** Offer-path tool handlers wired to the temp home + fixture catalog. */
  const tools = () => ({
    recordObservation: makeRecordObservationTool(home, fixtureLoader).handler,
    getOffer: makeGetOfferTool(home, fixtureLoader).handler,
    recordResponse: makeRecordOfferResponseTool(home).handler,
  });

  /** Seed only `config` (the offer path needs nothing else pre-existing). */
  const seedProfile = async (
    offerCadence: "off" | "per_session" | "per_topic",
    proactiveOffers = true,
  ): Promise<void> => {
    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(offerCadence, proactiveOffers),
      }),
      home,
    );
  };

  /** Read the persisted profile JSON from disk. */
  const readProfile = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(profilePath(home), "utf8")) as Record<
      string,
      unknown
    >;

  it("record_observation matches a tool signal → returns the topic as a candidate AND scores nothing (SC-003)", async () => {
    await seedProfile("per_session");
    const { recordObservation } = tools();

    const before = await readProfile();

    const result = (await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Task", success: true, toolUseId: "tu-1" }],
      sessionId: "s-1",
    })) as RecordObservationResult;

    // FR-015: the Task signal matched the `subagents` topic's trigger.
    expect(result.offerCandidates).toHaveLength(1);
    expect(result.offerCandidates[0]?.key).toBe(SUBAGENTS_KEY);
    expect(result.offerCandidates[0]?.title).toBe("Subagents");
    expect(result.offerCandidates[0]?.reason.length).toBeGreaterThan(0);

    // SC-003 / FR-005: observed usage awards NOTHING — abilities, graduations,
    // and quizHistory are byte-for-byte unchanged. (Only the `offers` ledger and
    // `updatedAt` may move.)
    const after = await readProfile();
    expect(after["abilities"]).toEqual(before["abilities"]);
    expect(after["graduations"]).toEqual(before["graduations"]);
    expect(after["quizHistory"]).toEqual(before["quizHistory"]);
    expect(after["abilities"]).toEqual({});
    expect(after["graduations"]).toEqual({});
    expect(after["quizHistory"]).toEqual([]);
  });

  it("a non-matching signal yields no candidates", async () => {
    await seedProfile("per_session");
    const { recordObservation } = tools();

    const result = (await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Read", success: true }],
      sessionId: "s-1",
    })) as RecordObservationResult;

    expect(result.offerCandidates).toEqual([]);
  });

  it("get_offer surfaces an offer; decline ⇒ next get_offer this session is suppressed:'declined' (FR-020)", async () => {
    await seedProfile("per_session");
    const { recordObservation, getOffer, recordResponse } = tools();

    // Observe Task activity → accumulate the `subagents` candidate.
    await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Task" }],
      sessionId: "s-1",
    });

    // An offer surfaces.
    const offered = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(offered.offer).toBeDefined();
    expect(offered.offer?.key).toBe(SUBAGENTS_KEY);
    expect(offered.offer?.title).toBe("Subagents");
    expect(offered.offer?.prompt.length).toBeGreaterThan(0);
    expect(offered.suppressed).toBeUndefined();

    // Decline it.
    const ack = await recordResponse({
      sessionId: "s-1",
      key: SUBAGENTS_KEY,
      response: "decline",
    });
    expect(ack).toEqual({ ok: true });

    // The rest of the session is suppressed (no nagging, FR-020).
    const afterDecline = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(afterDecline.offer).toBeUndefined();
    expect(afterDecline.suppressed).toBe("declined");
  });

  it("per_session cadence: a 2nd distinct candidate is suppressed:'cadence' after the first offer (FR-020a)", async () => {
    await seedProfile("per_session");
    const { recordObservation, getOffer } = tools();

    // Two distinct candidates accumulate this session (Task + Bash).
    await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Task" }, { toolName: "Bash" }],
      sessionId: "s-1",
    });

    // First offer surfaces (one of the two).
    const first = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(first.offer).toBeDefined();

    // per_session ⇒ at most one offer for the whole session: the 2nd is capped.
    const second = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(second.offer).toBeUndefined();
    expect(second.suppressed).toBe("cadence");
  });

  it("per_topic cadence: a distinct second candidate CAN surface in the same session (FR-020a)", async () => {
    await seedProfile("per_topic");
    const { recordObservation, getOffer } = tools();

    await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Task" }, { toolName: "Bash" }],
      sessionId: "s-1",
    });

    const first = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(first.offer).toBeDefined();
    const firstKey = first.offer?.key;

    // per_topic ⇒ at most one offer per DISTINCT key: the other candidate surfaces.
    const second = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(second.offer).toBeDefined();
    expect(second.offer?.key).not.toBe(firstKey);

    // A third call has no remaining distinct candidate ⇒ cadence-suppressed.
    const third = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(third.offer).toBeUndefined();
    expect(third.suppressed).toBe("cadence");
  });

  it("offerCadence 'off' ⇒ get_offer always suppressed:'offers_off' (FR-020a)", async () => {
    await seedProfile("off");
    const { recordObservation, getOffer } = tools();

    // Even with a matched candidate, an "off" cadence never offers.
    await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Task" }],
      sessionId: "s-1",
    });

    const result = (await getOffer({
      sessionId: "s-1",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(result.offer).toBeUndefined();
    expect(result.suppressed).toBe("offers_off");
  });

  it("cross-session: after declineMuteThreshold consecutive declines, offers are globally muted (FR-020b)", async () => {
    await seedProfile("per_session");
    const { recordResponse } = tools();

    const threshold = ASSESSMENT_CONFIG.declineMuteThreshold;
    expect(threshold).toBeGreaterThan(0);

    // Decline once per session across `threshold` distinct sessions. Each
    // decline bumps the cross-session consecutive-decline counter (FR-020b).
    for (let i = 0; i < threshold; i++) {
      await recordResponse({
        sessionId: `s-${i + 1}`,
        key: SUBAGENTS_KEY,
        response: "decline",
      });
    }

    // The Nth consecutive decline sets a global `mutedUntil` in the future.
    const profile = (await readProfile()) as {
      backoff: { consecutiveDeclines: number; mutedUntil?: string };
    };
    expect(profile.backoff.consecutiveDeclines).toBe(threshold);
    expect(profile.backoff.mutedUntil).toBeDefined();
    expect(Date.parse(profile.backoff.mutedUntil as string)).toBeGreaterThan(
      Date.now(),
    );

    // And a fresh-session get_offer with a live candidate is muted (cadence).
    const { recordObservation, getOffer } = tools();
    await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Task" }],
      sessionId: "s-muted",
    });
    const muted = (await getOffer({
      sessionId: "s-muted",
      tool: "claude-code",
    })) as GetOfferResult;
    expect(muted.offer).toBeUndefined();
    expect(muted.suppressed).toBe("cadence");
  });

  it("accept resets the consecutive-decline counter and clears the mute (FR-020b)", async () => {
    await seedProfile("per_session");
    const { recordResponse } = tools();

    await recordResponse({
      sessionId: "s-1",
      key: SUBAGENTS_KEY,
      response: "decline",
    });
    await recordResponse({
      sessionId: "s-2",
      key: SUBAGENTS_KEY,
      response: "accept",
    });

    const profile = (await readProfile()) as {
      backoff: { consecutiveDeclines: number; mutedUntil?: string };
    };
    expect(profile.backoff.consecutiveDeclines).toBe(0);
    expect(profile.backoff.mutedUntil).toBeUndefined();
  });
});
