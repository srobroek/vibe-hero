/**
 * @file Real `get_status` tool module (T025, US-2).
 *
 * Reports the learner's standing for a tool (or, when no `tool` is given, the
 * first tool they are learning per `config.toolsLearning`). For every in-scope
 * catalog topic it returns a per-(topic × class) row — key, title, displayed
 * tier, status (`current` / `due_for_review` / `not_started`), and current
 * ability — plus a `dueForReview` key list and weakest-first `suggestions`.
 *
 * Telemetry-free (SC-011): the result is derived purely from the bundled catalog
 * and the profile's `abilities`/`graduations`. No observation, offer, or
 * transcript state is consulted, so status works fully in the pull path even
 * when no hook is installed (FR-021).
 *
 * Lapse (T046, US-3 / FR-009): on read, graduated topics that have gone stale
 * and decayed near/under their lower band ({@link detectLapses}, OD-003) are
 * surfaced as `due_for_review`. This is the read-side trigger for knowledge
 * lapse: status reads the clock and passes `now` into the PURE lapse engine,
 * then persists the `due_for_review` status and enqueues a
 * `ReviewEntry{reason:"lapsed"}` for each newly-detected topic (T046 owns
 * reviewSchedule writes for BOTH the spaced — on graduation — and lapsed reasons,
 * resolving analyze C1's single-writer concern). The enqueue is idempotent: a
 * topic already flagged `due_for_review` is skipped, so re-reading status does
 * not pile up duplicate lapsed entries.
 *
 * Gated (FR-032 + FR-031): this tool is NOT exempt. The setup gate returns
 * SETUP_REQUIRED when `profile.config` is absent; the tool gate returns
 * UNSUPPORTED_TOOL when the host is unrecognised and no `toolsLearning` is
 * configured. The handler therefore assumes both config and a resolvable tool.
 *
 * Each tool is exposed as a factory closing over an optional `dirOverride` (the
 * store's test seam), mirroring `config.ts`: the registry uses the default
 * instance (env / `~/.vibe-hero`); tests build a dir-scoped instance against a
 * temp home.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (`get_status`),
 * spec.md US-2 / FR-021 / SC-011.
 */

import { resolveCatalog, type ResolvedCatalog } from "../catalog/resolve.js";
import type { CatalogLoadResult } from "../catalog/loader.js";
import { loadProfile, updateProfile } from "../profile/store.js";
import type { AbilityKey, ToolId } from "../schemas/common.js";
import type { Profile, ReviewEntry } from "../schemas/profile.js";
import type { GetStatusInput, GetStatusResult } from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";
import {
  GetStatusInputSchema,
} from "../schemas/tools.js";
import {
  computeStandings,
  detectLapses,
  rankByWeakness,
  suggestionReason,
} from "./us2/standing.js";
import { getDetectedTool } from "../detection.js";

/**
 * Resolve which tool `get_status` reports on. Priority order:
 *   1. explicit `tool` parameter from the caller
 *   2. auto-detected tool from the MCP handshake ({@link getDetectedTool})
 *   3. first tool in `config.toolsLearning` (explicit config — always valid)
 *
 * The handler is gated (setup gate + tool gate), so by the time this runs a
 * supported tool is guaranteed: either detection is set or toolsLearning[0]
 * exists. The `?? "claude-code"` hard default is intentionally removed —
 * unknown hosts are rejected by the tool gate before reaching here.
 *
 * The non-null assertion is safe: the tool gate guarantees at least one of
 * detected or toolsLearning[0] is present when the handler executes.
 */
const resolveTool = (
  requested: ToolId | undefined,
  toolsLearning: readonly ToolId[],
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
): ToolId => (requested ?? getDetectedTool() ?? toolsLearning[0])!;

/** How many weakest/stale topics to surface as `suggestions`. */
const MAX_SUGGESTIONS = 3;

