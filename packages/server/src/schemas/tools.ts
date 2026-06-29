/**
 * @file MCP tool input/output schemas.
 *
 * One input + output schema per MCP tool. All inputs/outputs are Zod-validated
 * both directions. Every tool (except get_config/save_config) may instead
 * return the {@link SetupRequiredSchema} gate sentinel when `profile.config` is
 * absent (FR-032).
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md.
 */

import { z } from "zod";
import {
  AbilityKeySchema,
  TierSchema,
  ToolIdSchema,
  QuestionTypeSchema,
  GradeSchema,
} from "./common.js";
import { ChoiceSchema, RubricCriterionSchema } from "./content.js";
import { ConfigSchema } from "./profile.js";

/**
 * The setup gate sentinel. Returned by any gated tool when `profile.config` is
 * absent (FR-032). Tool result schemas that can be gated are unioned with this.
 */
export const SetupRequiredSchema = z.object({
  status: z.literal("SETUP_REQUIRED"),
  message: z.string().min(1),
  setupSkill: z.string().min(1),
});
/** The SETUP_REQUIRED gate sentinel. */
export type SetupRequired = z.infer<typeof SetupRequiredSchema>;

/**
 * Wrap a tool result schema so it can also be the gate sentinel. Discriminated
 * on `status` is not possible for arbitrary object results, so this is a plain
 * union; callers narrow on the `status === "SETUP_REQUIRED"` field.
 */
const gated = <T extends z.ZodTypeAny>(result: T) =>
  z.union([SetupRequiredSchema, result]);

// ---------------------------------------------------------------------------
// get_status
// ---------------------------------------------------------------------------

/** Input for `get_status`. */
export const GetStatusInputSchema = z.object({
  tool: ToolIdSchema.optional(),
});
export type GetStatusInput = z.infer<typeof GetStatusInputSchema>;

/** Per-topic standing row in `get_status`. */
export const StatusTopicSchema = z.object({
  key: AbilityKeySchema,
  title: z.string(),
  tier: z.union([TierSchema, z.literal(0)]),
  status: z.enum(["current", "due_for_review", "not_started"]),
  ability: z.number(),
});
export type StatusTopic = z.infer<typeof StatusTopicSchema>;

/** Result for `get_status`. */
export const GetStatusResultSchema = z.object({
  tool: ToolIdSchema,
  topics: z.array(StatusTopicSchema),
  dueForReview: z.array(z.string()),
  suggestions: z.array(
    z.object({ key: AbilityKeySchema, reason: z.string() }),
  ),
});
export type GetStatusResult = z.infer<typeof GetStatusResultSchema>;

/** Output for `get_status` (may be gated). */
export const GetStatusOutputSchema = gated(GetStatusResultSchema);
export type GetStatusOutput = z.infer<typeof GetStatusOutputSchema>;

// ---------------------------------------------------------------------------
// list_topics
// ---------------------------------------------------------------------------

/** Input for `list_topics`. */
export const ListTopicsInputSchema = z.object({
  tool: ToolIdSchema.optional(),
  class: z.enum(["general", "tool"]).optional(),
});
export type ListTopicsInput = z.infer<typeof ListTopicsInputSchema>;

/** One topic row in `list_topics`. */
export const ListTopicsRowSchema = z.object({
  key: AbilityKeySchema,
  id: z.string(),
  class: z.enum(["general", "tool"]),
  title: z.string(),
  tiers: z.array(TierSchema),
  itemCount: z.number().int().nonnegative(),
});
export type ListTopicsRow = z.infer<typeof ListTopicsRowSchema>;

/** Result for `list_topics`. */
export const ListTopicsResultSchema = z.object({
  topics: z.array(ListTopicsRowSchema),
  catalogVersion: z.string(),
});
export type ListTopicsResult = z.infer<typeof ListTopicsResultSchema>;

/** Output for `list_topics` (may be gated). */
export const ListTopicsOutputSchema = gated(ListTopicsResultSchema);
export type ListTopicsOutput = z.infer<typeof ListTopicsOutputSchema>;

// ---------------------------------------------------------------------------
// get_guidance
// ---------------------------------------------------------------------------

/** Input for `get_guidance`. No `key` ⇒ pick weakest/stale for `tool`. */
export const GetGuidanceInputSchema = z.object({
  key: AbilityKeySchema.optional(),
  tool: ToolIdSchema.optional(),
});
export type GetGuidanceInput = z.infer<typeof GetGuidanceInputSchema>;

