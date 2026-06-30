/**
 * @file Learner Profile schemas (read-write, per-user, local at ~/.vibe-hero/).
 *
 * The profile is a single Zod-validated JSON document. Privacy-critical: only
 * derived grades/scores are persisted, never raw answer text (FR-018/024).
 *
 * Source of truth: specs/001-vibe-hero-mvp/data-model.md (§ Learner Profile).
 */

import { z } from "zod";
import {
  AbilityKeySchema,
  GradeSchema,
  TierSchema,
  ToolIdSchema,
} from "./common.js";

/** ISO-8601 datetime string. */
const IsoDateTimeSchema = z.string().datetime();

/**
 * User configuration written by the setup skill (FR-031). Absence of `config`
 * on the root profile is the first-run setup gate (FR-032).
 */
export const ConfigSchema = z.object({
  toolsLearning: z.array(ToolIdSchema).optional().default([]),
  offerCadence: z.enum(["off", "per_session", "per_topic"]),
  proactiveOffers: z.boolean(),
  quizLength: z.number().int().min(3).max(5).default(4),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
/** User configuration. */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Elo-style ability estimate for one {@link AbilityKey}. `itemsSeen` drives the
 * provisional → settled K-factor; `lastItemIds` avoids back-to-back repeats.
 *
 * `dwell` is the consecutive count of recent graded items that satisfied the
 * promotion-crossing condition (FR-008 / SC-014). It is the dwell counter the
 * pure graduation engine threads across `submit_answer` calls so a single fluke
 * item cannot promote — incremented while θ stays above the promotion bar and
 * reset to 0 the moment an item fails it. Defaulted to `0` so profiles written
 * before this field read forward without migration (additive, forward-compat).
 */
export const AbilityEstimateSchema = z.object({
  value: z.number(),
  itemsSeen: z.number().int().nonnegative(),
  lastAssessedAt: IsoDateTimeSchema,
  lastItemIds: z.array(z.string().min(1)),
  dwell: z.number().int().nonnegative().default(0),
});
/** An Elo-style ability estimate. */
export type AbilityEstimate = z.infer<typeof AbilityEstimateSchema>;

/**
 * Per-key graduation state with hysteresis (FR-008/009). `currentTier` is 0
 * until the learner first graduates.
 */
export const TierGraduationSchema = z.object({
  currentTier: z.union([TierSchema, z.literal(0)]),
  status: z.enum(["current", "due_for_review"]),
  graduatedAt: IsoDateTimeSchema,
  lastChangeReason: z.enum(["graduated", "demoted", "review_due"]),
});
/** Per-key tier graduation state. */
export type TierGraduation = z.infer<typeof TierGraduationSchema>;

/** An entry in the due-for-review queue. */
export const ReviewEntrySchema = z.object({
  key: AbilityKeySchema,
  dueAt: IsoDateTimeSchema,
  reason: z.enum(["spaced", "lapsed"]),
});
/** A spaced-repetition review entry. */
export type ReviewEntry = z.infer<typeof ReviewEntrySchema>;

/**
 * One graded item inside a {@link QuizRecord}. Persists only the derived grade
 * and continuous score — NO raw answer text (privacy, FR-018/024).
 */
export const AnsweredItemSchema = z.object({
  itemId: z.string().min(1),
  tier: TierSchema,
  difficulty: z.number(),
  grade: GradeSchema,
  score: z.number().min(0).max(1),
  gradedBy: z.enum(["engine", "host_agent"]),
  answeredAt: IsoDateTimeSchema,
});
/** A graded quiz item (no raw answer text). */
export type AnsweredItem = z.infer<typeof AnsweredItemSchema>;

/**
 * One quiz session. Only records with `completedAt` present count toward
 * graduation; partial sessions are discarded.
 */
export const QuizRecordSchema = z.object({
  id: z.string().min(1),
  key: AbilityKeySchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  items: z.array(AnsweredItemSchema),
  abilityBefore: z.number(),
  abilityAfter: z.number(),
});
/** A quiz session record. */
export type QuizRecord = z.infer<typeof QuizRecordSchema>;

/**
 * Per-session offer accounting (anti-fatigue, FR-020/020a). Reset per session
 * id. Under `per_session`: max 1 offer; a decline sets `declinedThisSession`
 * and suppresses further offers. Under `per_topic`: at most one offer per
 * distinct {@link AbilityKey} per session.
 *
 * `candidateKeys` is the per-session pool of topics that observed activity has
 * flagged as offer-worthy (accumulated by `record_observation` as signals
 * arrive). `get_offer` — which receives no signals of its own — resolves the
 * surfaced offer from this pool. It is distinct from `offeredTopicKeys`, which
 * records topics that have ALREADY surfaced (driving the `per_topic` cadence cap
 * and the cross-session backoff). Defaulted to `[]` so older persisted profiles
 * read forward without migration.
 */
export const OfferLedgerSchema = z.object({
  // Empty string denotes "no session bound yet" (fresh / reset profile); a real
  // session id is written when the first session begins.
  sessionId: z.string(),
  offersThisSession: z.number().int().nonnegative(),
  declinedThisSession: z.boolean(),
  offeredTopicKeys: z.array(AbilityKeySchema),
  candidateKeys: z.array(AbilityKeySchema).default([]),
});
/** Per-session offer ledger. */
export type OfferLedger = z.infer<typeof OfferLedgerSchema>;

/**
 * Cross-session backoff (FR-020b). Each decline lengthens the next-eligible
 * interval; after N consecutive declines offers are globally muted via
 * `mutedUntil`. An accept resets `consecutiveDeclines`.
 */
export const OfferBackoffSchema = z.object({
  consecutiveDeclines: z.number().int().nonnegative(),
  mutedUntil: IsoDateTimeSchema.optional(),
  perTopicNextEligibleAt: z.record(AbilityKeySchema, IsoDateTimeSchema),
});
/** Cross-session offer backoff state. */
export type OfferBackoff = z.infer<typeof OfferBackoffSchema>;

/**
 * Transient, privacy-safe observation event derived from a hook payload and/or
 * transcript record (correlated by `tool_use_id`, FR-017). Used only to
 * populate offer candidates; never stored as raw prompt/tool I/O (FR-018).
 */
export const ObservationEventSchema = z.object({
  tool: ToolIdSchema,
  topicKeys: z.array(AbilityKeySchema),
  success: z.boolean(),
  timestamp: IsoDateTimeSchema,
  correlationId: z.string().min(1),
});
/** A transient observation event. */
export type ObservationEvent = z.infer<typeof ObservationEventSchema>;

/** Current profile document schema version (migration guard). */
export const PROFILE_SCHEMA_VERSION = 1;

/**
 * One ability snapshot appended by `submit_answer` after each Elo update.
 * Used by `get_dashboard` to render ability-over-time history graphs.
 * Additive optional field — old profiles without `abilitySnapshots` default
 * to `[]` via the `.default([])` on {@link ProfileSchema}; no migration step
 * is needed (purely additive, forward-compatible with Zod defaults).
 */
export const AbilitySnapshotSchema = z.object({
  /** ISO datetime this snapshot was recorded. */
  ts: IsoDateTimeSchema,
  /** The ability key (class|topic) this snapshot is for. */
  key: AbilityKeySchema,
  /** The learner's ability value after this graded item. */
  ability: z.number(),
});
/** A single ability-over-time data point. */
export type AbilitySnapshot = z.infer<typeof AbilitySnapshotSchema>;

/**
 * The root learner profile document, persisted as a single JSON file. `config`
 * absent ⇒ first-run setup gate (FR-032). `abilities`/`graduations` are keyed
 * by {@link AbilityKeySchema} (`class|topic`).
 */
export const ProfileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  config: ConfigSchema.optional(),
  abilities: z.record(AbilityKeySchema, AbilityEstimateSchema),
  graduations: z.record(AbilityKeySchema, TierGraduationSchema),
  reviewSchedule: z.array(ReviewEntrySchema),
  quizHistory: z.array(QuizRecordSchema),
  offers: OfferLedgerSchema,
  backoff: OfferBackoffSchema,
  /**
   * Append-only log of ability snapshots (one per graded `submit_answer` call).
   * Drives the history graphs in `get_dashboard`. Additive; old profiles without
   * this field parse forward via `.default([])` — no migration step is needed.
   */
  abilitySnapshots: z.array(AbilitySnapshotSchema).default([]),
});
/** The root learner profile. */
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Build a valid, empty profile for first-run / corrupted-file recovery
 * (FR-023). `config` is intentionally omitted so the setup gate (FR-032)
 * engages until the user runs setup.
 *
 * @param now - ISO timestamp to stamp `createdAt`/`updatedAt` and the empty
 *   per-session ledger; defaults to the current time.
 */
export const emptyProfile = (now: string = new Date().toISOString()): Profile => ({
  schemaVersion: PROFILE_SCHEMA_VERSION,
  createdAt: now,
  updatedAt: now,
  abilities: {},
  graduations: {},
  reviewSchedule: [],
  quizHistory: [],
  offers: {
    sessionId: "",
    offersThisSession: 0,
    declinedThisSession: false,
    offeredTopicKeys: [],
    candidateKeys: [],
  },
  backoff: {
    consecutiveDeclines: 0,
    perTopicNextEligibleAt: {},
  },
  abilitySnapshots: [],
});
