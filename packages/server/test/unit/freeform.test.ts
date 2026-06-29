/**
 * @file PURE free-form grading unit tests (T048).
 *
 * Locks down {@link scoreVerdict}: score = fraction of rubric criteria met, grade
 * derived against the rubric's `passThreshold` (default 0.6), and the anti-gaming
 * shape validation (FR-013) — bare/empty verdicts, unknown criterion ids,
 * duplicate ids, and partial coverage are all rejected with clear errors.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md FR-012/FR-013, research.md
 * (OD-002 — `freeFormPassThreshold` 0.6).
 */

import { describe, expect, it } from "vitest";

import { scoreVerdict } from "../../src/grading/freeform.js";
import type { Rubric } from "../../src/schemas/content.js";
import type { FreeFormVerdict } from "../../src/schemas/tools.js";

/** A 3-criterion rubric (default passThreshold 0.6). */
const rubric = (passThreshold = 0.6): Rubric => ({
  referenceAnswer: "the reference answer",
  passThreshold,
  criteria: [
    { id: "c1", text: "first criterion" },
    { id: "c2", text: "second criterion" },
    { id: "c3", text: "third criterion" },
  ],
});

/** A verdict marking the first `metCount` of 3 criteria met. */
const verdict = (metCount: number): FreeFormVerdict => ({
  criteria: ["c1", "c2", "c3"].map((id, i) => ({
    id,
    met: i < metCount,
    justification: `judgement for ${id}`,
  })),
});

describe("scoreVerdict (T048, pure free-form grading)", () => {
  it("scores the fraction of criteria met and derives the grade vs passThreshold", () => {
    expect(scoreVerdict(verdict(3), rubric())).toEqual({ score: 1, grade: "correct" });
    expect(scoreVerdict(verdict(0), rubric())).toEqual({ score: 0, grade: "incorrect" });

    const twoOfThree = scoreVerdict(verdict(2), rubric());
    expect(twoOfThree.score).toBeCloseTo(2 / 3, 6); // ≈ 0.67 ≥ 0.6
    expect(twoOfThree.grade).toBe("correct");

    const oneOfThree = scoreVerdict(verdict(1), rubric());
    expect(oneOfThree.score).toBeCloseTo(1 / 3, 6); // ≈ 0.33 < 0.6
    expect(oneOfThree.grade).toBe("incorrect");
  });

  it("honors a custom rubric passThreshold over the default", () => {
    // 2/3 ≈ 0.67: passes at 0.6 but fails at a stricter 0.7.
    expect(scoreVerdict(verdict(2), rubric(0.7)).grade).toBe("incorrect");
    expect(scoreVerdict(verdict(2), rubric(0.6)).grade).toBe("correct");
  });

  it("rejects an empty criteria array (a non-per-criterion verdict)", () => {
    expect(() => scoreVerdict({ criteria: [] }, rubric())).toThrow(
      /per-criterion array/,
    );
  });

  it("rejects a verdict referencing an unknown criterion id (agent cannot invent criteria)", () => {
    const bogus: FreeFormVerdict = {
      criteria: [
        { id: "c1", met: true, justification: "ok" },
        { id: "c2", met: true, justification: "ok" },
        { id: "made-up", met: true, justification: "ok" },
      ],
    };
    expect(() => scoreVerdict(bogus, rubric())).toThrow(/unknown criterion id/);
  });

  it("rejects a duplicated criterion id", () => {
    const dup: FreeFormVerdict = {
      criteria: [
        { id: "c1", met: true, justification: "ok" },
        { id: "c1", met: false, justification: "again" },
        { id: "c2", met: true, justification: "ok" },
      ],
    };
    expect(() => scoreVerdict(dup, rubric())).toThrow(/more than once/);
  });

  it("rejects a partial verdict that omits a rubric criterion (FR-013)", () => {
    const partial: FreeFormVerdict = {
      criteria: [
        { id: "c1", met: true, justification: "ok" },
        { id: "c2", met: true, justification: "ok" },
      ],
    };
    expect(() => scoreVerdict(partial, rubric())).toThrow(
      /cover every rubric criterion/,
    );
  });
});