/** Result for `get_guidance`. */
export const GetGuidanceResultSchema = z.object({
  key: AbilityKeySchema,
  title: z.string(),
  currentTier: z.union([TierSchema, z.literal(0)]),
  guidance: z.string(),
  nextStep: z.object({
    action: z.enum(["quiz", "read"]),
    detail: z.string(),
  }),
});
export type GetGuidanceResult = z.infer<typeof GetGuidanceResultSchema>;

/** Output for `get_guidance` (may be gated). */
export const GetGuidanceOutputSchema = gated(GetGuidanceResultSchema);
export type GetGuidanceOutput = z.infer<typeof GetGuidanceOutputSchema>;

// ---------------------------------------------------------------------------
// start_quiz
// ---------------------------------------------------------------------------

/** Input for `start_quiz`. */
export const StartQuizInputSchema = z.object({
  key: AbilityKeySchema,
  length: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
});
export type StartQuizInput = z.infer<typeof StartQuizInputSchema>;

/**
 * An item as presented to the host agent. Deterministic items omit answer keys
 * and rubric/referenceAnswer; `free_form` items include `rubric.criteria` (with
 * ids) AND `referenceAnswer` so the host agent can judge.
 */
export const PresentedItemSchema = z.object({
  itemId: z.string(),
  tier: TierSchema,
  type: QuestionTypeSchema,
  prompt: z.string(),
  choices: z.array(ChoiceSchema).optional(),
  rubric: z.object({ criteria: z.array(RubricCriterionSchema) }).optional(),
  referenceAnswer: z.string().optional(),
});
export type PresentedItem = z.infer<typeof PresentedItemSchema>;

/** Result for `start_quiz`. */
export const StartQuizResultSchema = z.object({
  quizId: z.string(),
  items: z.array(PresentedItemSchema),
});
export type StartQuizResult = z.infer<typeof StartQuizResultSchema>;

/** Output for `start_quiz` (may be gated). */
export const StartQuizOutputSchema = gated(StartQuizResultSchema);
export type StartQuizOutput = z.infer<typeof StartQuizOutputSchema>;

// ---------------------------------------------------------------------------
// submit_answer
// ---------------------------------------------------------------------------

/** Deterministic answer payload (multiple_choice / short_answer). */
export const SubmitAnswerDeterministicInputSchema = z.object({
  quizId: z.string(),
  itemId: z.string(),
  answer: z.object({
    choiceId: z.string().optional(),
    text: z.string().optional(),
  }),
});
export type SubmitAnswerDeterministicInput = z.infer<
  typeof SubmitAnswerDeterministicInputSchema
>;

/**
 * Free-form per-criterion verdict from the host agent. A single-boolean verdict
 * is rejected as non-conformant (anti-gaming, critique E2): each criterion id
 * must carry its own `met` + `justification`. The MCP computes the score.
 */
export const FreeFormVerdictSchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().min(1),
        met: z.boolean(),
        justification: z.string().min(1),
      }),
    )
    .min(1),
});
export type FreeFormVerdict = z.infer<typeof FreeFormVerdictSchema>;

/** Free-form answer payload (host-agent verdict). */
export const SubmitAnswerFreeFormInputSchema = z.object({
  quizId: z.string(),
  itemId: z.string(),
  verdict: FreeFormVerdictSchema,
});
export type SubmitAnswerFreeFormInput = z.infer<
  typeof SubmitAnswerFreeFormInputSchema
>;

/**
 * Input for `submit_answer`: either a deterministic answer or a free-form
 * verdict. Discriminated structurally (presence of `answer` vs. `verdict`).
 */
export const SubmitAnswerInputSchema = z.union([
  SubmitAnswerDeterministicInputSchema,
  SubmitAnswerFreeFormInputSchema,
]);
export type SubmitAnswerInput = z.infer<typeof SubmitAnswerInputSchema>;

