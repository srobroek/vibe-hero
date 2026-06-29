/**
 * @file Real `get_guidance` tool module (T027, US-2).
 *
 * Returns teaching guidance plus a concrete next step for a topic. Given a `key`
 * it guides on that exact `(topic × class)`; with NO `key` it auto-selects the
 * learner's weakest/stale in-scope topic (the same weakness ranking
 * `get_status` uses for `suggestions`) so "what should I learn next?" resolves
 * without the user naming a topic.
 *
 * Guidance text is pulled from the topic's authored content: the `guidance` of
 * an item at — or, failing that, nearest above — the learner's current tier,
 * falling back to the topic `summary` when the topic has no items. The next step
 * is a `quiz` when the topic has gradeable items (the practice path, FR-021),
 * else a `read` nudge toward the summary.
 *
 * Telemetry-free (SC-011): everything is derived from the bundled catalog + the
 * profile's `abilities`/`graduations`; no observation/offer state is read.
 * Gated (FR-032) — `index.ts` returns SETUP_REQUIRED before the handler runs
 * when unconfigured, so `config.toolsLearning` is available for the default tool.
 *
 * Exposed as a `dirOverride`-closing factory mirroring `config.ts`.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`get_guidance`), spec.md US-2 / FR-021 / SC-011.
 */

import { loadBundledCatalog } from "../catalog/bundled/index.js";
import { loadProfile } from "../profile/store.js";
import {
  abilityKey,
  parseAbilityKey,
  type AbilityKey,
  type ToolId,
} from "../schemas/common.js";
import type { ContentItem, Topic } from "../schemas/content.js";
import type { Profile } from "../schemas/profile.js";
import {
  GetGuidanceInputSchema,
  type GetGuidanceInput,
  type GetGuidanceResult,
} from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";
import {
  computeStandings,
  rankByWeakness,
  standingFor,
  type TopicStanding,
} from "./us2/standing.js";

/** Resolve the default tool (explicit → first learning → claude-code). */
const resolveTool = (
  requested: ToolId | undefined,
  toolsLearning: readonly ToolId[],
): ToolId => requested ?? toolsLearning[0] ?? "claude-code";

/** Find the catalog topic whose `(class, id)` serializes to `key`. */
const findTopicByKey = (
  topics: readonly Topic[],
  key: AbilityKey,
): Topic | undefined =>
  topics.find((topic) => abilityKey(topic.class, topic.id) === key);

/**
 * Pick the authored item whose `guidance` best fits `currentTier`: prefer an
 * item AT the current tier (or tier 100 when the learner has not graduated, so
 * tier is 0), else the nearest item ABOVE it, else any item. Returns `undefined`
 * only when the topic has no items at all.
 */
const guidanceItemFor = (
  topic: Topic,
  currentTier: number,
): ContentItem | undefined => {
  if (topic.items.length === 0) return undefined;
  const floor = currentTier === 0 ? 100 : currentTier;

  const atTier = topic.items.find((item) => item.tier === floor);
  if (atTier !== undefined) return atTier;

  const above = [...topic.items]
    .filter((item) => item.tier >= floor)
    .sort((a, b) => a.tier - b.tier)[0];
  if (above !== undefined) return above;

  // Below the floor (learner graduated past authored content): take the highest.
  return [...topic.items].sort((a, b) => b.tier - a.tier)[0];
};

/** Build the contract result for one resolved topic standing. */
const guidanceResultFor = (standing: TopicStanding): GetGuidanceResult => {
  const { topic, key, row } = standing;
  const item = guidanceItemFor(topic, row.tier);
  const guidance = item?.guidance ?? topic.summary;

  const nextStep: GetGuidanceResult["nextStep"] =
    topic.items.length > 0
      ? {
          action: "quiz",
          detail: `Try a short quiz on "${topic.title}" to ${
            row.status === "not_started" ? "establish a baseline" : "reinforce and advance"
          }.`,
        }
      : {
          action: "read",
          detail: `Review "${topic.title}": ${topic.summary}`,
        };

  return { key, title: topic.title, currentTier: row.tier, guidance, nextStep };
};

/**
 * Resolve the standing `get_guidance` should report on. With a `key`, guide on
 * that exact topic (scoped via its own class). With no `key`, auto-select the
 * weakest/stale in-scope topic for the resolved tool.
 *
 * @throws {Error} if a supplied `key` matches no catalog topic.
 */
const resolveStanding = (
  input: GetGuidanceInput,
  topics: readonly Topic[],
  profile: Profile,
): TopicStanding => {
  if (input.key !== undefined) {
    // Validate the key shape (throws on malformed) before lookup.
    parseAbilityKey(input.key);
    const topic = findTopicByKey(topics, input.key);
    if (topic === undefined) {
      throw new Error(
        `get_guidance: no catalog topic matches key ${JSON.stringify(input.key)}`,
      );
    }
    return standingFor(topic, profile);
  }

  const tool = resolveTool(input.tool, profile.config?.toolsLearning ?? []);
  const ranked = rankByWeakness(computeStandings(topics, profile, tool));
  const weakest = ranked[0];
  if (weakest === undefined) {
    throw new Error(
      `get_guidance: no topics available for tool ${JSON.stringify(tool)}`,
    );
  }
  return weakest;
};

/**
 * Build the `get_guidance` tool module (US-2).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @returns The erased registry entry for `get_guidance`.
 */
export const makeGetGuidanceTool = (dirOverride?: string): AnyToolModule =>
  defineTool({
    name: "get_guidance",
    description:
      "Return teaching guidance and what to learn next for a topic or the weakest area. Read-only.",
    inputSchema: GetGuidanceInputSchema,
    handler: async (input: GetGuidanceInput): Promise<GetGuidanceResult> => {
      const profile = await loadProfile(dirOverride);
      const { topics } = loadBundledCatalog();
      const standing = resolveStanding(input, topics, profile);
      return guidanceResultFor(standing);
    },
  });

/** Default `get_guidance` module (env / `~/.vibe-hero`), used by the registry. */
export const getGuidanceTool: AnyToolModule = makeGetGuidanceTool();
