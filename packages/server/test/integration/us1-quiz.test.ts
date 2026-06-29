/**
 * @file US-1 deterministic quiz-loop integration test (T031/T032 + SC-004).
 *
 * Proves the core US-1 loop end-to-end against a real temp profile home and a
 * real temp CATALOG dir (no mocks), driving the actual `start_quiz` /
 * `submit_answer` handlers:
 *
 *   - start_quiz selects a bounded 3–5 items (FR-008a) and presents them with
 *     NO answer key / correct answer leaked (deterministic items omit the key;
 *     MC choices carry no "correct" flag) — the engine grades server-side.
 *   - submit_answer grades multiple_choice AND short_answer correctly (FR-011),
 *     applying the answer key's `normalize` directive.
 *   - ability RISES on a correct answer and FALLS on a wrong one (Elo update
 *     against the item's FIXED difficulty).
 *   - identical deterministic answer ⇒ identical grade + score (SC-004).
 *   - the persisted AnsweredItem records ONLY derived fields — the raw answer
 *     text / chosen id never reaches disk (FR-018 / SC-008).
 *
 * The bundled v1 catalog ships too few items for a 3–5 selection, so this test
 * seeds its own catalog dir (a topic with ≥5 deterministic items of varied
 * difficulty) and injects it via the tools' `catalogLoader` seam — leaving the
 * shared bundled snapshot (and the other suites) untouched. Each test uses its
 * own `VIBE_HERO_HOME` under `os.tmpdir()` via the store's `dirOverride` seam.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`start_quiz` / `submit_answer` deterministic path), spec.md FR-008a / FR-011 /
 * FR-018 / SC-004, data-model.md (QuizRecord / AnsweredItem).
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
const TOPIC_KEY = abilityKey({ kind: "general" }, "quiz-fixture");

/** Item ids used by direct submit_answer assertions. */
const MC_ITEM = "qf-mc-1";
const SA_ITEM = "qf-sa-1";

/**
 * A fixture topic YAML with 6 deterministic items of varied difficulty
 * (300–400) across tiers 100–300 — a mix of multiple_choice + short_answer.
 * With the seeded learner (ability ≈ 360, graduated tier 300) the selection
 * target clamps to the tier-300 promotion bar (boundary 350 + margin 30 = 380),
 * so five items (320–400) fall inside the ±60 window — enough for a 3–5
 * selection (FR-008a).
 */
const FIXTURE_YAML = `
id: quiz-fixture
class:
  kind: general
title: Quiz Fixture
summary: A deterministic topic for the start_quiz / submit_answer loop.
triggerSignals: []
items:
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
      - id: c
        text: Another wrong one.
    answerKey:
      kind: choice
      correctChoiceId: a
    guidance: Pick option a — it is the correct one.
  - id: ${SA_ITEM}
    tier: 300
    bloom: understand
    difficulty: 340
    type: short_answer
    prompt: "Type the word: skill"
    answerKey:
      kind: keyword
      anyOf:
        - skill
        - skills
      normalize: both
    guidance: A skill is portable, loadable guidance.
  - id: qf-mc-2
    tier: 200
    bloom: remember
    difficulty: 320
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
  - id: qf-sa-2
    tier: 300
    bloom: understand
    difficulty: 380
    type: short_answer
    prompt: "Type the word: elo"
    answerKey:
      kind: keyword
      anyOf:
        - elo
      normalize: both
    guidance: Elo is the ability-estimation model.
  - id: qf-mc-3
    tier: 300
    bloom: apply
    difficulty: 400
    type: multiple_choice
    prompt: Which is right?
    choices:
      - id: a
        text: This one.
      - id: b
        text: Not this one.
    answerKey:
      kind: choice
      correctChoiceId: a
    guidance: Option a.
  - id: qf-sa-3
    tier: 100
    bloom: remember
    difficulty: 300
    type: short_answer
    prompt: "Type the word: hysteresis"
    answerKey:
      kind: keyword
      anyOf:
        - hysteresis
      normalize: both
    guidance: Hysteresis prevents graduation flip-flop.
`;

/** A valid config that clears the setup gate. */
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

