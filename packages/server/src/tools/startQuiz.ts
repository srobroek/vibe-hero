/**
 * @file Real `start_quiz` tool module (T031, US-1).
 *
 * Begins a quiz session for one `(topic × class)`: it resolves the topic by key,
 * reads the learner's current ability (cold-start default
 * {@link ASSESSMENT_CONFIG.startingAbility}), computes the next tier boundary
 * above their current tier, and asks the pure {@link selectItems} engine to pick
 * a small bounded set (3–5, default {@link ASSESSMENT_CONFIG.defaultQuizLength})
 * of difficulty-targeted items — excluding the items most recently served
 * (`abilities[key].lastItemIds`) so a session never re-serves the same item
 * back-to-back (edge case "repeated identical questions").
 *
 * It then creates a {@link QuizRecord} (`startedAt`, NO `completedAt` — a partial
 * session must never count toward graduation, FR-008a) and persists it via the
 * store's atomic {@link updateProfile}. The returned `items` are
 * {@link PresentedItem}s with **answer keys STRIPPED** for deterministic types —
 * the engine must never leak the correct answer before grading (contract;
 * SC-004 reproducibility relies on grading server-side, not the client knowing
 * the key).
 *
 * Free-form (v1, T048/T049): `start_quiz` now SUPPORTS `free_form` items in
 * selection. A presented `free_form` item carries `rubric.criteria` (with ids)
 * AND `referenceAnswer` so the host agent can run the judging handshake
 * (`submit_answer` free-form path, T048). Deterministic items still strip every
 * answer key — the engine grades them server-side (SC-004).
 *
 * Graceful degradation (FR-014, T049): when free-form judging is UNAVAILABLE —
 * the host agent can't judge an open answer — the caller passes
 * `allowFreeForm: false`. Selection then EXCLUDES `free_form` items, preferring
 * deterministic ones so the quiz still completes rather than serving an
 * unjudgeable item. The flag defaults to `true` (judging available); a quiz
 * therefore never gets stuck with only an unjudgeable item — if the topic has
 * deterministic items they are served instead.
 *
 * Gated (FR-032): NOT exempt — `index.ts`/`withSetupGate` returns SETUP_REQUIRED
 * before this handler runs when `profile.config` is absent.
 *
 * Exposed as a `dirOverride`-closing factory mirroring `config.ts` / `status.ts`:
 * the registry uses the default instance (env / `~/.vibe-hero`); tests build a
 * dir-scoped instance against a temp home.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (`start_quiz`),
 * spec.md FR-008a / FR-011 / FR-018, data-model.md (QuizRecord), research.md
 * (OD-005 selection).
 */

import { randomUUID } from "node:crypto";

import { ASSESSMENT_CONFIG } from "../config.js";
import { resolveCatalog, type ResolvedCatalog } from "../catalog/resolve.js";
import type { CatalogLoadResult } from "../catalog/loader.js";
import { selectItems } from "../engine/selection.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import { abilityKey, parseAbilityKey, type AbilityKey } from "../schemas/common.js";
import type { ContentItem, Topic } from "../schemas/content.js";
import type { Profile, QuizRecord } from "../schemas/profile.js";
import {
  StartQuizInputSchema,
  type PresentedItem,
  type StartQuizInput,
  type StartQuizResult,
} from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";

/** Find the catalog topic whose `(class, id)` serializes to `key`. */
const findTopicByKey = (
  topics: readonly Topic[],
  key: AbilityKey,
): Topic | undefined =>
  topics.find((topic) => abilityKey(topic.class, topic.id) === key);

/**
 * Compute the difficulty of the next tier boundary ABOVE a learner at
 * `currentTier`, which the selection engine clamps its difficulty target to (the
 * "promotion bar"). The boundaries sit halfway between tier centers
 * (`tierBoundaries = [150, 250, 350, 450]`):
 *  - not yet graduated (tier 0) or at tier 100 ⇒ the first boundary (150).
 *  - tier 200 ⇒ 250, tier 300 ⇒ 350, tier 400 ⇒ 450.
 *  - tier 500 (top) ⇒ the last boundary (450); there is no higher bar.
 *
 * Indexing: boundary `i` lies just above tier center `i` (100→[0], 200→[1] …),
 * so the next boundary above tier `t` is `tierBoundaries[centerIndex(t)]`,
 * clamped to the last boundary at the top tier.
 *
 * @param currentTier - The learner's current tier (0 = not yet graduated).
 * @returns The difficulty of the next boundary to target.
 */
export const nextBoundaryFor = (currentTier: number): number => {
  const { tierCenters, tierBoundaries } = ASSESSMENT_CONFIG;
  // Tier 0 (ungraduated) behaves like the bottom rung: aim at the first boundary.
  if (currentTier <= tierCenters[0]!) return tierBoundaries[0]!;
  const centerIndex = tierCenters.indexOf(currentTier as (typeof tierCenters)[number]);
  // Unknown tier (defensive) or the top tier: clamp to the last boundary.
  if (centerIndex < 0 || centerIndex >= tierBoundaries.length) {
    return tierBoundaries[tierBoundaries.length - 1]!;
  }
  return tierBoundaries[centerIndex]!;
};

