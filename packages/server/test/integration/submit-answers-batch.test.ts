/**
 * @file Integration tests for the batch `submit_answers` tool.
 *
 * The batch tool's contract: grading ALL answers of one quiz in a single call
 * must be observably IDENTICAL to N sequential `submit_answer` calls — same
 * grades, same Elo trajectory, same persisted history — while doing only one
 * profile transaction. These tests drive the real handlers against a temp
 * profile home + temp catalog dir (no mocks), mirroring us1-quiz.test.ts.
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCatalogFromDir } from "../../src/catalog/loader.js";
import { makeStartQuizTool } from "../../src/tools/startQuiz.js";
import { makeSubmitAnswerTool } from "../../src/tools/submitAnswer.js";
import { makeSubmitAnswersTool } from "../../src/tools/submitAnswers.js";
import { profilePath, updateProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import type { Profile } from "../../src/schemas/profile.js";
import type {
  StartQuizResult,
  SubmitAnswerResult,
  SubmitAnswersResult,
} from "../../src/schemas/tools.js";

const TOPIC_KEY = abilityKey({ kind: "general" }, "batch-fixture");

/** Three deterministic items + one free-form, all inside the ±60 window. */
const FIXTURE_YAML = `
id: batch-fixture
class:
  kind: general
title: Batch Fixture
summary: A topic for the batch submit_answers path.
triggerSignals: []
items:
  - id: bf-mc-1
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
  - id: bf-sa-1
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
  - id: bf-mc-2
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
  - id: bf-ff-1
    tier: 300
    bloom: analyze
    difficulty: 380
    type: free_form
    prompt: Explain the thing.
    rubric:
      criteria:
        - id: c1
          text: Names the mechanism.
        - id: c2
          text: Explains the tradeoff.
      referenceAnswer: The mechanism is X; the tradeoff is Y.
    guidance: Mechanism X, tradeoff Y.
`;

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

