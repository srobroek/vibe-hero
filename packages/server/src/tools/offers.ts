/**
 * @file Real `get_offer` / `record_offer_response` tool modules (T036, US-1).
 *
 * These two tools are the end-of-work offer surface, thin wrappers over the pure
 * offer engine (`../observation/offers.js`):
 *
 *  - `get_offer` ({sessionId, tool}) resolves whether an offer may surface at an
 *    end-of-work breakpoint and for which key, honoring cadence + anti-fatigue
 *    via {@link resolveOffer}. The candidate pool is the per-session
 *    `OfferLedger.candidateKeys` accumulated by `record_observation` (get_offer
 *    receives no signals of its own), PLUS any topics currently due for review
 *    (task #21 — due-first priority). Due-for-review topics are prepended to the
 *    candidate list — most-overdue first — so they are offered ahead of
 *    activity-based candidates. All existing cadence / backoff / decline gates
 *    apply unchanged; no new interruption path is introduced.
 *
 *    SIDE EFFECT: when a real offer is resolved, `get_offer` calls `armSession`,
 *    persists `offerArms[sessionId]` into the profile, and writes a cheap /tmp
 *    cache file. The UserPromptSubmit hook reads ONLY that file — no npx/node
 *    on the prompt path.
 *
 *    BOOTSTRAPPING: the MCP server does NOT know the session id inherently — it
 *    learns it from the agent's MCP tool calls (`sessionId` is an explicit arg
 *    on every offer tool). The injected UserPromptSubmit context includes the
 *    session id and instructs the agent to pass it. On the FIRST prompt of a
 *    session no cache exists yet, so the hook emits nothing (desired: no offer
 *    until the agent has called a vibe-hero tool at least once with the id).
 *
 *  - `record_offer_response` ({sessionId, key, response}) persists the
 *    accept/decline/defer outcome: a decline applies within-session suppression
 *    (FR-020) AND cross-session backoff + eventual global mute (FR-020b) via
 *    {@link applyDecline}; an accept resets the consecutive-decline counter and
 *    clears the mute via {@link applyAccept}; a defer leaves state unchanged.
 *    Decline and defer also call `clearArm` + write the cleared cache so the
 *    hook falls silent until the cooldown elapses. Accept writes no cache change
 *    (the arm is already consumed).
 *
 * /tmp cache file schema (JSON):
 *   {
 *     sessionId:   string,   // must match filename segment AND stdin payload
 *     armedKey:    string|null,
 *     armedTitle:  string|null,
 *     armedAt:     string|null,  // ISO datetime
 *     lastOfferAt: string|null,  // ISO datetime — cooldown stamp
 *     cooldownSeconds: number,   // pre-computed by server so hook needs no env
 *   }
 * The hook verifies embedded `sessionId` == stdin `session_id` before trusting
 * the file (guards against stale / reused /tmp entries). Stale-file cleanup:
 * the server overwrites by session id on every arm; the hook may unlink files
 * whose `armedAt` + `cooldownSeconds` is expired. No background process needed.
 *
 * Both tools delegate the decision/state math to the pure engine and own only
 * the IO: clock, catalog load, and the atomic {@link updateProfile} write.
 * Neither tool EVER touches abilities/graduations/quizHistory — offers never
 * score (FR-005, SC-003).
 *
 * Gated (FR-032): NOT exempt — `index.ts`/`withSetupGate` returns SETUP_REQUIRED
 * when `profile.config` is absent. The handlers assume a configured profile.
 *
 * Each tool is a `(dirOverride, catalogLoader)` factory mirroring
 * `startQuiz.ts`/`recordObservation.ts`.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (`get_offer`,
 * `record_offer_response`), spec.md FR-019/020/020a/020b, data-model.md
 * (§ OfferLedger), src/config.ts (ASSESSMENT_CONFIG).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import { resolveCatalog } from "../catalog/resolve.js";
import { isDueForReview, daysBetween } from "../engine/lapse.js";
import { updateProfile } from "../profile/store.js";
import { abilityKey, type AbilityKey, type ToolId } from "../schemas/common.js";
import type { Topic } from "../schemas/content.js";
import type { OfferArm, OfferLedger, Profile } from "../schemas/profile.js";
import {
  GetOfferInputSchema,
  RecordOfferResponseInputSchema,
  type GetOfferInput,
  type GetOfferResult,
  type OfferDiagnostics,
  type RecordOfferResponseInput,
  type RecordOfferResponseResult,
} from "../schemas/tools.js";
import {
  applyAccept,
  applyDecline,
  applyDefer,
  armSession,
  canArm,
  clearArm,
  cooldownSeconds,
  ledgerForSession,
  markOffered,
  resolveOffer,
  type SuppressionReason,
} from "../observation/offers.js";
import { inWindowWeightByKey } from "../observation/arming.js";
import { eagernessParams } from "../observation/eagerness.js";
import { writeArmCache } from "../observation/armCache.js";
import { defineTool, type AnyToolModule } from "./types.js";
import {
  loadCatalog,
  type CatalogLoader,
  type CatalogResolver,
} from "./catalogTypes.js";

// ---------------------------------------------------------------------------
// Arm cache data-flow (implementation in ../observation/armCache.ts):
//   1. Agent calls get_offer (MCP) with sessionId — OR the drain pipeline arms
//      autonomously from organic evidence (observation/drain.ts).
//   2. Server resolves offer, calls armSession, persists profile.offerArms,
//      atomically writes ~/.vibe-hero/arm/vibe-hero-offer-<sid>.json.
//   3. Next UserPromptSubmit: hook reads that file, verifies embedded
//      sessionId, emits the pre-built `context` — zero node/npx spawn.
//   4. On decline/defer/quiz-start: server overwrites the cache cleared.
//   The server owns the cache lifecycle end-to-end; the hook never deletes.
// ---------------------------------------------------------------------------

// Re-exported for backward compatibility (tests import from this module).
export { ARM_CACHE_PREFIX, armCachePath, writeArmCache } from "../observation/armCache.js";
export type { ArmCacheEntry } from "../observation/armCache.js";
export type { CatalogLoader, CatalogResolver } from "./catalogTypes.js";

/** Find the catalog topic whose `(class, id)` serializes to `key`. */
const findTopicByKey = (
  topics: readonly Topic[],
  key: AbilityKey,
): Topic | undefined =>
  topics.find((topic) => abilityKey(topic.class, topic.id) === key);