describe("US-1 deterministic quiz loop (T031/T032 / SC-004)", () => {
  let home: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-us1-"));
    catalogDir = await mkdtemp(path.join(tmpdir(), "vibe-hero-cat-"));
    const generalDir = path.join(catalogDir, "general");
    await mkdir(generalDir, { recursive: true });
    await writeFile(path.join(generalDir, "quiz-fixture.yaml"), FIXTURE_YAML, "utf8");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  /** A catalog loader bound to this test's fixture dir. */
  const fixtureLoader = () => loadCatalogFromDir(catalogDir);

  /** start_quiz / submit_answer tool handlers wired to the temp home + catalog. */
  const tools = () => ({
    startQuiz: makeStartQuizTool(home, fixtureLoader).handler,
    submitAnswer: makeSubmitAnswerTool(home, fixtureLoader).handler,
  });

  /**
   * Seed config + a settled ability centered on the fixture's difficulties, plus
   * a tier-300 graduation so the selection target clamps to the tier-300
   * promotion bar (boundary 350 + margin 30 = 380) and the ±60 window catches
   * the 320–400 items (≥5 eligible → a 3–5 selection).
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

  /** Begin a quiz and return its id. */
  const beginQuiz = async (): Promise<string> => {
    const { startQuiz } = tools();
    const result = (await startQuiz({ key: TOPIC_KEY })) as StartQuizResult;
    return result.quizId;
  };

  it("start_quiz returns 3-5 items with NO answer key / correct answer leaked", async () => {
    await seedProfile();
    const { startQuiz } = tools();

    const result = (await startQuiz({ key: TOPIC_KEY })) as StartQuizResult;

    expect(typeof result.quizId).toBe("string");
    expect(result.quizId.length).toBeGreaterThan(0);

    // Bounded selection (FR-008a): 3–5 items.
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.items.length).toBeLessThanOrEqual(5);

    // No answer key / correct answer leaks. Deterministic items carry no
    // `answerKey`, no `rubric`, no `referenceAnswer`; MC choices carry no
    // "correct" marker. Inspect the FULL serialized payload for safety.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("answerKey");
    expect(serialized).not.toContain("correctChoiceId");
    expect(serialized).not.toContain("referenceAnswer");

    for (const item of result.items) {
      const asRecord = item as unknown as Record<string, unknown>;
      expect(asRecord["answerKey"]).toBeUndefined();
      expect(asRecord["referenceAnswer"]).toBeUndefined();
      expect(asRecord["rubric"]).toBeUndefined();
      // MC items keep choices but no choice is flagged correct.
      if (item.type === "multiple_choice") {
        expect(item.choices).toBeDefined();
        for (const choice of item.choices ?? []) {
          expect(Object.keys(choice).sort()).toEqual(["id", "text"]);
        }
      }
    }
  });

  it("submit_answer grades a correct multiple_choice answer (FR-011) and raises ability", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    const result = (await submitAnswer({
      quizId,
      itemId: MC_ITEM,
      answer: { choiceId: "a" },
    })) as SubmitAnswerResult;

    expect(result.grade).toBe("correct");
    expect(result.score).toBe(1);
    expect(result.correctAnswer).toBe("a");
    expect(result.guidance.length).toBeGreaterThan(0);
    // Correct answer ⇒ ability rises.
    expect(result.ability.after).toBeGreaterThan(result.ability.before);
    // T046 now wires graduation: a single in-band correct answer doesn't change
    // the tier (ability ≈ 360 sits inside the tier-300 band), so the engine
    // reports no change rather than an absent field.
    expect(result.graduation).toEqual({ changed: false });
  });

  it("submit_answer grades a wrong multiple_choice answer and lowers ability", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    const result = (await submitAnswer({
      quizId,
      itemId: MC_ITEM,
      answer: { choiceId: "b" },
    })) as SubmitAnswerResult;

    expect(result.grade).toBe("incorrect");
    expect(result.score).toBe(0);
    // Still surfaces the correct answer for teaching.
    expect(result.correctAnswer).toBe("a");
    // Wrong answer ⇒ ability falls.
    expect(result.ability.after).toBeLessThan(result.ability.before);
  });

  it("submit_answer grades short_answer with normalization (FR-011)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    // `normalize: both` ⇒ trim + lowercase; "  SKILLS  " matches "skills".
    const correct = (await submitAnswer({
      quizId,
      itemId: SA_ITEM,
      answer: { text: "  SKILLS  " },
    })) as SubmitAnswerResult;
    expect(correct.grade).toBe("correct");
    expect(correct.score).toBe(1);
    // short_answer has no correctAnswer field surfaced.
    expect(correct.correctAnswer).toBeUndefined();

    // A non-matching answer scores 0.
    const wrong = (await submitAnswer({
      quizId,
      itemId: SA_ITEM,
      answer: { text: "not the answer" },
    })) as SubmitAnswerResult;
    expect(wrong.grade).toBe("incorrect");
    expect(wrong.score).toBe(0);
  });

  it("identical answer ⇒ identical grade + score (SC-004 reproducibility)", async () => {
    await seedProfile();
    const { submitAnswer } = tools();

    // Two independent quizzes, same answer to the same item, same grade/score.
    const quizA = await beginQuiz();
    const first = (await submitAnswer({
      quizId: quizA,
      itemId: MC_ITEM,
      answer: { choiceId: "a" },
    })) as SubmitAnswerResult;

    const quizB = await beginQuiz();
    const second = (await submitAnswer({
      quizId: quizB,
      itemId: MC_ITEM,
      answer: { choiceId: "a" },
    })) as SubmitAnswerResult;

    expect(second.grade).toBe(first.grade);
    expect(second.score).toBe(first.score);
    expect(first.grade).toBe("correct");
  });

  it("persisted AnsweredItem contains ONLY derived fields — no raw answer text (FR-018 / SC-008)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    // Answer a short_answer with a distinctive raw string that must NOT persist.
    const secretText = "ZZZ-RAW-ANSWER-PROBE-9000";
    await submitAnswer({
      quizId,
      itemId: SA_ITEM,
      answer: { text: secretText },
    });
    // And an MC with a distinctive (wrong) choice id.
    await submitAnswer({
      quizId,
      itemId: MC_ITEM,
      answer: { choiceId: "b" },
    });

    const onDisk = await readFile(profilePath(home), "utf8");

    // The raw answer text never reaches disk.
    expect(onDisk).not.toContain(secretText);

    // The persisted AnsweredItems carry exactly the derived field set.
    const profile = JSON.parse(onDisk) as {
      quizHistory: Array<{
        id: string;
        items: Array<Record<string, unknown>>;
      }>;
    };
    const record = profile.quizHistory.find((q) => q.id === quizId);
    expect(record).toBeDefined();
    expect(record?.items).toHaveLength(2);
    for (const answered of record?.items ?? []) {
      expect(Object.keys(answered).sort()).toEqual(
        [
          "answeredAt",
          "difficulty",
          "grade",
          "gradedBy",
          "itemId",
          "score",
          "tier",
        ].sort(),
      );
      expect(answered["gradedBy"]).toBe("engine");
      // No raw-answer keys leak into the persisted shape.
      expect(answered["answer"]).toBeUndefined();
      expect(answered["text"]).toBeUndefined();
      expect(answered["choiceId"]).toBeUndefined();
    }
  });

  it("a wrong answer after a correct one moves ability the opposite way (Elo against fixed difficulty)", async () => {
    await seedProfile();
    const quizId = await beginQuiz();
    const { submitAnswer } = tools();

    const correct = (await submitAnswer({
      quizId,
      itemId: MC_ITEM,
      answer: { choiceId: "a" },
    })) as SubmitAnswerResult;
    const wrong = (await submitAnswer({
      quizId,
      itemId: MC_ITEM,
      answer: { choiceId: "b" },
    })) as SubmitAnswerResult;

    // The second update starts from the first update's result (persisted) and
    // moves down, since it was wrong.
    expect(wrong.ability.before).toBeCloseTo(correct.ability.after, 6);
    expect(wrong.ability.after).toBeLessThan(wrong.ability.before);
  });
});