describe("submit_answers (batch)", () => {
  let home: string;
  let homeSeq: string;
  let catalogDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-batch-"));
    homeSeq = await mkdtemp(path.join(tmpdir(), "vibe-hero-batch-seq-"));
    catalogDir = await mkdtemp(path.join(tmpdir(), "vibe-hero-batch-cat-"));
    const generalDir = path.join(catalogDir, "general");
    await mkdir(generalDir, { recursive: true });
    await writeFile(
      path.join(generalDir, "batch-fixture.yaml"),
      FIXTURE_YAML,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(homeSeq, { recursive: true, force: true });
    await rm(catalogDir, { recursive: true, force: true });
  });

  const fixtureLoader = () => loadCatalogFromDir(catalogDir);

  const seedProfile = async (dir: string): Promise<void> => {
    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(),
        abilities: {
          [TOPIC_KEY]: {
            value: 360,
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
      dir,
    );
  };

  const beginQuiz = async (dir: string): Promise<StartQuizResult> => {
    const startQuiz = makeStartQuizTool(dir, fixtureLoader).handler;
    return (await startQuiz({ key: TOPIC_KEY })) as StartQuizResult;
  };

  /** The canonical 4-answer batch: 2 correct, 1 wrong, 1 partial free-form. */
  const ANSWERS = [
    { itemId: "bf-mc-1", answer: { choiceId: "a" } }, // correct
    { itemId: "bf-sa-1", answer: { text: "wrong-word" } }, // incorrect
    { itemId: "bf-mc-2", answer: { choiceId: "a" } }, // correct
    {
      itemId: "bf-ff-1",
      verdict: {
        criteria: [
          { id: "c1", met: true, justification: "Named the mechanism." },
          { id: "c2", met: false, justification: "No tradeoff given." },
        ],
      },
    }, // 0.5 → incorrect at 0.6 threshold
  ];

  it("grades a whole quiz in one call with per-item results", async () => {
    await seedProfile(home);
    const { quizId } = await beginQuiz(home);
    const submitAnswers = makeSubmitAnswersTool(home, fixtureLoader).handler;

    const result = (await submitAnswers({
      quizId,
      answers: ANSWERS,
    })) as SubmitAnswersResult;

    expect(result.results).toHaveLength(4);
    expect(result.correctCount).toBe(2);
    expect(result.results.map((r) => r.grade)).toEqual([
      "correct",
      "incorrect",
      "correct",
      "incorrect",
    ]);
    // Deterministic MC rows surface correctAnswer; free-form rows do not.
    expect(result.results[0]!.correctAnswer).toBe("a");
    expect(result.results[3]!.correctAnswer).toBeUndefined();
    expect(result.results[3]!.score).toBe(0.5);
    // Batch ability spans first-before → last-after and chains per item.
    expect(result.ability.before).toBe(360);
    expect(result.ability.after).toBe(result.results[3]!.ability.after);
    expect(result.results[0]!.ability.after).toBe(
      result.results[1]!.ability.before,
    );
  });

  it("matches N sequential submit_answer calls exactly (same grades + Elo)", async () => {
    // Batch home.
    await seedProfile(home);
    const { quizId } = await beginQuiz(home);
    const submitAnswers = makeSubmitAnswersTool(home, fixtureLoader).handler;
    const batch = (await submitAnswers({
      quizId,
      answers: ANSWERS,
    })) as SubmitAnswersResult;

    // Sequential home (identical seed).
    await seedProfile(homeSeq);
    const { quizId: seqQuizId } = await beginQuiz(homeSeq);
    const submitAnswer = makeSubmitAnswerTool(homeSeq, fixtureLoader).handler;
    const sequential: SubmitAnswerResult[] = [];
    for (const a of ANSWERS) {
      sequential.push(
        (await submitAnswer({ quizId: seqQuizId, ...a })) as SubmitAnswerResult,
      );
    }

    // Per-item grades, scores, and the full Elo trajectory must be identical.
    expect(batch.results.map((r) => r.grade)).toEqual(
      sequential.map((r) => r.grade),
    );
    expect(batch.results.map((r) => r.score)).toEqual(
      sequential.map((r) => r.score),
    );
    expect(batch.results.map((r) => r.ability)).toEqual(
      sequential.map((r) => r.ability),
    );
    expect(batch.results.map((r) => r.graduation)).toEqual(
      sequential.map((r) => r.graduation),
    );

    // Persisted history matches too (same items, grades, ability, dwell).
    const read = async (dir: string): Promise<Profile> =>
      JSON.parse(await readFile(profilePath(dir), "utf8")) as Profile;
    const batchProfile = await read(home);
    const seqProfile = await read(homeSeq);
    // Wall-clock timestamps necessarily differ between the two runs; strip
    // them and compare everything semantic (values, dwell, tier, history).
    const strip = (p: Profile) => ({
      ability: { ...p.abilities[TOPIC_KEY], lastAssessedAt: "ts" },
      graduation: { ...p.graduations[TOPIC_KEY], graduatedAt: "ts" },
      items: p.quizHistory[0]!.items.map(
        ({ answeredAt: _answeredAt, ...rest }) => rest,
      ),
    });
    expect(strip(batchProfile)).toEqual(strip(seqProfile));
  });

  it("rejects the whole batch when any row is invalid (no partial writes)", async () => {
    await seedProfile(home);
    const { quizId } = await beginQuiz(home);
    const submitAnswers = makeSubmitAnswersTool(home, fixtureLoader).handler;

    await expect(
      submitAnswers({
        quizId,
        answers: [
          { itemId: "bf-mc-1", answer: { choiceId: "a" } },
          { itemId: "no-such-item", answer: { choiceId: "a" } },
        ],
      }),
    ).rejects.toThrow(/no catalog item matches/);

    // Nothing was persisted: the quiz record has zero graded items.
    const profile = JSON.parse(
      await readFile(profilePath(home), "utf8"),
    ) as Profile;
    expect(profile.quizHistory[0]!.items).toHaveLength(0);
    expect(profile.abilities[TOPIC_KEY]!.value).toBe(360);
  });

  it("rejects duplicate itemIds in one batch", async () => {
    await seedProfile(home);
    const { quizId } = await beginQuiz(home);
    const submitAnswers = makeSubmitAnswersTool(home, fixtureLoader).handler;

    await expect(
      submitAnswers({
        quizId,
        answers: [
          { itemId: "bf-mc-1", answer: { choiceId: "a" } },
          { itemId: "bf-mc-1", answer: { choiceId: "b" } },
        ],
      }),
    ).rejects.toThrow(/more than once/);
  });

  it("stamps completedAt once every planned item is graded, then rejects further submits", async () => {
    await seedProfile(home);
    const startQuiz = makeStartQuizTool(home, fixtureLoader).handler;
    const { quizId, items } = (await startQuiz({
      key: TOPIC_KEY,
      length: 3,
      allowFreeForm: false,
    })) as StartQuizResult;
    const submitAnswers = makeSubmitAnswersTool(home, fixtureLoader).handler;

    // Answer exactly the planned items (choice/text values don't matter).
    await submitAnswers({
      quizId,
      answers: items.map((i) =>
        i.type === "multiple_choice"
          ? { itemId: i.itemId, answer: { choiceId: "a" } }
          : { itemId: i.itemId, answer: { text: "skill" } },
      ),
    });

    const profile = JSON.parse(
      await readFile(profilePath(home), "utf8"),
    ) as Profile;
    const record = profile.quizHistory.find((q) => q.id === quizId)!;
    expect(record.completedAt).toBeDefined();
    expect(record.items).toHaveLength(items.length);

    // The completed-quiz guard is now live: a further submit is rejected.
    await expect(
      submitAnswers({
        quizId,
        answers: [{ itemId: items[0]!.itemId, answer: { choiceId: "a" } }],
      }),
    ).rejects.toThrow(/already completed/);
  });

  it("rejects an unknown quizId", async () => {
    await seedProfile(home);
    const submitAnswers = makeSubmitAnswersTool(home, fixtureLoader).handler;
    await expect(
      submitAnswers({
        quizId: "nope",
        answers: [{ itemId: "bf-mc-1", answer: { choiceId: "a" } }],
      }),
    ).rejects.toThrow(/no quiz session found/);
  });
});
