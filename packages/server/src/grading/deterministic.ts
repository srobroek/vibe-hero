/**
 * @file PURE deterministic grading (T030, FR-011, SC-004).
 *
 * Grades the two deterministic question types — `multiple_choice` and
 * `short_answer` — entirely in-engine, with NO IO, NO clock, and NO host-agent
 * involvement. Grading is objective and **reproducible**: the same item + same
 * answer always yields the same `score` and `Grade` (SC-004). Free-form grading
 * is the host-agent verdict handshake and lives elsewhere (T048); this module
 * never touches it.
 *
 * Both graders return a continuous `score ∈ {0, 1}` (deterministic items are
 * all-or-nothing — there is no partial credit for MC/short-answer), which the
 * Elo engine consumes, plus enough context for the caller to build the
 * `submit_answer` result (`correctChoiceId` for MC). The binary {@link Grade}
 * projection is derived from the score via {@link toGrade} against the item's
 * pass threshold.
 *
 * Invariants (mirrors engine/elo.ts, engine/selection.ts):
 *  - PURE: no `Date`, no `fs`, no `Math.random`, no network.
 *  - Item difficulty is read-only input — never mutated here (E3).
 *  - Determinism: identical inputs ⇒ identical outputs (SC-004).
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`submit_answer` deterministic path), spec.md FR-011 / SC-004,
 * data-model.md (Grade = binary projection of a continuous score).
 */

import type { ContentItem } from "../schemas/content.js";
import type { Grade } from "../schemas/common.js";

/** Result of grading a `multiple_choice` item. */
export interface MultipleChoiceGrade {
  /** All-or-nothing score: `1` if the chosen id matches the key, else `0`. */
  readonly score: 0 | 1;
  /** The authored correct choice id (for the `submit_answer` `correctAnswer`). */
  readonly correctChoiceId: string;
}

/** Result of grading a `short_answer` item. */
export interface ShortAnswerGrade {
  /** All-or-nothing score: `1` if the normalized text matches a key, else `0`. */
  readonly score: 0 | 1;
}

/**
 * Apply a `short_answer` answer key's `normalize` directive to a string before
 * comparison. Pure and idempotent:
 *  - `"lower"` → lowercase only.
 *  - `"trim"`  → trim leading/trailing whitespace only.
 *  - `"both"`  → trim then lowercase.
 *  - omitted   → exact comparison (no normalization).
 *
 * @param value - The raw string (user text or an authored keyword).
 * @param normalize - The key's normalization mode, if any.
 * @returns The normalized string.
 */
export const applyNormalize = (
  value: string,
  normalize: "lower" | "trim" | "both" | undefined,
): string => {
  switch (normalize) {
    case "lower":
      return value.toLowerCase();
    case "trim":
      return value.trim();
    case "both":
      return value.trim().toLowerCase();
    case undefined:
      return value;
  }
};

/**
 * Grade a `multiple_choice` item (PURE, reproducible).
 *
 * Compares the submitted `choiceId` to the item's `answerKey.correctChoiceId`.
 * The score is `1` for an exact id match, `0` otherwise; the correct choice id
 * is returned regardless so the caller can surface it after grading.
 *
 * @param item - The catalog item being graded (must be `multiple_choice` with a
 *   `choice` answer key — guaranteed by {@link ContentItem} validation).
 * @param choiceId - The choice id the user selected (may be `undefined` if the
 *   user submitted no/blank choice, which scores `0`).
 * @returns The score and the authored correct choice id.
 * @throws {Error} if the item is not a `multiple_choice` item with a `choice`
 *   answer key (a programming error — the catalog schema forbids it).
 */
export const gradeMultipleChoice = (
  item: ContentItem,
  choiceId: string | undefined,
): MultipleChoiceGrade => {
  if (item.type !== "multiple_choice" || item.answerKey?.kind !== "choice") {
    throw new Error(
      `gradeMultipleChoice: item ${JSON.stringify(item.id)} is not a multiple_choice item with a choice answer key`,
    );
  }
  const correctChoiceId = item.answerKey.correctChoiceId;
  return {
    score: choiceId === correctChoiceId ? 1 : 0,
    correctChoiceId,
  };
};

/**
 * Grade a `short_answer` item (PURE, reproducible).
 *
 * Applies the key's `normalize` directive to BOTH the user's text and each
 * accepted keyword, then scores `1` if the normalized user text equals any
 * accepted keyword (`anyOf`), else `0`. Normalizing both sides keeps the match
 * symmetric (the same rule applied to authored keys and user input).
 *
 * @param item - The catalog item being graded (must be `short_answer` with a
 *   `keyword` answer key — guaranteed by {@link ContentItem} validation).
 * @param text - The user's free-text answer (may be `undefined` if the user
 *   submitted no/blank text, which scores `0`).
 * @returns The all-or-nothing score.
 * @throws {Error} if the item is not a `short_answer` item with a `keyword`
 *   answer key (a programming error — the catalog schema forbids it).
 */
export const gradeShortAnswer = (
  item: ContentItem,
  text: string | undefined,
): ShortAnswerGrade => {
  if (item.type !== "short_answer" || item.answerKey?.kind !== "keyword") {
    throw new Error(
      `gradeShortAnswer: item ${JSON.stringify(item.id)} is not a short_answer item with a keyword answer key`,
    );
  }
  if (text === undefined) return { score: 0 };

  const { anyOf, normalize } = item.answerKey;
  const normalizedText = applyNormalize(text, normalize);
  const matches = anyOf.some(
    (keyword) => applyNormalize(keyword, normalize) === normalizedText,
  );
  return { score: matches ? 1 : 0 };
};

/**
 * Project a continuous `score ∈ [0, 1]` to the binary {@link Grade} persisted in
 * history: `score ≥ passThreshold ⇒ "correct"`, else `"incorrect"`
 * (data-model.md / research.md). The same projection serves deterministic
 * (score ∈ {0, 1}) and free-form (fractional score) grades, keeping one
 * definition of "correct".
 *
 * For deterministic items the natural threshold is any value in `(0, 1]` (e.g.
 * the default `1`), so a `0` is always incorrect and a `1` always correct.
 *
 * @param score - The continuous outcome in `[0, 1]`.
 * @param passThreshold - The fraction at/above which the grade is `"correct"`.
 * @returns The derived binary grade.
 */
export const toGrade = (score: number, passThreshold: number): Grade =>
  score >= passThreshold ? "correct" : "incorrect";
