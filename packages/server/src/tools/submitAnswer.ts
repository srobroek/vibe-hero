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
 * Graduation (T046, US-3): after the ability update, the PURE
 * {@link evaluateGraduation} engine decides whether this graded item promotes
 * the learner to the next tier (hysteresis band + `dwell` consecutive
 * qualifying items — SC-014) or demotes/flags below the lower band (FR-008/009).
 * The decision updates `profile.graduations[key]` and the dwell counter on the
 * AbilityEstimate; on a promotion a proactive spaced {@link ReviewEntry} is
 * enqueued (FR-010) so a one-time streak is later re-verified, and the
 * `graduation` field is surfaced on the result so the host informs the user.
 *
 * Scope: free-form verdict grading is T048; a `verdict` payload here is rejected
 * as not-yet-supported.
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
  evaluateGraduation,
  type GraduationDecision,
  type TierOrZero,
} from "../engine/graduation.js";
import {
  gradeMultipleChoice,
  gradeShortAnswer,
  toGrade,
} from "../grading/deterministic.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import { abilityKey, type AbilityKey, type Grade } from "../schemas/common.js";
import type { ContentItem, Topic } from "../schemas/content.js";
import type {
  AbilityEstimate,
  AnsweredItem,
  Profile,
  QuizRecord,
  ReviewEntry,
  TierGraduation,
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
      // Carry the prior dwell forward unchanged here; the graduation step
      // (applyGraduation) reads it, then overwrites with the engine's next
      // dwell so the consecutive-streak counter advances/resets per item.
      dwell: prior?.dwell ?? 0,
    },
  };
};

/**
 * Apply the PURE graduation decision (T046, US-3) to one ability key inside the
 * store transaction. Reads the just-updated ability + the prior dwell counter,
 * asks {@link evaluateGraduation} for the decision, then returns the next
 * `graduations[key]`, the dwell to persist on the estimate, and (on a
 * promotion) a proactive spaced {@link ReviewEntry} to enqueue (FR-010).
 *
 * - On `"graduated"`: write a `current` graduation at the new tier and enqueue a
 *   `reason: "spaced"` review one staleness window out (so a one-time streak is
 *   later re-verified — durable-knowledge semantics).
 * - On `"demoted"`: step the tier down and flag `due_for_review` (FR-009). No
 *   spaced entry — the lapse path (status/standing, T046) owns lapsed entries.
 * - On no change: leave the existing graduation untouched, but still persist the
 *   engine's dwell so the consecutive streak carries across items.
 *
 * @returns The decision plus the derived graduation/dwell/review side-outputs.
 */