/**
 * Persist a detected knowledge lapse (T046 / FR-009): for each newly-lapsed key,
 * flag its graduation `due_for_review` and enqueue a `ReviewEntry{reason:
 * "lapsed"}` due now. Runs inside one atomic {@link updateProfile} transaction
 * (FR-023a). Re-derives the lapse status from the CURRENT on-disk profile so a
 * concurrent writer that already flagged/handled a key is respected (idempotent:
 * an already-`due_for_review` key is skipped, and a `lapsed` entry is not
 * duplicated). No-op when `newlyLapsed` is empty.
 *
 * @param newlyLapsed - Keys that {@link detectLapses} found newly due.
 * @param now - The reference ISO datetime (the lapsed entry's `dueAt`).
 * @param dirOverride - Profile-directory override (test seam).
 */
const persistLapses = async (
  newlyLapsed: readonly AbilityKey[],
  now: string,
  dirOverride: string | undefined,
): Promise<void> => {
  if (newlyLapsed.length === 0) return;
  await updateProfile((current: Profile): Profile => {
    const graduations = { ...current.graduations };
    const reviewSchedule = [...current.reviewSchedule];
    for (const key of newlyLapsed) {
      const grad = graduations[key];
      // Skip if it vanished or a concurrent writer already flagged it.
      if (grad === undefined || grad.status === "due_for_review") continue;
      graduations[key] = {
        ...grad,
        status: "due_for_review",
        lastChangeReason: "review_due",
      };
      const already = reviewSchedule.some(
        (e) => e.key === key && e.reason === "lapsed",
      );
      if (!already) {
        const entry: ReviewEntry = { key, dueAt: now, reason: "lapsed" };
        reviewSchedule.push(entry);
      }
    }
    return { ...current, graduations, reviewSchedule };
  }, dirOverride);
};

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
 * Build the `get_status` tool module (US-2).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @param loaderOrResolver - Catalog source seam (test seam); accepts a sync
 *   {@link CatalogLoader} (test fixtures) or an async {@link CatalogResolver}
 *   (production). Defaults to {@link resolveCatalog} (fresh-fetch → cache →
 *   bundled). With no `VIBE_HERO_CONTENT_URL` set, resolver falls back to
 *   bundled — identical to the prior behavior offline.
 * @returns The erased registry entry for `get_status`.
 */
export const makeGetStatusTool = (
  dirOverride?: string,
  loaderOrResolver: CatalogLoader | CatalogResolver = resolveCatalog,
): AnyToolModule =>
  defineTool({
    name: "get_status",
    description:
      "Show the user's learning standing for a tool (or all). Read-only.",
    inputSchema: GetStatusInputSchema,
    handler: async (input: GetStatusInput): Promise<GetStatusResult> => {
      const profile = await loadProfile(dirOverride);
      const tool = resolveTool(input.tool, profile.config?.toolsLearning ?? []);

      // Normalize: sync loader (tests) vs async resolver (production).
      const rawResult = loaderOrResolver(dirOverride);
      const { topics } = rawResult instanceof Promise ? await rawResult : rawResult;

      const baseStandings = computeStandings(topics, profile, tool);

      // Lapse detection (T046 / FR-009): read the clock once and pass it into
      // the PURE lapse engine. Graduated topics that have gone stale + decayed
      // near their lower band are surfaced as due_for_review; persist the
      // status + a `lapsed` review entry so the lapse durably surfaces.
      const now = new Date().toISOString();
      const { standings, newlyLapsed } = detectLapses(baseStandings, profile, now);
      await persistLapses(newlyLapsed, now, dirOverride);

      const dueForReview = standings
        .filter((s) => s.row.status === "due_for_review")
        .map((s) => s.key);

      const suggestions = rankByWeakness(standings)
        .slice(0, MAX_SUGGESTIONS)
        .map((s) => ({ key: s.key, reason: suggestionReason(s) }));

      return {
        tool,
        topics: standings.map((s) => s.row),
        dueForReview,
        suggestions,
      };
    },
  });

/** Default `get_status` module (env / `~/.vibe-hero`), used by the registry. */
export const getStatusTool: AnyToolModule = makeGetStatusTool();
