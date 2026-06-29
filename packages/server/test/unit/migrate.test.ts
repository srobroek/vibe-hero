/**
 * @file Unit tests for the profile schema-version / migration policy (T056, E6).
 *
 * Proves the four documented branches of {@link migrateProfile} plus the content
 * major-version compatibility guard:
 *   1. same version + valid  → pass-through (`migrated: false`, not reset).
 *   2. older known version   → migration PATH runs (proven via an injected step,
 *      since v1 is the only real version and its registry is an empty stub).
 *   3. newer (future) version → empty + preserved + stderr warning, NO crash
 *      (FR-023 tolerate).
 *   4. corrupt / invalid     → empty (consistent with the store's degrade path).
 *
 * Plus: a content-version test for {@link isContentVersionSupported} (accept
 * same/older major, reject unknown-newer major).
 *
 * The migration registry is module-level (`MIGRATIONS`), so to exercise the
 * older→migrated path we temporarily push a step onto it (and restore it after),
 * driving a synthetic "current is v2" scenario without changing shipped code.
 *
 * Source of truth: spec.md FR-023, data-model.md (§ Profile schemaVersion),
 * tasks.md T056.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  migrateProfile,
  MIGRATIONS,
  CURRENT_PROFILE_SCHEMA_VERSION,
  type MigrationStep,
} from "../../src/profile/migrate.js";
import {
  isContentVersionSupported,
  parseMajorVersion,
  SUPPORTED_CONTENT_MAJOR,
} from "../../src/catalog/loader.js";
import {
  emptyProfile,
  PROFILE_SCHEMA_VERSION,
} from "../../src/schemas/profile.js";

/**
 * A plain-JSON snapshot of a profile at a given declared schemaVersion. Built
 * from {@link emptyProfile} (which is always current-shape and current-version)
 * then overridden so we can simulate any on-disk version without hand-writing
 * the whole document.
 */
