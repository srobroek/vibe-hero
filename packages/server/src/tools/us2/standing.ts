/**
 * @file Shared standing/ranking helpers for the US-2 read tools (T025–T027).
 *
 * `get_status`, `get_guidance`, and (indirectly) `list_topics` all need the same
 * derivation: given the loaded catalog topics + the learner profile, compute the
 * per-(topic × class) standing — its {@link AbilityKey}, displayed tier, status,
 * and current ability — and rank topics by weakness so the weakest/stale one can
 * be suggested or auto-selected. Centralizing it here keeps the three tools DRY
 * and guarantees they agree on what "weak", "not_started", and "due_for_review"
 * mean.
 *
 * Pure + telemetry-free (SC-011): every value is derived from the catalog
 * (bundled or fetched) plus the profile's `abilities`/`graduations` — NO
 * observation/offer state is consulted, so the whole pull path works with zero
 * telemetry.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`get_status` / `get_guidance`), spec.md US-2 / FR-021 / SC-011.
 */

import { ASSESSMENT_CONFIG } from "../../config.js";
import {
  abilityKey,
  type AbilityKey,
  type ToolId,
} from "../../schemas/common.js";
import type { Topic } from "../../schemas/content.js";
import type { Profile } from "../../schemas/profile.js";
import type { StatusTopic } from "../../schemas/tools.js";

/**
 * A topic's computed standing, plus the source {@link Topic} so callers can read
 * its items/summary (e.g. for guidance text) without re-joining.
 */
export interface TopicStanding {
  /** The serialized `(class, topicId)` key this standing is keyed by. */
  readonly key: AbilityKey;
  /** The source catalog topic. */
  readonly topic: Topic;
  /** The per-topic status row, contract-shaped for `get_status`. */
  readonly row: StatusTopic;
}

/**
 * Whether `topic` is in scope for `tool`. A `general` topic is always in scope
 * (it applies to every tool); a tool-scoped topic is in scope only when its tool
 * matches. With no `tool` filter, every topic is in scope.
 */
export const topicInScope = (topic: Topic, tool?: ToolId): boolean => {
  if (tool === undefined) return true;
  return topic.class.kind === "general" || topic.class.tool === tool;
};

/**
 * Derive the standing for one topic from the profile (telemetry-free).
 *
 * - `tier`/`status` come from `graduations[key]`: a learner with no graduation
 *   entry has never graduated, so tier is `0` and status is `not_started`.
 *   Otherwise the displayed tier is `currentTier` and the status mirrors the
 *   graduation's `current` / `due_for_review`.
 * - `ability` comes from `abilities[key].value`, defaulting to the cold-start
 *   {@link ASSESSMENT_CONFIG.startingAbility} when the learner has no estimate
 *   yet (so a never-touched topic reports a sensible baseline, not `0`).
 */
export const standingFor = (topic: Topic, profile: Profile): TopicStanding => {
  const key = abilityKey(topic.class, topic.id);
  const graduation = profile.graduations[key];
  const ability = profile.abilities[key]?.value ?? ASSESSMENT_CONFIG.startingAbility;

  const row: StatusTopic =
    graduation === undefined
      ? { key, title: topic.title, tier: 0, status: "not_started", ability }
      : {
          key,
          title: topic.title,
          tier: graduation.currentTier,
          status: graduation.status,
          ability,
        };

  return { key, topic, row };
};

/**
 * Compute every in-scope topic's standing, in catalog order.
 *
 * @param topics - The loaded catalog topics (bundled or fetched).
 * @param profile - The learner profile (only `abilities`/`graduations` are read).
 * @param tool - Optional tool filter; see {@link topicInScope}.
 */
export const computeStandings = (
  topics: readonly Topic[],
  profile: Profile,
  tool?: ToolId,
): TopicStanding[] =>
  topics
    .filter((topic) => topicInScope(topic, tool))
    .map((topic) => standingFor(topic, profile));

/**
 * Weakness ordering for suggestions / weakest-pick (lower ⇒ weaker ⇒ surfaced
 * first):
 *   1. `not_started` topics rank ahead of any started topic (they are the most
 *      valuable next step and need no telemetry to identify).
 *   2. within each group, lower `ability` ranks first (the weakest area).
 *   3. ties break on `key` for a stable, deterministic total order.
 *
 * @returns A negative/zero/positive comparator result for `Array#sort`.
 */
export const byWeakness = (a: TopicStanding, b: TopicStanding): number => {
  const aNotStarted = a.row.status === "not_started" ? 0 : 1;
  const bNotStarted = b.row.status === "not_started" ? 0 : 1;
  if (aNotStarted !== bNotStarted) return aNotStarted - bNotStarted;
  if (a.row.ability !== b.row.ability) return a.row.ability - b.row.ability;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

/**
 * Rank in-scope standings weakest-first (stable, deterministic).
 * A copy is returned; the input is never mutated.
 */
export const rankByWeakness = (
  standings: readonly TopicStanding[],
): TopicStanding[] => [...standings].sort(byWeakness);

/**
 * A short, human reason for why a topic is suggested as a next step.
 * `not_started` topics are framed as "not started yet"; everything else as a
 * relative-weakness nudge.
 */
export const suggestionReason = (standing: TopicStanding): string =>
  standing.row.status === "not_started"
    ? "Not started yet — a good place to begin."
    : standing.row.status === "due_for_review"
      ? "Due for review — knowledge may be going stale."
      : `Weakest area so far (ability ≈ ${Math.round(standing.row.ability)}).`;
