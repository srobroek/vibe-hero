/**
 * @file Real `submit_answer` tool module — DETERMINISTIC + FREE-FORM paths
 * (T032 deterministic, US-1; T048 free-form, US-4).
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
 * Free-form path (T048, US-4): when the item is `free_form` and the input carries
 * a per-criterion `verdict`, the host agent's verdict is scored by the PURE
 * {@link scoreVerdict} against the item's MCP-supplied rubric — the MCP computes
 * the score (fraction of criteria met) and derives the grade; the agent never
 * returns a bare score/boolean (anti-gaming, FR-012/013). The graded result then
 * flows through the SAME ability-update / persistence / graduation pipeline as a
 * deterministic grade, recorded as `gradedBy: "host_agent"` with NO raw answer
 * text (FR-018). The two paths cross-guard: a deterministic answer on a free-form
 * item, or a free-form verdict on a deterministic item, is rejected with a clear
 * error.
 *
 * Gated (FR-032): NOT exempt — the gate runs before this handler.
 *
 * Exposed as a `dirOverride`-closing factory mirroring `config.ts` / `status.ts`.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`submit_answer` deterministic + free-form paths), spec.md FR-005 / FR-011 /
 * FR-012 / FR-013 / FR-018 / SC-004, data-model.md (AnsweredItem /
 * AbilityEstimate), research.md (OD-002 / OD-005).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import { resolveCatalog, type ResolvedCatalog } from "../catalog/resolve.js";
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
import { scoreVerdict } from "../grading/freeform.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import { abilityKey, type AbilityKey, type Grade } from "../schemas/common.js";
import type { ContentItem, Topic } from "../schemas/content.js";
import type {
  AbilityEstimate,
  AbilitySnapshot,
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
export const findItem = (
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
 * @throws {Error} if `item` is `free_form` — a deterministic answer was submitted
 *   for a free-form item; the caller must send a per-criterion `verdict` instead
 *   (cross-guard, T048).
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
        `submit_answer: item ${JSON.stringify(item.id)} is free_form; submit a per-criterion \`verdict\`, not a deterministic \`answer\` (T048)`,
      );
  }
};

/**
 * Build the AnsweredItem persisted in history. Derived fields ONLY — never the
 * raw answer text / chosen id / verdict justifications (FR-018). The item's
 * authored `tier` + fixed `difficulty` are recorded so history is
 * self-describing without re-joining the catalog. `gradedBy` records WHO graded:
 * the engine (deterministic) or the host agent (free-form verdict).
 */
