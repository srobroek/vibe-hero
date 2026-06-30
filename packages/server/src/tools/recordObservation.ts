/**
 * @file Real `record_observation` tool module (T034, US-1).
 *
 * Intake for the observation source (the real-time Claude Code hook in v1). It
 * accepts derived, privacy-safe signals (`toolName` / `mcpTool` / `success` /
 * `toolUseId`) plus a `sessionId`, matches them to candidate topic keys against
 * the catalog's {@link TriggerSignal}s, accumulates the candidates into the
 * per-session {@link OfferLedger}, and returns `{ offerCandidates }`.
 *
 * Trigger-only — AWARDS NOTHING (FR-005 / SC-003). It deliberately touches ONLY
 * the profile's `offers` ledger (its `sessionId` / candidate accounting). It
 * never reads or writes `abilities`, `graduations`, `quizHistory`, or
 * `reviewSchedule`, so observed usage with no answered quiz produces exactly 0
 * change to points or graduation state (SC-003) — the integration test asserts
 * those fields are byte-identical before/after.
 *
 * v1 scope note: a SINGLE real-time hook source feeds this tool. FR-017's
 * two-source (hook + transcript backfill) correlation by `tool_use_id` is
 * architecture-ready (signals carry `toolUseId`; the {@link ObservationSource}
 * seam exists) but is NOT built here, per tasks.md.
 *
 * Gated (FR-032): NOT exempt — `index.ts`/`withSetupGate` returns SETUP_REQUIRED
 * before this handler runs when `profile.config` is absent. The handler assumes
 * a configured profile and reads `config.proactiveOffers` / `config.offerCadence`
 * only to short-circuit candidate work when offers are disabled (so a disabled
 * user never accrues candidate state needlessly).
 *
 * Exposed as a `(dirOverride, catalogLoader)` factory mirroring
 * `startQuiz.ts` / `status.ts`: the registry uses the default instance
 * (env / `~/.vibe-hero` + bundled catalog); tests inject a temp home + fixture
 * catalog.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`record_observation`), spec.md FR-005 / FR-015..017 / FR-018 / SC-003,
 * data-model.md (§ OfferLedger).
 */

import { resolveCatalog, type ResolvedCatalog } from "../catalog/resolve.js";
import type { CatalogLoadResult } from "../catalog/loader.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import type { Profile } from "../schemas/profile.js";
import { getDetectedTool } from "../detection.js";
import {
  RecordObservationInputSchema,
  type OfferCandidate,
  type RecordObservationInput,
  type RecordObservationResult,
} from "../schemas/tools.js";
import {
  ledgerForSession,
  matchCandidates,
  noteCandidates,
  type ObservedSignal,
} from "../observation/offers.js";
import { defineTool, type AnyToolModule } from "./types.js";

/**
 * Sync catalog loader (test seam): returns topics synchronously from a fixture
 * dir. Tests inject this form; production uses {@link CatalogResolver}.
 * The optional arg is unused by sync loaders but makes the type compatible with
 * the {@link CatalogResolver} union so both can be called as `fn(dirOverride)`.
 */
export type CatalogLoader = (dirOverride?: string) => CatalogLoadResult;

/**
 * Async catalog resolver (production path): resolves via fresh-fetch → cache →
 * bundled. Mirrors {@link resolveCatalog}'s signature.
 */
export type CatalogResolver = (dirOverride?: string) => Promise<ResolvedCatalog>;

/**
 * Build the `record_observation` tool module (US-1).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @param loaderOrResolver - Catalog source seam (test seam); accepts a sync
 *   {@link CatalogLoader} (test fixtures) or an async {@link CatalogResolver}
 *   (production). Defaults to {@link resolveCatalog} (fresh-fetch → cache →
 *   bundled). With no `VIBE_HERO_CONTENT_URL` set, resolver falls back to
 *   bundled — identical to the prior behavior offline.
 * @returns The erased registry entry for `record_observation`.
 */
export const makeRecordObservationTool = (
  dirOverride?: string,
  loaderOrResolver: CatalogLoader | CatalogResolver = resolveCatalog,
): AnyToolModule =>
  defineTool({
    name: "record_observation",
    description:
      "Intake derived activity signals and map them to candidate offer topics. Never scores.",
    inputSchema: RecordObservationInputSchema,
    handler: async (
      input: RecordObservationInput,
    ): Promise<RecordObservationResult> => {
      const profile = await loadProfile(dirOverride);
      const config = profile.config;

      // If offers are disabled entirely there is nothing to surface — return
      // empty candidates WITHOUT mutating any state (and certainly never
      // touching abilities/graduations/quizHistory — FR-005 / SC-003).
      if (
        config === undefined ||
        !config.proactiveOffers ||
        config.offerCadence === "off"
      ) {
        return { offerCandidates: [] };
      }

      // Normalize: sync loader (tests) vs async resolver (production).
      const rawResult = loaderOrResolver(dirOverride);
      const { topics } = rawResult instanceof Promise ? await rawResult : rawResult;
      const signals: ObservedSignal[] = input.signals.map((s) => ({
        ...(s.toolName !== undefined ? { toolName: s.toolName } : {}),
        ...(s.mcpTool !== undefined ? { mcpTool: s.mcpTool } : {}),
        ...(s.success !== undefined ? { success: s.success } : {}),
        ...(s.toolUseId !== undefined ? { toolUseId: s.toolUseId } : {}),
      }));

      // Resolve tool: explicit input wins, then fall back to auto-detected tool.
      // If neither is available matchCandidates receives undefined and returns []
      // (graceful degradation — no crash).
      const resolvedTool = input.tool ?? getDetectedTool();

      const candidates: OfferCandidate[] = matchCandidates(
        topics,
        resolvedTool,
        signals,
      );

      // Reconcile (or roll over) the per-session ledger, accumulate the matched
      // candidate keys into its per-session pool, and persist ONLY the `offers`
      // block. No scoring fields are read or written — this is the chokepoint
      // that makes SC-003 (usage scores nothing) structurally true.
      const candidateKeys = candidates.map((c) => c.key);
      await updateProfile(
        (current: Profile): Profile => ({
          ...current,
          offers: noteCandidates(
            ledgerForSession(current.offers, input.sessionId),
            candidateKeys,
          ),
        }),
        dirOverride,
      );

      return { offerCandidates: candidates };
    },
  });

/** Default `record_observation` module (env / `~/.vibe-hero` + bundled catalog). */
export const recordObservationTool: AnyToolModule = makeRecordObservationTool();
