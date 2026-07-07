/**
 * @file US-4 free-form judging-handshake integration test (T048/T049/T051).
 *
 * Proves the free-form host-agent handshake end-to-end against a real temp
 * profile home and a real temp CATALOG dir (no mocks), driving the actual
 * `start_quiz` / `submit_answer` handlers:
 *
 *   - start_quiz presents the free_form item WITH `rubric.criteria` (ids + text)
 *     AND `referenceAnswer` so the host agent can judge (FR-012), while the
 *     deterministic items in the SAME quiz still hide their answer keys
 *     (no answerKey / correctChoiceId / rubric leaked).
 *   - submit_answer with a per-criterion verdict has the MCP compute the score:
 *     2 of 3 criteria met ⇒ score 2/3 ≈ 0.67 ≥ 0.6 ⇒ grade "correct" and ability
 *     RISES; 1 of 3 met ⇒ ≈ 0.33 < 0.6 ⇒ "incorrect" and ability FALLS
 *     (FR-013 — score from fraction met vs `freeFormPassThreshold` 0.6). The
 *     graded item is recorded `gradedBy: "host_agent"`.
 *   - a BARE BOOLEAN verdict (or one missing criteria) is REJECTED — a lazy
 *     single self-pass is non-conformant (anti-gaming, critique E2 / FR-013).
 *   - graceful degradation (FR-014, T049): start_quiz with `allowFreeForm: false`
 *     returns ONLY deterministic items (the quiz still has items), proving a quiz
 *     never gets stuck with an unjudgeable item.
 *   - the persisted AnsweredItem carries ONLY derived fields — no raw answer
 *     text / verdict justification reaches disk (FR-018).
 *
 * The 3 bundled claude-code content files are deterministic-only, so this test
 * seeds its own catalog dir (a topic with a free_form item carrying a 3-criterion
 * rubric + referenceAnswer, alongside deterministic items) and injects it via the
 * tools' `catalogLoader` seam — leaving the shared bundled snapshot untouched.
 * Each test uses its own `VIBE_HERO_HOME` under `os.tmpdir()`.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`start_quiz` free-form PresentedItem / `submit_answer` free-form path),
 * spec.md FR-012 / FR-013 / FR-014, research.md (OD-002 — free-form IN v1,
 * `freeFormPassThreshold` 0.6), data-model.md (AnsweredItem `gradedBy`).
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCatalogFromDir } from "../../src/catalog/loader.js";
import { makeStartQuizTool } from "../../src/tools/startQuiz.js";
import { makeSubmitAnswerTool } from "../../src/tools/submitAnswer.js";
import { profilePath, updateProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import type {
  StartQuizResult,
  SubmitAnswerResult,
} from "../../src/schemas/tools.js";

/** The fixture topic key (general class). */
const TOPIC_KEY = abilityKey({ kind: "general" }, "freeform-fixture");

/** Item ids used by direct assertions. */
const FF_ITEM = "ff-1";
const MC_ITEM = "ff-mc-1";

/** The three rubric criterion ids the host agent must judge per-criterion. */
const CRIT = ["c1", "c2", "c3"] as const;

/** A distinctive reference answer string asserted to be presented to the host. */
const REFERENCE = "REFERENCE-ANSWER-PROBE: do not parallelize when steps depend on each other.";

/**
 * A fixture topic YAML with ONE free_form item (3-criterion rubric +
 * referenceAnswer, difficulty 380) plus FOUR deterministic items, all within the
 * selection window for the seeded learner (ability ≈ 360, tier 300 ⇒ target 380,
 * ±60 window [320,440]). With a length-5 request and exactly 5 in-window items,
 * selection returns all five — so the free_form item is guaranteed present and
 * its presented shape can be asserted directly.
 */
