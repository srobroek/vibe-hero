/**
 * @file Download-only GitHub catalog fetcher (T053).
 *
 * Fetches an updated curriculum from a central, **publicly published** source and
 * caches it locally so a connected user automatically benefits from the latest
 * content without reinstalling the tool (FR-026, FR-027, SC-007). The fetch is
 * strictly **one-directional (download only)** — no user content ever leaves the
 * machine (FR-024).
 *
 * ## Content-source scheme (manifest-first)
 *
 * The published source is a **base URL** (e.g. a GitHub Pages site or a
 * `raw.githubusercontent.com/<owner>/<repo>/<ref>/content` prefix) under which:
 *
 *   - `manifest.json` is a {@link CatalogManifest}: `{ version, publishedAt,
 *     topics: [{ id, class, file, itemCount, tiers, sha256? }], etag? }`.
 *   - each topic's `file` (relative to the base URL) is a YAML document in the
 *     **same authoring format** the bundled catalog uses, parsed + Zod-validated
 *     by {@link loadTopicFromYaml}'s sibling {@link parseTopicYaml} (research E8 —
 *     validate fetched content BEFORE caching).
 *
 * This reuses the existing {@link CatalogManifest} index and the existing
 * YAML/Zod content pipeline, so a fetched catalog and the bundled snapshot are
 * byte-for-byte interchangeable once on disk. A "manifest listing topic files,
 * then fetch each" scheme is the simplest thing that composes with what we
 * already have (loader.ts) — no archive format, no new parser.
 *
 * ## Configuration
 *
 * The source is configured via the **`VIBE_HERO_CONTENT_URL`** environment
 * variable (a base URL). When unset, fetching is **disabled** and the resolver
 * (resolve.ts) silently serves cache/bundled — so the default, zero-config
 * behavior is exactly the prior offline/bundled behavior (keeps the gate-free
 * pull path and all existing tests green). {@link DEFAULT_CONTENT_URL} documents
 * the intended published location but is intentionally NOT used unless the env
 * var is set, so CI / first-run / offline never reaches for the network.
 *
 * ## Caching + ETag (FR-026)
 *
 * Cache lives under `${VIBE_HERO_HOME}/content/` (sibling of the profile dir; see
 * {@link contentCacheDir}). Alongside the manifest + topic files we persist a
 * small `cache-meta.json` ({@link CacheMeta}) holding the manifest `etag` and
 * `version`. On refresh we send `If-None-Match: <etag>`; a `304 Not Modified`
 * means "unchanged" and we skip rewriting the cache entirely.
 *
 * ## Integrity verification (sha256, A)
 *
 * When a manifest entry carries a `sha256` field, the fetcher computes the
 * sha256 hex digest of the raw fetched bytes and compares it to the expected
 * value. A mismatch rejects the WHOLE catalog as `{ ok: false, reason:
 * "invalid" }` — tampered or corrupt content is never cached or served. When
 * the manifest entry has no `sha256` (optional/legacy), the check is skipped so
 * existing manifests without hashes continue to work.
 *
 * ## First-run / no-ETag hash diff (B)
 *
 * When a 200 response arrives for the manifest (no ETag hit), instead of
 * unconditionally downloading every topic file the fetcher compares each remote
 * topic's `sha256` against the locally-known hash (from the cached manifest or
 * from the bundled manifest). Topics whose hash matches are reused from the
 * local source; only changed or new topics are downloaded. This keeps bandwidth
 * low even on a cold start.
 *
 * ## Network safety (FR-027)
 *
 * EVERY fetch failure — offline, DNS error, timeout, 4xx/5xx, malformed body,
 * Zod-invalid content, sha256 mismatch — is caught and reported as a **soft
 * failure** ({@link FetchOutcome} with `ok: false`), never thrown to the caller.
 * This lets the resolver fall back to cache/bundled with NO user-facing error
 * (SC-006).
 *
 * Source of truth: specs/001-vibe-hero-mvp/data-model.md (§ CatalogManifest,
 * § Storage notes), spec FR-024/025/026/027, research.md E8.
 */

import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import {
  CatalogManifestSchema,
  type CatalogManifest,
  type Topic,
} from "../schemas/content.js";
import {
  parseTopicYaml,
  isContentVersionSupported,
  contentVersionRejection,
} from "./loader.js";

