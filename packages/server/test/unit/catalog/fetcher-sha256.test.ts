/**
 * @file Unit tests for sha256 integrity verification (A) and first-run hash-diff
 * optimisation (B) in packages/server/src/catalog/fetcher.ts.
 *
 * Coverage:
 *   A1 — sha256 mismatch → catalog rejected as "invalid", fallback, no throw.
 *   A2 — sha256 match → catalog served + cached normally.
 *   A3 — manifest entry without sha256 → integrity check skipped gracefully.
 *   B1 — first-run hash diff: topic whose sha256 matches bundled is NOT fetched
 *        (fake fetch is never called for that file URL).
 *   B2 — first-run hash diff: topic whose sha256 DIFFERS from bundled IS fetched
 *        and integrity-verified.
 *   B3 — when local bytes are unavailable for a hash-matching entry, the file is
 *        downloaded normally (no silent drop).
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fetchCatalog,
  refreshCatalogCache,
  type FetchImpl,
  type FetchResponseLike,
  type FetchOptions,
} from "../../../src/catalog/fetcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute sha256 hex of a UTF-8 string (mirrors fetcher internals). */
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** A valid minimal topic YAML for a given id. */
const topicYaml = (id: string): string =>
  [
    `id: ${id}`,
    "class: { kind: general }",
    `title: Topic ${id}`,
    "summary: test topic",
    "triggerSignals: []",
    "items:",
    "  - id: q1",
    "    tier: 100",
    "    bloom: remember",
    "    difficulty: 200",
    "    type: short_answer",
    "    prompt: What?",
    "    answerKey: { kind: keyword, anyOf: [yes] }",
    "    guidance: Because.",
  ].join("\n");

/** Build a manifest JSON string for a single topic entry with an optional sha256. */
const manifestJson = (
  file: string,
  topicId: string,
  topicSha256?: string,
): string =>
  JSON.stringify({
    version: "1.0.0",
    publishedAt: "2026-01-01T00:00:00.000Z",
    topics: [
      {
        id: topicId,
        class: { kind: "general" },
        file,
        itemCount: 1,
        tiers: [100],
        ...(topicSha256 !== undefined ? { sha256: topicSha256 } : {}),
      },
    ],
  });

/** Build a 200 OK {@link FetchResponseLike}. */
const ok200 = (body: string, etag?: string): FetchResponseLike => ({
  ok: true,
  status: 200,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === "etag" ? (etag ?? null) : null,
  },
  text: () => Promise.resolve(body),
});

const CONTENT_URL = "https://example.test/content";

// ---------------------------------------------------------------------------
// A: Integrity verification
// ---------------------------------------------------------------------------

describe("A: sha256 integrity verification", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-sha256-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("A1: sha256 mismatch → catalog rejected as invalid, no throw", async () => {
    const yaml = topicYaml("alpha");
    const wrongHash = "a".repeat(64); // obviously wrong hex digest

    const requested: string[] = [];
    const fetchImpl: FetchImpl = (url) => {
      requested.push(url);
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(ok200(manifestJson("general/alpha.yaml", "alpha", wrongHash)));
      }
      if (url.endsWith("general/alpha.yaml")) {
        return Promise.resolve(ok200(yaml));
      }
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve("") });
    };

    const outcome = await fetchCatalog({ contentUrl: CONTENT_URL, fetchImpl });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("invalid");
      expect(outcome.detail).toMatch(/sha256 mismatch/);
      expect(outcome.detail).toMatch(/alpha\.yaml/);
    }
    // The topic file WAS fetched (needed to hash it).
    expect(requested).toContain(`${CONTENT_URL}/general/alpha.yaml`);
  });

  it("A1b: integrity mismatch → catalog not cached, resolver falls back to bundled", async () => {
    const yaml = topicYaml("alpha");
    const wrongHash = "b".repeat(64);

    const fetchImpl: FetchImpl = (url) => {
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(ok200(manifestJson("general/alpha.yaml", "alpha", wrongHash)));
      }
      return Promise.resolve(ok200(yaml));
    };

    const outcome = await refreshCatalogCache(home, { contentUrl: CONTENT_URL, fetchImpl });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("invalid");
    }

    // Nothing should have been cached.
    const { readCachedCatalog } = await import("../../../src/catalog/fetcher.js");
    const cached = await readCachedCatalog(home);
    expect(cached).toBeUndefined();
  });

  it("A2: sha256 match → catalog served and cached normally", async () => {
    const yaml = topicYaml("beta");
    const correctHash = sha256(yaml);

    const fetchImpl: FetchImpl = (url) => {
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(ok200(manifestJson("general/beta.yaml", "beta", correctHash)));
      }
      return Promise.resolve(ok200(yaml));
    };

    const outcome = await fetchCatalog({ contentUrl: CONTENT_URL, fetchImpl });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.catalog.topics.map((t) => t.id)).toEqual(["beta"]);
    }
  });

  it("A3: manifest entry without sha256 → integrity check skipped, topic served", async () => {
    const yaml = topicYaml("gamma");
    // No sha256 in the manifest entry.
    const manifest = manifestJson("general/gamma.yaml", "gamma"); // no sha256 arg

    const fetchImpl: FetchImpl = (url) => {
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(ok200(manifest));
      }
      return Promise.resolve(ok200(yaml));
    };

    const outcome = await fetchCatalog({ contentUrl: CONTENT_URL, fetchImpl });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.catalog.topics.map((t) => t.id)).toEqual(["gamma"]);
    }
  });
});

