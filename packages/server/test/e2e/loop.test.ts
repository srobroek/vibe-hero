/**
 * @file US-1 full adaptive-loop END-TO-END test (T039 / quickstart V1).
 *
 * The canonical end-to-end proof of the US-1 loop, driven entirely through the
 * REAL MCP tool handlers (not engine internals) against:
 *   - a temp `VIBE_HERO_HOME` (the store's `dirOverride` seam), and
 *   - the REAL bundled Claude Code curriculum at `content/claude-code/`
 *     (loaded via `loadCatalogFromDir` through every tool's `catalogLoader`
 *     seam) — so this test proves the actual shipped content drives the loop,
 *     not a fixture.
 *
 * Loop steps exercised, in order (quickstart V1 + spec US-1):
 *   1. save_config           — tool claude-code, cadence per_session, offers on
 *                              (clears the FR-032 setup gate via the real tool).
 *   2. record_observation    — a `Task` signal matches the `subagents` topic's
 *                              trigger (FR-015) → returned as an offer candidate,
 *                              AND abilities/graduations/quizHistory are BYTE-
 *                              identical before/after (SC-003 — usage scores 0).
 *   3. get_offer             — surfaces an offer for `subagents`;
 *      record_offer_response — accept it.
 *   4. start_quiz            — 3–5 PresentedItems for `subagents`, with NO answer
 *                              key / correct choice leaked (contract).
 *   5. submit_answer × N     — the CORRECT answer for every selected item (read
 *                              from the loaded catalog's answerKey at runtime —
 *                              the test is the harness). Each grades "correct"
 *                              and ability rises across the sequence (US-1 #3).
 *   6. submit_answer twice   — same correct answer to one item ⇒ identical grade
 *                              (SC-004 reproducibility).
 *   7. profile inspection    — AnsweredItems persist DERIVED fields only (no raw
 *                              answer text on disk — substring probe, FR-018 /
 *                              SC-008), the ability estimate is updated, and the
 *                              quizHistory holds the record.
 *
 * Determinism: the engine never calls `Math.random`; selection is the RNG-free
 * top-weighted path, so the same seeded profile + same catalog yield the same
 * 3–5 items every run. The pre-quiz ability/graduation seed (ability 360,
 * tier 300 on `subagents`) exists ONLY so the real catalog's tier-300/400 items
 * fall inside the ±60 selection window — without it a cold-start learner targets
 * the tier-100 boundary, where the real topic ships only 2 eligible items
 * (< the 3 required). The seed is written via the store before the loop; step 2
 * snapshots that exact state and proves observation does not perturb it.
 *
 * Source of truth: specs/001-vibe-hero-mvp/quickstart.md (V1),
 * spec.md US-1 / FR-005 / FR-008a / FR-011 / FR-015 / FR-018 / SC-003 / SC-004 /
 * SC-008 / SC-009, contracts/mcp-tools.md, data-model.md.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCatalogFromDir } from "../../src/catalog/loader.js";
import { makeSaveConfigTool } from "../../src/tools/config.js";
import { makeRecordObservationTool } from "../../src/tools/recordObservation.js";
import {
  makeGetOfferTool,
  makeRecordOfferResponseTool,
} from "../../src/tools/offers.js";
import { makeStartQuizTool } from "../../src/tools/startQuiz.js";
import { makeSubmitAnswerTool } from "../../src/tools/submitAnswer.js";
import { profilePath, updateProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import type { Topic } from "../../src/schemas/content.js";
import type {
  GetOfferResult,
  PresentedItem,
  RecordObservationResult,
  SaveConfigResult,
  StartQuizResult,
  SubmitAnswerResult,
} from "../../src/schemas/tools.js";

/**
 * Absolute path to the REAL bundled Claude Code curriculum, resolved relative to
 * THIS test file (robust to the CWD vitest is launched from).
 *   packages/server/test/e2e → repo-root/content/claude-code
 */
const CONTENT_CLAUDE_CODE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../content/claude-code",
);

