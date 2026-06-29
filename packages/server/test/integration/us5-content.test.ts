/**
 * @file US-5 content delivery integration test (T055).
 *
 * Proves the fresh-fetch → cache → bundled resolution order and its network
 * safety, WITHOUT touching the real network: a fake `fetchImpl` (the fetcher's
 * injected `FetchImpl` seam) returns controlled manifest + topic YAML + ETags.
 * Each test runs under its own `VIBE_HERO_HOME` temp dir so the content cache
 * (a sibling of the profile dir) is fully isolated.
 *
 * Coverage (maps to spec criteria):
 *   - OFFLINE (fetch disabled OR fetch throws) → bundled topics served, ≥1, no
 *     error (FR-025, SC-006).
 *   - NEWER VALID REMOTE → fetched, Zod-validated, cached, served; the reported
 *     `catalogVersion` advances over the bundled placeholder (FR-026, SC-007).
 *   - UNREACHABLE AFTER A CACHE EXISTS → serves the cache, no throw, no
 *     user-facing error (FR-027).
 *   - MALFORMED REMOTE (fails Zod) → rejected, NOT cached, falls back to
 *     cache/bundled, no throw (research E8).
 *   - ETAG 304 (unchanged) → keeps the cached content, no redundant rewrite
 *     (FR-026).
 *
 * Source of truth: spec FR-025/026/027, SC-006/007, research.md E8,
 * contracts/mcp-tools.md (`list_topics` → `catalogVersion`).
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  contentCacheDir,
  fetchCatalog,
  refreshCatalogCache,
  readCachedCatalog,
  type FetchImpl,
  type FetchResponseLike,
} from "../../src/catalog/fetcher.js";
import { resolveCatalog } from "../../src/catalog/resolve.js";
import { makeListTopicsTool } from "../../src/tools/listTopics.js";
import { PLACEHOLDER_CATALOG_VERSION } from "../../src/catalog/loader.js";
import { loadBundledCatalog } from "../../src/catalog/bundled/index.js";
import type { ListTopicsResult } from "../../src/schemas/tools.js";

/** A test content base URL (never actually hit — the fake fetch intercepts it). */
const CONTENT_URL = "https://example.test/content";

/** A valid topic YAML the fake remote serves. */
const remoteTopicYaml = (id: string): string =>
  [
    `id: ${id}`,
    "class: { kind: general }",
    `title: Remote ${id}`,
    "summary: a freshly fetched topic",
    "triggerSignals: []",
    "items:",
    "  - id: q1",
    "    tier: 100",
    "    bloom: remember",
    "    difficulty: 200",
    "    type: short_answer",
    "    prompt: q?",
    "    answerKey: { kind: keyword, anyOf: [yes] }",
    "    guidance: g",
  ].join("\n");

/** A manifest JSON string for `version` listing one topic file `file`. */
const remoteManifest = (version: string, file: string, topicId: string): string =>
  JSON.stringify({
    version,
    publishedAt: "2026-06-01T00:00:00.000Z",
    topics: [
      { id: topicId, class: { kind: "general" }, file, itemCount: 1, tiers: [100] },
    ],
  });

/** Build a minimal {@link FetchResponseLike} for a 200 OK body with an ETag. */
const ok = (body: string, etag?: string): FetchResponseLike => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => (name.toLowerCase() === "etag" ? etag ?? null : null) },
  text: () => Promise.resolve(body),
});

/** A 304 Not Modified response (empty body, no headers of interest). */
const notModified = (): FetchResponseLike => ({
  ok: false,
  status: 304,
  headers: { get: () => null },
  text: () => Promise.resolve(""),
});

/** A 4xx/5xx error response. */
const httpError = (status: number): FetchResponseLike => ({
  ok: false,
  status,
  headers: { get: () => null },
  text: () => Promise.resolve(""),
});

/**
 * A controllable fake remote: maps URL → body (+ optional ETag), honors
 * conditional `If-None-Match` (returns 304 when the request etag matches the
 * resource's etag), and records every requested URL for assertions.
 */
interface FakeRemote {
  readonly fetchImpl: FetchImpl;
  readonly requested: string[];
  /** Reset the recorded request log (e.g. between refresh phases). */
  clear(): void;
}

const makeFakeRemote = (
  resources: ReadonlyMap<string, { body: string; etag?: string }>,
): FakeRemote => {
  const requested: string[] = [];
  const fetchImpl: FetchImpl = (input, init) => {
    requested.push(input);
    const resource = resources.get(input);
    if (resource === undefined) {
      return Promise.resolve(httpError(404));
    }
    const ifNoneMatch = init?.headers?.["If-None-Match"];
    if (
      ifNoneMatch !== undefined &&
      resource.etag !== undefined &&
      ifNoneMatch === resource.etag
    ) {
      return Promise.resolve(notModified());
    }
    return Promise.resolve(ok(resource.body, resource.etag));
  };
  return {
    fetchImpl,
    requested,
    clear: () => {
      requested.length = 0;
    },
  };
};

