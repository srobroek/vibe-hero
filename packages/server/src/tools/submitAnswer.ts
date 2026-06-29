/**
 * @file Real `submit_answer` tool module — DETERMINISTIC path (T032, US-1).
 *
 * The core scoring entry point. For a deterministic item (`multiple_choice` /
 * `short_answer`) it: finds the live {@link QuizRecord} + catalog item by
 * `quizId`/`itemId`, grades it in-engine via {@link gradeMultipleChoice} /
 * {@link gradeShortAnswer} (FR-011, instant + reproducible — SC-004), updates the
 * learner's Elo ability against the item's FIXED authored difficulty
 * ({@link updateAbility}; item difficulty never self-updates — E3), and persists
 * the result.
 *
 * Privacy (FR-018): the persisted {@link AnsweredItem} carries ONLY derived
 * fields — `itemId`, `tier`, `difficulty`, `grade`, `score`,
 * `gradedBy: "engine"`, `answeredAt`. The raw answer text / chosen id is used to
 * grade and then DISCARDED; it never reaches disk. The continuous `score` drives
 * the Elo update; the binary {@link Grade} is the projection persisted in
 * history.
 *
 * Persistence (atomic, FR-023a): a single {@link updateProfile} read-modify-write
 * appends the {@link AnsweredItem} to the matching {@link QuizRecord} and updates
 * the {@link AbilityEstimate} (`value`, `itemsSeen++`, `lastAssessedAt`, push
 * `itemId` to `lastItemIds`). Re-running on the same answer is naturally
 * idempotent in grade (SC-004) though it appends another graded item — quiz
 * sessions are append-only event logs.
 *
 * Scope: free-form verdict grading is T048; a `verdict` payload here is rejected
 * as not-yet-supported. `graduation` is intentionally left `undefined` — T046
 * wires hysteresis/dwell graduation + the review schedule into this same handler.
 *
 * Gated (FR-032): NOT exempt — the gate runs before this handler.
 *
 * Exposed as a `dirOverride`-closing factory mirroring `config.ts` / `status.ts`.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`submit_answer` deterministic path), spec.md FR-005 / FR-011 / FR-018 /
 * SC-004, data-model.md (AnsweredItem / AbilityEstimate), research.md (OD-005).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import { loadBundledCatalog } from "../catalog/bundled/index.js";
import type { CatalogLoadResult } from "../catalog/loader.js";
import { updateAbility } from "../engine/elo.js";
import {
  gradeMultipleChoice,
  gradeShortAnswer,
  toGrade,
} from "../grading/deterministic.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import { abilityKey, type Grade } from "../schemas/common.js";
import type { ContentItem, Topic } from "../schemas/content.js";
import type {
  AbilityEstimate,
  AnsweredItem,
  Profile,
  QuizRecord,
} from "../schemas/profile.js";
import { z } from "zod";

import {
  SubmitAnswerInputSchema,
  type SubmitAnswerInput,
  type SubmitAnswerResult,
} from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";

/**
 * Permissive OBJECT schema registered with the SDK. `submit_answer`'s contract
 * input is a *union* (deterministic answer XOR free-form verdict) which has no
 * single `.shape` for `registerTool`, so the wire schema is a superset:
 * `quizId` + `itemId` required, `answer`/`verdict` optional. The handler
 * re-validates against the authoritative {@link SubmitAnswerInputSchema} union
 * (discriminated structurally) before grading — a malformed payload is rejected
 * there, not silently mis-graded.
 */
