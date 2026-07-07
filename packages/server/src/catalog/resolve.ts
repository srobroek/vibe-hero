/**
 * @file Catalog resolution order: fresh-fetch → cache → bundled (T054).
 *
 * Decides which catalog the runtime serves, honoring the spec's freshness +
 * offline-resilience contract (FR-025/026/027, SC-006/007):
 *
 *   1. **fresh-fetch** — if a content source is configured AND reachable AND the
 *      fetched content is valid (Zod-validated BEFORE caching, research E8), use
 *      it and update the cache.
 *   2. **cache** — otherwise, if a previously-fetched cache exists, serve it
 *      (covers: offline, source unreachable, 304 not-modified, invalid remote).
 *   3. **bundled** — otherwise serve the in-package bundled snapshot (FR-025),
 *      so the product ALWAYS works offline / on first run with no network.
 *
 * Every remote failure is **silent** to the user (FR-027): an offline / 4xx-5xx
 * / timeout / DNS / invalid-content situation simply downgrades the source and
 * serves the next tier; no error surfaces. The `source` discriminator lets
 * callers/tests observe which tier won without changing behavior.
 *
 * `catalogVersion` is taken from the winning manifest so `list_topics` reports a
 * version that **advances after an update** (SC-007): bundled →
 * `PLACEHOLDER_CATALOG_VERSION`; fetched/cached → the published manifest semver.
 *
 * ## Default behavior preserves the existing tools
 *
 * When no content URL is configured (the default), step 1 is `disabled` and, if
 * no cache exists, the resolver returns the **bundled** catalog — exactly what
 * the tools served before this task. So switching a tool from
 * `loadBundledCatalog()` to `resolveCatalog()` is behavior-preserving offline
 * (keeps the 124 existing tests green); fetching only ever engages when a URL is
 * explicitly set.
 *
 * Source of truth: spec FR-025/026/027, SC-006/007, research.md E8,
 * contracts/mcp-tools.md (`list_topics` → `catalogVersion`).
 */

import { loadBundledCatalog } from "./bundled/index.js";
import {
  buildManifest,
  PLACEHOLDER_CATALOG_VERSION,
  type CatalogLoadError,
} from "./loader.js";
import {
  readCachedCatalog,
  refreshCatalogCache,
  type FetchImpl,
} from "./fetcher.js";
import type { Topic } from "../schemas/content.js";
import { timed } from "../perf.js";

/** Which tier of the resolution order produced the served catalog. */
export type CatalogSource = "fetched" | "cache" | "bundled";

/** The resolved catalog the runtime serves. */
export interface ResolvedCatalog {
  /** The topics to serve (already Zod-validated for every source). */
  readonly topics: Topic[];
  /** The catalog version of the winning source (advances after an update). */
  readonly catalogVersion: string;
  /** Which tier of the order won — observability/test seam, never user-facing. */
  readonly source: CatalogSource;
  /**
   * Per-file load errors from the bundled snapshot, when it is the served
   * source. Empty for fetched/cache (those validate the whole catalog up front
   * and reject any invalid file). Mirrors {@link loadBundledCatalog}'s contract.
   */
  readonly errors: CatalogLoadError[];
}

/** Options controlling {@link resolveCatalog}. */
export interface ResolveOptions {
  /**
   * Whether to attempt a fresh network fetch this resolution. Defaults to
   * `true`, but a fetch only actually happens when a content URL is configured
   * (otherwise it is reported `disabled` and we fall through). Pass `false` to
   * force a cache/bundled resolution without touching the network at all.
   */
  readonly fetch?: boolean;
  /** Published content base URL (overrides `VIBE_HERO_CONTENT_URL`). */
  readonly contentUrl?: string;
  /** Injected `fetch` (test seam); defaults to the global `fetch`. */
  readonly fetchImpl?: FetchImpl;
  /** Per-request fetch timeout (ms). */
  readonly timeoutMs?: number;
}

/**
 * Resolve the catalog to serve using the **fresh-fetch → cache → bundled** order.
 *
 * Asynchronous because the fetch + cache tiers do IO. Never throws: a remote or
 * cache failure silently degrades to the next tier and ultimately the bundled
 * snapshot, which is always present (FR-027, SC-006).
 *
 * @param dirOverride - Profile-home override (test seam) used for the cache dir
 *   (sibling of the profile dir, same `VIBE_HERO_HOME` seam).
 * @param options - Fetch toggle, source URL, injected fetch, timeout.
 * @returns The resolved catalog with its version and winning source.
 */
export const resolveCatalog = async (
  dirOverride?: string,
  options: ResolveOptions = {},
): Promise<ResolvedCatalog> => {
  const tryFetch = options.fetch ?? true;

  // --- 1. fresh-fetch (only if enabled + a source is configured) -----------
  if (tryFetch) {
    // Build the fetch options immutably, omitting absent keys so
    // `exactOptionalPropertyTypes` is satisfied (no `undefined` assignments).
    const fetchOpts: Parameters<typeof refreshCatalogCache>[1] = {
      ...(options.contentUrl !== undefined ? { contentUrl: options.contentUrl } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };

    const outcome = await timed("catalog:fetch", () =>
      refreshCatalogCache(dirOverride, fetchOpts),
    );
    if (outcome.ok) {
      return {
        topics: outcome.catalog.topics,
        catalogVersion: outcome.catalog.manifest.version,
        source: "fetched",
        errors: [],
      };
    }
    // disabled / not_modified / unreachable / invalid all fall through to the
    // cache tier — silently, no user-facing error (FR-027). For not_modified
    // and a write-skipped success, the cache below already holds the content.
  }

  // --- 2. cache (a prior successful fetch) ---------------------------------
  const cached = await timed("catalog:read-cache", () =>
    readCachedCatalog(dirOverride),
  );
  if (cached !== undefined) {
    return {
      topics: cached.topics,
      catalogVersion: cached.manifest.version,
      source: "cache",
      errors: [],
    };
  }

  // --- 3. bundled (always present; offline / first-run guarantee) ----------
  const { topics, errors } = await timed("catalog:bundled", () =>
    loadBundledCatalog(),
  );
  const version = bundledVersion(topics);
  return { topics, catalogVersion: version, source: "bundled", errors };
};

/**
 * Derive the version reported for the bundled snapshot. {@link buildManifest}
 * stamps {@link PLACEHOLDER_CATALOG_VERSION} when no explicit version is given,
 * which is exactly the right "this is the un-versioned baseline" signal — a real
 * fetched/cached version is a semver and thus always compares as newer.
 */
const bundledVersion = (topics: readonly Topic[]): string => {
  // buildManifest validates and stamps the placeholder version; reuse it so the
  // bundled version stays consistent with the manifest the tools build elsewhere.
  if (topics.length === 0) return PLACEHOLDER_CATALOG_VERSION;
  return buildManifest(topics).version;
};