/**
 * Default published content base URL. Documented for operators; **not used
 * unless `VIBE_HERO_CONTENT_URL` is set** so first-run / offline / CI never hits
 * the network implicitly (fetch is opt-in). Points at the curriculum published
 * from this repo's `content/` directory on the default branch.
 */
export const DEFAULT_CONTENT_URL =
  "https://raw.githubusercontent.com/vibe-hero/vibe-hero/main/content";

/** Environment variable naming the published content base URL. */
export const CONTENT_URL_ENV = "VIBE_HERO_CONTENT_URL";

/** Environment variable naming the profile home (shared with the profile store). */
const HOME_ENV = "VIBE_HERO_HOME";

/** Default profile home directory name under `~` (`~/.vibe-hero`). */
const DEFAULT_DIRNAME = ".vibe-hero";

/** Sub-directory of the profile home that holds cached catalog content. */
const CONTENT_SUBDIR = "content";

/** Basename of the fetched manifest within the cache dir. */
const MANIFEST_FILENAME = "manifest.json";

/** Basename of the cache metadata (etag/version) within the cache dir. */
const CACHE_META_FILENAME = "cache-meta.json";

/** Default per-request timeout (ms) for catalog fetches. */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Minimal structural type of the global `fetch` we depend on, so the fetcher can
 * accept an injected implementation in tests without pulling in DOM lib types.
 * Matches Node's built-in `fetch` (Node ≥18).
 */