/** The real subagents topic key (tool-scoped, claude-code). */
const SUBAGENTS_KEY = abilityKey(
  { kind: "tool", tool: "claude-code" },
  "subagents",
);

/** Stable session id for the whole loop. */
const SESSION_ID = "e2e-session-1";

/**
 * Build the correct deterministic answer payload for a presented item by reading
 * its authoritative answerKey from the LOADED catalog topic. The test is the
 * grading harness, so it may peek at the key the engine hides from the client:
 *  - multiple_choice → `{ choiceId: <correctChoiceId> }`
 *  - short_answer    → `{ text: <first accepted keyword> }`
 *
 * @throws if the item is missing, free-form, or lacks a deterministic key —
 *   the e2e only drives the deterministic backbone (free-form is T048).
 */
const correctAnswerFor = (
  topic: Topic,
  presented: PresentedItem,
): { choiceId?: string; text?: string } => {
  const item = topic.items.find((i) => i.id === presented.itemId);
  if (item === undefined) {
    throw new Error(`e2e: presented item ${presented.itemId} not in catalog`);
  }
  if (item.type === "multiple_choice" && item.answerKey?.kind === "choice") {
    return { choiceId: item.answerKey.correctChoiceId };
  }
  if (item.type === "short_answer" && item.answerKey?.kind === "keyword") {
    // anyOf is guaranteed non-empty by the schema; the engine normalizes both
    // sides, so submitting the authored keyword verbatim always matches.
    return { text: item.answerKey.anyOf[0]! };
  }
  throw new Error(
    `e2e: item ${presented.itemId} (type ${item.type}) has no deterministic answer key`,
  );
};