/** Result for `submit_answer`. */
export const SubmitAnswerResultSchema = z.object({
  grade: GradeSchema,
  score: z.number().min(0).max(1),
  correctAnswer: z.string().optional(),
  guidance: z.string(),
  ability: z.object({ before: z.number(), after: z.number() }),
  graduation: z
    .object({
      changed: z.boolean(),
      tier: TierSchema.optional(),
      status: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
});
export type SubmitAnswerResult = z.infer<typeof SubmitAnswerResultSchema>;

/** Output for `submit_answer` (may be gated). */
export const SubmitAnswerOutputSchema = gated(SubmitAnswerResultSchema);
export type SubmitAnswerOutput = z.infer<typeof SubmitAnswerOutputSchema>;

// ---------------------------------------------------------------------------
// save_config (not gated — clears the gate)
// ---------------------------------------------------------------------------

/** Input for `save_config`. */
export const SaveConfigInputSchema = z.object({
  toolsLearning: z.array(ToolIdSchema),
  offerCadence: z.enum(["off", "per_session", "per_topic"]),
  proactiveOffers: z.boolean(),
  quizLength: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
});
export type SaveConfigInput = z.infer<typeof SaveConfigInputSchema>;

/** Result/output for `save_config` (never gated). */
export const SaveConfigResultSchema = z.object({
  ok: z.literal(true),
  config: ConfigSchema,
});
export type SaveConfigResult = z.infer<typeof SaveConfigResultSchema>;
export const SaveConfigOutputSchema = SaveConfigResultSchema;
export type SaveConfigOutput = z.infer<typeof SaveConfigOutputSchema>;

// ---------------------------------------------------------------------------
// get_config (not gated — reports gate state)
// ---------------------------------------------------------------------------

/** Input for `get_config`. */
export const GetConfigInputSchema = z.object({});
export type GetConfigInput = z.infer<typeof GetConfigInputSchema>;

/** Result/output for `get_config` (never gated). */
export const GetConfigResultSchema = z.object({
  configured: z.boolean(),
  config: ConfigSchema.optional(),
});
export type GetConfigResult = z.infer<typeof GetConfigResultSchema>;
export const GetConfigOutputSchema = GetConfigResultSchema;
export type GetConfigOutput = z.infer<typeof GetConfigOutputSchema>;

// ---------------------------------------------------------------------------
// record_observation (trigger-only; never scores)
// ---------------------------------------------------------------------------

/** Input for `record_observation`. */
export const RecordObservationInputSchema = z.object({
  tool: ToolIdSchema,
  signals: z.array(
    z.object({
      toolName: z.string().optional(),
      mcpTool: z.string().optional(),
      success: z.boolean().optional(),
      toolUseId: z.string().optional(),
    }),
  ),
  sessionId: z.string(),
});
export type RecordObservationInput = z.infer<
  typeof RecordObservationInputSchema
>;

/** One offer candidate from `record_observation`. */
export const OfferCandidateSchema = z.object({
  key: AbilityKeySchema,
  title: z.string(),
  reason: z.string(),
});
export type OfferCandidate = z.infer<typeof OfferCandidateSchema>;

/** Result for `record_observation`. */
export const RecordObservationResultSchema = z.object({
  offerCandidates: z.array(OfferCandidateSchema),
});
export type RecordObservationResult = z.infer<
  typeof RecordObservationResultSchema
>;

/** Output for `record_observation` (may be gated). */
export const RecordObservationOutputSchema = gated(
  RecordObservationResultSchema,
);
export type RecordObservationOutput = z.infer<
  typeof RecordObservationOutputSchema
>;

// ---------------------------------------------------------------------------
// get_offer
// ---------------------------------------------------------------------------

/** Input for `get_offer`. */
export const GetOfferInputSchema = z.object({
  sessionId: z.string(),
  tool: ToolIdSchema,
});
export type GetOfferInput = z.infer<typeof GetOfferInputSchema>;

/** Result for `get_offer`. */
export const GetOfferResultSchema = z.object({
  offer: z
    .object({
      key: AbilityKeySchema,
      title: z.string(),
      prompt: z.string(),
    })
    .optional(),
  suppressed: z
    .enum(["cadence", "declined", "offers_off", "no_candidate"])
    .optional(),
});
export type GetOfferResult = z.infer<typeof GetOfferResultSchema>;

/** Output for `get_offer` (may be gated). */
export const GetOfferOutputSchema = gated(GetOfferResultSchema);
export type GetOfferOutput = z.infer<typeof GetOfferOutputSchema>;

// ---------------------------------------------------------------------------
// record_offer_response
// ---------------------------------------------------------------------------

/** Input for `record_offer_response`. */
export const RecordOfferResponseInputSchema = z.object({
  sessionId: z.string(),
  key: AbilityKeySchema,
  response: z.enum(["accept", "decline", "defer"]),
});
export type RecordOfferResponseInput = z.infer<
  typeof RecordOfferResponseInputSchema
>;

/** Result for `record_offer_response`. */
export const RecordOfferResponseResultSchema = z.object({
  ok: z.literal(true),
});
export type RecordOfferResponseResult = z.infer<
  typeof RecordOfferResponseResultSchema
>;

/** Output for `record_offer_response` (may be gated). */
export const RecordOfferResponseOutputSchema = gated(
  RecordOfferResponseResultSchema,
);
export type RecordOfferResponseOutput = z.infer<
  typeof RecordOfferResponseOutputSchema
>;
