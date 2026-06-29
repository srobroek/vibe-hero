/**
 * @file Integration tests for the profile store (T014).
 *
 * Exercises the durable fs/lock boundary directly against a real temp
 * directory (no mocks): missing/corrupt-file recovery (FR-023), round-trip
 * fidelity, and — the load-bearing one — concurrent {@link updateProfile}
 * serialization with no lost updates (FR-023a / edge case E1).
 *
 * Each test gets its own unique `VIBE_HERO_HOME` under `os.tmpdir()`, passed
 * explicitly via the store's injectable `dirOverride` seam so tests stay
 * isolated and don't depend on process env.
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadProfile,
  saveProfile,
  updateProfile,
  profilePath,
  profileDir,
} from "../../src/profile/store.js";
import {
  ProfileSchema,
  emptyProfile,
  PROFILE_SCHEMA_VERSION,
  type Profile,
  type QuizRecord,
} from "../../src/schemas/profile.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vibe-hero-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build a minimal valid {@link QuizRecord} tagged with `id`. */
const quizRecord = (id: string): QuizRecord => ({
  id,
  key: "general|planning",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  items: [],
  abilityBefore: 300,
  abilityAfter: 300,
});

describe("profile path helpers", () => {
  it("resolves the dir and profile.json under an explicit override", () => {
    expect(profileDir(dir)).toBe(path.resolve(dir));
    expect(profilePath(dir)).toBe(path.join(path.resolve(dir), "profile.json"));
  });

  it("falls back to VIBE_HERO_HOME when no override is given", () => {
    const prev = process.env["VIBE_HERO_HOME"];
    process.env["VIBE_HERO_HOME"] = dir;
    try {
      expect(profileDir()).toBe(path.resolve(dir));
      expect(profilePath()).toBe(path.join(path.resolve(dir), "profile.json"));
    } finally {
      if (prev === undefined) delete process.env["VIBE_HERO_HOME"];
      else process.env["VIBE_HERO_HOME"] = prev;
    }
  });
});

describe("loadProfile (FR-023: tolerate missing/corrupt)", () => {
  it("returns a valid empty profile when the file is missing", async () => {
    const profile = await loadProfile(dir);
    // It is a schema-valid empty profile.
    expect(() => ProfileSchema.parse(profile)).not.toThrow();
    expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    expect(profile.config).toBeUndefined();
    expect(profile.quizHistory).toEqual([]);
    expect(profile.abilities).toEqual({});
  });

  it("returns an empty profile (no throw) when the JSON is corrupt", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(profilePath(dir), "{ this is not valid json :::", "utf8");

    const profile = await loadProfile(dir);
    expect(() => ProfileSchema.parse(profile)).not.toThrow();
    expect(profile.quizHistory).toEqual([]);
  });

  it("returns an empty profile when the JSON is well-formed but schema-invalid", async () => {
    await mkdir(dir, { recursive: true });
    // Valid JSON, wrong shape (schemaVersion must be a positive int).
    await writeFile(profilePath(dir), JSON.stringify({ schemaVersion: "nope" }), "utf8");

    const profile = await loadProfile(dir);
    expect(() => ProfileSchema.parse(profile)).not.toThrow();
    expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
  });

  it("leaves a corrupt file on disk untouched (does not clobber on read)", async () => {
    await mkdir(dir, { recursive: true });
    const corrupt = "{ not json";
    await writeFile(profilePath(dir), corrupt, "utf8");

    await loadProfile(dir);

    expect(await readFile(profilePath(dir), "utf8")).toBe(corrupt);
  });
});

describe("saveProfile / round-trip", () => {
  it("save then load returns equal data (sans the bumped updatedAt)", async () => {
    const original = emptyProfile("2026-01-01T00:00:00.000Z");
    const seeded: Profile = {
      ...original,
      quizHistory: [quizRecord("q1"), quizRecord("q2")],
      abilities: {
        "general|planning": {
          value: 312,
          itemsSeen: 4,
          lastAssessedAt: "2026-01-01T00:00:00.000Z",
          lastItemIds: ["i1", "i2"],
        },
      },
    };

    await saveProfile(seeded, dir);
    const loaded = await loadProfile(dir);

    // updatedAt is intentionally bumped by saveProfile; everything else round-trips.
    expect(loaded.updatedAt).not.toBe(seeded.updatedAt);
    const { updatedAt: _ignoredA, ...loadedRest } = loaded;
    const { updatedAt: _ignoredB, ...seededRest } = seeded;
    expect(loadedRest).toEqual(seededRest);
  });

  it("produces a file that is itself schema-valid JSON", async () => {
    await saveProfile(emptyProfile(), dir);
    const onDisk = JSON.parse(await readFile(profilePath(dir), "utf8"));
    expect(() => ProfileSchema.parse(onDisk)).not.toThrow();
  });
});

describe("updateProfile concurrency (FR-023a / E1: no lost updates)", () => {
  it("applies all N concurrent updates with none lost", async () => {
    const N = 20;

    // Seed an empty profile first so all updaters start from the same base.
    await saveProfile(emptyProfile(), dir);

    // Fire N concurrent read-modify-write cycles, each appending one unique
    // quiz record. If the lock+atomic-write fails to serialize, interleaved
    // read-modify-writes would drop entries and the final count would be < N.
    const updaters = Array.from({ length: N }, (_unused, i) =>
      updateProfile(
        (current) => ({
          ...current,
          quizHistory: [...current.quizHistory, quizRecord(`q-${i}`)],
        }),
        dir,
      ),
    );

    const settled = await Promise.allSettled(updaters);
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(rejected, JSON.stringify(rejected.map((r) => (r as PromiseRejectedResult).reason?.message))).toHaveLength(0);

    const final = await loadProfile(dir);
    expect(final.quizHistory).toHaveLength(N);

    // Every distinct id is present exactly once (no lost, no duplicated update).
    const ids = new Set(final.quizHistory.map((q) => q.id));
    expect(ids.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(ids.has(`q-${i}`)).toBe(true);
    }
  });

  it("serializes concurrent numeric increments without lost updates", async () => {
    const N = 20;
    await saveProfile(emptyProfile(), dir);

    const bump = Array.from({ length: N }, () =>
      updateProfile(
        (current) => ({
          ...current,
          backoff: {
            ...current.backoff,
            consecutiveDeclines: current.backoff.consecutiveDeclines + 1,
          },
        }),
        dir,
      ),
    );

    await Promise.all(bump);

    const final = await loadProfile(dir);
    expect(final.backoff.consecutiveDeclines).toBe(N);
  });
});