/** Build the user-facing offer prompt for a regular activity-based offer. */
const offerPrompt = (topic: Topic): string =>
  `You just exercised "${topic.title}". Want a quick quiz to check your grasp? (${topic.summary})`;

/** Build the user-facing offer prompt for a due-for-review offer. */
const reviewOfferPrompt = (topic: Topic): string =>
  `Time to refresh "${topic.title}" — it's been a while. Want a quick quiz to keep that knowledge sharp? (${topic.summary})`;

/**
 * Compute the due-for-review candidate keys for the given scope, sorted
 * most-overdue first (largest days-since-last-assessed).
 *
 * Includes topics in EITHER of these states:
 *  1. Already flagged `due_for_review` in the graduation record (persisted by
 *     `get_status` or `submit_answer` demotion — the most common case).
 *  2. Newly-detected lapses via {@link isDueForReview} (topics that became stale
 *     since the last `get_status` call, before the flag was persisted).
 *
 * This covers the case where `get_status` has not been called recently and the
 * graduation record has not yet been updated — the lapse engine detects these
 * on-the-fly here, consistent with the status tool's own detection (SC-011).
 *
 * Only topics in scope for `tool` (general + that tool) are considered.  Pure /
 * read-only — no profile mutations.
 *
 * @param topics - The full catalog topic list.
 * @param profile - The current profile (reads abilities + graduations).
 * @param tool - Optional tool scope filter (same semantics as get_status).
 * @param now - Reference ISO datetime (injected; engine is clock-free).
 * @returns Keys of due-for-review topics, most-overdue first.
 */
