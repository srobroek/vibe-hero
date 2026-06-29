/**
 * @file US-3 graduation + lapse integration test (T047).
 *
 * Drives the REAL `start_quiz` / `submit_answer` / `get_status` handlers against
 * a temp profile home and a temp fixture catalog (no mocks) to prove the US-3
 * acceptance scenarios end-to-end:
 *
 *  1. GRADUATION (FR-008 / SC-014): a sequence of CORRECT answers on
 *     progressively harder items pushes ability across a tier boundary+margin;
 *     once the crossing has held for `dwell` consecutive graded items, the
 *     learner graduates — `submit_answer` reports `graduation.changed=true` with
 *     the new tier (so the host can inform the user), and the profile's
 *     `graduations[key]` + a proactive `spaced` review entry are persisted
 *     (FR-010). A SINGLE qualifying item does NOT promote (dwell, SC-014).
 *
 *  2. NO FLIP-FLOP / demotion only below boundary−margin (SC-014 / FR-009):
 *     wrong answers that drop ability INTO the hysteresis band (below the
 *     boundary but above boundary−margin) do NOT demote; only a drop BELOW
 *     boundary−margin flags the topic for review.
 *
 *  3. INDEPENDENCE per tool/class (SC-010 / FR-007): graduating a topic under
 *     `claude-code` leaves the SAME concept under a different class
 *     (`general`) with completely independent graduation state.
 *
 * Each test uses its own `VIBE_HERO_HOME` under `os.tmpdir()` (store seam) and
 * its own fixture catalog dir injected via the tools' `catalogLoader` seam, so
 * the shared bundled snapshot and other suites are untouched.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md US-3 (FR-007/008/008a/009/010,
 * SC-005/SC-010/SC-014), research.md (OD-005 / OD-003), data-model.md
 * (TierGraduation / ReviewEntry).
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCatalogFromDir } from "../../src/catalog/loader.js";
import { makeStartQuizTool } from "../../src/tools/startQuiz.js";
import { makeSubmitAnswerTool } from "../../src/tools/submitAnswer.js";
import { makeGetStatusTool } from "../../src/tools/status.js";
import { loadProfile, updateProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import type {
  GetStatusResult,
  StartQuizResult,
  SubmitAnswerResult,
} from "../../src/schemas/tools.js";

/** Topic key under the claude-code tool (the one that graduates). */
const CC_KEY = abilityKey({ kind: "tool", tool: "claude-code" }, "subagents");
/** The SAME concept under the general class (independent state — SC-010). */
const GENERAL_KEY = abilityKey({ kind: "general" }, "subagents");

/** Hard item ids used to push ability over the tier-300 → 400 promotion bar (380). */
const HARD_1 = "cc-hard-1";
const HARD_2 = "cc-hard-2";
const HARD_3 = "cc-hard-3";
/** An easy item used to demonstrate wrong-answer drops within / below the band. */
const EASY_1 = "cc-easy-1";

/**
 * A claude-code `subagents` fixture: several hard (difficulty 400) items plus an
 * easy (difficulty 200) one. All multiple_choice with correct answer `a`. The
 * hard items let a learner seeded just below the 380 promotion bar cross it for
 * `dwell` consecutive correct answers; the easy item lets wrong answers drop
 * ability for the demotion scenarios.
 */
const ccItem = (id: string, difficulty: number, tier: number): string => `
  - id: ${id}
    tier: ${tier}
    bloom: analyze
    difficulty: ${difficulty}
    type: multiple_choice
    prompt: Question ${id}?
    choices:
      - id: a
        text: Correct.
      - id: b
        text: Wrong.
    answerKey:
      kind: choice
      correctChoiceId: a
    guidance: Option a is correct for ${id}.`;

const CC_YAML = `
id: subagents
class:
  kind: tool
  tool: claude-code
title: Subagents (Claude Code)
summary: Claude Code subagents topic for the US-3 graduation loop.
triggerSignals: []
items:${ccItem(HARD_1, 400, 400)}${ccItem(HARD_2, 400, 400)}${ccItem(HARD_3, 410, 400)}${ccItem("cc-hard-4", 390, 400)}${ccItem("cc-hard-5", 405, 400)}${ccItem(EASY_1, 200, 200)}
`;