const FIXTURE_YAML = `
id: freeform-fixture
class:
  kind: general
title: Free-form Fixture
summary: A topic exercising the free-form judging handshake.
triggerSignals: []
items:
  - id: ${FF_ITEM}
    tier: 400
    bloom: evaluate
    difficulty: 380
    type: free_form
    prompt: Explain when you would NOT parallelize subagents.
    rubric:
      referenceAnswer: "${REFERENCE}"
      passThreshold: 0.6
      criteria:
        - id: c1
          text: Identifies data dependencies between steps.
        - id: c2
          text: Mentions shared mutable state / race conditions.
        - id: c3
          text: Notes coordination/merge overhead outweighing gains.
    guidance: Parallelize only independent work; serialize dependent steps.
  - id: ${MC_ITEM}
    tier: 300
    bloom: understand
    difficulty: 360
    type: multiple_choice
    prompt: Which is the correct option?
    choices:
      - id: a
        text: The right one.
      - id: b
        text: A wrong one.
    answerKey:
      kind: choice
      correctChoiceId: a
    guidance: Pick option a.
  - id: ff-sa-1
    tier: 300
    bloom: understand
    difficulty: 340
    type: short_answer
    prompt: "Type the word: skill"
    answerKey:
      kind: keyword
      anyOf:
        - skill
      normalize: both
    guidance: A skill is portable guidance.
  - id: ff-mc-2
    tier: 300
    bloom: apply
    difficulty: 400
    type: multiple_choice
    prompt: Choose the correct answer.
    choices:
      - id: a
        text: Correct.
      - id: b
        text: Incorrect.
    answerKey:
      kind: choice
      correctChoiceId: a
    guidance: Option a is correct.
  - id: ff-sa-2
    tier: 300
    bloom: remember
    difficulty: 420
    type: short_answer
    prompt: "Type the word: elo"
    answerKey:
      kind: keyword
      anyOf:
        - elo
      normalize: both
    guidance: Elo is the ability-estimation model.
`;

/** A valid config that clears the setup gate. */
const seedConfig = () => {
  const now = "2026-06-01T00:00:00.000Z";
  return {
    toolsLearning: ["claude-code" as const],
    offerCadence: "per_session" as const,
    proactiveOffers: true,
    quizLength: 5,
    createdAt: now,
    updatedAt: now,
  };
};