const dueForReviewCandidates = (
  topics: readonly Topic[],
  profile: Profile,
  tool: ToolId | undefined,
  now: string,
): AbilityKey[] => {
  const due: { key: AbilityKey; daysSince: number }[] = [];

  for (const topic of topics) {
    // Scope filter: general topics apply to every tool; tool-scoped topics only
    // apply to their own tool (or when no tool filter is set).
    const inScope =
      topic.class.kind === "general" ||
      tool === undefined ||
      topic.class.tool === tool;
    if (!inScope) continue;

    const key = abilityKey(topic.class, topic.id);
    const graduation = profile.graduations[key];
    const ability = profile.abilities[key];
    if (graduation === undefined || ability === undefined) continue;

    // Include if already flagged due_for_review (persisted state from get_status
    // or demotion), OR if the lapse engine detects it newly due now (not yet
    // persisted — isDueForReview skips already-flagged topics, so we check the
    // flag first).
    const alreadyFlagged = graduation.status === "due_for_review";
    const newlyDue = !alreadyFlagged && isDueForReview(graduation, ability, now);
    if (!alreadyFlagged && !newlyDue) continue;

    // Sort by how overdue: days since last assessment (proxy for urgency).
    const daysSince = daysBetween(ability.lastAssessedAt, now);
    due.push({ key, daysSince });
  }

  // Most-overdue first.
  due.sort((a, b) => b.daysSince - a.daysSince);
  return due.map((d) => d.key);
};

/**
 * Build the `get_offer` tool module (US-1).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @param loaderOrResolver - Catalog source seam (test seam); accepts a sync
 *   {@link CatalogLoader} (test fixtures) or an async {@link CatalogResolver}
 *   (production). Defaults to {@link resolveCatalog} (fresh-fetch → cache →
 *   bundled). With no `VIBE_HERO_CONTENT_URL` set, resolver falls back to
 *   bundled — identical to the prior behavior offline.
 * @returns The erased registry entry for `get_offer`.
 */