/** A valid config clearing the setup gate (learning claude-code). */
const seedConfig = () => {
  const now = "2026-06-01T00:00:00.000Z";
  return {
    toolsLearning: ["claude-code" as const],
    offerCadence: "per_session" as const,
    proactiveOffers: true,
    quizLength: 4,
    createdAt: now,
    updatedAt: now,
  };
};

describe("US-3 graduation + lapse (T047)", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-us3-"));
    catalogDir = await mkdtemp(path.join(tmpdir(), "vibe-hero-us3-cat-"));
    const ccDir = path.join(catalogDir, "claude-code");
    await mkdir(ccDir, { recursive: true });
    await writeFile(path.join(ccDir, "subagents.yaml"), CC_YAML, "utf8");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  const fixtureLoader = () => loadCatalogFromDir(catalogDir);

  const tools = () => ({
    startQuiz: makeStartQuizTool(home, fixtureLoader).handler,
    submitAnswer: makeSubmitAnswerTool(home, fixtureLoader).handler,
    getStatus: makeGetStatusTool(home, fixtureLoader).handler,
  });

  /**
   * Seed config + a settled claude-code ability just BELOW the tier-300 → 400
   * promotion bar (boundary 350 + margin 30 = 380), graduated at tier 300, so a
   * couple of correct HARD answers cross the bar for `dwell` consecutive items.
   *
   * @param ccAbility - starting claude-code ability (default 370, just under 380).
   * @param ccDwell - starting dwell streak (default 0).
   */
  const seedCc = async (ccAbility = 370, ccDwell = 0): Promise<void> => {
    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(),
        abilities: {
          ...current.abilities,
          [CC_KEY]: {
            value: ccAbility,
            itemsSeen: 20, // settled (K=24) for predictable step sizes
            lastAssessedAt: "2026-06-01T00:00:00.000Z",
            lastItemIds: [],
            dwell: ccDwell,
          },
        },
        graduations: {
          ...current.graduations,
          [CC_KEY]: {
            currentTier: 300 as const,
            status: "current" as const,
            graduatedAt: "2026-05-01T00:00:00.000Z",
            lastChangeReason: "graduated" as const,
          },
        },
      }),
      home,
    );
  };

  /** Begin a quiz on a key and return its id. */
  const beginQuiz = async (key: string): Promise<string> => {
    const { startQuiz } = tools();
    const result = (await startQuiz({ key })) as StartQuizResult;
    return result.quizId;
  };

  /** Submit one MC answer and return the typed result. */
  const answer = async (
    quizId: string,
    itemId: string,
    choiceId: "a" | "b",
  ): Promise<SubmitAnswerResult> => {
    const { submitAnswer } = tools();
    return (await submitAnswer({
      quizId,
      itemId,
      answer: { choiceId },
    })) as SubmitAnswerResult;
  };

  it("a single qualifying correct item does NOT promote (dwell, SC-014)", async () => {
    await seedCc(370);
    const quizId = await beginQuiz(CC_KEY);

    // One correct HARD answer pushes ability over the 380 bar, but dwell=1 < 2.
    const first = await answer(quizId, HARD_1, "a");
    expect(first.ability.after).toBeGreaterThan(380); // crossed the bar...
    expect(first.graduation).toEqual({ changed: false }); // ...but not yet graduated

    // The profile still shows tier 300 and a dwell streak of 1.
    const profile = await loadProfile(home);
    expect(profile.graduations[CC_KEY]?.currentTier).toBe(300);
    expect(profile.abilities[CC_KEY]?.dwell).toBe(1);
  });

  it("graduates to the next tier after dwell consecutive crossing items and informs the user (FR-008 / SC-005)", async () => {
    await seedCc(370);
    const quizId = await beginQuiz(CC_KEY);

    const first = await answer(quizId, HARD_1, "a");
    expect(first.graduation).toEqual({ changed: false });

    // Second consecutive correct HARD item: crossing held for dwell=2 → graduate.
    const second = await answer(quizId, HARD_2, "a");
    expect(second.ability.after).toBeGreaterThan(380);
    expect(second.graduation?.changed).toBe(true);
    expect(second.graduation?.tier).toBe(400);
    expect(second.graduation?.status).toBe("current");
    expect(second.graduation?.reason).toBe("graduated");

    // Persisted: tier 400, dwell reset, and a proactive SPACED review enqueued.
    const profile = await loadProfile(home);
    expect(profile.graduations[CC_KEY]?.currentTier).toBe(400);
    expect(profile.graduations[CC_KEY]?.status).toBe("current");
    expect(profile.graduations[CC_KEY]?.lastChangeReason).toBe("graduated");
    expect(profile.abilities[CC_KEY]?.dwell).toBe(0);

    const spaced = profile.reviewSchedule.filter(
      (e) => e.key === CC_KEY && e.reason === "spaced",
    );
    expect(spaced).toHaveLength(1);
    expect(Date.parse(spaced[0]!.dueAt)).toBeGreaterThan(Date.now()); // due later (FR-010)
  });

  it("does NOT demote when wrong answers drop ability only INTO the band (no flip-flop, SC-014)", async () => {
    // Seed ability at 240: above the tier-300 demotion floor (250 − 30 = 220),
    // inside the hysteresis band. One wrong EASY answer nudges ability down but
    // stays above 220 → no demotion, tier holds at 300.
    await seedCc(240);
    const quizId = await beginQuiz(CC_KEY);

    const wrong = await answer(quizId, EASY_1, "b");
    expect(wrong.grade).toBe("incorrect");
    expect(wrong.ability.after).toBeLessThan(wrong.ability.before);
    expect(wrong.ability.after).toBeGreaterThan(220); // still inside the band
    expect(wrong.graduation).toEqual({ changed: false }); // tier unchanged

    const profile = await loadProfile(home);
    expect(profile.graduations[CC_KEY]?.currentTier).toBe(300);
    expect(profile.graduations[CC_KEY]?.status).toBe("current");
  });

  it("demotes/flags for review only once ability falls BELOW boundary−margin (FR-009)", async () => {
    // Seed just above the 220 demotion floor. A wrong EASY answer (difficulty
    // 200, high expected score ⇒ big drop) pushes ability below 220 → demote.
    await seedCc(222);
    const quizId = await beginQuiz(CC_KEY);

    const wrong = await answer(quizId, EASY_1, "b");
    expect(wrong.ability.after).toBeLessThan(220); // crossed below the floor
    expect(wrong.graduation?.changed).toBe(true);
    expect(wrong.graduation?.reason).toBe("demoted");
    expect(wrong.graduation?.status).toBe("due_for_review");
    expect(wrong.graduation?.tier).toBe(200); // stepped down one tier

    const profile = await loadProfile(home);
    expect(profile.graduations[CC_KEY]?.currentTier).toBe(200);
    expect(profile.graduations[CC_KEY]?.status).toBe("due_for_review");
    expect(profile.graduations[CC_KEY]?.lastChangeReason).toBe("demoted");
  });

  it("graduation state is INDEPENDENT per tool/class (SC-010 / FR-007)", async () => {
    // Seed BOTH the claude-code key (about to graduate) AND the same concept
    // under the general class with its own untouched state.
    await seedCc(370);
    await updateProfile(
      (current) => ({
        ...current,
        abilities: {
          ...current.abilities,
          [GENERAL_KEY]: {
            value: 305,
            itemsSeen: 3,
            lastAssessedAt: "2026-06-01T00:00:00.000Z",
            lastItemIds: [],
            dwell: 0,
          },
        },
        graduations: {
          ...current.graduations,
          [GENERAL_KEY]: {
            currentTier: 100 as const,
            status: "current" as const,
            graduatedAt: "2026-05-15T00:00:00.000Z",
            lastChangeReason: "graduated" as const,
          },
        },
      }),
      home,
    );

    // Graduate the claude-code key to tier 400.
    const quizId = await beginQuiz(CC_KEY);
    await answer(quizId, HARD_1, "a");
    const second = await answer(quizId, HARD_2, "a");
    expect(second.graduation?.changed).toBe(true);
    expect(second.graduation?.tier).toBe(400);

    const profile = await loadProfile(home);
    // claude-code advanced...
    expect(profile.graduations[CC_KEY]?.currentTier).toBe(400);
    // ...while the SAME concept under `general` is completely unchanged.
    expect(profile.graduations[GENERAL_KEY]?.currentTier).toBe(100);
    expect(profile.graduations[GENERAL_KEY]?.status).toBe("current");
    expect(profile.graduations[GENERAL_KEY]?.lastChangeReason).toBe("graduated");
    expect(profile.abilities[GENERAL_KEY]?.value).toBe(305);
    expect(profile.abilities[GENERAL_KEY]?.itemsSeen).toBe(3);
    expect(profile.abilities[GENERAL_KEY]?.dwell).toBe(0);
    // And no spaced review was enqueued for the untouched general key.
    expect(
      profile.reviewSchedule.some((e) => e.key === GENERAL_KEY),
    ).toBe(false);
  });

  it("get_status surfaces a stale graduated topic as due_for_review + enqueues a lapsed entry (FR-009)", async () => {
    // `get_status` reads the real wall clock internally, so seed
    // `lastAssessedAt` 50 days BEFORE real now: that is past the 30-day
    // staleness window AND, with ability 230 decaying toward center 300,
    // effective ≈ 300 − 70·exp(−50/60) ≈ 269.6 (< the 280 review band) — robustly
    // due regardless of the exact date the test runs on.
    const fiftyDaysAgo = new Date(
      Date.now() - 50 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(),
        abilities: {
          ...current.abilities,
          [CC_KEY]: {
            value: 230, // below the 280 band, above the 220 demote floor
            itemsSeen: 20,
            lastAssessedAt: fiftyDaysAgo,
            lastItemIds: [],
            dwell: 0,
          },
        },
        graduations: {
          ...current.graduations,
          [CC_KEY]: {
            currentTier: 300 as const,
            status: "current" as const,
            graduatedAt: "2026-01-01T00:00:00.000Z",
            lastChangeReason: "graduated" as const,
          },
        },
      }),
      home,
    );

    const { getStatus } = tools();
    const status = (await getStatus({ tool: "claude-code" })) as GetStatusResult;

    // The stale, decayed topic is surfaced for review.
    const row = status.topics.find((t) => t.key === CC_KEY);
    expect(row?.status).toBe("due_for_review");
    expect(status.dueForReview).toContain(CC_KEY);

    // ...and the lapse is persisted: graduation flagged + a `lapsed` entry queued.
    const profile = await loadProfile(home);
    expect(profile.graduations[CC_KEY]?.status).toBe("due_for_review");
    expect(profile.graduations[CC_KEY]?.lastChangeReason).toBe("review_due");
    const lapsed = profile.reviewSchedule.filter(
      (e) => e.key === CC_KEY && e.reason === "lapsed",
    );
    expect(lapsed).toHaveLength(1);
  });

  it("re-reading status does NOT duplicate the lapsed review entry (idempotent)", async () => {
    const fiftyDaysAgo = new Date(
      Date.now() - 50 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(),
        abilities: {
          ...current.abilities,
          [CC_KEY]: {
            value: 230,
            itemsSeen: 20,
            lastAssessedAt: fiftyDaysAgo,
            lastItemIds: [],
            dwell: 0,
          },
        },
        graduations: {
          ...current.graduations,
          [CC_KEY]: {
            currentTier: 300 as const,
            status: "current" as const,
            graduatedAt: "2026-01-01T00:00:00.000Z",
            lastChangeReason: "graduated" as const,
          },
        },
      }),
      home,
    );

    const { getStatus } = tools();
    await getStatus({ tool: "claude-code" });
    await getStatus({ tool: "claude-code" }); // second read: must not re-enqueue

    const profile = await loadProfile(home);
    const lapsed = profile.reviewSchedule.filter(
      (e) => e.key === CC_KEY && e.reason === "lapsed",
    );
    expect(lapsed).toHaveLength(1);
  });
});
