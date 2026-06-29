/**
 * @file Content Catalog schemas (read-only at runtime).
 *
 * Defines topics, items, answer keys, rubrics, trigger signals, and the catalog
 * manifest. Cross-field validation (item type vs. choices/answerKey/rubric) is
 * enforced with `.superRefine` so catalog load rejects violations with a
 * path-qualified diagnostic (FR-004).
 *
 * Source of truth: specs/001-vibe-hero-mvp/data-model.md (§ Content Catalog).
 */

import { z } from "zod";
import {
  BloomLevelSchema,
  ContentClassSchema,
  TierSchema,
  ToolIdSchema,
  QuestionTypeSchema,
} from "./common.js";

/** A selectable answer option for a multiple-choice item. */
export const ChoiceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
/** A multiple-choice option. */
export type Choice = z.infer<typeof ChoiceSchema>;

/**
 * Deterministic grading key. Discriminated on `kind`:
 * - `choice`  — the id of the single correct choice (multiple_choice).
 * - `keyword` — any of the accepted keyword answers, with optional
 *   normalization applied before comparison (short_answer).
 */
export const AnswerKeySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    correctChoiceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("keyword"),
    anyOf: z.array(z.string().min(1)).min(1),
    normalize: z.enum(["lower", "trim", "both"]).optional(),
  }),
]);
/** A deterministic answer key. */
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

/** A single rubric criterion the host agent judges for free-form items. */
export const RubricCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
/** A rubric criterion. */
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

/**
 * Free-form grading rubric. The criteria + reference answer are handed to the
 * host agent for judging (returned by `start_quiz`); the MCP computes the score
 * from the per-criterion verdict. `passThreshold` is the fraction of criteria
 * that must be met to count as "correct" (default 0.6).
 */
export const RubricSchema = z.object({
  criteria: z.array(RubricCriterionSchema).min(1),
  referenceAnswer: z.string().min(1),
  passThreshold: z.number().min(0).max(1).default(0.6),
});
/** A free-form grading rubric. */
export type Rubric = z.infer<typeof RubricSchema>;

/**
 * A single catalog question. The base fields are validated structurally here;
 * the type-dependent invariants (choices/answerKey/rubric) are enforced on the
 * {@link TopicSchema}/{@link ContentItemSchema} via `.superRefine`.
 */
const ContentItemBaseSchema = z.object({
  id: z.string().min(1),
  tier: TierSchema,
  bloom: BloomLevelSchema,
  /**
   * Fixed authored Elo item-rating. Never self-updates — only the learner's
   * ability moves against it.
   */
  difficulty: z.number(),
  type: QuestionTypeSchema,
  prompt: z.string().min(1),
  choices: z.array(ChoiceSchema).optional(),
  answerKey: AnswerKeySchema.optional(),
  rubric: RubricSchema.optional(),
  /** Teaching text shown after answering / on detected weakness. */
  guidance: z.string().min(1),
});

/**
 * Enforces the type-dependent invariants for a content item, pushing
 * path-qualified issues for catalog-load diagnostics (FR-004):
 * - `multiple_choice` ⇒ ≥2 choices AND a `choice` answerKey whose
 *   `correctChoiceId` exists among the choices.
 * - `short_answer`    ⇒ a `keyword` answerKey (no choices/rubric).
 * - `free_form`       ⇒ a rubric AND no answerKey.
 */
const refineContentItem = (
  item: z.infer<typeof ContentItemBaseSchema>,
  ctx: z.RefinementCtx,
): void => {
  switch (item.type) {
    case "multiple_choice": {
      if (!item.choices || item.choices.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["choices"],
          message: "multiple_choice requires at least 2 choices",
        });
      }
      const answerKey = item.answerKey;
      if (!answerKey || answerKey.kind !== "choice") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answerKey"],
          message: 'multiple_choice requires an answerKey of kind "choice"',
        });
      } else if (
        item.choices &&
        !item.choices.some((c) => c.id === answerKey.correctChoiceId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answerKey", "correctChoiceId"],
          message: "correctChoiceId must reference an existing choice id",
        });
      }
      if (item.rubric) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rubric"],
          message: "multiple_choice must not define a rubric",
        });
      }
      break;
    }
    case "short_answer": {
      if (!item.answerKey || item.answerKey.kind !== "keyword") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answerKey"],
          message: 'short_answer requires an answerKey of kind "keyword"',
        });
      }
      if (item.choices) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["choices"],
          message: "short_answer must not define choices",
        });
      }
      if (item.rubric) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rubric"],
          message: "short_answer must not define a rubric",
        });
      }
      break;
    }
    case "free_form": {
      if (!item.rubric) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rubric"],
          message: "free_form requires a rubric",
        });
      }
      if (item.answerKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answerKey"],
          message: "free_form must not define an answerKey",
        });
      }
      if (item.choices) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["choices"],
          message: "free_form must not define choices",
        });
      }
      break;
    }
  }
};

/**
 * A catalog question with all type-dependent invariants enforced.
 * Difficulty is a fixed authored field (no self-update).
 */
export const ContentItemSchema =
  ContentItemBaseSchema.superRefine(refineContentItem);
/** A catalog question. */
export type ContentItem = z.infer<typeof ContentItemSchema>;

/**
 * How observed host activity maps to a topic for offer candidacy (FR-003a).
 * At least one of the `match` selectors must be present. Trigger-only: it
 * selects which topic to offer and never contributes to scoring.
 */
export const TriggerSignalSchema = z.object({
  tool: ToolIdSchema,
  match: z
    .object({
      toolName: z.string().min(1).optional(),
      toolNamePattern: z.string().min(1).optional(),
      mcpToolPattern: z.string().min(1).optional(),
    })
    .refine(
      (m) =>
        m.toolName !== undefined ||
        m.toolNamePattern !== undefined ||
        m.mcpToolPattern !== undefined,
      { message: "match requires at least one selector" },
    ),
  weight: z.number().min(0).max(1).default(1),
});
/** A topic trigger signal. */
export type TriggerSignal = z.infer<typeof TriggerSignalSchema>;

/**
 * A topic file resolves to exactly one `(id, class)` pair and carries every
 * tier's items plus its trigger signals (which may be empty).
 */
export const TopicSchema = z.object({
  id: z.string().min(1),
  class: ContentClassSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  triggerSignals: z.array(TriggerSignalSchema),
  items: z.array(ContentItemSchema),
});
/** A catalog topic (one topic × class). */
export type Topic = z.infer<typeof TopicSchema>;

/** A manifest entry indexing one topic for fast listing. */
export const CatalogManifestTopicSchema = z.object({
  id: z.string().min(1),
  class: ContentClassSchema,
  file: z.string().min(1),
  itemCount: z.number().int().nonnegative(),
  tiers: z.array(TierSchema),
});
/** A topic index entry in the catalog manifest. */
export type CatalogManifestTopic = z.infer<typeof CatalogManifestTopicSchema>;

/**
 * The catalog manifest: a versioned index of all topics. `etag` is set by the
 * fetch layer for cache validation.
 */
export const CatalogManifestSchema = z.object({
  version: z.string().min(1),
  publishedAt: z.string().datetime(),
  topics: z.array(CatalogManifestTopicSchema),
  etag: z.string().min(1).optional(),
});
/** The catalog manifest. */
export type CatalogManifest = z.infer<typeof CatalogManifestSchema>;