const applyGraduation = (
  key: AbilityKey,
  newAbility: number,
  priorDwell: number,
  existing: TierGraduation | undefined,
  answeredAt: string,
): {
  decision: GraduationDecision;
  graduation: TierGraduation | undefined;
  dwell: number;
  spacedReview?: ReviewEntry;
} => {
  const currentTier: TierOrZero = existing?.currentTier ?? 0;
  const decision = evaluateGraduation({
    ability: newAbility,
    currentTier,
    dwell: priorDwell,
  });

  if (decision.reason === "graduated") {
    const dueAt = new Date(
      Date.parse(answeredAt) +
        ASSESSMENT_CONFIG.stalenessWindowDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return {
      decision,
      dwell: decision.dwell,
      graduation: {
        currentTier: decision.tier,
        status: "current",
        graduatedAt: answeredAt,
        lastChangeReason: "graduated",
      },
      spacedReview: { key, dueAt, reason: "spaced" },
    };
  }

  if (decision.reason === "demoted") {
    return {
      decision,
      dwell: decision.dwell,
      graduation: {
        currentTier: decision.tier,
        status: "due_for_review",
        // Preserve the original graduation timestamp if we have one; this is an
        // audit field, and a demotion is a status change, not a re-graduation.
        graduatedAt: existing?.graduatedAt ?? answeredAt,
        lastChangeReason: "demoted",
      },
    };
  }

  // No change: keep the existing graduation row but persist the (possibly
  // advanced) dwell streak.
  return { decision, dwell: decision.dwell, graduation: existing };
};

/**
 * Project a {@link GraduationDecision} into the `submit_answer` result's
 * `graduation` field `{ changed, tier?, status?, reason? }`. On a change the
 * `status` reflects the resulting graduation state (`current` on promotion,
 * `due_for_review` on demotion); `tier` is included only when the resulting tier
 * is a real tier (100–500) — a demotion all the way to `0` (un-graduated) omits
 * it, matching the result schema (`TierSchema.optional()`). A no-change decision
 * reports `changed: false` and nothing else.
 */
const toGraduationResult = (
  decision: GraduationDecision,
): NonNullable<SubmitAnswerResult["graduation"]> => {
  if (!decision.changed) return { changed: false };
  const status = decision.reason === "graduated" ? "current" : "due_for_review";
  const base = {
    changed: true,
    status,
    ...(decision.reason !== null ? { reason: decision.reason } : {}),
  };
  return decision.tier === 0 ? base : { ...base, tier: decision.tier };
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
): Promise<{ before: number; after: number; decision: GraduationDecision }> => {
  let outcome:
    | { before: number; after: number; decision: GraduationDecision }
    | undefined;

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
    const prior = current.abilities[key];
    const { before, estimate } = advanceEstimate(prior, item, score, answeredAt);

    // Graduation (T046): evaluate hysteresis/dwell against the JUST-updated
    // ability, threading the prior dwell counter through the pure engine.
    const grad = applyGraduation(
      key,
      estimate.value,
      prior?.dwell ?? 0,
      current.graduations[key],
      answeredAt,
    );
    // Persist the engine's next dwell on the estimate so the consecutive streak
    // carries across submit_answer calls (advanceEstimate seeded it from prior).
    const estimateWithDwell: AbilityEstimate = { ...estimate, dwell: grad.dwell };

    outcome = { before, after: estimate.value, decision: grad.decision };

    const answered = buildAnsweredItem(item, score, grade, answeredAt);
    const updatedRecord: QuizRecord = {
      ...record,
      items: [...record.items, answered],
      abilityAfter: estimate.value,
    };
    const quizHistory = [...current.quizHistory];
    quizHistory[recordIndex] = updatedRecord;

    const graduations =
      grad.graduation === undefined
        ? current.graduations
        : { ...current.graduations, [key]: grad.graduation };

    // On promotion, enqueue a proactive spaced review (FR-010), de-duped by key
    // so repeated promotions don't pile up duplicate spaced entries.
    const reviewSchedule =
      grad.spacedReview === undefined
        ? current.reviewSchedule
        : [
            ...current.reviewSchedule.filter(
              (e) => !(e.key === key && e.reason === "spaced"),
            ),
            grad.spacedReview,
          ];

    return {
      ...current,
      abilities: { ...current.abilities, [key]: estimateWithDwell },
      graduations,
      reviewSchedule,
      quizHistory,
    };
  }, dirOverride);

  if (outcome === undefined) {
    // Unreachable: the transform either set `outcome` or threw above.
    throw new Error("submit_answer: ability update did not run");
  }
  return outcome;
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
      const { before, after, decision } = await persistGrade(
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
        // Surface the graduation outcome so the host can congratulate (on a
        // promotion) or flag for review (on a demotion). When nothing changed we
        // still report `changed: false` with the holding tier (US-3).
        graduation: toGraduationResult(decision),
      };
      // Only surface the correct answer for MC (where `correctAnswer` is set).
      return correctAnswer !== undefined
        ? { ...result, correctAnswer }
        : result;
    },
  });

/** Default `submit_answer` module (env / `~/.vibe-hero`), used by the registry. */
export const submitAnswerTool: AnyToolModule = makeSubmitAnswerTool();
