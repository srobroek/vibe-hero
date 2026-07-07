/**
 * @file Unit tests for offer arm/throttle lifecycle (per-session keying).
 *
 * Tests the pure functions from `observation/offers.ts`:
 *   - `armSession`      — sets key/title/armedAt/lastOfferAt
 *   - `clearArm`        — clears key/title/armedAt, preserves lastOfferAt
 *   - `isArmExpired`    — true when armedAt + cooldown < now
 *   - `isWithinCooldown`— true when lastOfferAt + cooldown > now
 *   - `cooldownSeconds` — reads VIBE_HERO_OFFER_COOLDOWN_SECONDS or falls back
 *
 * And integration-level assertions on the tool layer:
 *   - Two concurrent sessions using different sessionIds never clobber each
 *     other's arm state in profile.offerArms.
 *   - `get_offer` arms the session and writes the /tmp cache file.
 *   - `record_offer_response` (decline/defer) clears the arm.
 *   - `start_quiz` (with sessionId) clears the arm.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  armSession,
  canArm,
  clearArm,
  clearArmOnQuiz,
  isArmExpired,
  isWithinCooldown,
  cooldownSeconds,
  isThrottleDisabled,
  describeCooldown,
  DEFAULT_COOLDOWN_SECONDS,
  MAX_COOLDOWN_SECONDS,
  MIN_COOLDOWN_SECONDS,
} from "../../src/observation/offers.js";
import { makeGetOfferTool, makeRecordOfferResponseTool, armCachePath } from "../../src/tools/offers.js";
import { makeStartQuizTool } from "../../src/tools/startQuiz.js";
import { makeRecordObservationTool } from "../../src/tools/recordObservation.js";
import { loadCatalogFromDir } from "../../src/catalog/loader.js";
import { loadProfile, updateProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import { TopicSchema } from "../../src/schemas/content.js";

// ---------------------------------------------------------------------------
// Fixture catalog (same as us1-offers.test.ts)
// ---------------------------------------------------------------------------

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

const SUBAGENTS_KEY = abilityKey({ kind: "tool", tool: "claude-code" }, "subagents");

// ---------------------------------------------------------------------------
// Pure unit tests for arm helpers
// ---------------------------------------------------------------------------

describe("armSession (pure)", () => {
  it("sets armedKey, armedTitle, armedAt; does NOT stamp lastOfferAt to now on fresh arm", () => {
    // KEY INVARIANT: lastOfferAt must NOT be set to now during arming.
    // If armedAt == lastOfferAt the hook gates become mutually exclusive:
    //   before cooldown elapses: isWithinCooldown=true  -> hook silent
    //   at/after cooldown:       isArmExpired=true      -> hook silent
    // There is NO instant where the hook can emit. Fix: fresh arms leave
    // lastOfferAt undefined so the hook emits immediately; only
    // clearArmOnQuiz/clearArm stamp lastOfferAt to enforce the cooldown.
    const now = new Date("2026-01-01T12:00:00.000Z");
    const arm = armSession("tool|bash", "Bash Use", now);
    expect(arm.armedKey).toBe("tool|bash");
    expect(arm.armedTitle).toBe("Bash Use");
    expect(arm.armedAt).toBe(now.toISOString());
    expect(arm.lastOfferAt).toBeUndefined(); // must NOT equal armedAt
  });

  it("carries forward existing lastOfferAt from a prior quiz/decline (not overwritten by arm)", () => {
    const quizTime = new Date("2026-01-01T10:00:00.000Z");
    const armTime  = new Date("2026-01-01T12:00:00.000Z");
    // Simulate state after a quiz: clearArmOnQuiz stamped lastOfferAt
    const afterQuiz = clearArmOnQuiz({}, quizTime);
    const arm = armSession("tool|bash", "Bash", armTime, afterQuiz);
    // lastOfferAt must remain the quiz time — NOT armTime
    expect(arm.lastOfferAt).toBe(quizTime.toISOString());
    expect(arm.armedAt).toBe(armTime.toISOString());
  });
});

describe("clearArm (pure, decline/defer path)", () => {
  it("drops armedKey/armedTitle/armedAt, stamps lastOfferAt, preserves quiz state", () => {
    const armTime = new Date("2026-01-01T11:00:00.000Z");
    const clearTime = new Date("2026-01-01T12:00:00.000Z");
    const quizTime = "2026-01-01T10:00:00.000Z";
    const existing = {
      ...armSession("tool|bash", "Bash", armTime),
      lastQuizAt: quizTime,
      hasWorkSinceLastQuiz: true,
    };
    const cleared = clearArm(existing, clearTime);
    expect(cleared.armedKey).toBeUndefined();
    expect(cleared.armedTitle).toBeUndefined();
    expect(cleared.armedAt).toBeUndefined();
    expect(cleared.lastOfferAt).toBe(clearTime.toISOString());
    // Quiz/work history preserved (decline doesn't reset semantic gate).
    expect(cleared.lastQuizAt).toBe(quizTime);
    expect(cleared.hasWorkSinceLastQuiz).toBe(true);
  });
});

describe("clearArmOnQuiz (pure, quiz-start path)", () => {
  it("stamps lastQuizAt, resets hasWorkSinceLastQuiz to false, stamps lastOfferAt", () => {
    const quizTime = new Date("2026-01-01T12:00:00.000Z");
    const existing = armSession("tool|bash", "Bash", new Date("2026-01-01T11:00:00.000Z"));
    const cleared = clearArmOnQuiz(existing, quizTime);
    expect(cleared.armedKey).toBeUndefined();
    expect(cleared.armedTitle).toBeUndefined();
    expect(cleared.armedAt).toBeUndefined();
    expect(cleared.lastOfferAt).toBe(quizTime.toISOString());
    expect(cleared.lastQuizAt).toBe(quizTime.toISOString());
    expect(cleared.hasWorkSinceLastQuiz).toBe(false);
  });
});

describe("canArm (pure, semantic + timer gate)", () => {
  it("returns true when no quiz history and cooldown elapsed", () => {
    const old = new Date(Date.now() - 2_000_000).toISOString();
    expect(canArm({ lastOfferAt: old }, new Date())).toBe(true);
  });

  it("returns false within cooldown window", () => {
    const recent = new Date(Date.now() - 100).toISOString();
    expect(canArm({ lastOfferAt: recent }, new Date())).toBe(false);
  });

  it("returns false when lastQuizAt set but hasWorkSinceLastQuiz is false", () => {
    const old = new Date(Date.now() - 2_000_000).toISOString();
    expect(canArm({
      lastOfferAt: old,
      lastQuizAt: old,
      hasWorkSinceLastQuiz: false,
    }, new Date())).toBe(false);
  });

  it("returns true when lastQuizAt set AND hasWorkSinceLastQuiz is true", () => {
    const old = new Date(Date.now() - 2_000_000).toISOString();
    expect(canArm({
      lastOfferAt: old,
      lastQuizAt: old,
      hasWorkSinceLastQuiz: true,
    }, new Date())).toBe(true);
  });

  it("returns true when lastQuizAt is absent (no quiz done yet)", () => {
    const old = new Date(Date.now() - 2_000_000).toISOString();
    expect(canArm({ lastOfferAt: old }, new Date())).toBe(true);
  });
});

describe("isArmExpired (pure)", () => {
  it("returns false when armedAt is absent (nothing armed)", () => {
    const arm = clearArm({}, new Date());
    expect(isArmExpired(arm, new Date())).toBe(false);
  });

  it("returns false when armedAt is within the cooldown window", () => {
    const now = new Date();
    const arm = armSession("k", "T", new Date(now.getTime() - 100));
    // cooldown default 900s; 100ms elapsed → not expired
    expect(isArmExpired(arm, now)).toBe(false);
  });

  it("returns true when armedAt is older than cooldown window", () => {
    const now = new Date();
    const oldNow = new Date(now.getTime() - 1_000_000); // ~16 min ago
    const arm = armSession("k", "T", oldNow);
    // 1_000_000 ms > 900_000 ms (900s default) → expired
    expect(isArmExpired(arm, now)).toBe(true);
  });
});

describe("isWithinCooldown (pure)", () => {
  it("returns false when lastOfferAt is absent", () => {
    expect(isWithinCooldown({}, new Date())).toBe(false);
  });

  it("returns true when lastOfferAt is very recent", () => {
    const now = new Date();
    const arm = { lastOfferAt: new Date(now.getTime() - 100).toISOString() };
    expect(isWithinCooldown(arm, now)).toBe(true);
  });

  it("returns false when lastOfferAt is older than cooldown window", () => {
    const now = new Date();
    const oldAt = new Date(now.getTime() - 1_000_000).toISOString(); // > 900s ago
    const arm = { lastOfferAt: oldAt };
    expect(isWithinCooldown(arm, now)).toBe(false);
  });
});

describe("cooldownSeconds (env)", () => {
  it("returns the default when env var is unset", () => {
    const orig = process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    try {
      expect(cooldownSeconds()).toBe(DEFAULT_COOLDOWN_SECONDS);
    } finally {
      if (orig !== undefined) process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = orig;
    }
  });

  it("returns the parsed value when env var is set", () => {
    // Use a value above MIN_COOLDOWN_SECONDS (60) so this exercises pass-through,
    // not the floor (the floor has its own dedicated test below).
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "120";
    try {
      expect(cooldownSeconds()).toBe(120);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });

  it("falls back to 900 when env var is non-numeric", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "not-a-number";
    try {
      expect(cooldownSeconds()).toBe(900);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });

  it("clamps an outsized value to the maximum (never mutes offers forever)", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "9999999999999999999";
    try {
      expect(cooldownSeconds()).toBe(MAX_COOLDOWN_SECONDS);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });

  it("floors a tiny positive value to the minimum (no offer spam)", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "1";
    try {
      expect(cooldownSeconds()).toBe(MIN_COOLDOWN_SECONDS);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });

  it("preserves 0 as the explicit no-throttle value (not floored)", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
    try {
      expect(cooldownSeconds()).toBe(0);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });
});

describe("isThrottleDisabled", () => {
  it("is true only when the resolved cooldown is 0", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
    try {
      expect(isThrottleDisabled()).toBe(true);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });

  it("is false for a positive cooldown", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "120";
    try {
      expect(isThrottleDisabled()).toBe(false);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });
});

describe("describeCooldown", () => {
  it("reports the resolved cooldown config as a struct", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "120";
    try {
      const d = describeCooldown();
      expect(d.seconds).toBe(120);
      expect(d.disabled).toBe(false);
      expect(d.min).toBe(MIN_COOLDOWN_SECONDS);
      expect(d.max).toBe(MAX_COOLDOWN_SECONDS);
      expect(d.default).toBe(DEFAULT_COOLDOWN_SECONDS);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });

  it("reflects the disabled (no-throttle) state when cooldown is 0", () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
    try {
      const d = describeCooldown();
      expect(d.seconds).toBe(0);
      expect(d.disabled).toBe(true);
    } finally {
      delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — per-session arm keying (two sessions don't clobber)
// ---------------------------------------------------------------------------

describe("per-session arm keying — two sessions independent", () => {
  // Each session gets its own profile home (mirrors how the server works:
  // the profile is per-user, but each tool call carries its sessionId).
  // The key assertion is that offerArms[sessionId] is keyed by session so
  // session-A's arm does NOT overwrite session-B's arm in the same profile.
  let home: string;
  let catalogDir: string;

  const seedConfig = () => ({
    toolsLearning: ["claude-code" as const],
    offerCadence: "per_topic" as const, // per_topic allows multiple offers per session
    proactiveOffers: true,
    quizLength: 4 as const,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-arm-"));
    process.env["VIBE_HERO_HOME"] = home;
    catalogDir = await mkdtemp(path.join(tmpdir(), "vh-arm-cat-"));
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_HOME"];
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  it("arming session-A does not affect session-B's offerArms slot", async () => {
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    // Session A: observe work + get offer → arms session-A slot.
    const recObsA = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOfferA = makeGetOfferTool(home, fixtureLoader).handler;
    await recObsA({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: "arm-sid-a" });
    const offerA = await getOfferA({ sessionId: "arm-sid-a", tool: "claude-code" }) as { offer?: { key: string } };
    expect(offerA.offer).toBeDefined();

    // Read profile: arm-sid-a should be armed, arm-sid-b slot untouched.
    const profile = await loadProfile(home);
    const armA = profile.offerArms["arm-sid-a"];
    const armB = profile.offerArms["arm-sid-b"];
    expect(armA?.armedKey).toBe(SUBAGENTS_KEY);
    expect(armB?.armedKey).toBeUndefined(); // arm-sid-b never touched

    // /tmp cache for session-A exists with correct embedded sessionId.
    const cacheA = armCachePath("arm-sid-a");
    expect(existsSync(cacheA)).toBe(true);
    const cacheJson = JSON.parse(await readFile(cacheA, "utf8")) as { sessionId: string; armedKey: string };
    expect(cacheJson.sessionId).toBe("arm-sid-a");
    expect(cacheJson.armedKey).toBe(SUBAGENTS_KEY);

    // Session B: observe work + get offer → arms arm-sid-b without touching arm-sid-a.
    const recObsB = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOfferB = makeGetOfferTool(home, fixtureLoader).handler;
    await recObsB({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: "arm-sid-b" });
    await getOfferB({ sessionId: "arm-sid-b", tool: "claude-code" });

    const profile2 = await loadProfile(home);
    // session-A arm must still be intact after session-B armed.
    expect(profile2.offerArms["arm-sid-a"]?.armedKey).toBe(SUBAGENTS_KEY);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — arm reset on decline
// ---------------------------------------------------------------------------

describe("arm reset on decline", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-arm-decline-"));
    process.env["VIBE_HERO_HOME"] = home;
    catalogDir = await mkdtemp(path.join(tmpdir(), "vh-arm-decline-cat-"));
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          toolsLearning: ["claude-code" as const],
          offerCadence: "per_session" as const,
          proactiveOffers: true,
          quizLength: 4 as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      home,
    );
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_HOME"];
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  it("decline clears the arm (armedKey absent) and stamps lastOfferAt", async () => {
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;
    const recordResponse = makeRecordOfferResponseTool(home).handler;

    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: "session-decline" });
    const offer = await getOffer({ sessionId: "session-decline", tool: "claude-code" }) as { offer?: { key: string } };
    expect(offer.offer).toBeDefined();

    // Decline the offer.
    await recordResponse({ sessionId: "session-decline", key: SUBAGENTS_KEY, response: "decline" });

    // Arm should be cleared.
    const profile = await loadProfile(home);
    const arm = profile.offerArms["session-decline"];
    expect(arm?.armedKey).toBeUndefined();
    expect(arm?.lastOfferAt).toBeDefined(); // cooldown stamp must be present

    // /tmp cache should have a null armedKey.
    const cacheFile = armCachePath("session-decline");
    if (existsSync(cacheFile)) {
      const cache = JSON.parse(await readFile(cacheFile, "utf8")) as { armedKey: unknown };
      expect(cache.armedKey).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests — arm reset on start_quiz
// ---------------------------------------------------------------------------

describe("arm reset on start_quiz", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-arm-quiz-"));
    process.env["VIBE_HERO_HOME"] = home;
    catalogDir = await mkdtemp(path.join(tmpdir(), "vh-arm-quiz-cat-"));
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          toolsLearning: ["claude-code" as const],
          offerCadence: "per_session" as const,
          proactiveOffers: true,
          quizLength: 4 as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      home,
    );
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_HOME"];
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  it("start_quiz with sessionId clears the arm and stamps lastOfferAt", async () => {
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;
    const startQuiz = makeStartQuizTool(home, fixtureLoader).handler;

    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: "session-quiz" });
    const offer = await getOffer({ sessionId: "session-quiz", tool: "claude-code" }) as { offer?: { key: string } };
    expect(offer.offer).toBeDefined();

    // Start the quiz with sessionId → should clear the arm.
    await startQuiz({ key: SUBAGENTS_KEY, sessionId: "session-quiz" });

    const profile = await loadProfile(home);
    const arm = profile.offerArms["session-quiz"];
    expect(arm?.armedKey).toBeUndefined();
    expect(arm?.lastOfferAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — cooldown stamping
// ---------------------------------------------------------------------------

describe("cooldown stamping", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-cooldown-"));
    process.env["VIBE_HERO_HOME"] = home;
    catalogDir = await mkdtemp(path.join(tmpdir(), "vh-cooldown-cat-"));
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          toolsLearning: ["claude-code" as const],
          offerCadence: "per_session" as const,
          proactiveOffers: true,
          quizLength: 4 as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      home,
    );
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_HOME"];
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  it("get_offer sets armedAt on the arm record; lastOfferAt is NOT stamped on fresh arm", async () => {
    // Regression guard for the mutually-exclusive-gates bug: armedAt is set to
    // now, but lastOfferAt must remain undefined on a fresh arm so the hook can
    // emit immediately. (See armSession JSDoc for the full invariant.)
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;

    const before = Date.now();
    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: "session-cd" });
    const offer = await getOffer({ sessionId: "session-cd", tool: "claude-code" }) as { offer?: { key: string } };
    expect(offer.offer).toBeDefined();
    const after = Date.now();

    const profile = await loadProfile(home);
    const arm = profile.offerArms["session-cd"];
    expect(arm?.armedKey).toBe(SUBAGENTS_KEY);
    expect(arm?.armedAt).toBeDefined();
    // Fresh arm: lastOfferAt must be undefined (not equal to armedAt).
    expect(arm?.lastOfferAt).toBeUndefined();

    const armedEpoch = Date.parse(arm?.armedAt ?? "");
    expect(armedEpoch).toBeGreaterThanOrEqual(before);
    expect(armedEpoch).toBeLessThanOrEqual(after);
  });

  it("arm cache file includes cooldownSeconds from env", async () => {
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "120";
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;

    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: "session-cd" });
    await getOffer({ sessionId: "session-cd", tool: "claude-code" });

    const cacheFile = armCachePath("session-cd");
    const cache = JSON.parse(await readFile(cacheFile, "utf8")) as { cooldownSeconds: number; sessionId: string };
    expect(cache.sessionId).toBe("session-cd");
    expect(cache.cooldownSeconds).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Integration test — break-and-return after quiz: semantic gate prevents
// re-offering until real work happens (not just time passing).
// ---------------------------------------------------------------------------

describe("break-and-return after quiz: no re-offer without intervening work", () => {
  let home: string;
  let catalogDir: string;
  const SID = "session-break";

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-break-"));
    process.env["VIBE_HERO_HOME"] = home;
    catalogDir = await mkdtemp(path.join(tmpdir(), "vh-break-cat-"));
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          toolsLearning: ["claude-code" as const],
          offerCadence: "per_session" as const,
          proactiveOffers: true,
          quizLength: 4 as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      home,
    );
    // Set cooldown to 0 so the TIMER gate is always satisfied — proving the
    // semantic gate is the active guard in this test.
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "0";
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_HOME"];
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  it("quiz taken -> cooldown=0, no work since quiz -> get_offer returns offer but does NOT rearm the cache", async () => {
    // The canArm gate controls whether the /tmp cache is written (which drives
    // the hook). get_offer always returns the offer when resolveOffer says so —
    // the agent can confirm and present it. But the hook won't fire again until
    // both cooldown elapsed AND real work has arrived since the quiz.
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;
    const startQuiz = makeStartQuizTool(home, fixtureLoader).handler;

    // Step 1: Work → candidate accumulates.
    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: SID });

    // Step 2: Offer resolves and session is armed (canArm=true: no prior quiz).
    const offer = await getOffer({ sessionId: SID, tool: "claude-code" }) as { offer?: { key: string } };
    expect(offer.offer).toBeDefined();

    // Verify cache was written.
    const cacheAfterArm = armCachePath(SID);
    expect(existsSync(cacheAfterArm)).toBe(true);
    const cacheArmed = JSON.parse(await readFile(cacheAfterArm, "utf8")) as { armedKey: string | null };
    expect(cacheArmed.armedKey).toBe(SUBAGENTS_KEY);

    // Step 3: Quiz starts → clears arm + stamps lastQuizAt, resets hasWorkSinceLastQuiz.
    await startQuiz({ key: SUBAGENTS_KEY, sessionId: SID });

    // Cache should now show cleared arm.
    if (existsSync(cacheAfterArm)) {
      const cacheCleared = JSON.parse(await readFile(cacheAfterArm, "utf8")) as { armedKey: string | null };
      expect(cacheCleared.armedKey).toBeNull();
    }

    // Step 4: Time passes (timer=0 so cooldown always elapsed).
    // User returns with no work — canArm = false (no work since quiz).
    // get_offer: resolveOffer still suppressed because per_session cap hit
    // (offersThisSession=1). But the key assertion is the semantic state.
    const profileAfterQuiz = await loadProfile(home);
    const armAfterQuiz = profileAfterQuiz.offerArms[SID];
    expect(armAfterQuiz?.lastQuizAt).toBeDefined();
    expect(armAfterQuiz?.hasWorkSinceLastQuiz).toBe(false);

    // Step 5: Real work arrives.
    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: SID });

    // hasWorkSinceLastQuiz is now true — the semantic gate has cleared.
    const profileAfterWork = await loadProfile(home);
    expect(profileAfterWork.offerArms[SID]?.hasWorkSinceLastQuiz).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E2E regression: full arm → hook-emit cycle with real timestamps.
//
// Two bugs were caught by this suite:
//   Bug 1 (mutually-exclusive gates): armSession stamped armedAt == lastOfferAt,
//     so isWithinCooldown and isArmExpired were both true at every instant —
//     the hook could never emit. Fixed by not stamping lastOfferAt in armSession.
//   Bug 2 (timezone): the BSD branch of iso_to_epoch parsed the UTC Z-timestamp
//     in local time, making armed_epoch = (true epoch - TZ offset). On UTC+4 a
//     freshly-written arm appeared ~14400 s old (> 900 s cooldown) and was
//     immediately treated as expired. Fixed by using `date -u -j` with the Z
//     kept in the format string.
//
// WHY COOLDOWN=0 MISSED BUG 2: with cooldown=0 the expiry block is gated by
//   `[ "$cooldown_ms" -gt 0 ]`, so iso_to_epoch is never called. The timezone
//   parse is only exercised when cooldown > 0. All hook-script emit tests MUST
//   run with a non-zero cooldown so the expiry and cooldown-window paths run.
// ---------------------------------------------------------------------------

// repo root = up from packages/server/test/unit
const REPO_ROOT_FOR_E2E = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
);
const HOOK_SCRIPT = path.join(REPO_ROOT_FOR_E2E, "hooks", "claude-code", "prompt-offer.sh");
/** Plugin root (contains hooks/claude-code/_lib.sh). */
const PLUGIN_ROOT_FOR_E2E = path.join(REPO_ROOT_FOR_E2E, "packages", "vibe-hero-plugin");
const E2E_TIMEOUT = 15_000;