/**
 * Strip an item to its presented form. Deterministic items (`multiple_choice` /
 * `short_answer`) carry NO answer key and NO rubric/referenceAnswer — the host
 * agent and user must never see the correct answer before grading. MC keeps its
 * `choices` (without marking the correct one). `free_form` items carry
 * `rubric.criteria` (ids + text) + `referenceAnswer` so the host agent can run
 * the judging handshake (T048) — the rubric here is the agent's INSTRUCTION, not
 * a leaked deterministic key.
 */
const toPresentedItem = (item: ContentItem): PresentedItem => {
  const base: PresentedItem = {
    itemId: item.id,
    tier: item.tier,
    type: item.type,
    prompt: item.prompt,
  };
  if (item.type === "multiple_choice") {
    // Present choices WITHOUT the answer key — the correct id never leaves here.
    return { ...base, choices: item.choices };
  }
  if (item.type === "free_form" && item.rubric !== undefined) {
    // Judging handshake (T048): hand the agent criteria + reference answer.
    return {
      ...base,
      rubric: { criteria: item.rubric.criteria },
      referenceAnswer: item.rubric.referenceAnswer,
    };
  }
  // short_answer: prompt only, no answer key leaked.
  return base;
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
 * bundled. Mirrors {@link resolveCatalog}'s signature so the seam is compatible
 * with both the production resolver and test fakes.
 */
export type CatalogResolver = (dirOverride?: string) => Promise<ResolvedCatalog>;

/**
 * Build the `start_quiz` tool module (US-1).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @param loaderOrResolver - Catalog source seam (test seam); accepts a sync
 *   {@link CatalogLoader} (test fixtures) or an async {@link CatalogResolver}
 *   (production). Defaults to {@link resolveCatalog} (fresh-fetch → cache →
 *   bundled). With no `VIBE_HERO_CONTENT_URL` set, resolver falls back to
 *   bundled — identical to the prior behavior offline.
 */
export const makeStartQuizTool = (
  dirOverride?: string,
  loaderOrResolver: CatalogLoader | CatalogResolver = resolveCatalog,
): AnyToolModule =>
  defineTool({
    name: "start_quiz",
    description:
      "Begin a quiz session for a topic, selecting 3-5 difficulty-targeted items.",
    inputSchema: StartQuizInputSchema,
    handler: async (input: StartQuizInput): Promise<StartQuizResult> => {
      const key = input.key;
      // Validate the key shape (throws on malformed) before any lookup.
      parseAbilityKey(key);

      const profile = await loadProfile(dirOverride);
      // Normalize: sync loader (tests) vs async resolver (production).
      const rawResult = loaderOrResolver(dirOverride);
      const { topics } = rawResult instanceof Promise ? await rawResult : rawResult;

      const topic = findTopicByKey(topics, key);
      if (topic === undefined) {
        throw new Error(
          `start_quiz: no catalog topic matches key ${JSON.stringify(key)}`,
        );
      }

      const estimate = profile.abilities[key];
      const ability = estimate?.value ?? ASSESSMENT_CONFIG.startingAbility;
      const currentTier = profile.graduations[key]?.currentTier ?? 0;

      // Graceful degradation (FR-014, T049): free-form items are eligible only
      // when the host can judge them (`allowFreeForm`, default true). When
      // judging is unavailable the caller passes `false` and we EXCLUDE
      // `free_form`, leaving the deterministic backbone so the quiz still
      // completes rather than serving an unjudgeable item.
      const allowFreeForm = input.allowFreeForm ?? true;
      const candidates = allowFreeForm
        ? topic.items
        : topic.items.filter((item) => item.type !== "free_form");

      const length = input.length ?? ASSESSMENT_CONFIG.defaultQuizLength;
      const selected = selectItems({
        ability,
        candidates,
        nextBoundary: nextBoundaryFor(currentTier),
        recentItemIds: estimate?.lastItemIds ?? [],
        length,
      });

      const quizId = randomUUID();
      const startedAt = new Date().toISOString();
      const record: QuizRecord = {
        id: quizId,
        key,
        startedAt,
        // NO completedAt — partial sessions never count toward graduation.
        items: [],
        abilityBefore: ability,
        // Unchanged until items are graded; submit_answer advances it.
        abilityAfter: ability,
      };

      await updateProfile(
        (current: Profile) => ({
          ...current,
          quizHistory: [...current.quizHistory, record],
        }),
        dirOverride,
      );

      return {
        quizId,
        items: selected.map(toPresentedItem),
      };
    },
  });

/** Default `start_quiz` module (env / `~/.vibe-hero`), used by the registry. */
export const startQuizTool: AnyToolModule = makeStartQuizTool();