export type FetchImpl = (
  input: string,
  init?: {
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** The subset of the `fetch` `Response` the fetcher reads. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  /** Response header accessor (case-insensitive, like the WHATWG `Headers`). */
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * Cache metadata persisted alongside the cached catalog so a later refresh can
 * revalidate with `If-None-Match` and skip unchanged downloads (FR-026).
 */
export interface CacheMeta {
  /** Catalog version (semver) of the cached manifest. */
  readonly version: string;
  /** Manifest ETag, if the source provided one; drives `If-None-Match`. */
  readonly etag?: string;
  /** When this cache entry was written (ISO datetime). */
  readonly fetchedAt: string;
}

/** A successfully fetched + validated catalog, ready to cache and serve. */
export interface FetchedCatalog {
  /** The validated manifest (its `etag` reflects the response, if any). */
  readonly manifest: CatalogManifest;
  /** Every topic, parsed + Zod-validated BEFORE caching (research E8). */
  readonly topics: Topic[];
  /** Raw YAML text per topic `file`, used to write the cache verbatim. */
  readonly rawByFile: ReadonlyMap<string, string>;
}

/**
 * Outcome of a fetch attempt. Always resolved (never rejected) so callers fall
 * back without try/catch (FR-027):
 * - `ok: true`  ⇒ fresh catalog fetched + validated.
 * - `ok: false, reason: "not_modified"` ⇒ 304; the cache is still current.
 * - `ok: false, reason: "disabled"` ⇒ no source configured (fetch opt-out).
 * - `ok: false, reason: "unreachable" | "invalid"` ⇒ soft failure; fall back.
 */
export type FetchOutcome =
  | { readonly ok: true; readonly catalog: FetchedCatalog }
  | {
      readonly ok: false;
      readonly reason: "not_modified" | "disabled" | "unreachable" | "invalid";
      /** Human-readable diagnostic (never surfaced to the user; for logs/tests). */
      readonly detail: string;
    };

/** Options for {@link fetchCatalog} / {@link refreshCatalogCache}. */
export interface FetchOptions {
  /**
   * Published content base URL. When omitted, falls back to
   * `VIBE_HERO_CONTENT_URL`; if that is also unset, fetching is **disabled**
   * (returns `{ ok: false, reason: "disabled" }`) — the default zero-config
   * offline/bundled behavior.
   */
  readonly contentUrl?: string;
  /** Injected `fetch` (test seam). Defaults to the global `fetch` (Node ≥18). */
  readonly fetchImpl?: FetchImpl;
  /** Per-request timeout in ms. Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** ETag of the currently-cached manifest, sent as `If-None-Match` (FR-026). */
  readonly etag?: string;
  /**
   * Per-topic sha256 hashes known locally (from the cached or bundled manifest).
   * When provided, topic files whose remote sha256 matches a local hash are
   * reused from `localTopicBytes` instead of downloaded (hash-diff optimisation,
   * feature B).
   */
  readonly localTopicHashes?: ReadonlyMap<string, string>;
  /**
   * Local raw bytes for topics that can be reused when the remote sha256
   * matches a local hash (keyed by `file` path, the same key as
   * `localTopicHashes`). Required to be consistent with `localTopicHashes`.
   */
  readonly localTopicBytes?: ReadonlyMap<string, string>;
}

/**
 * Resolve the cache directory that holds fetched catalog content. It is a
 * **sibling of the profile document directory** under the same `VIBE_HERO_HOME`
 * seam the profile store uses, so a test that points `VIBE_HERO_HOME` at a temp
 * dir transparently isolates both the profile and the content cache.
 *
 * @param dirOverride - Explicit profile-home override (test seam). When omitted,
 *   falls back to `VIBE_HERO_HOME`, then to `~/.vibe-hero`.
 * @returns Absolute path to `${home}/content`.
 */
export const contentCacheDir = (dirOverride?: string): string => {
  if (dirOverride !== undefined && dirOverride !== "") {
    return path.join(path.resolve(dirOverride), CONTENT_SUBDIR);
  }
  const fromEnv = process.env[HOME_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    return path.join(path.resolve(fromEnv), CONTENT_SUBDIR);
  }
  return path.join(homedir(), DEFAULT_DIRNAME, CONTENT_SUBDIR);
};

/** Absolute path to the cached manifest. */
const manifestPath = (cacheDir: string): string =>
  path.join(cacheDir, MANIFEST_FILENAME);

/** Absolute path to the cache metadata. */
const cacheMetaPath = (cacheDir: string): string =>
  path.join(cacheDir, CACHE_META_FILENAME);

/**
 * Resolve the configured content base URL, or `undefined` when fetching is
 * disabled. Order: explicit `contentUrl` → `VIBE_HERO_CONTENT_URL`. The
 * {@link DEFAULT_CONTENT_URL} constant is intentionally NOT consulted here so the
 * network is never reached implicitly (fetch is strictly opt-in).
 */
const resolveContentUrl = (contentUrl?: string): string | undefined => {
  if (contentUrl !== undefined && contentUrl !== "") return contentUrl;
  const fromEnv = process.env[CONTENT_URL_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return undefined;
};

/** Join a base URL and a relative path with exactly one separating slash. */
const joinUrl = (base: string, rel: string): string =>
  `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;

/**
 * Compute the sha256 hex digest of a UTF-8 string (treating the string as the
 * raw bytes that were fetched). This must hash the *exact bytes* received from
 * the network, which in practice are the UTF-8 encoding of the text body.
 */
const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * GET a URL with a timeout, returning the body text. Throws on any non-2xx
 * status or transport error (the caller converts throws into soft failures).
 * A `304 Not Modified` is signalled via the {@link NotModifiedError} sentinel so
 * the caller can distinguish "unchanged" from a real error.
 */
const getText = async (
  fetchImpl: FetchImpl,
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (res.status === 304) {
      throw new NotModifiedError();
    }
    if (!res.ok) {
      throw new Error(`GET ${url} → HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
};

/** Sentinel thrown by {@link getText} on a `304 Not Modified` response. */
class NotModifiedError extends Error {
  constructor() {
    super("not_modified");
    this.name = "NotModifiedError";
  }
}

/**
 * Load the bundled `manifest.json` (the one generated by gen-manifest.mjs and
 * shipped with the package). Returns `undefined` on any IO / parse error so
 * callers can treat a missing bundled manifest as "no local hashes available"
 * — never throws (FR-027).
 *
 * The manifest lives at `content/manifest.json` relative to the repo root, which
 * is 4 levels up from `src/catalog/`. In the built package it is copied into
 * `dist/catalog/bundled/` by the copy-assets step, so we look there first and
 * fall back to the source-tree path. We use a relative path from import.meta.url
 * so both `src` and `dist` contexts resolve correctly.
 */
export const loadBundledManifest = async (): Promise<CatalogManifest | undefined> => {
  // Candidate paths: the bundled-assets copy (dist or src) and the repo-root copy.
  const thisDir = path.dirname(
    // import.meta.url is a file:// URL; fileURLToPath is in node:url.
    // We avoid the extra import by using a simple string strip.
    new URL(import.meta.url).pathname,
  );
  const candidates = [
    // In `dist/catalog/` → manifest was copied to `dist/catalog/bundled/`
    path.join(thisDir, "bundled", MANIFEST_FILENAME),
    // In `src/catalog/` → repo root is 4 levels up
    path.join(thisDir, "..", "..", "..", "..", "content", MANIFEST_FILENAME),
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return CatalogManifestSchema.parse(parsed);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
};

/**
 * Build maps of `{ file → sha256 }` and `{ file → rawBytes }` from a manifest
 * and a cache/bundled directory so the hash-diff path can compare and reuse
 * local topic bytes.
 *
 * Reads each topic file from `dir`; silently skips files that cannot be read
 * (missing or unreadable files just mean we won't reuse that topic, harmless).
 */
const buildLocalTopicMaps = async (
  manifest: CatalogManifest,
  dir: string,
): Promise<{
  hashes: ReadonlyMap<string, string>;
  bytes: ReadonlyMap<string, string>;
}> => {
  const hashes = new Map<string, string>();
  const bytes = new Map<string, string>();

  for (const entry of manifest.topics) {
    if (entry.sha256 === undefined) continue;
    try {
      const body = await fs.readFile(path.join(dir, entry.file), "utf8");
      hashes.set(entry.file, entry.sha256);
      bytes.set(entry.file, body);
    } catch {
      // File unreadable — skip; topic will be downloaded.
    }
  }

  return { hashes, bytes };
};

/**
 * Fetch the manifest + every topic file from the configured source, validating
 * each topic with Zod **before** anything is returned for caching (research E8).
 * Pure with respect to disk — it performs NO writes; {@link refreshCatalogCache}
 * composes this with the cache layer.
 *
 * ### Integrity verification (A)
 *
 * For each topic entry that carries a `sha256`, the raw fetched bytes are hashed
 * and compared. A mismatch returns `{ ok: false, reason: "invalid" }` and
 * rejects the entire catalog — tampered or corrupt content is never cached.
 * Entries without a `sha256` skip the check (optional/legacy manifests).
 *
 * ### Hash-diff optimisation (B)
 *
 * When `options.localTopicHashes` is provided (keyed by `file` path), topic
 * files whose remote `sha256` matches the local hash are served from
 * `options.localTopicBytes` without issuing a network request for that file.
 * This covers both the "warm cache" and "cold start with bundled hashes" cases.
 *
 * Never throws: all failure modes (disabled, offline/DNS/timeout, 4xx/5xx,
 * malformed JSON/YAML, Zod-invalid content, sha256 mismatch) become a
 * `{ ok: false }` {@link FetchOutcome} (FR-027).
 *
 * @param options - Source URL, injected fetch, timeout, prior ETag, and local
 *   hash maps for the hash-diff optimisation.
 * @returns A {@link FetchOutcome} — never rejects.
 */
export const fetchCatalog = async (
  options: FetchOptions = {},
): Promise<FetchOutcome> => {
  const baseUrl = resolveContentUrl(options.contentUrl);
  if (baseUrl === undefined) {
    return {
      ok: false,
      reason: "disabled",
      detail: `no content source configured (set ${CONTENT_URL_ENV})`,
    };
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchImpl);
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      reason: "unreachable",
      detail: "no fetch implementation available",
    };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  // --- 1. Fetch + validate the manifest (with conditional revalidation). ---
  const manifestUrl = joinUrl(baseUrl, MANIFEST_FILENAME);
  const conditionalHeaders: Record<string, string> =
    options.etag !== undefined ? { "If-None-Match": options.etag } : {};

  let manifestBody: string;
  let responseEtag: string | undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let res: FetchResponseLike;
    try {
      res = await fetchImpl(manifestUrl, {
        headers: conditionalHeaders,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304) {
      return {
        ok: false,
        reason: "not_modified",
        detail: "manifest unchanged (304); cache is current",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "unreachable",
        detail: `GET ${manifestUrl} → HTTP ${res.status}`,
      };
    }
    manifestBody = await res.text();
    responseEtag = res.headers.get("etag") ?? undefined;
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      detail: `fetch failed for ${manifestUrl}: ${describeError(err)}`,
    };
  }

  let manifest: CatalogManifest;
  try {
    const parsedJson: unknown = JSON.parse(manifestBody);
    manifest = CatalogManifestSchema.parse(parsedJson);
  } catch (err) {
    // Malformed/invalid manifest is treated as invalid remote content (E8):
    // reject and fall back, never cache.
    return {
      ok: false,
      reason: "invalid",
      detail: `invalid manifest at ${manifestUrl}: ${describeError(err)}`,
    };
  }

  // Content-version compatibility guard (T056, E6): refuse a manifest whose
  // MAJOR is newer than this engine supports BEFORE fetching any topic files.
  // Treated as invalid remote content so the resolver falls back to
  // cache/bundled with no user-facing error (FR-027).
  if (!isContentVersionSupported(manifest.version)) {
    return {
      ok: false,
      reason: "invalid",
      detail: contentVersionRejection(manifest.version),
    };
  }

  // Prefer the HTTP ETag header; fall back to a manifest-embedded etag if any.
  const effectiveEtag = responseEtag ?? manifest.etag;

  // --- 2. Fetch + validate every topic file BEFORE caching (research E8). --
  // Hash-diff: use local copies for topics whose remote sha256 matches.
  const localHashes = options.localTopicHashes;
  const localBytes = options.localTopicBytes;

  const topics: Topic[] = [];
  const rawByFile = new Map<string, string>();
  for (const entry of manifest.topics) {
    const fileUrl = joinUrl(baseUrl, entry.file);

    // Hash-diff optimisation (B): if the remote manifest carries a sha256 AND
    // we have a matching local hash for this file, reuse local bytes and skip
    // the network request entirely.
    if (
      entry.sha256 !== undefined &&
      localHashes !== undefined &&
      localBytes !== undefined &&
      localHashes.get(entry.file) === entry.sha256
    ) {
      const localBody = localBytes.get(entry.file);
      if (localBody !== undefined) {
        // Still parse + Zod-validate the local bytes (E8 applies to reused
        // content too — a corrupted local copy is rejected here).
        try {
          topics.push(parseTopicYaml(localBody, entry.file));
        } catch (err) {
          return {
            ok: false,
            reason: "invalid",
            detail: `invalid local topic ${entry.file}: ${describeError(err)}`,
          };
        }
        rawByFile.set(entry.file, localBody);
        continue; // skip the network fetch
      }
    }

    // Download the topic file.
    let body: string;
    try {
      body = await getText(fetchImpl, fileUrl, timeoutMs, {});
    } catch (err) {
      if (err instanceof NotModifiedError) {
        // A per-file 304 without an If-None-Match is anomalous; treat as
        // unreachable so we fall back rather than cache a partial catalog.
        return {
          ok: false,
          reason: "unreachable",
          detail: `unexpected 304 for ${fileUrl}`,
        };
      }
      return {
        ok: false,
        reason: "unreachable",
        detail: `fetch failed for ${fileUrl}: ${describeError(err)}`,
      };
    }

    // Integrity verification (A): when the manifest entry has a sha256, hash
    // the raw fetched bytes and compare. A mismatch rejects the WHOLE catalog
    // so tampered/corrupt content is never cached or served. When no sha256 is
    // present in the entry the check is skipped (optional/legacy manifests).
    if (entry.sha256 !== undefined) {
      const actual = sha256Hex(body);
      if (actual !== entry.sha256) {
        return {
          ok: false,
          reason: "invalid",
          detail:
            `sha256 mismatch for ${entry.file}: ` +
            `expected ${entry.sha256}, got ${actual}`,
        };
      }
    }

    // E8: Zod-validate the fetched topic BEFORE it is eligible for caching.
    // Any malformed/invalid file rejects the WHOLE fetch so we never serve a
    // partially-valid remote catalog; the resolver falls back to cache/bundled.
    try {
      topics.push(parseTopicYaml(body, fileUrl));
    } catch (err) {
      return {
        ok: false,
        reason: "invalid",
        detail: `invalid topic ${entry.file}: ${describeError(err)}`,
      };
    }
    rawByFile.set(entry.file, body);
  }

  const manifestWithEtag: CatalogManifest =
    effectiveEtag !== undefined
      ? { ...manifest, etag: effectiveEtag }
      : manifest;

  return {
    ok: true,
    catalog: { manifest: manifestWithEtag, topics, rawByFile },
  };
};

/**
 * Fetch the catalog and, on success, persist it to the content cache atomically
 * enough for a single-writer refresh: writes the manifest, every topic file, and
 * `cache-meta.json` (etag/version) so a later refresh can revalidate via
 * `If-None-Match` (FR-026).
 *
 * The currently-cached ETag is read automatically (if present) and sent as the
 * conditional header, so an unchanged source short-circuits to `not_modified`
 * and the cache is left untouched (no redundant rewrite).
 *
 * ### Hash-diff wiring
 *
 * When there is no ETag hit (a 200 response for the manifest), the fetcher
 * checks whether local topic hashes are available — first from the on-disk
 * cached manifest, then from the bundled manifest — and passes them to
 * {@link fetchCatalog} so unchanged topics are reused without re-downloading.
 *
 * Never throws (FR-027): a soft fetch failure is returned verbatim and the cache
 * is left as-is.
 *
 * @param dirOverride - Profile-home override (test seam); see {@link contentCacheDir}.
 * @param options - Fetch options (URL / fetchImpl / timeout). A caller-supplied
 *   `etag` overrides the on-disk one.
 * @returns The {@link FetchOutcome}; on `ok` the cache now reflects it.
 */
export const refreshCatalogCache = async (
  dirOverride?: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> => {
  const cacheDir = contentCacheDir(dirOverride);

  // Send the cached ETag (if any) unless the caller pinned one explicitly.
  let etag = options.etag;
  if (etag === undefined) {
    const meta = await readCacheMeta(cacheDir);
    if (meta?.etag !== undefined) etag = meta.etag;
  }

  // Resolve local topic hashes + bytes for the hash-diff optimisation (B).
  // Priority: cached manifest > bundled manifest.
  // We only do this when the caller hasn't already supplied them.
  let localTopicHashes = options.localTopicHashes;
  let localTopicBytes = options.localTopicBytes;

  if (localTopicHashes === undefined) {
    // Try the on-disk cached manifest first.
    const cachedManifestResult = await readCachedManifestForHashes(cacheDir);
    if (cachedManifestResult !== undefined) {
      localTopicHashes = cachedManifestResult.hashes;
      localTopicBytes = cachedManifestResult.bytes;
    } else {
      // Fall back to the bundled manifest.
      const bundledManifestResult = await readBundledManifestForHashes();
      if (bundledManifestResult !== undefined) {
        localTopicHashes = bundledManifestResult.hashes;
        localTopicBytes = bundledManifestResult.bytes;
      }
    }
  }

  const fetchOpts: FetchOptions = {
    ...(options.contentUrl !== undefined ? { contentUrl: options.contentUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(etag !== undefined ? { etag } : {}),
    ...(localTopicHashes !== undefined ? { localTopicHashes } : {}),
    ...(localTopicBytes !== undefined ? { localTopicBytes } : {}),
  };

  const outcome = await fetchCatalog(fetchOpts);
  if (!outcome.ok) {
    // not_modified / disabled / unreachable / invalid — leave the cache alone.
    return outcome;
  }

  try {
    await writeCache(cacheDir, outcome.catalog);
  } catch (err) {
    // A cache write failure must not throw to the caller (FR-027): the freshly
    // fetched topics are still returned and served this run; next refresh retries.
    return {
      ok: false,
      reason: "unreachable",
      detail: `cache write failed: ${describeError(err)}`,
    };
  }
  return outcome;
};

/** A catalog read back from the on-disk cache. */
export interface CachedCatalog {
  readonly manifest: CatalogManifest;
  readonly topics: Topic[];
  readonly meta: CacheMeta;
}

/**
 * Read the previously-cached catalog from disk, validating both the manifest and
 * every topic file against Zod (a cache corrupted between runs is rejected just
 * like invalid remote content — E8 applies to the cache too).
 *
 * Never throws: returns `undefined` when no usable cache exists (missing,
 * unreadable, or invalid), so the resolver falls through to the bundled snapshot.
 *
 * @param dirOverride - Profile-home override (test seam).
 * @returns The cached catalog, or `undefined` if absent/invalid.
 */
export const readCachedCatalog = async (
  dirOverride?: string,
): Promise<CachedCatalog | undefined> => {
  const cacheDir = contentCacheDir(dirOverride);
  const meta = await readCacheMeta(cacheDir);
  if (meta === undefined) return undefined;

  let manifest: CatalogManifest;
  try {
    const raw = await fs.readFile(manifestPath(cacheDir), "utf8");
    manifest = CatalogManifestSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }

  // Content-version compatibility guard (T056, E6): a cache written by a future
  // engine (major newer than we support) is unreadable — fall through to bundled
  // rather than serve an unknown content format.
  if (!isContentVersionSupported(manifest.version)) return undefined;

  const topics: Topic[] = [];
  for (const entry of manifest.topics) {
    let body: string;
    try {
      body = await fs.readFile(path.join(cacheDir, entry.file), "utf8");
    } catch {
      return undefined;
    }
    try {
      topics.push(parseTopicYaml(body, entry.file));
    } catch {
      return undefined;
    }
  }
  return { manifest, topics, meta };
};

// --- cache IO (thin) -------------------------------------------------------

/** Read + validate `cache-meta.json`, or `undefined` if missing/invalid. */
const readCacheMeta = async (
  cacheDir: string,
): Promise<CacheMeta | undefined> => {
  let raw: string;
  try {
    raw = await fs.readFile(cacheMetaPath(cacheDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CacheMeta>;
    if (typeof parsed.version !== "string" || typeof parsed.fetchedAt !== "string") {
      return undefined;
    }
    const meta: CacheMeta =
      typeof parsed.etag === "string"
        ? { version: parsed.version, etag: parsed.etag, fetchedAt: parsed.fetchedAt }
        : { version: parsed.version, fetchedAt: parsed.fetchedAt };
    return meta;
  } catch {
    return undefined;
  }
};

/**
 * Write the fetched catalog to the cache dir: the manifest, every topic file
 * (verbatim YAML, preserving authoring), and the cache metadata. Topic files are
 * written under their `file` path so the cache mirrors the published layout and
 * {@link readCachedCatalog} can re-read them by manifest index.
 */
const writeCache = async (
  cacheDir: string,
  catalog: FetchedCatalog,
): Promise<void> => {
  await fs.mkdir(cacheDir, { recursive: true });

  // Manifest.
  await fs.writeFile(
    manifestPath(cacheDir),
    `${JSON.stringify(catalog.manifest, null, 2)}\n`,
    "utf8",
  );

  // Topic files (create nested dirs as needed for paths like "general/x.yaml").
  for (const [file, body] of catalog.rawByFile) {
    const dest = path.join(cacheDir, file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, body, "utf8");
  }

  // Cache metadata (etag/version) for the next conditional refresh.
  const meta: CacheMeta =
    catalog.manifest.etag !== undefined
      ? {
          version: catalog.manifest.version,
          etag: catalog.manifest.etag,
          fetchedAt: new Date().toISOString(),
        }
      : {
          version: catalog.manifest.version,
          fetchedAt: new Date().toISOString(),
        };
  await fs.writeFile(
    cacheMetaPath(cacheDir),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
};

// --- hash-diff helpers -------------------------------------------------------

/**
 * Read the on-disk cached manifest and build the local-hash maps for the
 * hash-diff optimisation. Returns `undefined` if the cached manifest is absent
 * or invalid (soft failure — just means no hash-diff for this refresh).
 */
const readCachedManifestForHashes = async (
  cacheDir: string,
): Promise<{ hashes: ReadonlyMap<string, string>; bytes: ReadonlyMap<string, string> } | undefined> => {
  let manifest: CatalogManifest;
  try {
    const raw = await fs.readFile(manifestPath(cacheDir), "utf8");
    manifest = CatalogManifestSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }

  // Only proceed if any entry actually has a sha256.
  if (!manifest.topics.some((t) => t.sha256 !== undefined)) return undefined;

  const result = await buildLocalTopicMaps(manifest, cacheDir);
  if (result.hashes.size === 0) return undefined;
  return result;
};

/**
 * Load the bundled manifest and build local-hash maps pointing at the bundled
 * topic files on disk. Returns `undefined` on any error (soft failure).
 */
const readBundledManifestForHashes = async (): Promise<
  | { hashes: ReadonlyMap<string, string>; bytes: ReadonlyMap<string, string> }
  | undefined
> => {
  let manifest: CatalogManifest | undefined;
  try {
    manifest = await loadBundledManifest();
  } catch {
    return undefined;
  }
  if (manifest === undefined) return undefined;
  if (!manifest.topics.some((t) => t.sha256 !== undefined)) return undefined;

  // Bundled topic files live alongside the bundled index.ts/index.js.
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const bundledDir = path.join(thisDir, "bundled");

  const result = await buildLocalTopicMaps(manifest, bundledDir);
  if (result.hashes.size === 0) return undefined;
  return result;
};

/** Best-effort human description of an unknown thrown value (for logs/tests). */
const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
