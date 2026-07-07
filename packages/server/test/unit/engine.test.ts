/**
 * @file Unit tests for the PURE assessment engine (T012).
 *
 * Covers the Elo math (expectedScore, updateAbility, kFactor) and item
 * selection (selectItems): window/anchor/exclusion behaviour, length cap, the
 * fixed-difficulty invariant (E3), and determinism (E5 — same inputs ⇒ same
 * output, no clock/RNG reads).
 *
 * Source of truth: specs/001-vibe-hero-mvp/research.md (OD-005).
 */

import { describe, it, expect } from "vitest";
import { ASSESSMENT_CONFIG } from "../../src/config.js";
import {
  expectedScore,
  kFactor,
  updateAbility,
} from "../../src/engine/elo.js";
import { selectItems } from "../../src/engine/selection.js";
import type { ContentItem } from "../../src/schemas/content.js";
import type { Tier } from "../../src/schemas/common.js";

/**
 * Build a minimal, fully-typed multiple_choice {@link ContentItem}. Selection
 * only reads `id`/`difficulty`/`tier`/`type`; the rest are filled to satisfy
 * the strict type without exercising Zod refinement (engine is schema-free).
 */
const item = (id: string, difficulty: number, tier: Tier = 300): ContentItem => ({
  id,
  tier,
  bloom: "understand",
  difficulty,
  type: "multiple_choice",
  prompt: `prompt-${id}`,
  choices: [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
  ],
  answerKey: { kind: "choice", correctChoiceId: "a" },
  guidance: `guidance-${id}`,
});

/** A tiny deterministic LCG RNG factory for reproducible-sampling tests. */
const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG.
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

