/**
 * @file PURE free-form grading (T048, FR-012/013, US-4).
 *
 * Scores a free-form item from the host agent's **per-criterion** verdict against
 * the item's MCP-supplied {@link Rubric}. The score is the FRACTION of rubric
 * criteria the agent marked `met`; the binary {@link Grade} is the projection of
 * that score against the rubric's `passThreshold` (default
 * {@link ASSESSMENT_CONFIG.freeFormPassThreshold} = 0.6) via the shared
 * {@link toGrade} (one definition of "correct" across deterministic + free-form).
 *
 * Anti-gaming (critique E2, FR-013): the verdict MUST be a per-criterion array
 * that aligns to the rubric's criteria ids. This module REJECTS a bare boolean,
 * a missing/empty criteria array, an unknown criterion id, or a verdict that
 * does not cover every rubric criterion — a lazy single self-pass is
 * non-conformant and never silently scored. The host agent cannot invent its own
 * criteria: only ids present in the authoritative rubric are accepted.
 *
 * Invariants (mirrors grading/deterministic.ts, engine/elo.ts):
 *  - PURE: no `Date`, no `fs`, no `Math.random`, no network.
 *  - The rubric is read-only input — never mutated here.
 *  - Determinism: identical verdict + rubric ⇒ identical score + grade.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`submit_answer` free-form path), spec.md FR-012 / FR-013, research.md
 * (OD-002 — free-form IN v1, `freeFormPassThreshold` 0.6), data-model.md
 * (Grade = binary projection of a continuous score).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import { toGrade } from "./deterministic.js";
import type { Grade } from "../schemas/common.js";
import type { Rubric } from "../schemas/content.js";
import type { FreeFormVerdict } from "../schemas/tools.js";

/** The outcome of scoring a free-form verdict against its rubric. */
export interface FreeFormGrade {
  /** Fraction of rubric criteria the agent marked `met`, in `[0, 1]`. */
  readonly score: number;
  /** Binary projection of `score` against the rubric's pass threshold. */
  readonly grade: Grade;
}

/**
 * Score a free-form item from the host agent's per-criterion verdict (PURE).
 *
 * The score is `metCount / rubric.criteria.length` — the fraction of the
 * authoritative rubric criteria the agent reported as met. The grade derives
 * from that score against the rubric's `passThreshold` (falling back to
 * {@link ASSESSMENT_CONFIG.freeFormPassThreshold} when the rubric omits one).
 *
 * The verdict is validated for SHAPE before scoring (anti-gaming, FR-013):
 *  - it MUST carry a non-empty `criteria` array (a bare boolean / missing
 *    criteria is rejected — the SDK union also rejects it, this is defence in
 *    depth so a direct caller can't bypass the structure);
 *  - every verdict criterion id MUST reference a real rubric criterion id (the
 *    agent cannot invent criteria);
 *  - no rubric criterion id may be duplicated in the verdict (an id is reported
 *    once);
 *  - EVERY rubric criterion MUST be covered by the verdict (the agent cannot
 *    silently skip a criterion to inflate the fraction).
 *
 * @param verdict - The host agent's per-criterion verdict.
 * @param rubric - The item's authoritative MCP-supplied rubric.
 * @returns The continuous score and its derived binary grade.
 * @throws {Error} with a clear message when the verdict shape does not conform
 *   to the rubric (per the rules above).
 */
export const scoreVerdict = (
  verdict: FreeFormVerdict,
  rubric: Rubric,
): FreeFormGrade => {
  const rubricIds = new Set(rubric.criteria.map((c) => c.id));

  // A bare boolean / missing criteria — defence in depth beyond the SDK union.
  if (!Array.isArray(verdict.criteria) || verdict.criteria.length === 0) {
    throw new Error(
      "scoreVerdict: free-form verdict must be a per-criterion array " +
        "(a bare boolean or empty verdict is non-conformant — FR-013)",
    );
  }

  const seen = new Set<string>();
  for (const c of verdict.criteria) {
    if (!rubricIds.has(c.id)) {
      throw new Error(
        `scoreVerdict: verdict references unknown criterion id ${JSON.stringify(c.id)}; ` +
          `the host agent may only judge the MCP-supplied rubric criteria ` +
          `${JSON.stringify([...rubricIds])}`,
      );
    }
    if (seen.has(c.id)) {
      throw new Error(
        `scoreVerdict: verdict reports criterion id ${JSON.stringify(c.id)} more than once`,
      );
    }
    seen.add(c.id);
  }

  // Every rubric criterion must be judged — no silent omissions.
  if (seen.size !== rubricIds.size) {
    const missing = [...rubricIds].filter((id) => !seen.has(id));
    throw new Error(
      `scoreVerdict: verdict does not cover every rubric criterion; missing ` +
        `${JSON.stringify(missing)} (a partial verdict is non-conformant — FR-013)`,
    );
  }

  const metCount = verdict.criteria.filter((c) => c.met).length;
  const score = metCount / rubric.criteria.length;
  const passThreshold =
    rubric.passThreshold ?? ASSESSMENT_CONFIG.freeFormPassThreshold;
  return { score, grade: toGrade(score, passThreshold) };
};
