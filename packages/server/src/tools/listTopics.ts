/**
 * @file Real `list_topics` tool module (T026, US-2).
 *
 * Enumerates the catalog's topics, optionally filtered by `tool` and/or `class`,
 * returning one row per topic (`{ key, id, class, title, tiers, itemCount }`)
 * plus the catalog `version`. Works offline against the bundled snapshot
 * (FR-025); `catalogVersion` comes from the manifest derived over the loaded
 * topics (the placeholder `0.0.0-bundled` until the fetch layer supplies a real
 * semver — see `buildManifest`).
 *
 * Telemetry-free (SC-011): enumeration reads only the catalog, never the
 * profile's observation/offer state. Gated (FR-032) — `index.ts` returns
 * SETUP_REQUIRED before the handler runs when unconfigured.
 *
 * Filters:
 * - `class` ("general" | "tool") matches a topic's `class.kind`.
 * - `tool` keeps `general` topics (they apply to every tool) plus tool-scoped
 *   topics whose tool matches — the same scoping rule `get_status` uses.
 *
 * Exposed as a `dirOverride`-closing factory mirroring `config.ts` (the catalog
 * itself ignores the override; the seam is kept uniform across tool factories so
 * the registry and tests wire every tool identically).
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (`list_topics`),
 * spec.md US-2 / FR-025 / SC-007.
 */

import { loadBundledCatalog } from "../catalog/bundled/index.js";
import { buildManifest } from "../catalog/loader.js";
import { abilityKey } from "../schemas/common.js";
import type { Topic } from "../schemas/content.js";
import {
  ListTopicsInputSchema,
  type ListTopicsInput,
  type ListTopicsResult,
  type ListTopicsRow,
} from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";
import { topicInScope } from "./us2/standing.js";

/** The narrowed `class` discriminator surfaced in a {@link ListTopicsRow}. */
const classKind = (topic: Topic): "general" | "tool" => topic.class.kind;

/** Distinct tiers present in a topic's items, ascending (manifest convention). */
const topicTiers = (topic: Topic): ListTopicsRow["tiers"] =>
  [...new Set(topic.items.map((item) => item.tier))].sort((a, b) => a - b);

/**
 * Build the `list_topics` tool module (US-2).
 *
 * @param _dirOverride - Profile-directory override (test seam); unused here (the
 *   catalog is read-only and not under the profile home), kept for a uniform
 *   factory signature across the tool modules.
 * @returns The erased registry entry for `list_topics`.
 */
export const makeListTopicsTool = (_dirOverride?: string): AnyToolModule =>
  defineTool({
    name: "list_topics",
    description:
      "Enumerate catalog topics, optionally filtered by tool or class. Read-only.",
    inputSchema: ListTopicsInputSchema,
    handler: async (input: ListTopicsInput): Promise<ListTopicsResult> => {
      const { topics } = loadBundledCatalog();

      // `catalogVersion` is derived from the FULL catalog, independent of the
      // caller's filter, so the reported version is stable across queries.
      const { version } = buildManifest(topics);

      const filtered = topics
        .filter((topic) => topicInScope(topic, input.tool))
        .filter(
          (topic) => input.class === undefined || classKind(topic) === input.class,
        );

      const rows: ListTopicsRow[] = filtered.map((topic) => ({
        key: abilityKey(topic.class, topic.id),
        id: topic.id,
        class: classKind(topic),
        title: topic.title,
        tiers: topicTiers(topic),
        itemCount: topic.items.length,
      }));

      return { topics: rows, catalogVersion: version };
    },
  });

/** Default `list_topics` module (env / `~/.vibe-hero`), used by the registry. */
export const listTopicsTool: AnyToolModule = makeListTopicsTool();