/**
 * Run the real prompt-offer.sh script.
 *
 * CLAUDE_PLUGIN_ROOT must be set so the hook can source _lib.sh (set -eu would
 * crash immediately otherwise). VIBE_HERO_HOME must point to the same tmp dir
 * used to write arm caches so the hook reads the correct file.
 */
function runHookScript(
  sessionId: string,
  vibeHeroHome: string,
  extraEnv?: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT_FOR_E2E,
      VIBE_HERO_HOME: vibeHeroHome,
      ...extraEnv,
    };
    const child = execFile(
      HOOK_SCRIPT,
      [],
      { timeout: E2E_TIMEOUT, env, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") { reject(err); return; }
        const code = err && typeof (err as { code?: number }).code === "number"
          ? (err as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(JSON.stringify({ session_id: sessionId }));
  });
}

describe("E2E regression: arm → hook emit cycle (catches mutually-exclusive-gates + timezone bugs)", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-e2e-"));
    catalogDir = await mkdtemp(path.join(tmpdir(), "vh-e2e-cat-"));
    // Set VIBE_HERO_HOME so armCachePath() and writeArmCache() both resolve
    // to the same tmp dir; the hook child process also inherits this.
    process.env["VIBE_HERO_HOME"] = home;
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          toolsLearning: ["claude-code" as const],
          offerCadence: "per_session" as const,
          proactiveOffers: true,
          quizLength: 4 as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      home,
    );
    // NOTE: do NOT set VIBE_HERO_OFFER_COOLDOWN_SECONDS=0 here. Each test sets
    // its own cooldown via the env var passed at arm time (so writeArmCache
    // writes the right cooldownSeconds into the JSON). The hook reads
    // cooldownSeconds from the JSON, not the env var, so the child process env
    // only matters for the arm step, not the hook invocation.
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_HOME"];
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  it("(1) fresh arm — cache has armedKey set and lastOfferAt null (not equal armedAt)", async () => {
    const SID = "e2e-fresh";
    // Use 900s cooldown so the cache is written with cooldownSeconds:900.
    // This exercises iso_to_epoch during the hook run (expiry gate is active).
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "900";
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;

    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: SID });
    const offer = await getOffer({ sessionId: SID, tool: "claude-code" }) as { offer?: { key: string } };
    expect(offer.offer).toBeDefined();

    const cacheFile = armCachePath(SID);
    expect(existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(await readFile(cacheFile, "utf8")) as {
      armedKey: string | null;
      armedAt: string | null;
      lastOfferAt: string | null;
      cooldownSeconds: number;
    };
    expect(cache.armedKey).toBe(SUBAGENTS_KEY);
    // Bug 1 regression: lastOfferAt must NOT equal armedAt on a fresh arm.
    // If they were equal, isWithinCooldown and isArmExpired would be mutually
    // exclusive at every instant and the hook could never emit.
    expect(cache.lastOfferAt).toBeNull();
    expect(cache.armedAt).not.toBeNull();
    expect(cache.cooldownSeconds).toBe(900);
  }, E2E_TIMEOUT);

  it("(2) hook EMITS with real 900s cooldown — exercises iso_to_epoch UTC parsing (Bug 2 regression)", async () => {
    // CRITICAL: this test uses cooldown=900 so iso_to_epoch is actually called.
    // Bug 2 (timezone) would cause iso_to_epoch on macOS/BSD to return
    // (epoch - TZ_offset), making a fresh arm appear ~TZ_offset seconds old.
    // On UTC+4 that's 14400s > 900s → instant expiry → silent hook.
    // With the fix (date -u -j) the epoch is parsed correctly and the arm is
    // NOT expired, so the hook emits.
    const SID = "e2e-fresh";
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "900";
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;

    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: SID });
    const offer = await getOffer({ sessionId: SID, tool: "claude-code" }) as { offer?: { key: string; title: string } };
    expect(offer.offer).toBeDefined();
    const offerTitle = offer.offer!.title;

    // Run the ACTUAL hook script with 900s cooldown in the cache.
    // A fresh arm (armedAt ≈ now) must NOT be expired (< 900s elapsed), so
    // iso_to_epoch must parse the UTC timestamp correctly regardless of host TZ.
    const { code, stdout } = await runHookScript(SID, home);
    expect(code).toBe(0);
    // THE REGRESSION ASSERTION: must emit. If iso_to_epoch returns wrong epoch
    // (off by TZ offset), elapsed_arm > 900 → expired → stdout would be empty.
    expect(stdout.trim()).not.toBe("");

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toMatch(/vibe-hero hook/i);
    expect(ctx).toMatch(/NOT from the user/i);
    // Agent infers break from activity — does not wait for user to announce.
    expect(ctx).toMatch(/infer|detect|activity|shape of the work/i);
    expect(ctx).toMatch(/do not wait|will not/i);
    expect(ctx).toContain(offerTitle);
    expect(ctx).toContain("get_offer");
  }, E2E_TIMEOUT);

  it("(3) arm with armedAt far in the past (> cooldown) is treated as expired — hook silent", async () => {
    // Also exercises iso_to_epoch: an old arm must parse to a low epoch,
    // making elapsed_arm > cooldown, so the hook exits 0.
    const SID = "e2e-expired";
    // Write cache directly with armedAt 2000s ago, cooldown=900s.
    const oldArmedAt = new Date(Date.now() - 2_000_000).toISOString(); // ~33 min ago
    const armDir = path.join(home, "arm");
    await mkdir(armDir, { recursive: true });
    const cacheFile = armCachePath(SID);
    await writeFile(cacheFile, JSON.stringify({
      sessionId: SID,
      armedKey: SUBAGENTS_KEY,
      armedTitle: "Subagents",
      armedAt: oldArmedAt,
      lastOfferAt: null,
      cooldownSeconds: 900,
      lastQuizAt: null,
      hasWorkSinceLastQuiz: false,
      context: "some context",
    }), { encoding: "utf8", mode: 0o600 });

    const { code, stdout } = await runHookScript(SID, home);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(""); // expired arm → silent
  }, E2E_TIMEOUT);

  it("(4) lastOfferAt recent (within 900s cooldown) → hook silent — exercises cooldown-window gate", async () => {
    // Exercises the cooldown-window iso_to_epoch call (last_epoch path).
    const SID = "e2e-cooldown";
    const nowIso = new Date().toISOString();
    const armDir = path.join(home, "arm");
    await mkdir(armDir, { recursive: true });
    const cacheFile = armCachePath(SID);
    await writeFile(cacheFile, JSON.stringify({
      sessionId: SID,
      armedKey: SUBAGENTS_KEY,
      armedTitle: "Subagents",
      armedAt: nowIso,
      lastOfferAt: nowIso, // just stamped → within 900s cooldown
      cooldownSeconds: 900,
      lastQuizAt: null,
      hasWorkSinceLastQuiz: false,
      context: "some context",
    }), { encoding: "utf8", mode: 0o600 });

    const { code, stdout } = await runHookScript(SID, home);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(""); // within cooldown → silent
  }, E2E_TIMEOUT);

  it("(5) after start_quiz — arm cleared, hook silent regardless of cooldown", async () => {
    const SID = "e2e-post-quiz";
    // Arm with 900s cooldown so iso_to_epoch runs.
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "900";
    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;
    const startQuiz = makeStartQuizTool(home, fixtureLoader).handler;

    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: SID });
    const offer = await getOffer({ sessionId: SID, tool: "claude-code" }) as { offer?: { key: string } };
    expect(offer.offer).toBeDefined();

    // Quiz starts — arm is cleared (armedKey → null), lastQuizAt stamped.
    await startQuiz({ key: SUBAGENTS_KEY, sessionId: SID });

    const cacheFile = armCachePath(SID);
    if (existsSync(cacheFile)) {
      const cache = JSON.parse(await readFile(cacheFile, "utf8")) as { armedKey: string | null };
      expect(cache.armedKey).toBeNull();

      // Hook: armedKey is null → exits silently before any time math.
      const { code, stdout } = await runHookScript(SID, home);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("");
    }
  }, E2E_TIMEOUT);
});