// ---------------------------------------------------------------------------
// B: First-run hash-diff optimisation
// ---------------------------------------------------------------------------

describe("B: first-run / no-etag hash-diff optimisation", () => {
  it("B1: topic whose remote sha256 matches local hash is NOT fetched", async () => {
    const yaml = topicYaml("unchanged");
    const hash = sha256(yaml);

    // Local hash map says we already have this topic at the same hash.
    const localTopicHashes = new Map([["general/unchanged.yaml", hash]]);
    const localTopicBytes = new Map([["general/unchanged.yaml", yaml]]);

    const requested: string[] = [];
    const fetchImpl: FetchImpl = (url) => {
      requested.push(url);
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(
          ok200(manifestJson("general/unchanged.yaml", "unchanged", hash)),
        );
      }
      // Should NOT be called for the topic file.
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve("") });
    };

    const outcome = await fetchCatalog({
      contentUrl: CONTENT_URL,
      fetchImpl,
      localTopicHashes,
      localTopicBytes,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.catalog.topics.map((t) => t.id)).toEqual(["unchanged"]);
    }
    // The manifest WAS fetched, but NOT the topic file.
    expect(requested).toContain(`${CONTENT_URL}/manifest.json`);
    expect(requested).not.toContain(`${CONTENT_URL}/general/unchanged.yaml`);
  });

  it("B2: topic whose sha256 differs from local is fetched and integrity-verified", async () => {
    const oldYaml = topicYaml("changed-old");
    const newYaml = topicYaml("changed"); // different content → different hash
    const newHash = sha256(newYaml);

    // Local has the old hash.
    const localTopicHashes = new Map([["general/changed.yaml", sha256(oldYaml)]]);
    const localTopicBytes = new Map([["general/changed.yaml", oldYaml]]);

    const requested: string[] = [];
    const fetchImpl: FetchImpl = (url) => {
      requested.push(url);
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(
          ok200(manifestJson("general/changed.yaml", "changed", newHash)),
        );
      }
      if (url.endsWith("general/changed.yaml")) {
        return Promise.resolve(ok200(newYaml));
      }
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve("") });
    };

    const outcome = await fetchCatalog({
      contentUrl: CONTENT_URL,
      fetchImpl,
      localTopicHashes,
      localTopicBytes,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.catalog.topics.map((t) => t.id)).toEqual(["changed"]);
    }
    // The topic file WAS fetched because the hash differed.
    expect(requested).toContain(`${CONTENT_URL}/general/changed.yaml`);
  });

  it("B2b: changed topic with wrong integrity (tampered) → rejected even after hash-diff triggered download", async () => {
    const localYaml = topicYaml("tampered-local");
    const remoteYaml = topicYaml("tampered-remote");
    // Manifest claims the hash of remoteYaml, but we corrupt it.
    const tamperedYaml = remoteYaml + "\n# corrupted";
    const remoteHash = sha256(remoteYaml); // hash of clean content

    const localTopicHashes = new Map([["general/tampered.yaml", sha256(localYaml)]]);
    const localTopicBytes = new Map([["general/tampered.yaml", localYaml]]);

    const fetchImpl: FetchImpl = (url) => {
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(
          ok200(manifestJson("general/tampered.yaml", "tampered-remote", remoteHash)),
        );
      }
      // Server returns tampered bytes, not matching the manifest hash.
      return Promise.resolve(ok200(tamperedYaml));
    };

    const outcome = await fetchCatalog({
      contentUrl: CONTENT_URL,
      fetchImpl,
      localTopicHashes,
      localTopicBytes,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("invalid");
      expect(outcome.detail).toMatch(/sha256 mismatch/);
    }
  });

  it("B3: local bytes missing for hash-matching entry → file is downloaded normally", async () => {
    const yaml = topicYaml("fallback");
    const hash = sha256(yaml);

    // Hashes say we have it but bytes map is empty (inconsistent local state).
    const localTopicHashes = new Map([["general/fallback.yaml", hash]]);
    const localTopicBytes = new Map<string, string>(); // empty

    const requested: string[] = [];
    const fetchImpl: FetchImpl = (url) => {
      requested.push(url);
      if (url.endsWith("manifest.json")) {
        return Promise.resolve(
          ok200(manifestJson("general/fallback.yaml", "fallback", hash)),
        );
      }
      return Promise.resolve(ok200(yaml));
    };

    const outcome = await fetchCatalog({
      contentUrl: CONTENT_URL,
      fetchImpl,
      localTopicHashes,
      localTopicBytes,
    });

    // Since the local bytes were missing the file was downloaded.
    expect(outcome.ok).toBe(true);
    expect(requested).toContain(`${CONTENT_URL}/general/fallback.yaml`);
  });
});