/** A fetchImpl that always throws (offline / DNS failure). */
const throwingFetch: FetchImpl = () =>
  Promise.reject(new Error("getaddrinfo ENOTFOUND example.test"));

describe("US-5 content delivery (T055): resolveCatalog fetch → cache → bundled", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-us5-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("OFFLINE (no source configured) serves bundled topics, ≥1, no error (SC-006)", async () => {
    // No contentUrl and fetch disabled → resolution falls straight to bundled.
    const resolved = await resolveCatalog(home, { fetch: false });

    expect(resolved.source).toBe("bundled");
    expect(resolved.topics.length).toBeGreaterThanOrEqual(1);
    expect(resolved.errors).toEqual([]);
    expect(resolved.catalogVersion).toBe(PLACEHOLDER_CATALOG_VERSION);

    // It matches the actual bundled snapshot.
    const { topics: bundled } = loadBundledCatalog();
    expect(resolved.topics.map((t) => t.id).sort()).toEqual(
      bundled.map((t) => t.id).sort(),
    );
  });

  it("OFFLINE (fetch throws) with a source configured still serves bundled, no throw (SC-006)", async () => {
    const resolved = await resolveCatalog(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: throwingFetch,
    });

    // A thrown fetch is caught and downgraded silently; bundled is served.
    expect(resolved.source).toBe("bundled");
    expect(resolved.topics.length).toBeGreaterThanOrEqual(1);
    expect(resolved.errors).toEqual([]);
  });

  it("NEWER VALID REMOTE is fetched, validated, cached, and served; version advances (SC-007)", async () => {
    const remote = makeFakeRemote(
      new Map([
        [
          `${CONTENT_URL}/manifest.json`,
          { body: remoteManifest("1.2.0", "general/remote.yaml", "remote"), etag: '"v1.2.0"' },
        ],
        [`${CONTENT_URL}/general/remote.yaml`, { body: remoteTopicYaml("remote") }],
      ]),
    );

    const resolved = await resolveCatalog(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: remote.fetchImpl,
    });

    // Fetched + served.
    expect(resolved.source).toBe("fetched");
    expect(resolved.topics.map((t) => t.id)).toEqual(["remote"]);

    // catalogVersion advances over the bundled placeholder (SC-007).
    expect(resolved.catalogVersion).toBe("1.2.0");
    expect(resolved.catalogVersion).not.toBe(PLACEHOLDER_CATALOG_VERSION);

    // It was cached: a follow-up read of the on-disk cache returns the topic +
    // the etag stored for conditional refresh.
    const cached = await readCachedCatalog(home);
    expect(cached?.topics.map((t) => t.id)).toEqual(["remote"]);
    expect(cached?.manifest.version).toBe("1.2.0");
    expect(cached?.meta.etag).toBe('"v1.2.0"');
  });

  it("UNREACHABLE source AFTER a prior cache serves the cache, no throw, no error (FR-027)", async () => {
    // Phase 1: populate the cache from a reachable remote.
    const remote = makeFakeRemote(
      new Map([
        [
          `${CONTENT_URL}/manifest.json`,
          { body: remoteManifest("2.0.0", "general/cached.yaml", "cached"), etag: '"v2"' },
        ],
        [`${CONTENT_URL}/general/cached.yaml`, { body: remoteTopicYaml("cached") }],
      ]),
    );
    const first = await resolveCatalog(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: remote.fetchImpl,
    });
    expect(first.source).toBe("fetched");

    // Phase 2: source now unreachable (fetch throws) → cache is served.
    const second = await resolveCatalog(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: throwingFetch,
    });

    expect(second.source).toBe("cache");
    expect(second.topics.map((t) => t.id)).toEqual(["cached"]);
    expect(second.catalogVersion).toBe("2.0.0");
  });

  it("UNREACHABLE source (5xx) with NO cache falls all the way to bundled, no throw (FR-027/SC-006)", async () => {
    // Manifest endpoint returns 503 → soft unreachable; with no cache the
    // resolver lands on the bundled snapshot.
    const fiveHundred: FetchImpl = () => Promise.resolve(httpError(503));

    const resolved = await resolveCatalog(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: fiveHundred,
    });

    expect(resolved.source).toBe("bundled");
    expect(resolved.topics.length).toBeGreaterThanOrEqual(1);
  });

  it("MALFORMED remote content (fails Zod) is rejected, NOT cached, falls back (E8)", async () => {
    // A manifest pointing at a topic file that violates TopicSchema
    // (multiple_choice with a single choice + no answerKey).
    const badTopicYaml = [
      "id: broken",
      "class: { kind: general }",
      "title: Broken",
      "summary: invalid",
      "triggerSignals: []",
      "items:",
      "  - id: q1",
      "    tier: 100",
      "    bloom: remember",
      "    difficulty: 200",
      "    type: multiple_choice",
      "    prompt: q?",
      "    choices:",
      "      - { id: a, text: only one }",
      "    guidance: g",
    ].join("\n");

    const remote = makeFakeRemote(
      new Map([
        [
          `${CONTENT_URL}/manifest.json`,
          { body: remoteManifest("9.9.9", "general/broken.yaml", "broken"), etag: '"bad"' },
        ],
        [`${CONTENT_URL}/general/broken.yaml`, { body: badTopicYaml }],
      ]),
    );

    // Direct fetch: the invalid topic makes the whole fetch a soft "invalid".
    const outcome = await fetchCatalog({
      contentUrl: CONTENT_URL,
      fetchImpl: remote.fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("invalid");
      // The diagnostic is source-qualified (FR-004) but never surfaced to users.
      expect(outcome.detail).toMatch(/broken\.yaml/);
    }

    // Through the resolver: no throw, NOT cached, falls back to bundled.
    const resolved = await resolveCatalog(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: remote.fetchImpl,
    });
    expect(resolved.source).toBe("bundled");
    expect(resolved.topics.map((t) => t.id)).not.toContain("broken");

    // Confirm nothing was written to the cache (no manifest on disk).
    const cached = await readCachedCatalog(home);
    expect(cached).toBeUndefined();
  });

  it("ETAG: a 304 unchanged response keeps the cached content (no redundant rewrite, FR-026)", async () => {
    const etag = '"stable-etag"';
    const remote = makeFakeRemote(
      new Map([
        [
          `${CONTENT_URL}/manifest.json`,
          { body: remoteManifest("3.1.0", "general/stable.yaml", "stable"), etag },
        ],
        [`${CONTENT_URL}/general/stable.yaml`, { body: remoteTopicYaml("stable") }],
      ]),
    );

    // Phase 1: first fetch populates the cache + records the etag.
    const first = await refreshCatalogCache(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: remote.fetchImpl,
    });
    expect(first.ok).toBe(true);

    const manifestFile = path.join(contentCacheDir(home), "manifest.json");
    const mtimeBefore = (await stat(manifestFile)).mtimeMs;
    const bodyBefore = await readFile(manifestFile, "utf8");

    // Phase 2: refresh again. The cached etag is sent as If-None-Match → the
    // fake remote returns 304 → not_modified, cache untouched.
    remote.clear();
    await new Promise((r) => setTimeout(r, 10)); // ensure any rewrite would change mtime
    const second = await refreshCatalogCache(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: remote.fetchImpl,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("not_modified");
    }
    // The conditional request was actually made with the stored etag.
    expect(remote.requested).toContain(`${CONTENT_URL}/manifest.json`);

    // The cache file was NOT rewritten (same mtime + same bytes).
    const mtimeAfter = (await stat(manifestFile)).mtimeMs;
    const bodyAfter = await readFile(manifestFile, "utf8");
    expect(mtimeAfter).toBe(mtimeBefore);
    expect(bodyAfter).toBe(bodyBefore);

    // And the resolver still serves the cached topic at the same version.
    const resolved = await resolveCatalog(home, {
      contentUrl: CONTENT_URL,
      fetchImpl: remote.fetchImpl,
    });
    // After a 304 the fresh-fetch tier reports not_modified and we fall to cache.
    expect(resolved.source).toBe("cache");
    expect(resolved.catalogVersion).toBe("3.1.0");
    expect(resolved.topics.map((t) => t.id)).toEqual(["stable"]);
  });

  it("list_topics reports an advancing catalogVersion after a published update (SC-007)", async () => {
    // Baseline: bundled placeholder version via the default resolver path with
    // fetch disabled (no source) — exercised through the real tool handler.
    const offlineList = makeListTopicsTool(home, (dir) =>
      resolveCatalog(dir, { fetch: false }),
    ).handler;
    const before = (await offlineList({})) as ListTopicsResult;
    expect(before.catalogVersion).toBe(PLACEHOLDER_CATALOG_VERSION);

    // Now a published update is reachable: inject a resolver that fetches it.
    const remote = makeFakeRemote(
      new Map([
        [
          `${CONTENT_URL}/manifest.json`,
          { body: remoteManifest("4.5.6", "general/fresh.yaml", "fresh"), etag: '"v4"' },
        ],
        [`${CONTENT_URL}/general/fresh.yaml`, { body: remoteTopicYaml("fresh") }],
      ]),
    );
    const onlineList = makeListTopicsTool(home, (dir) =>
      resolveCatalog(dir, { contentUrl: CONTENT_URL, fetchImpl: remote.fetchImpl }),
    ).handler;
    const after = (await onlineList({})) as ListTopicsResult;

    expect(after.catalogVersion).toBe("4.5.6");
    expect(after.catalogVersion).not.toBe(before.catalogVersion);
    expect(after.topics.map((t) => t.id)).toContain("fresh");
  });
});
