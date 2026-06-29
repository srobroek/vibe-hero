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
 * Gated (FR-032): this tool is NOT exempt, so `index.ts`/`withSetupGate` returns
 * SETUP_REQUIRED before the handler runs when `profile.config` is absent. The
 * handler therefore assumes a configured profile and reads `config.toolsLearning`
 * to resolve the default tool.
 *
 * Each tool is exposed as a factory closing over an optional `dirOverride` (the
 * store's test seam), mirroring `config.ts`: the registry uses the default
 * instance (env / `~/.vibe-hero`); tests build a dir-scoped instance against a
 * temp home.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (`get_status`),
 * spec.md US-2 / FR-021 / SC-011.
 */

import { loadBundledCatalog } from "../catalog/bundled/index.js";
import { loadProfile } from "../profile/store.js";
import type { ToolId } from "../schemas/common.js";
import type { GetStatusInput, GetStatusResult } from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";
import {
  GetStatusInputSchema,
} from "../schemas/tools.js";
import { computeStandings, rankByWeakness, suggestionReason } from "./us2/standing.js";

/**
 * Resolve which tool `get_status` reports on. Honors an explicit `tool`; else
 * falls back to the first tool the user is learning; else `claude-code` (the
 * only tool v1 ships content for). The handler is gated, so `config` is present.
 */
const resolveTool = (
  requested: ToolId | undefined,
  toolsLearning: readonly ToolId[],
): ToolId => requested ?? toolsLearning[0] ?? "claude-code";

/** How many weakest/stale topics to surface as `suggestions`. */
const MAX_SUGGESTIONS = 3;

/**
 * Build the `get_status` tool module (US-2).
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @returns The erased registry entry for `get_status`.
 */
export const makeGetStatusTool = (dirOverride?: string): AnyToolModule =>
  defineTool({
    name: "get_status",
    description:
      "Show the user's learning standing for a tool (or all). Read-only.",
    inputSchema: GetStatusInputSchema,
    handler: async (input: GetStatusInput): Promise<GetStatusResult> => {
      const profile = await loadProfile(dirOverride);
      const tool = resolveTool(input.tool, profile.config?.toolsLearning ?? []);

      // Bundled catalog is always available offline (FR-025); malformed files
      // are reported as `errors` and simply skipped here — status still lists
      // every topic that loaded cleanly.
      const { topics } = loadBundledCatalog();

      const standings = computeStandings(topics, profile, tool);

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