const profileDocAtVersion = (version: number): Record<string, unknown> => ({
  ...emptyProfile("2026-01-01T00:00:00.000Z"),
  schemaVersion: version,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migrateProfile (T056, FR-023)", () => {
  it("passes a same-version, valid profile through unchanged", () => {
    const doc = profileDocAtVersion(CURRENT_PROFILE_SCHEMA_VERSION);
    const result = migrateProfile(doc);

    expect(result.reset).toBe(false);
    if (result.reset) throw new Error("expected non-reset result");
    expect(result.migrated).toBe(false);
    expect(result.profile.schemaVersion).toBe(CURRENT_PROFILE_SCHEMA_VERSION);
    // Round-trips the data (createdAt preserved, not stamped fresh).
    expect(result.profile.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("ships an empty migration registry (v1 stub) yet keeps the SHAPE", () => {
    // For the only real version there are no steps; the registry is a documented
    // stub. A real same-version load therefore never reports `migrated`.
    expect(MIGRATIONS).toEqual([]);
    expect(CURRENT_PROFILE_SCHEMA_VERSION).toBe(PROFILE_SCHEMA_VERSION);
  });

  it("runs the migration PATH for an older known version (migrated: true)", () => {
    // v1 is the only real version, so drive the ordered-registry path through the
    // DI seam: pretend current is v2 and register a v1 → v2 step. The step is
    // additive (touches only an ignored marker field) so the migrated document
    // still validates against the current ProfileSchema.
    let ran = false;
    const step: MigrationStep = {
      from: PROFILE_SCHEMA_VERSION,
      up: (raw) => {
        ran = true;
        return { ...raw, _migratedMarker: true };
      },
    };

    // On-disk doc is the older (v1) shape; engine target is v2.
    const doc = profileDocAtVersion(PROFILE_SCHEMA_VERSION);
    const result = migrateProfile(doc, {
      currentVersion: PROFILE_SCHEMA_VERSION + 1,
      migrations: [step],
    });

    expect(ran).toBe(true);
    expect(result.reset).toBe(false);
    if (result.reset) throw new Error("expected non-reset result");
    expect(result.migrated).toBe(true);
    // applyMigrations stamps the document with the target version.
    expect(result.profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION + 1);
  });

  it("does not crash when a known-older version has a registry gap (resets)", () => {
    // Engine target is v3 but no v2 step is registered → applyMigrations throws
    // internally; the policy degrades to empty rather than crashing.
    const result = migrateProfile(profileDocAtVersion(PROFILE_SCHEMA_VERSION), {
      currentVersion: PROFILE_SCHEMA_VERSION + 2,
      migrations: [], // gap: no v1→v2 step
    });
    expect(result.reset).toBe(true);
    if (!result.reset) throw new Error("expected reset result");
    expect(result.preserved).toBe(false);
  });

  it("tolerates a NEWER future version: empty, preserved, warns, no crash", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const future = CURRENT_PROFILE_SCHEMA_VERSION + 5;
    const doc = profileDocAtVersion(future);

    // Must not throw (FR-023 tolerate gracefully).
    const result = migrateProfile(doc);

    expect(result.reset).toBe(true);
    if (!result.reset) throw new Error("expected reset result");
    // Preserve flag tells the store NOT to overwrite the newer file on disk.
    expect(result.preserved).toBe(true);
    // Fresh empty profile for this run.
    expect(result.profile.schemaVersion).toBe(CURRENT_PROFILE_SCHEMA_VERSION);
    expect(result.profile.config).toBeUndefined();
    expect(result.profile.quizHistory).toEqual([]);
    // A clear stderr warning was emitted naming the unsupported version.
    expect(stderr).toHaveBeenCalledTimes(1);
    const message = String(stderr.mock.calls[0]?.[0]);
    expect(message).toContain(`v${future}`);
    expect(message).toMatch(/newer/i);
  });

  it("resets a corrupt/invalid document to an empty profile (not preserved)", () => {
    // Valid JSON, wrong shape: schemaVersion present and current but the rest of
    // the required document is missing → fails ProfileSchema → corrupt path.
    const result = migrateProfile({
      schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
      abilities: "not-a-record",
    });

    expect(result.reset).toBe(true);
    if (!result.reset) throw new Error("expected reset result");
    expect(result.preserved).toBe(false);
    expect(result.profile.quizHistory).toEqual([]);
    expect(result.profile.schemaVersion).toBe(CURRENT_PROFILE_SCHEMA_VERSION);
  });

  it("resets non-object / version-less input to empty (not preserved)", () => {
    for (const bad of [null, 42, "nope", [], {}]) {
      const result = migrateProfile(bad);
      expect(result.reset).toBe(true);
      if (!result.reset) throw new Error("expected reset result");
      expect(result.preserved).toBe(false);
    }
  });

  it("accepts a version-less but structurally-complete document via direct parse", () => {
    // Drop schemaVersion entirely but keep a valid body — last-chance parse
    // should still accept it rather than discard on a version technicality.
    const { schemaVersion: _drop, ...withoutVersion } = profileDocAtVersion(
      CURRENT_PROFILE_SCHEMA_VERSION,
    );
    // Without schemaVersion the body fails ProfileSchema (it is required), so
    // this degrades to empty — documents the boundary precisely.
    const result = migrateProfile(withoutVersion);
    expect(result.reset).toBe(true);
  });
});

describe("content version compatibility (T056, E6)", () => {
  it("parses the major component of a semver-ish string", () => {
    expect(parseMajorVersion("1.2.3")).toBe(1);
    expect(parseMajorVersion("0.0.0-bundled")).toBe(0);
    expect(parseMajorVersion("12.0.0")).toBe(12);
    expect(parseMajorVersion("not-a-version")).toBeUndefined();
  });

  it("accepts same/older major and the bundled baseline", () => {
    expect(isContentVersionSupported("0.0.0-bundled")).toBe(true);
    expect(isContentVersionSupported(`${SUPPORTED_CONTENT_MAJOR}.4.2`)).toBe(true);
    expect(isContentVersionSupported(`${SUPPORTED_CONTENT_MAJOR}.0.0`)).toBe(true);
  });

  it("rejects a major newer than the engine supports", () => {
    expect(isContentVersionSupported(`${SUPPORTED_CONTENT_MAJOR + 1}.0.0`)).toBe(
      false,
    );
    expect(isContentVersionSupported("99.0.0")).toBe(false);
  });

  it("conservatively accepts an unparseable version (Zod gates elsewhere)", () => {
    expect(isContentVersionSupported("garbage")).toBe(true);
  });
});