describe("expectedScore", () => {
  it("returns exactly 0.5 when ability equals difficulty", () => {
    expect(expectedScore(300, 300)).toBeCloseTo(0.5, 12);
    expect(expectedScore(0, 0)).toBeCloseTo(0.5, 12);
  });

  it("is monotonically increasing in (ability − difficulty)", () => {
    const fixedDifficulty = 300;
    const abilities = [0, 100, 200, 300, 400, 500, 600];
    const scores = abilities.map((a) => expectedScore(a, fixedDifficulty));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });

  it("falls within the open interval (0, 1) and is symmetric about the gap", () => {
    expect(expectedScore(500, 300)).toBeGreaterThan(0.5);
    expect(expectedScore(100, 300)).toBeLessThan(0.5);
    // Symmetry: E(θ−d = +g) + E(θ−d = −g) === 1.
    expect(expectedScore(400, 300) + expectedScore(200, 300)).toBeCloseTo(1, 12);
  });

  it("respects a custom scale parameter", () => {
    const wide = expectedScore(400, 300, 800);
    const narrow = expectedScore(400, 300, 100);
    // A narrower scale makes the same +100 gap more decisive.
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("kFactor", () => {
  it("is provisional below the settle threshold and settled at/above it", () => {
    const { settleAfterItems, kProvisional, kSettled } = ASSESSMENT_CONFIG;
    expect(kFactor(0)).toBe(kProvisional);
    expect(kFactor(settleAfterItems - 1)).toBe(kProvisional);
    expect(kFactor(settleAfterItems)).toBe(kSettled);
    expect(kFactor(settleAfterItems + 1)).toBe(kSettled);
  });

  it("switches exactly at 15 items (the configured default)", () => {
    expect(ASSESSMENT_CONFIG.settleAfterItems).toBe(15);
    expect(kFactor(14)).toBe(ASSESSMENT_CONFIG.kProvisional);
    expect(kFactor(15)).toBe(24);
  });
});

describe("updateAbility", () => {
  it("raises ability on a correct answer and lowers it on a wrong one", () => {
    const start = 300;
    const correct = updateAbility(start, 0, 300, 1);
    const wrong = updateAbility(start, 0, 300, 0);
    expect(correct.value).toBeGreaterThan(start);
    expect(wrong.value).toBeLessThan(start);
  });

  it("raises ability MORE for a correct answer on a harder item", () => {
    const ability = 300;
    const easy = updateAbility(ability, 0, 200, 1); // E high ⇒ small gain
    const hard = updateAbility(ability, 0, 400, 1); // E low  ⇒ larger gain
    const easyGain = easy.value - ability;
    const hardGain = hard.value - ability;
    expect(hardGain).toBeGreaterThan(easyGain);
  });

  it("lowers ability MORE for a wrong answer on an easier item", () => {
    const ability = 300;
    const easy = updateAbility(ability, 0, 200, 0); // expected to pass ⇒ big drop
    const hard = updateAbility(ability, 0, 400, 0); // expected to fail ⇒ small drop
    const easyDrop = ability - easy.value;
    const hardDrop = ability - hard.value;
    expect(easyDrop).toBeGreaterThan(hardDrop);
  });

  it("increments itemsSeen by exactly one", () => {
    expect(updateAbility(300, 0, 300, 1).itemsSeen).toBe(1);
    expect(updateAbility(300, 7, 300, 0).itemsSeen).toBe(8);
  });

  it("uses the provisional K below the threshold and the settled K above it", () => {
    const ability = 300;
    const difficulty = 400; // E ≈ 0.36, so a correct answer moves K·(1−E).
    const provisional = updateAbility(ability, 0, difficulty, 1).value - ability;
    const settled = updateAbility(ability, 20, difficulty, 1).value - ability;
    // Same (score − E), larger K while provisional ⇒ larger move.
    expect(provisional).toBeGreaterThan(settled);
    expect(provisional / settled).toBeCloseTo(
      ASSESSMENT_CONFIG.kProvisional / ASSESSMENT_CONFIG.kSettled,
      6,
    );
  });

  it("never mutates or returns the item difficulty (fixed-difficulty invariant E3)", () => {
    const difficulty = 400;
    const result = updateAbility(300, 0, difficulty, 1);
    // The argument value is unchanged...
    expect(difficulty).toBe(400);
    // ...and the result exposes ONLY ability + itemsSeen, never a difficulty.
    expect(Object.keys(result).sort()).toEqual(["itemsSeen", "value"]);
    expect(result).not.toHaveProperty("difficulty");
    expect(result).not.toHaveProperty("itemDifficulty");
  });

  it("does not mutate a fixed-difficulty ContentItem when used to update ability", () => {
    const fixed = item("q1", 400);
    const snapshot = { ...fixed };
    updateAbility(300, 0, fixed.difficulty, 1);
    expect(fixed).toEqual(snapshot);
    expect(fixed.difficulty).toBe(400);
  });
});

describe("selectItems", () => {
  const ability = 300;
  // nextBoundary 350 ⇒ promotion bar = 350 + 30 = 380.
  // target = min(300 + 50, 380) = 350. Window ±60 ⇒ [290, 410].
  const nextBoundary = 350;

  it("only returns items within ±selectWindow of the target difficulty", () => {
    const candidates = [
      item("in-low", 290),
      item("in-mid", 350),
      item("in-high", 410),
      item("too-low", 200), // outside window
      item("too-high", 500), // outside window
    ];
    const chosen = selectItems({ ability, candidates, nextBoundary, length: 5 });
    const ids = chosen.map((c) => c.id);
    expect(ids).not.toContain("too-low");
    expect(ids).not.toContain("too-high");
    for (const c of chosen) {
      expect(Math.abs(c.difficulty - 350)).toBeLessThanOrEqual(
        ASSESSMENT_CONFIG.selectWindow,
      );
    }
  });

  it("excludes recentItemIds from the pool", () => {
    const candidates = [
      item("recent", 300),
      item("fresh-a", 320),
      item("fresh-b", 340),
    ];
    const chosen = selectItems({
      ability,
      candidates,
      nextBoundary,
      recentItemIds: ["recent"],
      length: 5,
    });
    expect(chosen.map((c) => c.id)).not.toContain("recent");
  });

  it("always includes an anchor item within ±anchorWindow of θ when one exists", () => {
    const candidates = [
      item("anchor", 300), // |300−300| = 0 ≤ 20 ⇒ anchor-eligible
      item("near", 295),
      item("far-a", 400),
      item("far-b", 405),
      item("far-c", 410),
    ];
    // length 2 with several non-anchor items; the anchor must still appear.
    const chosen = selectItems({ ability, candidates, nextBoundary, length: 2 });
    expect(chosen.map((c) => c.id)).toContain("anchor");
    // Anchor is returned first.
    expect(chosen[0]?.id).toBe("anchor");
  });

  it("returns no more than `length` items", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      item(`q${i}`, 300 + i * 5),
    );
    const chosen = selectItems({ ability, candidates, nextBoundary, length: 3 });
    expect(chosen.length).toBeLessThanOrEqual(3);
    expect(chosen.length).toBe(3);
  });

  it("returns fewer than `length` items when the pool is smaller", () => {
    const candidates = [item("only-a", 300), item("only-b", 340)];
    const chosen = selectItems({ ability, candidates, nextBoundary, length: 5 });
    expect(chosen.length).toBe(2);
  });

  it("returns an empty array when no candidate falls in the window", () => {
    const candidates = [item("way-low", 50), item("way-high", 590)];
    const chosen = selectItems({ ability, candidates, nextBoundary, length: 4 });
    expect(chosen).toEqual([]);
  });

  it("defaults to ASSESSMENT_CONFIG.defaultQuizLength when length is omitted", () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      item(`q${i}`, 300 + i * 6),
    );
    const chosen = selectItems({ ability, candidates, nextBoundary });
    expect(chosen.length).toBe(ASSESSMENT_CONFIG.defaultQuizLength);
  });

  it("is deterministic: identical inputs yield identical output (default strategy)", () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      item(`q${i}`, 290 + i * 10),
    );
    const a = selectItems({ ability, candidates, nextBoundary, length: 4 });
    const b = selectItems({ ability, candidates, nextBoundary, length: 4 });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it("is deterministic with an injected seeded RNG (same seed ⇒ same output)", () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      item(`q${i}`, 290 + i * 10),
    );
    const a = selectItems({
      ability,
      candidates,
      nextBoundary,
      length: 4,
      rng: makeRng(42),
    });
    const b = selectItems({
      ability,
      candidates,
      nextBoundary,
      length: 4,
      rng: makeRng(42),
    });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it("does not mutate the candidate items or their difficulties (E3)", () => {
    const candidates = [item("q0", 300), item("q1", 340), item("q2", 380)];
    const snapshots = candidates.map((c) => ({ ...c }));
    selectItems({ ability, candidates, nextBoundary, length: 3 });
    candidates.forEach((c, i) => {
      expect(c).toEqual(snapshots[i]);
    });
  });
});
