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
 *    receives no signals of its own). When an offer surfaces it is recorded via
 *    {@link markOffered} so the cadence caps apply on the next call, and the
 *    offer's `prompt` is built from the catalog topic's summary.
 *
 *  - `record_offer_response` ({sessionId, key, response}) persists the
 *    accept/decline/defer outcome: a decline applies within-session suppression
 *    (FR-020) AND cross-session backoff + eventual global mute (FR-020b) via
 *    {@link applyDecline}; an accept resets the consecutive-decline counter and
 *    clears the mute via {@link applyAccept}; a defer leaves state unchanged.
 *
 * Both delegate the decision/state math to the pure engine and own only the IO:
 * clock, catalog load, and the atomic {@link updateProfile} write. Neither tool
 * EVER touches abilities/graduations/quizHistory — offers never score (FR-005,
 * SC-003).
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
import { loadBundledCatalog } from "../catalog/bundled/index.js";
import type { CatalogLoadResult } from "../catalog/loader.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import { abilityKey, type AbilityKey } from "../schemas/common.js";
import type { Topic } from "../schemas/content.js";
import type { OfferLedger, Profile } from "../schemas/profile.js";
import {
  GetOfferInputSchema,
  RecordOfferResponseInputSchema,
  type GetOfferInput,
  type GetOfferResult,
  type RecordOfferResponseInput,
  type RecordOfferResponseResult,
} from "../schemas/tools.js";
import {
  applyAccept,
  applyDecline,
  applyDefer,
  ledgerForSession,
  markOffered,
  resolveOffer,
} from "../observation/offers.js";
import { defineTool, type AnyToolModule } from "./types.js";

/** Catalog source override (test seam); defaults to the bundled snapshot. */
export type CatalogLoader = () => CatalogLoadResult;

/** Find the catalog topic whose `(class, id)` serializes to `key`. */
const findTopicByKey = (
  topics: readonly Topic[],
  key: AbilityKey,
): Topic | undefined =>
  topics.find((topic) => abilityKey(topic.class, topic.id) === key);

/** Build the user-facing offer prompt for a topic (privacy-safe, no scoring). */
const offerPrompt = (topic: Topic): string =>
  `You just exercised "${topic.title}". Want a quick quiz to check your grasp? (${topic.summary})`;

/**
 * Build the `get_offer` tool module (US-1).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @param catalogLoader - Catalog source override (test seam); defaults to the
 *   bundled snapshot {@link loadBundledCatalog}.
 * @returns The erased registry entry for `get_offer`.
 */
export const makeGetOfferTool = (
  dirOverride?: string,
  catalogLoader: CatalogLoader = loadBundledCatalog,
): AnyToolModule =>
  defineTool({
    name: "get_offer",
    description:
      "Resolve whether to surface an end-of-work learning offer for the session.",
    inputSchema: GetOfferInputSchema,
    handler: async (input: GetOfferInput): Promise<GetOfferResult> => {
      const now = new Date();
      const profile = await loadProfile(dirOverride);
      const config = profile.config;

      // Gated: config is present. Reconcile the ledger to THIS session (a new
      // session id rolls over the per-session accounting) before deciding.
      const ledger = ledgerForSession(profile.offers, input.sessionId);

      const decision = resolveOffer(
        {
          proactiveOffers: config?.proactiveOffers ?? false,
          offerCadence: config?.offerCadence ?? "off",
          ledger,
          backoff: profile.backoff,
          candidates: ledger.candidateKeys,
        },
        now,
      );

      if (decision.kind === "suppressed") {
        // Persist any session rollover (so a fresh session id is recorded) but
        // never touch scoring state.
        if (ledger.sessionId !== profile.offers.sessionId) {
          await persistLedger(ledger, dirOverride);
        }
        return { suppressed: decision.reason };
      }

      const { topics } = catalogLoader();
      const topic = findTopicByKey(topics, decision.key);
      if (topic === undefined) {
        // The candidate key has no resolvable topic (catalog drift): treat as
        // no candidate rather than throwing — offers must never crash the path.
        if (ledger.sessionId !== profile.offers.sessionId) {
          await persistLedger(ledger, dirOverride);
        }
        return { suppressed: "no_candidate" };
      }

      // Record that the offer surfaced so the cadence caps apply next time.
      const offered = markOffered(ledger, decision.key);
      await persistLedger(offered, dirOverride);

      return {
        offer: {
          key: decision.key,
          title: topic.title,
          prompt: offerPrompt(topic),
        },
      };
    },
  });

/**
 * Persist ONLY the `offers` ledger block (atomic). Never touches abilities,
 * graduations, quizHistory, reviewSchedule, or backoff — keeping the offer path
 * score-free (FR-005 / SC-003).
 */
const persistLedger = async (
  ledger: OfferLedger,
  dirOverride?: string,
): Promise<void> => {
  await updateProfile(
    (current: Profile): Profile => ({ ...current, offers: ledger }),
    dirOverride,
  );
};

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

      // Single atomic read-modify-write so concurrent sessions serialize. Only
      // the `offers` ledger + `backoff` change — scoring state is untouched.
      await updateProfile((current: Profile): Profile => {
        const ledger = ledgerForSession(current.offers, input.sessionId);

        switch (input.response) {
          case "decline": {
            const { ledger: nextLedger, backoff } = applyDecline(
              ledger,
              current.backoff,
              input.key,
              now,
              ASSESSMENT_CONFIG,
            );
            return { ...current, offers: nextLedger, backoff };
          }
          case "accept": {
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
            return { ...current, offers: nextLedger, backoff };
          }
        }
      }, dirOverride);

      return { ok: true };
    },
  });

/** Default `get_offer` module (env / `~/.vibe-hero` + bundled catalog). */
export const getOfferTool: AnyToolModule = makeGetOfferTool();

/** Default `record_offer_response` module (env / `~/.vibe-hero`). */
export const recordOfferResponseTool: AnyToolModule =
  makeRecordOfferResponseTool();
