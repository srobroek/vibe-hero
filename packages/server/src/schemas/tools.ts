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
 * The unsupported-tool gate sentinel. Returned by any gated tool when the host's
 * MCP `clientInfo.name` does not map to a supported {@link ToolId} AND no valid
 * `toolsLearning` is configured. vibe-hero only supports Claude Code, Codex,
 * Kiro CLI, and Kiro IDE; unknown hosts must fail explicitly rather than silently
 * defaulting to claude-code.
 */
export const UnsupportedToolSchema = z.object({
  status: z.literal("UNSUPPORTED_TOOL"),
  /** Raw `clientInfo.name` from the MCP handshake (or empty string if absent). */
  detectedName: z.string(),
  message: z.string().min(1),
  /** The ToolIds vibe-hero currently supports. */
  supported: z.array(z.string()),
});
/** The UNSUPPORTED_TOOL gate sentinel. */
export type UnsupportedTool = z.infer<typeof UnsupportedToolSchema>;

/**
 * Wrap a tool result schema so it can also be either gate sentinel.
 * Callers narrow on the `status` discriminant field.
 */
const gated = <T extends z.ZodTypeAny>(result: T) =>
  z.union([SetupRequiredSchema, UnsupportedToolSchema, result]);

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

/**
 * Input for `start_quiz`.
 *
 * `allowFreeForm` is the graceful-degradation switch (FR-014, T049): when the
 * host agent cannot judge a free-form answer (no judging capability), the caller
 * passes `false` and the selection EXCLUDES `free_form` items, preferring
 * deterministic ones so the quiz still completes rather than serving an
 * unjudgeable item. It defaults to `true` (free-form judging is available).
 */