const buildAnsweredItem = (
  item: ContentItem,
  score: number,
  grade: Grade,
  gradedBy: AnsweredItem["gradedBy"],
  answeredAt: string,
): AnsweredItem => ({
  itemId: item.id,
  tier: item.tier,
  difficulty: item.difficulty,
  grade,
  score,
  gradedBy,
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
export const toGraduationResult = (
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

/** The profile-level outcome of applying one graded item. */
export interface AppliedGrade {
  /** The next profile state (input profile is not mutated). */
  readonly profile: Profile;
  /** Ability before this item's Elo update. */
  readonly before: number;
  /** Ability after this item's Elo update. */
  readonly after: number;
  /** The graduation decision this item produced. */
  readonly decision: GraduationDecision;
}

/**
 * Apply ONE graded item to a profile (PURE): append the {@link AnsweredItem} to
 * the matching live {@link QuizRecord} (rolling its `abilityAfter`), advance the
 * {@link AbilityEstimate} for the quiz's key, evaluate graduation, and append an
 * ability snapshot. This is the single-item core shared by `submit_answer`
 * (one item per transaction) and `submit_answers` (N items folded sequentially
 * inside one transaction — identical math to N single calls).
 *
 * @throws {Error} if no live (un-completed) quiz with `quizId` exists.
 */
export const applyGradedItem = (
  current: Profile,
  quizId: string,
  item: ContentItem,
  score: number,
  grade: Grade,
  gradedBy: AnsweredItem["gradedBy"],
  answeredAt: string,
): AppliedGrade => {
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

  const answered = buildAnsweredItem(item, score, grade, gradedBy, answeredAt);
  const items = [...record.items, answered];
  // Close the session once every planned item has been graded (sniff finding
  // 2026-07-07: completedAt was never written). Records from before
  // plannedItemIds existed have no plan and stay open (legacy behavior).
  const planned = record.plannedItemIds;
  const complete =
    planned !== undefined &&
    planned.every((id) => items.some((a) => a.itemId === id));
  const updatedRecord: QuizRecord = {
    ...record,
    items,
    abilityAfter: estimate.value,
    ...(complete ? { completedAt: answeredAt } : {}),
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

  // Append an ability snapshot so get_dashboard can plot history over time.
  const snapshot: AbilitySnapshot = {
    ts: answeredAt,
    key,
    ability: estimate.value,
  };

  return {
    profile: {
      ...current,
      abilities: { ...current.abilities, [key]: estimateWithDwell },
      graduations,
      reviewSchedule,
      quizHistory,
      abilitySnapshots: [...(current.abilitySnapshots ?? []), snapshot],
    },
    before,
    after: estimate.value,
    decision: grad.decision,
  };
};

/**
 * Apply a graded answer to the profile inside the store's atomic
 * read-modify-write. Thin transactional wrapper around {@link applyGradedItem}.
 *
 * @throws {Error} if no live (un-completed) quiz with `quizId` exists.
 */
const persistGrade = async (
  quizId: string,
  item: ContentItem,
  score: number,
  grade: Grade,
  gradedBy: AnsweredItem["gradedBy"],
  answeredAt: string,
  dirOverride: string | undefined,
): Promise<{ before: number; after: number; decision: GraduationDecision }> => {
  let outcome:
    | { before: number; after: number; decision: GraduationDecision }
    | undefined;

  await updateProfile((current: Profile): Profile => {
    const applied = applyGradedItem(
      current,
      quizId,
      item,
      score,
      grade,
      gradedBy,
      answeredAt,
    );
    outcome = {
      before: applied.before,
      after: applied.after,
      decision: applied.decision,
    };
    return applied.profile;
  }, dirOverride);

  if (outcome === undefined) {
    // Unreachable: the transform either set `outcome` or threw above.
    throw new Error("submit_answer: ability update did not run");
  }
  return outcome;
};

/**
 * Sync catalog loader (test seam): returns topics synchronously from a fixture
 * dir. Tests inject this form; production uses {@link CatalogResolver}.
 * The optional arg is unused by sync loaders but makes the type compatible with
 * the {@link CatalogResolver} union so both can be called as `fn(dirOverride)`.
 */
export type CatalogLoader = (dirOverride?: string) => CatalogLoadResult;

/**
 * Async catalog resolver (production path): resolves via fresh-fetch → cache →
 * bundled. Mirrors {@link resolveCatalog}'s signature.
 */
export type CatalogResolver = (dirOverride?: string) => Promise<ResolvedCatalog>;

/** The graded outcome of one item, agnostic of which path produced it. */
export interface GradedOutcome {
  /** Continuous score in `[0, 1]` that drives the Elo update. */
  readonly score: number;
  /** Binary projection persisted in history. */
  readonly grade: Grade;
  /** Who graded: the in-engine grader or the host agent's verdict. */
  readonly gradedBy: AnsweredItem["gradedBy"];
  /** Authored correct choice id (MC only) to surface for teaching. */
  readonly correctAnswer?: string;
}

/**
 * Grade one item, dispatching on the input variant AND cross-guarding against
 * the item type (so a deterministic answer on a free-form item, or a free-form
 * verdict on a deterministic item, is rejected — never silently mis-graded):
 *
 * - DETERMINISTIC input (`answer`) → {@link gradeDeterministic}; all-or-nothing
 *   score graded `"engine"`. The `free_form` branch there throws the cross-guard.
 * - FREE-FORM input (`verdict`) → the item MUST be `free_form` with a rubric;
 *   the PURE {@link scoreVerdict} computes the fraction-met score + grade against
 *   the MCP-supplied rubric (FR-012/013), graded `"host_agent"`. A bare/partial
 *   verdict is rejected inside `scoreVerdict` (anti-gaming, E2).
 */
export const gradeItem = (
  input: SubmitAnswerInput,
  item: ContentItem,
): GradedOutcome => {
  if (isDeterministic(input)) {
    const { score, correctAnswer } = gradeDeterministic(item, input.answer);
    // Deterministic items are all-or-nothing: any threshold in (0,1] suffices.
    // Use the free-form pass threshold so there is one "correct" definition.
    const grade = toGrade(score, ASSESSMENT_CONFIG.freeFormPassThreshold);
    return correctAnswer !== undefined
      ? { score, grade, gradedBy: "engine", correctAnswer }
      : { score, grade, gradedBy: "engine" };
  }

  // Free-form verdict path (T048): the item must be free_form with a rubric.
  if (item.type !== "free_form" || item.rubric === undefined) {
    throw new Error(
      `submit_answer: item ${JSON.stringify(item.id)} is not free_form; submit a deterministic \`answer\`, not a \`verdict\``,
    );
  }
  // The MCP computes the score from the per-criterion verdict against its own
  // rubric — the agent never returns a bare score/boolean (FR-012/013).
  const { score, grade } = scoreVerdict(input.verdict, item.rubric);
  return { score, grade, gradedBy: "host_agent" };
};

/**
 * Build the `submit_answer` tool module (US-1 deterministic + US-4 free-form).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @param loaderOrResolver - Catalog source seam (test seam); accepts a sync
 *   {@link CatalogLoader} (test fixtures) or an async {@link CatalogResolver}
 *   (production). Defaults to {@link resolveCatalog} (fresh-fetch → cache →
 *   bundled). With no `VIBE_HERO_CONTENT_URL` set, resolver falls back to
 *   bundled — identical to the prior behavior offline.
 */
export const makeSubmitAnswerTool = (
  dirOverride?: string,
  loaderOrResolver: CatalogLoader | CatalogResolver = resolveCatalog,
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
      // A bare-boolean / shapeless verdict fails the union here (anti-gaming,
      // E2) before it ever reaches grading.
      const input: SubmitAnswerInput = SubmitAnswerInputSchema.parse(raw);

      // Resolve the quiz's topic key so we can find the item in catalog scope.
      const profile = await loadProfile(dirOverride);
      const record = profile.quizHistory.find((q) => q.id === input.quizId);
      if (record === undefined) {
        throw new Error(
          `submit_answer: no quiz session found for quizId ${JSON.stringify(input.quizId)}`,
        );
      }

      // Normalize: sync loader (tests) vs async resolver (production).
      const rawResult = loaderOrResolver(dirOverride);
      const { topics } = rawResult instanceof Promise ? await rawResult : rawResult;
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

      // Grade via the path matching the input + item type (deterministic engine
      // or free-form host verdict); both yield a continuous score + binary grade.
      const { score, grade, gradedBy, correctAnswer } = gradeItem(input, item);

      const answeredAt = new Date().toISOString();
      const { before, after, decision } = await persistGrade(
        input.quizId,
        item,
        score,
        grade,
        gradedBy,
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
      // Only surface the correct answer for MC (where `correctAnswer` is set);
      // free-form items have no single key to reveal.
      return correctAnswer !== undefined
        ? { ...result, correctAnswer }
        : result;
    },
  });

/** Default `submit_answer` module (env / `~/.vibe-hero`), used by the registry. */
export const submitAnswerTool: AnyToolModule = makeSubmitAnswerTool();
