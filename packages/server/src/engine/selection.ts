/**
 * @file PURE item-selection engine (T011, OD-005 / research.md).
 *
 * Chooses the items for one quiz session for a single (topic × class) given the
 * learner's current ability θ, the topic's candidate items (with FIXED authored
 * difficulties), the target tier's next boundary, and a recent-item exclusion
 * set. Difficulty-targets at the promotion bar so "passing a set" ≈ "ready to
 * graduate", while an information-weighted window avoids always serving the
 * hardest item.
 *
 * This module is IO-FREE and time-free (E5) and never mutates item difficulty
 * (E3): items are read-only inputs.
 *
 * Selection rule (OD-005):
 *   target = min(θ + targetOffset, nextBoundary + hysteresisMargin)
 *   pool   = items with |difficulty − target| ≤ selectWindow, excluding recents
 *   weight = p · (1 − p), p = expectedScore(θ, difficulty)  // Fisher info ∝ p(1−p)
 *   pick `length` items by weight; ALWAYS include one "anchor" item within
 *   ±anchorWindow of θ if one exists in the pool.
 *
 * Determinism: this function NEVER calls `Math.random`. Sampling is deterministic
 * given the inputs. By default it picks the top-weighted items (ties broken by
 * item id for total order). Callers that want stochastic-but-reproducible
 * sampling may inject a seeded {@link Rng}; the same seed ⇒ the same output.
 *
 * Source of truth: specs/001-vibe-hero-mvp/research.md (OD-005);
 * constants in ../config.ts (ASSESSMENT_CONFIG).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import type { ContentItem } from "../schemas/content.js";
import { expectedScore } from "./elo.js";

/**
 * A deterministic, reproducible random source returning values in `[0, 1)`.
 * Injecting one makes weighted sampling stochastic yet repeatable. Omit it for
 * the default deterministic top-weighted strategy.
 */
export type Rng = () => number;

/** Parameters for {@link selectItems}. */
export interface SelectItemsParams {
  /** The learner's current ability estimate (θ). */
  readonly ability: number;
  /**
   * Candidate items for the topic (any tier). FIXED authored difficulties;
   * read-only — never mutated by selection.
   */
  readonly candidates: readonly ContentItem[];
  /**
   * Difficulty of the next tier boundary above the learner (the promotion bar
   * the target is clamped to). E.g. for tier 300 this is the 350 boundary.
   */
  readonly nextBoundary: number;
  /** Item ids to exclude (recently served), to avoid immediate repeats. */
  readonly recentItemIds?: readonly string[];
  /**
   * Number of items to return (3–5). Defaults to
   * {@link ASSESSMENT_CONFIG.defaultQuizLength}. If fewer eligible candidates
   * exist, returns what is available.
   */
  readonly length?: number;
  /**
   * Optional injected RNG for reproducible weighted sampling. When omitted,
   * selection is deterministic top-weighted (no `Math.random`).
   */
  readonly rng?: Rng;
}

/** A candidate paired with its computed information weight. */
interface WeightedCandidate {
  readonly item: ContentItem;
  /** Fisher information proxy p·(1−p); higher ⇒ more informative. */
  readonly weight: number;
}

/**
 * Total ordering used to break ties deterministically: descending weight, then
 * ascending item id. Guarantees a single canonical order for equal weights so
 * the default (RNG-free) path is fully reproducible.
 */
const byWeightThenId = (a: WeightedCandidate, b: WeightedCandidate): number =>
  b.weight - a.weight || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);

/**
 * Draw `count` items from `pool` proportional to weight using an injected RNG,
 * without replacement. Deterministic for a given RNG sequence. Falls back to
 * uniform choice if all remaining weights are zero.
 */
const weightedSampleWithoutReplacement = (
  pool: readonly WeightedCandidate[],
  count: number,
  rng: Rng,
): ContentItem[] => {
  const remaining = [...pool];
  const picked: ContentItem[] = [];
  while (picked.length < count && remaining.length > 0) {
    const total = remaining.reduce((sum, c) => sum + c.weight, 0);
    let index = 0;
    if (total > 0) {
      const threshold = rng() * total;
      let acc = 0;
      for (let i = 0; i < remaining.length; i++) {
        acc += remaining[i]!.weight;
        if (acc >= threshold) {
          index = i;
          break;
        }
      }
    } else {
      // All-zero weights: uniform pick over the remaining pool.
      index = Math.min(remaining.length - 1, Math.floor(rng() * remaining.length));
    }
    picked.push(remaining[index]!.item);
    remaining.splice(index, 1);
  }
  return picked;
};

/**
 * Select 3–5 items for a quiz session (PURE; see file header for the rule).
 *
 * Items are read-only inputs; their difficulty is never mutated (E3). No clock,
 * file, or network access (E5). Output is deterministic for identical inputs
 * (and identical injected {@link Rng} sequence, if any).
 *
 * Behaviour summary:
 * - Builds `target = min(θ + targetOffset, nextBoundary + hysteresisMargin)`.
 * - Pool = candidates within ±`selectWindow` of `target`, excluding
 *   `recentItemIds`.
 * - Weights each by `p·(1−p)` (`p = expectedScore(θ, difficulty)`).
 * - Guarantees one anchor item within ±`anchorWindow` of θ (the most
 *   informative such item) is included when one exists in the pool.
 * - Returns at most `length` items; fewer if the pool is smaller.
 *
 * @returns The chosen items, length ≤ `length`, anchor-first when an anchor
 *   exists, then the remaining picks.
 */
export const selectItems = (params: SelectItemsParams): ContentItem[] => {
  const {
    ability,
    candidates,
    nextBoundary,
    recentItemIds = [],
    length = ASSESSMENT_CONFIG.defaultQuizLength,
    rng,
  } = params;

  if (length <= 0) return [];

  const { targetOffset, hysteresisMargin, selectWindow, anchorWindow } =
    ASSESSMENT_CONFIG;

  const target = Math.min(ability + targetOffset, nextBoundary + hysteresisMargin);
  const excluded = new Set(recentItemIds);

  // Eligible pool: within ±selectWindow of target, not recently served.
  const pool: WeightedCandidate[] = candidates
    .filter(
      (item) =>
        !excluded.has(item.id) &&
        Math.abs(item.difficulty - target) <= selectWindow,
    )
    .map((item) => {
      const p = expectedScore(ability, item.difficulty);
      return { item, weight: p * (1 - p) };
    });

  if (pool.length === 0) return [];

  // Pick the anchor: most-informative item within ±anchorWindow of θ.
  // Deterministic ordering guarantees a stable choice on ties.
  const anchorPool = pool
    .filter((c) => Math.abs(c.item.difficulty - ability) <= anchorWindow)
    .sort(byWeightThenId);
  const anchor = anchorPool[0]?.item;

  const remainingNeeded = anchor ? length - 1 : length;
  const rest = pool.filter((c) => c.item.id !== anchor?.id);

  const chosenRest =
    remainingNeeded <= 0
      ? []
      : rng
        ? weightedSampleWithoutReplacement(rest, remainingNeeded, rng)
        : [...rest].sort(byWeightThenId).slice(0, remainingNeeded).map((c) => c.item);

  return anchor ? [anchor, ...chosenRest] : chosenRest;
};