export const SubmitAnswerToolInputSchema = z.object({
  quizId: z.string(),
  itemId: z.string(),
  answer: z
    .object({
      choiceId: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  verdict: z
    .object({
      criteria: z.array(
        z.object({
          id: z.string(),
          met: z.boolean(),
          justification: z.string(),
        }),
      ),
    })
    .optional(),
});
/** Inferred wire-input type for `submit_answer` (permissive superset). */
export type SubmitAnswerToolInput = z.infer<typeof SubmitAnswerToolInputSchema>;

/**
 * A type guard for the deterministic input variant (carries `answer`, not
 * `verdict`). Free-form verdicts route to the T048 path; until then they are
 * rejected so a free-form answer never silently mis-grades.
 */
const isDeterministic = (
  input: SubmitAnswerInput,
): input is Extract<SubmitAnswerInput, { answer: unknown }> => "answer" in input;

/** Find the catalog item with `itemId` across all topics; returns its topic too. */
const findItem = (
  topics: readonly Topic[],
  itemId: string,
): { topic: Topic; item: ContentItem } | undefined => {
  for (const topic of topics) {
    const item = topic.items.find((i) => i.id === itemId);
    if (item !== undefined) return { topic, item };
  }
  return undefined;
};

/**
 * Grade a deterministic item, returning the continuous score plus (for MC) the
 * authored correct choice id so the caller can surface `correctAnswer`.
 *
 * @throws {Error} if `item` is `free_form` (handled by T048) — the deterministic
 *   path must not be asked to grade a rubric item.
 */
const gradeDeterministic = (
  item: ContentItem,
  answer: { choiceId?: string | undefined; text?: string | undefined },
): { score: 0 | 1; correctAnswer?: string } => {
  switch (item.type) {
    case "multiple_choice": {
      const { score, correctChoiceId } = gradeMultipleChoice(item, answer.choiceId);
      return { score, correctAnswer: correctChoiceId };
    }
    case "short_answer": {
      const { score } = gradeShortAnswer(item, answer.text);
      return { score };
    }
    case "free_form":
      throw new Error(
        `submit_answer: free-form grading is not supported on the deterministic path (item ${JSON.stringify(item.id)}); a per-criterion verdict is required (T048)`,
      );
  }
};

/**
 * Build the AnsweredItem persisted in history. Derived fields ONLY — never the
 * raw answer text / chosen id (FR-018). The item's authored `tier` + fixed
 * `difficulty` are recorded so history is self-describing without re-joining the
 * catalog.
 */
const buildAnsweredItem = (
  item: ContentItem,
  score: number,
  grade: Grade,
  answeredAt: string,
): AnsweredItem => ({
  itemId: item.id,
  tier: item.tier,
  difficulty: item.difficulty,
  grade,
  score,
  gradedBy: "engine",
  answeredAt,
});

/**
 * Advance an ability estimate by one graded item: apply the Elo update against
 * the item's fixed difficulty, stamp `lastAssessedAt`, and push the item id onto
 * `lastItemIds` (so the next `start_quiz` avoids re-serving it). A cold estimate
 * (no prior entry) starts from {@link ASSESSMENT_CONFIG.startingAbility} with
 * zero items seen.
 */
const advanceEstimate = (
  prior: AbilityEstimate | undefined,
  item: ContentItem,
  score: number,
  answeredAt: string,
): { before: number; estimate: AbilityEstimate } => {
  const before = prior?.value ?? ASSESSMENT_CONFIG.startingAbility;
  const itemsSeen = prior?.itemsSeen ?? 0;
  const update = updateAbility(before, itemsSeen, item.difficulty, score);
  return {
    before,
    estimate: {
      value: update.value,
      itemsSeen: update.itemsSeen,
      lastAssessedAt: answeredAt,
      lastItemIds: [...(prior?.lastItemIds ?? []), item.id],
    },
  };
};

/**
 * Apply a graded answer to the profile inside the store's atomic
 * read-modify-write: append the {@link AnsweredItem} to the matching live
 * {@link QuizRecord} (and roll its `abilityAfter`), and replace the
 * {@link AbilityEstimate} for the quiz's key. Returns the new profile plus the
 * before/after abilities for the tool result.
 *
 * @throws {Error} if no live (un-completed) quiz with `quizId` exists.
 */
const persistGrade = async (
  quizId: string,
  item: ContentItem,
  score: number,
  grade: Grade,
  answeredAt: string,
  dirOverride: string | undefined,
): Promise<{ before: number; after: number }> => {
  let abilities: { before: number; after: number } | undefined;

  await updateProfile((current: Profile): Profile => {
    const recordIndex = current.quizHistory.findIndex((q) => q.id === quizId);
    const record = current.quizHistory[recordIndex];
    if (record === undefined) {
      throw new Error(
        `submit_answer: no quiz session found for quizId ${JSON.stringify(quizId)}`,
      );
    }
    if (record.completedAt !== undefined) {
      throw new Error(
        `submit_answer: quiz ${JSON.stringify(quizId)} is already completed`,
      );
    }

    const key = record.key;
    const { before, estimate } = advanceEstimate(
      current.abilities[key],
      item,
      score,
      answeredAt,
    );
    abilities = { before, after: estimate.value };

    const answered = buildAnsweredItem(item, score, grade, answeredAt);
    const updatedRecord: QuizRecord = {
      ...record,
      items: [...record.items, answered],
      abilityAfter: estimate.value,
    };
    const quizHistory = [...current.quizHistory];
    quizHistory[recordIndex] = updatedRecord;

    return {
      ...current,
      abilities: { ...current.abilities, [key]: estimate },
      quizHistory,
    };
  }, dirOverride);

  if (abilities === undefined) {
    // Unreachable: the transform either set `abilities` or threw above.
    throw new Error("submit_answer: ability update did not run");
  }
  return abilities;
};

/**
 * A catalog source: returns the loaded topics (+ any per-file errors). Defaults
 * to {@link loadBundledCatalog}; tests inject a fixture-dir loader so grading can
 * resolve a topic with ≥5 deterministic items without disturbing the shared
 * bundled snapshot.
 */
export type CatalogLoader = () => CatalogLoadResult;

/**
 * Build the `submit_answer` tool module (US-1, deterministic path).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @param catalogLoader - Catalog source override (test seam); defaults to the
 *   bundled snapshot {@link loadBundledCatalog}.
 */
export const makeSubmitAnswerTool = (
  dirOverride?: string,
  catalogLoader: CatalogLoader = loadBundledCatalog,
): AnyToolModule =>
  defineTool({
    name: "submit_answer",
    description:
      "Grade one quiz item (deterministic answer or free-form host verdict) and update ability.",
    // The SDK needs an object schema; the handler re-validates against the real
    // discriminated union below (the authoritative parse).
    inputSchema: SubmitAnswerToolInputSchema,
    handler: async (
      raw: SubmitAnswerToolInput,
    ): Promise<SubmitAnswerResult> => {
      // Authoritative validation: deterministic answer XOR free-form verdict.
      const input: SubmitAnswerInput = SubmitAnswerInputSchema.parse(raw);
      if (!isDeterministic(input)) {
        throw new Error(
          "submit_answer: free-form verdict grading is not implemented yet (T048); submit a deterministic answer",
        );
      }

      // Resolve the quiz's topic key so we can find the item in catalog scope.
      const profile = await loadProfile(dirOverride);
      const record = profile.quizHistory.find((q) => q.id === input.quizId);
      if (record === undefined) {
        throw new Error(
          `submit_answer: no quiz session found for quizId ${JSON.stringify(input.quizId)}`,
        );
      }

      const { topics } = catalogLoader();
      const found = findItem(topics, input.itemId);
      if (found === undefined) {
        throw new Error(
          `submit_answer: no catalog item matches itemId ${JSON.stringify(input.itemId)}`,
        );
      }
      const { topic, item } = found;

      // Defensive: the item must belong to the quiz's topic.
      if (abilityKey(topic.class, topic.id) !== record.key) {
        throw new Error(
          `submit_answer: item ${JSON.stringify(input.itemId)} does not belong to quiz ${JSON.stringify(input.quizId)}`,
        );
      }

      const { score, correctAnswer } = gradeDeterministic(item, input.answer);
      // Deterministic items are all-or-nothing: any threshold in (0,1] suffices.
      // Use the item's free-form pass threshold default for one consistent rule.
      const grade = toGrade(score, ASSESSMENT_CONFIG.freeFormPassThreshold);

      const answeredAt = new Date().toISOString();
      const { before, after } = await persistGrade(
        input.quizId,
        item,
        score,
        grade,
        answeredAt,
        dirOverride,
      );

      const result: SubmitAnswerResult = {
        grade,
        score,
        guidance: item.guidance,
        ability: { before, after },
        // graduation intentionally omitted — T046 wires hysteresis/dwell + review.
      };
      // Only surface the correct answer for MC (where `correctAnswer` is set).
      return correctAnswer !== undefined
        ? { ...result, correctAnswer }
        : result;
    },
  });

/** Default `submit_answer` module (env / `~/.vibe-hero`), used by the registry. */
export const submitAnswerTool: AnyToolModule = makeSubmitAnswerTool();
