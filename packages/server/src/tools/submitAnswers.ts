/**
 * @file Batch `submit_answers` tool module.
 *
 * Grades EVERY answer of one quiz in a single MCP call: one catalog resolution,
 * one profile transaction, N grading passes — replacing N separate
 * `submit_answer` round-trips (each of which paid its own tool-call overhead,
 * catalog load, and profile lock/read/write cycle).
 *
 * Semantics are identical to N sequential `submit_answer` calls by
 * construction: each answer is folded through the SAME single-item core
 * ({@link applyGradedItem}) in array order, so Elo updates, dwell streaks,
 * graduation decisions, and spaced-review entries land exactly as they would
 * one-at-a-time. The per-item results echo `submit_answer`'s shape
 * (grade/score/guidance/ability/graduation) plus the `itemId` so the host can
 * relay each outcome.
 *
 * Failure model: the batch validates EVERY answer (item exists, belongs to the
 * quiz's topic, input variant matches item type) and grades them BEFORE opening
 * the profile transaction. A bad row rejects the whole batch — no partial
 * writes, so a retry is safe. (Grading itself is pure; only the fold mutates.)
 *
 * The single-item `submit_answer` remains registered for interactive
 * one-at-a-time flows; this tool is for hosts that collected all answers first
 * (e.g. a UI that presents the whole quiz as one form).
 *
 * Gated (FR-032): NOT exempt — the gate runs before this handler.
 */

import { resolveCatalog } from "../catalog/resolve.js";
import type { GraduationDecision } from "../engine/graduation.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import { abilityKey } from "../schemas/common.js";
import type { ContentItem } from "../schemas/content.js";
import type { Profile } from "../schemas/profile.js";
import {
  SubmitAnswerInputSchema,
  SubmitAnswersInputSchema,
  type BatchItemResult,
  type SubmitAnswersInput,
  type SubmitAnswersResult,
} from "../schemas/tools.js";
import type { CatalogLoader, CatalogResolver } from "./catalogTypes.js";
import { loadCatalog } from "./catalogTypes.js";
import {
  applyGradedItem,
  findItem,
  gradeItem,
  toGraduationResult,
  type GradedOutcome,
} from "./submitAnswer.js";
import { defineTool, type AnyToolModule } from "./types.js";

/** One pre-validated, pre-graded batch row awaiting the profile fold. */
interface PreparedRow {
  readonly item: ContentItem;
  readonly outcome: GradedOutcome;
}

/**
 * Build the `submit_answers` tool module (batch path).
 *
 * @param dirOverride - Profile-directory override (test seam).
 * @param loaderOrResolver - Catalog source seam (test seam); defaults to
 *   {@link resolveCatalog} (fresh-fetch → cache → bundled).
 */
export const makeSubmitAnswersTool = (
  dirOverride?: string,
  loaderOrResolver: CatalogLoader | CatalogResolver = resolveCatalog,
): AnyToolModule =>
  defineTool({
    name: "submit_answers",
    description:
      "Grade ALL answers of one quiz in a single call (batch form of submit_answer) and update ability once per item, atomically.",
    inputSchema: SubmitAnswersInputSchema,
    handler: async (
      input: SubmitAnswersInput,
    ): Promise<SubmitAnswersResult> => {
      // Resolve the quiz's topic key so items can be validated against it.
      const profile = await loadProfile(dirOverride);
      const record = profile.quizHistory.find((q) => q.id === input.quizId);
      if (record === undefined) {
        throw new Error(
          `submit_answers: no quiz session found for quizId ${JSON.stringify(input.quizId)}`,
        );
      }

      const { topics } = await loadCatalog(loaderOrResolver, dirOverride);

      // Reject duplicate itemIds up front: folding the same item twice in one
      // batch is almost certainly a host bug, not a legitimate re-answer.
      const seen = new Set<string>();
      for (const a of input.answers) {
        if (seen.has(a.itemId)) {
          throw new Error(
            `submit_answers: itemId ${JSON.stringify(a.itemId)} appears more than once in the batch`,
          );
        }
        seen.add(a.itemId);
      }

      // Validate + grade EVERY row before any write (all-or-nothing batch).
      const prepared: PreparedRow[] = input.answers.map((row) => {
        // Re-validate each row against the authoritative single-answer union
        // (deterministic answer XOR free-form verdict — same anti-gaming
        // guarantees as submit_answer).
        const single = SubmitAnswerInputSchema.parse({
          quizId: input.quizId,
          itemId: row.itemId,
          ...(row.answer !== undefined ? { answer: row.answer } : {}),
          ...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
        });

        const found = findItem(topics, row.itemId);
        if (found === undefined) {
          throw new Error(
            `submit_answers: no catalog item matches itemId ${JSON.stringify(row.itemId)}`,
          );
        }
        const { topic, item } = found;
        if (abilityKey(topic.class, topic.id) !== record.key) {
          throw new Error(
            `submit_answers: item ${JSON.stringify(row.itemId)} does not belong to quiz ${JSON.stringify(input.quizId)}`,
          );
        }

        return { item, outcome: gradeItem(single, item) };
      });

      // Fold every graded row through the single-item core inside ONE
      // transaction. Each row gets its own answeredAt so history stays an
      // ordered event log (identical semantics to N sequential calls).
      const results: BatchItemResult[] = [];
      let batchBefore: number | undefined;
      let batchAfter: number | undefined;

      await updateProfile((current: Profile): Profile => {
        // The transform may re-run on lock retry: reset accumulators so rows
        // are never duplicated.
        results.length = 0;
        batchBefore = undefined;

        let working = current;
        for (const { item, outcome } of prepared) {
          const answeredAt = new Date().toISOString();
          const applied = applyGradedItem(
            working,
            input.quizId,
            item,
            outcome.score,
            outcome.grade,
            outcome.gradedBy,
            answeredAt,
          );
          working = applied.profile;
          batchBefore ??= applied.before;
          batchAfter = applied.after;

          const decision: GraduationDecision = applied.decision;
          const row: BatchItemResult = {
            itemId: item.id,
            grade: outcome.grade,
            score: outcome.score,
            guidance: item.guidance,
            ability: { before: applied.before, after: applied.after },
            graduation: toGraduationResult(decision),
          };
          results.push(
            outcome.correctAnswer !== undefined
              ? { ...row, correctAnswer: outcome.correctAnswer }
              : row,
          );
        }
        return working;
      }, dirOverride);

      if (batchBefore === undefined || batchAfter === undefined) {
        // Unreachable: answers.min(1) guarantees at least one fold ran.
        throw new Error("submit_answers: batch update did not run");
      }

      return {
        results,
        ability: { before: batchBefore, after: batchAfter },
        correctCount: results.filter((r) => r.grade === "correct").length,
      };
    },
  });

/** Default `submit_answers` module (env / `~/.vibe-hero`), used by the registry. */
export const submitAnswersTool: AnyToolModule = makeSubmitAnswersTool();