describe("US-1 full adaptive loop E2E (T039 / quickstart V1 / SC-009)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-e2e-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** A catalog loader bound to the REAL claude-code content dir. */
  const realLoader = () => loadCatalogFromDir(CONTENT_CLAUDE_CODE_DIR);

  /** Every loop tool handler wired to the temp home + real catalog. */
  const tools = () => ({
    saveConfig: makeSaveConfigTool(home).handler,
    recordObservation: makeRecordObservationTool(home, realLoader).handler,
    getOffer: makeGetOfferTool(home, realLoader).handler,
    recordResponse: makeRecordOfferResponseTool(home).handler,
    startQuiz: makeStartQuizTool(home, realLoader).handler,
    submitAnswer: makeSubmitAnswerTool(home, realLoader).handler,
  });

  /** Read the persisted profile JSON from disk. */
  const readProfile = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(profilePath(home), "utf8")) as Record<
      string,
      unknown
    >;

  /** Resolve the real loaded `subagents` topic (sanity-guards the content dir). */
  const subagentsTopic = (): Topic => {
    const { topics, errors } = realLoader();
    expect(errors).toEqual([]);
    const topic = topics.find(
      (t) => abilityKey(t.class, t.id) === SUBAGENTS_KEY,
    );
    if (topic === undefined) {
      throw new Error("e2e: real catalog is missing the subagents topic");
    }
    return topic;
  };

  /**
   * Seed an ability/graduation so the REAL catalog yields a 3–5 selection.
   * The assembled subagents topic ships 20 tier-100 items (MC + SA), so a
   * cold-start ability of 150 + tier-100 graduation gives a ±60 window
   * [90, 210] that comfortably covers the 14 MC items at tier-100 (difficulty
   * 122–200). We keep the seed here (rather than relying on a fresh cold-start)
   * so step 2 has an EXACT snapshot to compare before/after observation — this
   * proves observation awards nothing (SC-003). Written directly via the store
   * as a precondition, distinct from the loop under test.
   */
  const seedAbilityForSelection = async (): Promise<void> => {
    await updateProfile(
      (current) => ({
        ...current,
        abilities: {
          [SUBAGENTS_KEY]: {
            value: 150,
            itemsSeen: 4,
            lastAssessedAt: "2026-05-01T00:00:00.000Z",
            lastItemIds: [],
          },
        },
        graduations: {
          [SUBAGENTS_KEY]: {
            currentTier: 100 as const,
            status: "current" as const,
            graduatedAt: "2026-05-01T00:00:00.000Z",
            lastChangeReason: "graduated" as const,
          },
        },
      }),
      home,
    );
  };

  it("drives detect → offer → quiz → grade → persisted profile through the real tools", async () => {
    const topic = subagentsTopic();
    const {
      saveConfig,
      recordObservation,
      getOffer,
      recordResponse,
      startQuiz,
      submitAnswer,
    } = tools();

    // ── Step 1: save_config (clears the FR-032 setup gate via the real tool) ──
    const saved = (await saveConfig({
      toolsLearning: ["claude-code"],
      offerCadence: "per_session",
      proactiveOffers: true,
    })) as SaveConfigResult;
    expect(saved.ok).toBe(true);
    expect(saved.config.offerCadence).toBe("per_session");
    expect(saved.config.proactiveOffers).toBe(true);

    // Precondition for a real-catalog 3–5 selection (NOT the loop under test).
    await seedAbilityForSelection();

    // ── Step 2: record_observation — Task signal matches `subagents` (FR-015) ─
    // Snapshot the scoring state BEFORE: observation must not move it (SC-003).
    const beforeObs = await readProfile();

    const obs = (await recordObservation({
      tool: "claude-code",
      signals: [{ toolName: "Task", success: true, toolUseId: "tu-1" }],
      sessionId: SESSION_ID,
    })) as RecordObservationResult;

    expect(obs.offerCandidates).toHaveLength(1);
    expect(obs.offerCandidates[0]?.key).toBe(SUBAGENTS_KEY);
    expect(obs.offerCandidates[0]?.title).toBe(topic.title);
    expect(obs.offerCandidates[0]?.reason.length).toBeGreaterThan(0);

    // SC-003 / FR-005: usage awards NOTHING — abilities, graduations, and
    // quizHistory are byte-for-byte unchanged (only the offers ledger moves).
    const afterObs = await readProfile();
    expect(afterObs["abilities"]).toEqual(beforeObs["abilities"]);
    expect(afterObs["graduations"]).toEqual(beforeObs["graduations"]);
    expect(afterObs["quizHistory"]).toEqual(beforeObs["quizHistory"]);
    expect(afterObs["quizHistory"]).toEqual([]);

    // ── Step 3: get_offer surfaces the offer; accept it ──────────────────────
    const offered = (await getOffer({
      sessionId: SESSION_ID,
      tool: "claude-code",
    })) as GetOfferResult;
    expect(offered.suppressed).toBeUndefined();
    expect(offered.offer?.key).toBe(SUBAGENTS_KEY);
    expect(offered.offer?.title).toBe(topic.title);
    expect(offered.offer?.prompt.length).toBeGreaterThan(0);

    const ack = await recordResponse({
      sessionId: SESSION_ID,
      key: SUBAGENTS_KEY,
      response: "accept",
    });
    expect(ack).toEqual({ ok: true });

    // ── Step 4: start_quiz — 3–5 deterministic items, NO answer key leaked ─────
    // `allowFreeForm: false` keeps the loop deterministic (free-form judging is
    // a separate capability path covered by T048). The assembled subagents topic
    // ships 14 MC items at tier-100, well above the 3–5 selection minimum.
    const quiz = (await startQuiz({ key: SUBAGENTS_KEY, allowFreeForm: false })) as StartQuizResult;
    expect(typeof quiz.quizId).toBe("string");
    expect(quiz.quizId.length).toBeGreaterThan(0);

    // Bounded selection from the REAL catalog (FR-008a): 3–5 items.
    expect(quiz.items.length).toBeGreaterThanOrEqual(3);
    expect(quiz.items.length).toBeLessThanOrEqual(5);

    // No internal answer keys leak in the serialized payload (allowFreeForm: false
    // guarantees no free_form items, so referenceAnswer/rubric are absent too).
    const serialized = JSON.stringify(quiz);
    expect(serialized).not.toContain("answerKey");
    expect(serialized).not.toContain("correctChoiceId");
    expect(serialized).not.toContain("anyOf");
    expect(serialized).not.toContain("referenceAnswer");
    expect(serialized).not.toContain("rubric");
    for (const item of quiz.items) {
      const asRecord = item as unknown as Record<string, unknown>;
      expect(asRecord["answerKey"]).toBeUndefined();
      expect(asRecord["referenceAnswer"]).toBeUndefined();
      expect(asRecord["rubric"]).toBeUndefined();
      if (item.type === "multiple_choice") {
        expect(item.choices).toBeDefined();
        for (const choice of item.choices ?? []) {
          // Each presented choice carries ONLY id + text — no "correct" marker.
          expect(Object.keys(choice).sort()).toEqual(["id", "text"]);
        }
      }
    }

    // ── Step 5: submit_answer — CORRECT answer for every selected item BUT
    // the last. The final item is held back until after the step-6 replays:
    // grading every planned item now stamps `completedAt` and closes the quiz,
    // so replays must happen while the session is still live.
    let priorAfter: number | undefined;
    const firstItem = quiz.items[0]!;
    const lastItem = quiz.items[quiz.items.length - 1]!;
    let firstItemBefore: number | undefined;
    let firstItemAfter: number | undefined;

    for (const presented of quiz.items.slice(0, -1)) {
      const answer = correctAnswerFor(topic, presented);
      const graded = (await submitAnswer({
        quizId: quiz.quizId,
        itemId: presented.itemId,
        answer,
      })) as SubmitAnswerResult;

      expect(graded.grade).toBe("correct");
      expect(graded.score).toBe(1);
      expect(graded.guidance.length).toBeGreaterThan(0);
      // Each correct grade raises ability against the item's fixed difficulty.
      expect(graded.ability.after).toBeGreaterThan(graded.ability.before);
      // The chain is continuous: this item's `before` is the prior `after`.
      if (priorAfter !== undefined) {
        expect(graded.ability.before).toBeCloseTo(priorAfter, 6);
      }
      priorAfter = graded.ability.after;

      if (presented.itemId === firstItem.itemId) {
        firstItemBefore = graded.ability.before;
        firstItemAfter = graded.ability.after;
      }
    }

    // Ability AFTER the full correct sequence strictly exceeds the start (US-1 #3).
    const startAbility = firstItemBefore!;
    expect(priorAfter!).toBeGreaterThan(startAbility);

    // ── Step 6: same correct answer twice ⇒ identical grade (SC-004) ─────────
    // Grading is pure (no clock / RNG / state), so the SAME item + SAME correct
    // answer yields the SAME grade + score every time. Re-submit the first
    // item's correct answer to the SAME live quiz twice and compare. The quiz
    // record is an append-only event log, so a re-submit appends another graded
    // item but the GRADE/SCORE is identical (SC-004 reproducibility). Doing this
    // on the live quiz avoids relying on a fresh selection re-serving the item —
    // after answers accumulate, `lastItemIds` shrinks the eligible pool.
    const replayAnswer = correctAnswerFor(topic, firstItem);
    const replayA = (await submitAnswer({
      quizId: quiz.quizId,
      itemId: firstItem.itemId,
      answer: replayAnswer,
    })) as SubmitAnswerResult;
    const replayB = (await submitAnswer({
      quizId: quiz.quizId,
      itemId: firstItem.itemId,
      answer: replayAnswer,
    })) as SubmitAnswerResult;

    // Same item + same correct answer ⇒ identical grade + score (SC-004).
    expect(replayA.grade).toBe("correct");
    expect(replayB.grade).toBe(replayA.grade);
    expect(replayB.score).toBe(replayA.score);

    // ── Step 6.5: grade the held-back final item — this completes the plan and
    // stamps `completedAt`, after which the session rejects further submits.
    const lastGraded = (await submitAnswer({
      quizId: quiz.quizId,
      itemId: lastItem.itemId,
      answer: correctAnswerFor(topic, lastItem),
    })) as SubmitAnswerResult;
    expect(lastGraded.grade).toBe("correct");
    await expect(
      submitAnswer({
        quizId: quiz.quizId,
        itemId: firstItem.itemId,
        answer: replayAnswer,
      }),
    ).rejects.toThrow(/already completed/);

    // ── Step 7: inspect the persisted profile ────────────────────────────────
    const onDisk = await readFile(profilePath(home), "utf8");
    const profile = JSON.parse(onDisk) as {
      abilities: Record<string, { value: number; itemsSeen: number }>;
      quizHistory: Array<{
        id: string;
        key: string;
        items: Array<Record<string, unknown>>;
        abilityBefore: number;
        abilityAfter: number;
      }>;
    };

    // The loop quiz holds one AnsweredItem per submission (append-only log): the
    // step-5 sweep over every selected item, plus the two step-6 SC-004 replays
    // of the first item.
    const REPLAY_SUBMISSIONS = 2;
    const record = profile.quizHistory.find((q) => q.id === quiz.quizId);
    expect(record).toBeDefined();
    expect(record?.key).toBe(SUBAGENTS_KEY);
    expect(record?.items).toHaveLength(quiz.items.length + REPLAY_SUBMISSIONS);

    // FR-018 / SC-008: every AnsweredItem carries DERIVED fields only — no raw
    // answer text / chosen id reaches disk. Assert the exact field set + probe
    // for any leaked choice id from the real catalog.
    for (const answered of record?.items ?? []) {
      expect(Object.keys(answered).sort()).toEqual(
        [
          "answeredAt",
          "difficulty",
          "grade",
          "gradedBy",
          "itemId",
          "score",
          "tier",
        ].sort(),
      );
      expect(answered["gradedBy"]).toBe("engine");
      expect(answered["answer"]).toBeUndefined();
      expect(answered["text"]).toBeUndefined();
      expect(answered["choiceId"]).toBeUndefined();
    }

    // No raw answer-key strings persisted on disk anywhere (privacy boundary,
    // FR-018 / SC-008). The assembled subagents topic ships MC items at tier-100
    // (allowFreeForm: false excludes free-form); the per-item field checks above
    // already verify choiceId is not persisted. Additionally confirm the raw
    // correct choice values are absent from the disk JSON.
    const correctChoiceIds = quiz.items
      .map((p) => correctAnswerFor(topic, p).choiceId)
      .filter((id): id is string => id !== undefined);
    // There should be at least one MC item in the deterministic selection.
    expect(correctChoiceIds.length).toBeGreaterThan(0);
    // The correct choice ids themselves (internal answer keys) must not appear
    // as a raw answer field on any persisted AnsweredItem — the per-item check
    // above verifies the field is absent; this cross-checks the serialized blob.
    const diskProfile = JSON.parse(onDisk) as { quizHistory: Array<{ items: Array<Record<string, unknown>> }> };
    const persistedItems = diskProfile.quizHistory.flatMap((q) => q.items);
    for (const answered of persistedItems) {
      expect(answered["choiceId"]).toBeUndefined();
      expect(answered["answer"]).toBeUndefined();
    }

    // The persisted ability estimate is updated above the start (loop raised it).
    const persistedAbility = profile.abilities[SUBAGENTS_KEY];
    expect(persistedAbility).toBeDefined();
    expect(persistedAbility!.value).toBeGreaterThan(startAbility);
    expect(persistedAbility!.itemsSeen).toBeGreaterThanOrEqual(quiz.items.length);

    // The loop quiz record's abilityAfter reflects the in-record progression.
    expect(record!.abilityAfter).toBeGreaterThan(record!.abilityBefore);
    expect(record!.abilityBefore).toBeCloseTo(startAbility, 6);

    // Sanity: the ability estimate rose across the first item's grading.
    expect(firstItemAfter).toBeGreaterThan(firstItemBefore!);
  });
});