describe("US-4 free-form judging handshake (T048/T049/T051)", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-us4-"));
    catalogDir = await mkdtemp(path.join(tmpdir(), "vibe-hero-cat-"));
    const generalDir = path.join(catalogDir, "general");
    await mkdir(generalDir, { recursive: true });
    await writeFile(
      path.join(generalDir, "freeform-fixture.yaml"),
      FIXTURE_YAML,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  /** A catalog loader bound to this test's fixture dir. */
  const fixtureLoader = () => loadCatalogFromDir(catalogDir);

  /** start_quiz / submit_answer handlers wired to the temp home + fixture catalog. */
  const tools = () => ({
    startQuiz: makeStartQuizTool(home, fixtureLoader).handler,
    submitAnswer: makeSubmitAnswerTool(home, fixtureLoader).handler,
  });

  /**
   * Seed config + a settled ability (≈ 360) and a tier-300 graduation so the
   * selection target clamps to the tier-300 promotion bar (boundary 350 + margin
   * 30 = 380); the ±60 window then catches the 340–420 fixture items (all five).
   */
  const seedProfile = async (abilityValue = 360): Promise<void> => {
    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(),
        abilities: {
          [TOPIC_KEY]: {
            value: abilityValue,
            itemsSeen: 4,
            lastAssessedAt: "2026-05-01T00:00:00.000Z",
            lastItemIds: [],
          },
        },
        graduations: {
          [TOPIC_KEY]: {
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

  /** Begin a quiz (free-form allowed by default) and return its id. */
  const beginQuiz = async (): Promise<string> => {
    const { startQuiz } = tools();
    const result = (await startQuiz({ key: TOPIC_KEY, length: 5 })) as StartQuizResult;
    return result.quizId;
  };

  /** Build a per-criterion verdict marking the first `metCount` criteria met. */
  const verdict = (metCount: number) => ({
    criteria: CRIT.map((id, i) => ({
      id,
      met: i < metCount,
      justification:
        i < metCount
          ? `Criterion ${id} is satisfied by the answer.`
          : `Criterion ${id} is not addressed.`,
    })),
  });

  it("start_quiz presents the free_form item WITH rubric.criteria + referenceAnswer; deterministic items still hide answers (FR-012)", async () => {
    await seedProfile();
    const { startQuiz } = tools();

    const result = (await startQuiz({ key: TOPIC_KEY, length: 5 })) as StartQuizResult;

    // All five in-window items selected ⇒ the free_form item is present.
    const ff = result.items.find((i) => i.itemId === FF_ITEM);
    expect(ff).toBeDefined();
    expect(ff?.type).toBe("free_form");

    // The host agent gets the rubric criteria (ids + text) AND the reference
    // answer so it can judge (FR-012).
    expect(ff?.referenceAnswer).toBe(REFERENCE);

    // Presentation directive: free_form is "open" (typed prose input, never a
    // menu); multiple_choice is "menu". Guards against hosts rendering
    // free-form items as fabricated option lists that leak the answer.
    expect(ff?.presentation).toBe("open");
    for (const item of result.items) {
      if (item.type === "multiple_choice") {
        expect(item.presentation).toBe("menu");
      } else {
        expect(item.presentation).toBe("open");
      }
    }
    expect(ff?.rubric?.criteria.map((c) => c.id).sort()).toEqual([...CRIT].sort());
    for (const c of ff?.rubric?.criteria ?? []) {
      expect(typeof c.text).toBe("string");
      expect(c.text.length).toBeGreaterThan(0);
    }

    // Deterministic items in the SAME quiz still hide their keys: no answerKey /
    // correctChoiceId, and (critically) no rubric / referenceAnswer leaks on them.
    for (const item of result.items) {
      const asRecord = item as unknown as Record<string, unknown>;
      expect(asRecord["answerKey"]).toBeUndefined();
      if (item.type !== "free_form") {
        expect(asRecord["rubric"]).toBeUndefined();
        expect(asRecord["referenceAnswer"]).toBeUndefined();
      }
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("answerKey");
    expect(serialized).not.toContain("correctChoiceId");
  });

  it("submit_answer with 2/3 criteria met ⇒ score ≈ 0.67 ≥ 0.6 ⇒ correct; ability rises; gradedBy host_agent (FR-013)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    const result = (await submitAnswer({
      quizId,
      itemId: FF_ITEM,
      verdict: verdict(2),
    })) as SubmitAnswerResult;

    // MCP computes the score from the fraction met (2 of 3).
    expect(result.score).toBeCloseTo(2 / 3, 6);
    expect(result.grade).toBe("correct");
    // The free-form item (difficulty 380, above θ 360) ⇒ a pass raises ability.
    expect(result.ability.after).toBeGreaterThan(result.ability.before);
    // No single key to reveal for free-form.
    expect(result.correctAnswer).toBeUndefined();

    // Persisted as a host-agent grade.
    const onDisk = JSON.parse(await readFile(profilePath(home), "utf8")) as {
      quizHistory: Array<{ id: string; items: Array<Record<string, unknown>> }>;
    };
    const record = onDisk.quizHistory.find((q) => q.id === quizId);
    const answered = record?.items.find((a) => a["itemId"] === FF_ITEM);
    expect(answered?.["gradedBy"]).toBe("host_agent");
  });

  it("submit_answer with 1/3 criteria met ⇒ score ≈ 0.33 < 0.6 ⇒ incorrect; ability falls (FR-013)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    const result = (await submitAnswer({
      quizId,
      itemId: FF_ITEM,
      verdict: verdict(1),
    })) as SubmitAnswerResult;

    expect(result.score).toBeCloseTo(1 / 3, 6);
    expect(result.grade).toBe("incorrect");
    // A fail on the free-form item lowers ability.
    expect(result.ability.after).toBeLessThan(result.ability.before);
  });

  it("a BARE BOOLEAN verdict is REJECTED (anti-gaming, critique E2)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    // A single self-pass boolean is non-conformant: it is neither a deterministic
    // `answer` nor a per-criterion `verdict`, so the input union rejects it.
    await expect(
      submitAnswer({
        quizId,
        itemId: FF_ITEM,
        verdict: true,
      } as unknown as Parameters<typeof submitAnswer>[0]),
    ).rejects.toThrow();

    // An empty criteria array is likewise rejected.
    await expect(
      submitAnswer({
        quizId,
        itemId: FF_ITEM,
        verdict: { criteria: [] },
      } as unknown as Parameters<typeof submitAnswer>[0]),
    ).rejects.toThrow();
  });

  it("a partial verdict (missing a rubric criterion) is REJECTED (FR-013)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    // Only judges c1 + c2, silently skipping c3 to inflate the fraction.
    await expect(
      submitAnswer({
        quizId,
        itemId: FF_ITEM,
        verdict: {
          criteria: [
            { id: "c1", met: true, justification: "ok" },
            { id: "c2", met: true, justification: "ok" },
          ],
        },
      }),
    ).rejects.toThrow(/cover every rubric criterion/);
  });

  it("rejects a deterministic answer on a free_form item and a verdict on a deterministic item (cross-guards)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    // Deterministic answer on the free_form item ⇒ rejected.
    await expect(
      submitAnswer({ quizId, itemId: FF_ITEM, answer: { text: "an essay" } }),
    ).rejects.toThrow(/free_form/);

    // Free-form verdict on the multiple_choice item ⇒ rejected.
    await expect(
      submitAnswer({
        quizId,
        itemId: MC_ITEM,
        verdict: verdict(3),
      }),
    ).rejects.toThrow(/not free_form/);
  });

  it("degradation (FR-014): start_quiz with allowFreeForm:false returns ONLY deterministic items, and the quiz still has items", async () => {
    await seedProfile();
    const { startQuiz } = tools();

    const result = (await startQuiz({
      key: TOPIC_KEY,
      length: 5,
      allowFreeForm: false,
    })) as StartQuizResult;

    // The quiz still completes with items (never stuck on an unjudgeable one).
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    // No free_form item is served when judging is unavailable.
    expect(result.items.some((i) => i.type === "free_form")).toBe(false);
    expect(result.items.find((i) => i.itemId === FF_ITEM)).toBeUndefined();
  });

  it("persisted AnsweredItem for a free-form grade has no raw answer text / justification (FR-018)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    const probe = "ZZZ-JUSTIFICATION-PROBE-9000";
    await submitAnswer({
      quizId,
      itemId: FF_ITEM,
      verdict: {
        criteria: CRIT.map((id) => ({
          id,
          met: true,
          justification: probe,
        })),
      },
    });

    const onDisk = await readFile(profilePath(home), "utf8");
    // Neither the verdict justifications nor any raw text reach disk.
    expect(onDisk).not.toContain(probe);

    const profile = JSON.parse(onDisk) as {
      quizHistory: Array<{ id: string; items: Array<Record<string, unknown>> }>;
    };
    const record = profile.quizHistory.find((q) => q.id === quizId);
    const answered = record?.items.find((a) => a["itemId"] === FF_ITEM);
    expect(answered).toBeDefined();
    // Exactly the derived field set — no verdict / justification / answer keys.
    expect(Object.keys(answered ?? {}).sort()).toEqual(
      ["answeredAt", "difficulty", "grade", "gradedBy", "itemId", "score", "tier"].sort(),
    );
    expect(answered?.["verdict"]).toBeUndefined();
    expect(answered?.["criteria"]).toBeUndefined();
  });
});