export const StartQuizInputSchema = z.object({
  key: AbilityKeySchema,
  length: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
  allowFreeForm: z.boolean().optional(),
  /**
   * Optional: the active session id. When provided, `start_quiz` resets the
   * per-session offer arm so the UserPromptSubmit hook falls silent until the
   * cooldown elapses (i.e. quiz started → arm cleared → cooldown restarts).
   * Omitting it is safe (arm is simply left untouched — backward-compat).
   */
  sessionId: z.string().optional(),
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
  /**
   * Hard presentation directive for the host agent, set by the server from the
   * item type: `menu` (present the supplied choices; a selection UI is fine)
   * or `open` (ask in plain prose and wait for typed input; NEVER a menu, NEVER
   * agent-invented options — fabricated options paraphrase the rubric/reference
   * and leak the answer, turning recall into recognition).
   */
  presentation: z.enum(["menu", "open"]).optional(),
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
// submit_answers (batch)
// ---------------------------------------------------------------------------

/**
 * One answer inside a `submit_answers` batch: the item id plus EITHER a
 * deterministic `answer` XOR a free-form `verdict` (same union semantics as
 * the single `submit_answer`, re-validated per item by the handler).
 */
export const BatchAnswerSchema = z.object({
  itemId: z.string(),
  answer: z
    .object({
      choiceId: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  verdict: FreeFormVerdictSchema.optional(),
});
export type BatchAnswer = z.infer<typeof BatchAnswerSchema>;

/** Input for `submit_answers`: every answer of one quiz in a single call. */
export const SubmitAnswersInputSchema = z.object({
  quizId: z.string(),
  answers: z.array(BatchAnswerSchema).min(1),
});
export type SubmitAnswersInput = z.infer<typeof SubmitAnswersInputSchema>;

/** Per-item result row in `submit_answers` (same shape as `submit_answer`). */
export const BatchItemResultSchema = z.object({
  itemId: z.string(),
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
export type BatchItemResult = z.infer<typeof BatchItemResultSchema>;

/** Result for `submit_answers`. */
export const SubmitAnswersResultSchema = z.object({
  results: z.array(BatchItemResultSchema),
  /** Ability across the whole batch: before item 1 → after the last item. */
  ability: z.object({ before: z.number(), after: z.number() }),
  /** Count of `grade === "correct"` rows, for a quick recap. */
  correctCount: z.number().int().nonnegative(),
});
export type SubmitAnswersResult = z.infer<typeof SubmitAnswersResultSchema>;

/** Output for `submit_answers` (may be gated). */
export const SubmitAnswersOutputSchema = gated(SubmitAnswersResultSchema);
export type SubmitAnswersOutput = z.infer<typeof SubmitAnswersOutputSchema>;

// ---------------------------------------------------------------------------
// save_config (not gated — clears the gate)
// ---------------------------------------------------------------------------

/** Input for `save_config`. */
export const SaveConfigInputSchema = z.object({
  toolsLearning: z.array(ToolIdSchema).optional(),
  offerCadence: z.enum(["off", "per_session", "per_topic"]),
  proactiveOffers: z.boolean(),
  quizLength: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
  organicEagerness: z.enum(["often", "normal", "rarely"]).optional(),
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
  tool: ToolIdSchema.optional(),
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
  tool: ToolIdSchema.optional(),
  /**
   * When true, the result carries a `diagnostics` block explaining the
   * decision: per-session organic evidence weights vs. the arming threshold,
   * pending/armed state, candidate pool, and which gate suppressed (if any).
   * Read-only -- enabling it never changes offer state.
   */
  debug: z.boolean().optional(),
});
export type GetOfferInput = z.infer<typeof GetOfferInputSchema>;

/** Per-session organic snapshot inside `get_offer` diagnostics. */
export const OfferDiagnosticsSessionSchema = z.object({
  /** In-window evidence weight per topic key. */
  weights: z.record(z.string(), z.number()),
  /** Topic pending promotion (threshold crossed, awaiting seam/quiet). */
  pendingKey: AbilityKeySchema.optional(),
  /** Topic currently armed for the hook relay. */
  armedKey: AbilityKeySchema.optional(),
  lastSignalAt: z.string().optional(),
});

/**
 * Diagnostics block for `get_offer` (`debug: true`). Answers "why (not)?"
 * in one call instead of requiring a read of the raw profile JSON.
 */
export const OfferDiagnosticsSchema = z.object({
  /** The gate that suppressed, or null when an offer was returned. */
  suppressedBy: z
    .enum(["cadence", "declined", "offers_off", "no_candidate"])
    .nullable(),
  /** Arming threshold (evidence weight) for the configured eagerness. */
  threshold: z.number(),
  /** Rolling evidence window in seconds. */
  windowSeconds: z.number(),
  /** Effective offer cooldown in seconds (0 = throttle disabled). */
  cooldownSeconds: z.number(),
  /** The merged candidate pool the decision ran against, in order. */
  candidates: z.array(AbilityKeySchema),
  /** Organic state for every live session in this home, keyed by sessionId. */
  sessions: z.record(z.string(), OfferDiagnosticsSessionSchema),
});
export type OfferDiagnostics = z.infer<typeof OfferDiagnosticsSchema>;

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
  /** Present only when the call passed `debug: true`. */
  diagnostics: OfferDiagnosticsSchema.optional(),
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

// ---------------------------------------------------------------------------
// get_dashboard
// ---------------------------------------------------------------------------

/** Input for `get_dashboard`. `tool` narrows the matrix to one tool scope. */
export const GetDashboardInputSchema = z.object({
  tool: ToolIdSchema.optional(),
});
export type GetDashboardInput = z.infer<typeof GetDashboardInputSchema>;

/**
 * One cell in the dashboard matrix.  `scope` is either `"general"` or a
 * {@link ToolId}.  `status` mirrors the graduation status.  `markers` collects
 * any combination of `"graduated"` | `"due"` | `"in_review"`.
 * A `null` cell (topic not offered by that scope) is represented by absence of
 * the cell in the array OR by a cell with `status: "not_in_scope"`.
 */
export const DashboardCellSchema = z.object({
  scope: z.string(),
  tier: z.union([TierSchema, z.literal(0)]),
  ability: z.number(),
  status: z.enum(["current", "due_for_review", "not_started", "not_in_scope"]),
  markers: z.array(z.enum(["graduated", "due", "in_review"])),
});
export type DashboardCell = z.infer<typeof DashboardCellSchema>;

/** One row in the dashboard matrix — one per catalog topic. */
export const DashboardRowSchema = z.object({
  topic: z.string(),
  title: z.string(),
  class: z.enum(["general", "tool"]),
  cells: z.array(DashboardCellSchema),
});
export type DashboardRow = z.infer<typeof DashboardRowSchema>;

/** Aggregated summary over the whole profile (or filtered tool). */
export const DashboardSummarySchema = z.object({
  itemsAnswered: z.number().int().nonnegative(),
  graduated: z.number().int().nonnegative(),
  dueForReview: z.number().int().nonnegative(),
  streak: z.number().int().nonnegative(),
  strongest: AbilityKeySchema.optional(),
  weakest: AbilityKeySchema.optional(),
  next: AbilityKeySchema.optional(),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

/**
 * One entry in the history series — per-scope mean ability over time.
 * `points` is sorted ascending by `ts`.  Only scopes that have ≥1
 * abilitySnapshot are included.
 */
export const DashboardHistoryEntrySchema = z.object({
  scope: z.string(),
  points: z.array(z.object({ ts: z.string(), meanAbility: z.number() })),
});
export type DashboardHistoryEntry = z.infer<typeof DashboardHistoryEntrySchema>;

/** Result for `get_dashboard`. */
export const GetDashboardResultSchema = z.object({
  matrix: z.array(DashboardRowSchema),
  summary: DashboardSummarySchema,
  history: z.array(DashboardHistoryEntrySchema),
  /**
   * Server-rendered fixed-width dashboard text.  The agent MUST output this
   * verbatim inside a code block — no reformatting, no improvisation.
   */
  rendered: z.string(),
});
export type GetDashboardResult = z.infer<typeof GetDashboardResultSchema>;

/** Output for `get_dashboard` (may be gated). */
export const GetDashboardOutputSchema = gated(GetDashboardResultSchema);
export type GetDashboardOutput = z.infer<typeof GetDashboardOutputSchema>;
