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
 * Catalog source: resolves via {@link resolveCatalog} (fresh-fetch → cache →
 * bundled, T054). With no `VIBE_HERO_CONTENT_URL` configured this is exactly the
 * prior bundled behavior; when a source is configured the reported
 * `catalogVersion` advances after a published update (SC-007). All remote
 * failures degrade silently to cache/bundled (FR-027).
 *
 * Filters:
 * - `class` ("general" | "tool") matches a topic's `class.kind`.
 * - `tool` keeps `general` topics (they apply to every tool) plus tool-scoped
 *   topics whose tool matches — the same scoping rule `get_status` uses.
 *
 * Exposed as a `(dirOverride, resolver)` factory: `dirOverride` flows to the
 * content-cache dir (sibling of the profile home), and `resolver` is the catalog
 * source seam (defaults to {@link resolveCatalog}) so tests can inject a fake
 * fetch/cache without touching the network.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (`list_topics`),
 * spec.md US-2 / FR-025 / FR-026 / FR-027 / SC-006 / SC-007.
 */

import { resolveCatalog, type ResolvedCatalog } from "../catalog/resolve.js";
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

/**
 * Catalog-resolution seam for {@link makeListTopicsTool}. Mirrors
 * {@link resolveCatalog}'s signature so tests can inject a fake fetch/cache while
 * production uses the real fresh-fetch → cache → bundled resolution.
 */
export type CatalogResolver = (
  dirOverride?: string,
) => Promise<ResolvedCatalog>;

/** The narrowed `class` discriminator surfaced in a {@link ListTopicsRow}. */
const classKind = (topic: Topic): "general" | "tool" => topic.class.kind;

/** Distinct tiers present in a topic's items, ascending (manifest convention). */
const topicTiers = (topic: Topic): ListTopicsRow["tiers"] =>
  [...new Set(topic.items.map((item) => item.tier))].sort((a, b) => a - b);

/**
 * Build the `list_topics` tool module (US-2).
 *
 * @param dirOverride - Profile-home override (test seam); flows to the content
 *   cache dir used by {@link resolveCatalog}.
 * @param resolver - Catalog-resolution seam (test seam); defaults to
 *   {@link resolveCatalog} (fresh-fetch → cache → bundled). Tests inject a fake
 *   resolver/fetch so no real network is hit.
 * @returns The erased registry entry for `list_topics`.
 */
export const makeListTopicsTool = (
  dirOverride?: string,
  resolver: CatalogResolver = resolveCatalog,
): AnyToolModule =>
  defineTool({
    name: "list_topics",
    description:
      "Enumerate catalog topics, optionally filtered by tool or class. Read-only.",
    inputSchema: ListTopicsInputSchema,
    handler: async (input: ListTopicsInput): Promise<ListTopicsResult> => {
      // Resolve via fresh-fetch → cache → bundled (T054). `catalogVersion` is
      // the winning source's version, independent of the caller's filter, so it
      // stays stable across queries and advances after a published update.
      const { topics, catalogVersion } = await resolver(dirOverride);

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

      return { topics: rows, catalogVersion };
    },
  });

/** Default `list_topics` module (env / `~/.vibe-hero`), used by the registry. */
export const listTopicsTool: AnyToolModule = makeListTopicsTool();