// ---------------------------------------------------------------------------
// Multi-topic: partial hash match (some reused, some fetched)
// ---------------------------------------------------------------------------

describe("B multi-topic: partial hash match across a catalog", () => {
  it("unchanged topics reused, changed topics downloaded, all validated", async () => {
    const yamlA = topicYaml("topic-a"); // unchanged
    const yamlBOld = topicYaml("topic-b-old"); // local version
    const yamlBNew = topicYaml("topic-b"); // new remote version
    const hashA = sha256(yamlA);
    const hashBNew = sha256(yamlBNew);

    const localTopicHashes = new Map([
      ["general/topic-a.yaml", hashA], // matches remote → reuse
      ["general/topic-b.yaml", sha256(yamlBOld)], // differs → download
    ]);
    const localTopicBytes = new Map([
      ["general/topic-a.yaml", yamlA],
      ["general/topic-b.yaml", yamlBOld],
    ]);

    const manifest = JSON.stringify({
      version: "2.0.0",
      publishedAt: "2026-01-01T00:00:00.000Z",
      topics: [
        { id: "topic-a", class: { kind: "general" }, file: "general/topic-a.yaml", itemCount: 1, tiers: [100], sha256: hashA },
        { id: "topic-b", class: { kind: "general" }, file: "general/topic-b.yaml", itemCount: 1, tiers: [100], sha256: hashBNew },
      ],
    });

    const requested: string[] = [];
    const fetchImpl: FetchImpl = (url) => {
      requested.push(url);
      if (url.endsWith("manifest.json")) return Promise.resolve(ok200(manifest));
      if (url.endsWith("topic-a.yaml")) return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, text: () => Promise.resolve("") });
      if (url.endsWith("topic-b.yaml")) return Promise.resolve(ok200(yamlBNew));
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve("") });
    };

    const outcome = await fetchCatalog({
      contentUrl: CONTENT_URL,
      fetchImpl,
      localTopicHashes,
      localTopicBytes,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const ids = outcome.catalog.topics.map((t) => t.id).sort();
      expect(ids).toEqual(["topic-a", "topic-b"]);
    }
    // topic-a was NOT fetched (reused from local), topic-b WAS fetched.
    expect(requested).not.toContain(`${CONTENT_URL}/general/topic-a.yaml`);
    expect(requested).toContain(`${CONTENT_URL}/general/topic-b.yaml`);
  });
});