export const makeGetOfferTool = (
  dirOverride?: string,
  loaderOrResolver: CatalogLoader | CatalogResolver = resolveCatalog,
): AnyToolModule =>
  defineTool({
    name: "get_offer",
    description:
      "Resolve whether to surface an end-of-work learning offer for the session.",
    inputSchema: GetOfferInputSchema,
    handler: async (input: GetOfferInput): Promise<GetOfferResult> => {
      const now = new Date();
      const nowIso = now.toISOString();

      // Catalog load happens outside the lock (read-only, no profile state).
      const { topics } = await loadCatalog(loaderOrResolver, dirOverride);

      // TOCTOU fix (code-review finding): the ENTIRE read-decide-write runs
      // inside ONE updateProfile closure, so the decision is made against the
      // locked, current profile — a concurrent drain-timer write can no longer
      // interleave between an unlocked read and the locked write. The closure
      // is pure state math (no IO); the arm-cache write happens after, from
      // the outcome captured here.
      let diagnostics: OfferDiagnostics | undefined;
      let outcome:
        | { kind: "suppressed"; reason: SuppressionReason }
        | {
            kind: "offer";
            key: AbilityKey;
            topic: Topic;
            isDue: boolean;
            armToWrite: OfferArm | undefined;
          }
        | undefined;

      await updateProfile((profile: Profile): Profile => {
        const config = profile.config;

        // Reconcile the ledger to THIS session (a new session id rolls over
        // the per-session accounting) before deciding.
        const ledger = ledgerForSession(profile.offers, input.sessionId);

        // Due-for-review candidates (task #21): compute from the lapse engine
        // and prepend them — most-overdue first — ahead of activity-based
        // candidates. Same lapse engine as get_status, so due detection is
        // consistent. No scoring state is touched — offers never score (SC-003).
        const dueCandidates = dueForReviewCandidates(
          topics,
          profile,
          input.tool,
          nowIso,
        );
        // The organically armed key (spool drain → arming state machine →
        // offerArms) is a first-class candidate: the surfacing hook tells the
        // agent to call get_offer to CONFIRM that exact offer, so it must be
        // resolvable here even though record_observation never ran. It ranks
        // first so the confirmation returns the topic the hook announced;
        // due-for-review candidates follow, then activity candidates.
        const armedKey = profile.offerArms[input.sessionId]?.armedKey;
        const seen = new Set(armedKey === undefined ? [] : [armedKey]);
        const mergedCandidates: AbilityKey[] = [
          ...(armedKey === undefined ? [] : [armedKey]),
          ...dueCandidates.filter((k) => !seen.has(k) && (seen.add(k), true)),
          ...ledger.candidateKeys.filter(
            (k) => !seen.has(k) && (seen.add(k), true),
          ),
        ];
        const dueSeen = new Set(dueCandidates);

        const decision = resolveOffer(
          {
            proactiveOffers: config?.proactiveOffers ?? false,
            offerCadence: config?.offerCadence ?? "off",
            ledger,
            backoff: profile.backoff,
            candidates: mergedCandidates,
          },
          now,
        );

        // Diagnostics (debug: true) — read-only snapshot of the decision
        // inputs, captured inside the lock so it is consistent with the
        // outcome. Never mutates offer state.
        if (input.debug === true) {
          const params = eagernessParams(config?.organicEagerness);
          const sessions: OfferDiagnostics["sessions"] = {};
          for (const [sid, s] of Object.entries(profile.organicSessions)) {
            sessions[sid] = {
              weights: Object.fromEntries(
                inWindowWeightByKey(s.evidence, now, params.windowSeconds),
              ),
              ...(s.pending !== undefined ? { pendingKey: s.pending.key } : {}),
              ...(profile.offerArms[sid]?.armedKey !== undefined
                ? { armedKey: profile.offerArms[sid].armedKey }
                : {}),
              ...(s.lastSignalAt !== undefined
                ? { lastSignalAt: s.lastSignalAt }
                : {}),
            };
          }
          diagnostics = {
            suppressedBy: decision.kind === "suppressed" ? decision.reason : null,
            threshold: params.threshold,
            windowSeconds: params.windowSeconds,
            cooldownSeconds: cooldownSeconds(),
            candidates: mergedCandidates,
            sessions,
          };
        }

        if (decision.kind === "suppressed") {
          outcome = { kind: "suppressed", reason: decision.reason };
          // Persist any session rollover (so a fresh session id is recorded)
          // but never touch scoring state.
          return ledger.sessionId !== profile.offers.sessionId
            ? { ...profile, offers: ledger }
            : profile;
        }

        const topic = findTopicByKey(topics, decision.key);
        if (topic === undefined) {
          // Catalog drift: treat as no candidate rather than throwing —
          // offers must never crash the path.
          outcome = { kind: "suppressed", reason: "no_candidate" };
          return ledger.sessionId !== profile.offers.sessionId
            ? { ...profile, offers: ledger }
            : profile;
        }

        // Record that the offer surfaced so the cadence caps apply next time.
        const offered = markOffered(ledger, decision.key);

        // Arm the session — but only refresh the hook cache when the arm gates
        // allow it. `canArm` checks:
        //   1. TIMER: cooldown since lastOfferAt has elapsed.
        //   2. SEMANTIC: real work has happened since the last quiz (if any).
        // `get_offer` is called EXPLICITLY by the agent; it always returns the
        // offer so the agent can present it. The hook cache only refreshes
        // when `canArm` passes.
        const existingArm: OfferArm = profile.offerArms[input.sessionId] ?? {};
        const shouldArm = canArm(existingArm, now);
        const arm = shouldArm
          ? armSession(decision.key, topic.title, now, existingArm)
          : existingArm;

        outcome = {
          kind: "offer",
          key: decision.key,
          topic,
          isDue: dueSeen.has(decision.key),
          armToWrite: shouldArm ? arm : undefined,
        };
        return {
          ...profile,
          offers: offered,
          offerArms: shouldArm
            ? { ...profile.offerArms, [input.sessionId]: arm }
            : profile.offerArms,
        };
      }, dirOverride);

      if (outcome === undefined || outcome.kind === "suppressed") {
        return {
          suppressed: outcome?.reason ?? "no_candidate",
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        };
      }

      // Write the hook cache as a side effect, outside the lock (best-effort;
      // logged inside writeArmCache).
      if (outcome.armToWrite !== undefined) {
        // Pass dirOverride through: the arm cache must land in the SAME home
        // as the profile, or a test/tool using the dirOverride seam leaks arm
        // files into the user's real ~/.vibe-hero (observed in the wild).
        await writeArmCache(input.sessionId, outcome.armToWrite, dirOverride);
      }

      return {
        offer: {
          key: outcome.key,
          title: outcome.topic.title,
          prompt: outcome.isDue
            ? reviewOfferPrompt(outcome.topic)
            : offerPrompt(outcome.topic),
        },
        ...(diagnostics !== undefined ? { diagnostics } : {}),
      };
    },
  });