// ---------------------------------------------------------------------------
// Defect regression tests: fractional cooldown + title escaping
// ---------------------------------------------------------------------------

describe("Defect regressions: fractional cooldown and title JSON injection", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-defect-"));
    // Set VIBE_HERO_HOME so armCachePath() and writeArmCache() resolve to tmp dir.
    process.env["VIBE_HERO_HOME"] = home;
    catalogDir = await mkdtemp(path.join(tmpdir(), "vh-defect-cat-"));
    const toolDir = path.join(catalogDir, "claude-code");
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, "subagents.yaml"), SUBAGENTS_YAML, "utf8");
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          toolsLearning: ["claude-code" as const],
          offerCadence: "per_session" as const,
          proactiveOffers: true,
          quizLength: 4 as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      home,
    );
  });

  afterEach(async () => {
    delete process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
    delete process.env["VIBE_HERO_HOME"];
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  it("fractional VIBE_HERO_OFFER_COOLDOWN_SECONDS: server writes integer, hook exits 0 (no arithmetic crash)", async () => {
    // Regression for: $((900.5 * 1)) under set -eu crashes with "invalid
    // arithmetic operator" on every prompt when a fractional cooldown reaches
    // the cache JSON.
    const SID = "defect-frac";
    // Set a fractional cooldown — the server must truncate it to an integer
    // before writing the cache, and the hook must also strip any fraction
    // defensively.
    process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"] = "900.5";

    const fixtureLoader = () => loadCatalogFromDir(catalogDir);
    const recordObservation = makeRecordObservationTool(home, fixtureLoader).handler;
    const getOffer = makeGetOfferTool(home, fixtureLoader).handler;

    await recordObservation({ tool: "claude-code", signals: [{ toolName: "Task" }], sessionId: SID });
    await getOffer({ sessionId: SID, tool: "claude-code" });

    // Verify server wrote an integer (not a float) into the cache.
    const cacheFile = armCachePath(SID);
    if (existsSync(cacheFile)) {
      const cache = JSON.parse(await readFile(cacheFile, "utf8")) as { cooldownSeconds: unknown };
      expect(Number.isInteger(cache.cooldownSeconds)).toBe(true);
      expect(cache.cooldownSeconds).toBe(900); // Math.trunc(900.5) = 900
    }

    // Run the actual hook — must exit 0, never crash with arithmetic error.
    const { code, stdout, stderr } = await runHookScript(SID, home);
    expect(code).toBe(0);
    // No arithmetic error in stderr.
    expect(stderr).not.toMatch(/invalid arithmetic|arithmetic operator/i);
    // With 900s cooldown and armedAt=now (not expired, no prior lastOfferAt),
    // the hook should emit the offer.
    expect(stdout.trim()).not.toBe("");
  }, E2E_TIMEOUT);

  it("title with double-quote and backslash: no-jq path emits valid JSON (escaping regression)", async () => {
    // Regression for: a topic title containing " or \ would break the no-jq
    // printf JSON injection, producing malformed JSON on every prompt for
    // affected users. We bypass the schema guard (which now forbids these chars)
    // by writing the cache directly, testing the hook's own escaping layer.
    const SID = "defect-title";
    const trickyTitle = 'The "tricky" \\topic';
    const nowIso = new Date().toISOString();
    // Ensure the arm dir exists (writeArmCache creates it, but here we write directly).
    await mkdir(path.join(home, "arm"), { recursive: true });
    const cacheFile = armCachePath(SID);
    await writeFile(cacheFile, JSON.stringify({
      sessionId: SID,
      armedKey: SUBAGENTS_KEY,
      armedTitle: trickyTitle,
      armedAt: nowIso,
      lastOfferAt: null,
      cooldownSeconds: 900,
      lastQuizAt: null,
      hasWorkSinceLastQuiz: false,
      // context contains the tricky title — it's what the hook relays
      context: `some context about ${trickyTitle}`,
    }), { encoding: "utf8", mode: 0o600 });

    // Run hook with jq absent from PATH so the no-jq printf path is exercised.
    // Strip known jq paths from PATH to force the grep/printf fallback.
    const origPath = process.env["PATH"] ?? "";
    const noJqPath = origPath
      .split(":")
      .filter((p) => !p.includes("jq") && !p.includes("homebrew") && !p.includes("mise"))
      .join(":");

    const { code, stdout, stderr } = await runHookScript(SID, home, { PATH: noJqPath });
    expect(code).toBe(0);

    if (stdout.trim() !== "") {
      // If the hook emitted (jq unavailable on this stripped PATH), the output
      // must be valid JSON — the key regression assertion.
      let parsed: { hookSpecificOutput?: { additionalContext?: string } } | undefined;
      expect(() => {
        parsed = JSON.parse(stdout) as typeof parsed;
      }, "hook output must be valid JSON even with special chars in title").not.toThrow();
      // The escaped title should appear in the context (backslash/quote handled).
      const ctx = parsed?.hookSpecificOutput?.additionalContext ?? "";
      expect(ctx.length).toBeGreaterThan(0);
    }
    // No JSON parse error in stderr either way.
    expect(stderr).not.toMatch(/JSON|parse error/i);
  }, E2E_TIMEOUT);

  it("content.ts TopicSchema rejects titles containing double-quote or backslash", () => {
    // The schema constraint guards content authors from accidentally creating
    // titles that would break the hook's no-jq JSON injection.
    const base = {
      id: "test",
      class: { kind: "general" },
      title: "Clean Title",
      summary: "Summary",
      triggerSignals: [],
      items: [],
    };
    expect(TopicSchema.safeParse({ ...base, title: 'Has "quotes"' }).success).toBe(false);
    expect(TopicSchema.safeParse({ ...base, title: "Has \\backslash" }).success).toBe(false);
    expect(TopicSchema.safeParse({ ...base, title: "Clean and fine" }).success).toBe(true);
  });
});