/**
 * Build the `record_offer_response` tool module (US-1).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @returns The erased registry entry for `record_offer_response`.
 */
export const makeRecordOfferResponseTool = (
  dirOverride?: string,
): AnyToolModule =>
  defineTool({
    name: "record_offer_response",
    description:
      "Record an accept/decline/defer offer response so cadence and anti-nag are honored.",
    inputSchema: RecordOfferResponseInputSchema,
    handler: async (
      input: RecordOfferResponseInput,
    ): Promise<RecordOfferResponseResult> => {
      const now = new Date();
      let armToClear: OfferArm | undefined;

      // Single atomic read-modify-write so concurrent sessions serialize. Only
      // the `offers` ledger + `backoff` + `offerArms` change — scoring state is
      // untouched.
      await updateProfile((current: Profile): Profile => {
        const ledger = ledgerForSession(current.offers, input.sessionId);
        const existingArm: OfferArm = current.offerArms[input.sessionId] ?? {};

        switch (input.response) {
          case "decline": {
            const { ledger: nextLedger, backoff } = applyDecline(
              ledger,
              current.backoff,
              input.key,
              now,
              ASSESSMENT_CONFIG,
            );
            // Clear the arm + stamp lastOfferAt so the hook falls silent until
            // the cooldown elapses. Arm cleared on decline (FR-020 extension).
            armToClear = clearArm(existingArm, now);
            return {
              ...current,
              offers: nextLedger,
              backoff,
              offerArms: { ...current.offerArms, [input.sessionId]: armToClear },
            };
          }
          case "accept": {
            // Accept does not clear the arm (it was already consumed by the
            // quiz flow) and does not stamp lastOfferAt — the user engaged, so
            // next offer timing is driven by start_quiz's clearArm call.
            return {
              ...current,
              offers: ledger,
              backoff: applyAccept(current.backoff),
            };
          }
          case "defer": {
            const { ledger: nextLedger, backoff } = applyDefer(
              ledger,
              current.backoff,
            );
            // Defer = "ask me later" — clear the arm so the hook is silent until
            // the cooldown elapses, then the next get_offer can re-arm.
            armToClear = clearArm(existingArm, now);
            return {
              ...current,
              offers: nextLedger,
              backoff,
              offerArms: { ...current.offerArms, [input.sessionId]: armToClear },
            };
          }
        }
      }, dirOverride);

      // Write cleared cache outside the lock (best-effort). Inlined former
      // writeClearedCache pass-through (code-review finding).
      if (armToClear !== undefined) {
        await writeArmCache(input.sessionId, armToClear, dirOverride);
      }

      return { ok: true };
    },
  });

/** Default `get_offer` module (env / `~/.vibe-hero` + bundled catalog). */
export const getOfferTool: AnyToolModule = makeGetOfferTool();

/** Default `record_offer_response` module (env / `~/.vibe-hero`). */
export const recordOfferResponseTool: AnyToolModule =
  makeRecordOfferResponseTool();
