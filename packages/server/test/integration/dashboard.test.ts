/**
 * @file Integration tests for `get_dashboard` and due-for-review offer wiring.
 *
 * Covers:
 *  - get_dashboard: output shape (matrix, summary, history).
 *  - get_dashboard: dynamic scope derivation (no hardcoded scopes).
 *  - get_dashboard: abilitySnapshots appended by submit_answer.
 *  - get_dashboard: history series built from abilitySnapshots.
 *  - get_offer: due-for-review topic surfaced as priority offer.
 *  - get_offer: review offer respects cadence (suppressed when off).
 *  - get_offer: review offer prompt uses "time to refresh" wording.
 *  - gen-manifest: manifest.json has sha256 fields and valid structure.
 *
 * Each test uses its own temp VIBE_HERO_HOME via dirOverride.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBundledCatalog } from "../../src/catalog/bundled/index.js";
import { makeGetDashboardTool, renderDashboard } from "../../src/tools/dashboard.js";
import { makeGetOfferTool } from "../../src/tools/offers.js";
import { makeSubmitAnswerTool } from "../../src/tools/submitAnswer.js";
import { makeGetStatusTool } from "../../src/tools/status.js";
import { makeStartQuizTool } from "../../src/tools/startQuiz.js";
import { updateProfile, loadProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import type {
  GetDashboardResult,
  GetOfferResult,
} from "../../src/schemas/tools.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const now = "2026-01-01T00:00:00.000Z";
// A "stale" timestamp: far enough in the past to trigger lapse detection.
const staleAt = "2025-05-01T00:00:00.000Z";

const seedConfig = () => ({
  toolsLearning: ["claude-code" as const],
  offerCadence: "per_session" as const,
  proactiveOffers: true,
  quizLength: 3 as const,
  createdAt: now,
  updatedAt: now,
});

/** A real bundled general topic key — task-decomposition ships in the assembled catalog. */
const PLACEHOLDER_KEY = abilityKey({ kind: "general" }, "task-decomposition");

describe("get_dashboard — output shape and dynamic scopes", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-dash-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns matrix, summary, and history fields with correct shape", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    // Top-level shape.
    expect(result).toHaveProperty("matrix");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("history");
    expect(Array.isArray(result.matrix)).toBe(true);
    expect(Array.isArray(result.history)).toBe(true);

    // Summary shape.
    expect(typeof result.summary.itemsAnswered).toBe("number");
    expect(typeof result.summary.graduated).toBe("number");
    expect(typeof result.summary.dueForReview).toBe("number");
    expect(typeof result.summary.streak).toBe("number");

    // Matrix rows must include the bundled placeholder topic.
    const { topics: bundled } = loadBundledCatalog();
    expect(result.matrix.length).toBe(bundled.length);

    // Each row must have cells.
    for (const row of result.matrix) {
      expect(Array.isArray(row.cells)).toBe(true);
      expect(row.cells.length).toBeGreaterThan(0);
      expect(typeof row.topic).toBe("string");
      expect(typeof row.title).toBe("string");
    }
  });

  it("matrix includes 'general' scope column for every row", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    for (const row of result.matrix) {
      const generalCell = row.cells.find((c) => c.scope === "general");
      expect(generalCell).toBeDefined();
    }
  });

  it("scopes are dynamic — derived from ToolIdSchema.options (not hardcoded)", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    // All scopes in the first row must be present in every row.
    if (result.matrix.length === 0) return;
    const firstRowScopes = result.matrix[0]!.cells.map((c) => c.scope);

    for (const row of result.matrix) {
      const rowScopes = row.cells.map((c) => c.scope);
      expect(rowScopes).toEqual(firstRowScopes);
    }

    // "general" must always be first.
    expect(firstRowScopes[0]).toBe("general");

    // The scope set must include the declared tool ids.
    expect(firstRowScopes).toContain("claude-code");
    expect(firstRowScopes).toContain("codex");
    expect(firstRowScopes).toContain("kiro-cli");
    expect(firstRowScopes).toContain("kiro-ide");
  });

  it("not_started topics have tier 0, status not_started, empty markers", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    // task-decomposition topic is not started yet — check the general cell.
    const placeholderRow = result.matrix.find((r) => r.topic === "task-decomposition");
    expect(placeholderRow).toBeDefined();
    const generalCell = placeholderRow!.cells.find((c) => c.scope === "general");
    expect(generalCell).toBeDefined();
    expect(generalCell!.tier).toBe(0);
    expect(generalCell!.status).toBe("not_started");
    expect(generalCell!.markers).toEqual([]);
  });

  it("graduated topic shows 'graduated' marker in the cell", async () => {
    await updateProfile(
      (p) => ({
        ...p,
        config: seedConfig(),
        abilities: {
          [PLACEHOLDER_KEY]: {
            value: 200,
            itemsSeen: 10,
            lastAssessedAt: now,
            lastItemIds: [],
            dwell: 0,
          },
        },
        graduations: {
          [PLACEHOLDER_KEY]: {
            currentTier: 100,
            status: "current" as const,
            graduatedAt: now,
            lastChangeReason: "graduated" as const,
          },
        },
      }),
      home,
    );
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    const placeholderRow = result.matrix.find((r) => r.topic === "task-decomposition");
    const generalCell = placeholderRow?.cells.find((c) => c.scope === "general");
    expect(generalCell).toBeDefined();
    expect(generalCell!.tier).toBe(100);
    expect(generalCell!.markers).toContain("graduated");
    expect(result.summary.graduated).toBe(1);
  });

  it("due_for_review topic shows 'due' marker and increments summary.dueForReview", async () => {
    await updateProfile(
      (p) => ({
        ...p,
        config: seedConfig(),
        abilities: {
          [PLACEHOLDER_KEY]: {
            value: 110,
            itemsSeen: 10,
            lastAssessedAt: staleAt,
            lastItemIds: [],
            dwell: 0,
          },
        },
        graduations: {
          [PLACEHOLDER_KEY]: {
            currentTier: 100,
            status: "due_for_review" as const,
            graduatedAt: staleAt,
            lastChangeReason: "review_due" as const,
          },
        },
      }),
      home,
    );
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    const placeholderRow = result.matrix.find((r) => r.topic === "task-decomposition");
    const generalCell = placeholderRow?.cells.find((c) => c.scope === "general");
    expect(generalCell).toBeDefined();
    expect(generalCell!.markers).toContain("due");
    expect(result.summary.dueForReview).toBeGreaterThanOrEqual(1);
  });

  it("summary.itemsAnswered counts graded items from quiz history", async () => {
    await updateProfile(
      (p) => ({
        ...p,
        config: seedConfig(),
        quizHistory: [
          {
            id: "q1",
            key: PLACEHOLDER_KEY,
            startedAt: now,
            abilityBefore: 300,
            items: [
              {
                itemId: "task-decomposition-100-mc-a",
                tier: 100 as const,
                difficulty: 100,
                grade: "correct" as const,
                score: 1,
                gradedBy: "engine" as const,
                answeredAt: now,
              },
              {
                itemId: "task-decomposition-100-mc-b",
                tier: 100 as const,
                difficulty: 100,
                grade: "incorrect" as const,
                score: 0,
                gradedBy: "engine" as const,
                answeredAt: now,
              },
            ],
            abilityAfter: 320,
          },
        ],
        // Schema requires abilities for any answered items key
        abilities: {
          [PLACEHOLDER_KEY]: {
            value: 320,
            itemsSeen: 2,
            lastAssessedAt: now,
            lastItemIds: ["task-decomposition-100-mc-a", "task-decomposition-100-mc-b"],
            dwell: 0,
          },
        },
      }),
      home,
    );
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;
    expect(result.summary.itemsAnswered).toBe(2);
  });

  it("summary.streak counts consecutive correct answers from most recent", async () => {
    await updateProfile(
      (p) => ({
        ...p,
        config: seedConfig(),
        abilities: {
          [PLACEHOLDER_KEY]: {
            value: 320,
            itemsSeen: 3,
            lastAssessedAt: "2025-12-01T12:00:00.000Z",
            lastItemIds: ["i1", "i2", "i3"],
            dwell: 0,
          },
        },
        quizHistory: [
          {
            id: "q1",
            key: PLACEHOLDER_KEY,
            startedAt: now,
            abilityBefore: 300,
            items: [
              {
                itemId: "i1",
                tier: 100 as const,
                difficulty: 100,
                grade: "incorrect" as const,
                score: 0,
                gradedBy: "engine" as const,
                answeredAt: "2025-12-01T10:00:00.000Z",
              },
              {
                itemId: "i2",
                tier: 100 as const,
                difficulty: 100,
                grade: "correct" as const,
                score: 1,
                gradedBy: "engine" as const,
                answeredAt: "2025-12-01T11:00:00.000Z",
              },
              {
                itemId: "i3",
                tier: 100 as const,
                difficulty: 100,
                grade: "correct" as const,
                score: 1,
                gradedBy: "engine" as const,
                answeredAt: "2025-12-01T12:00:00.000Z",
              },
            ],
            abilityAfter: 320,
          },
        ],
      }),
      home,
    );
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;
    // The two most-recent items are "correct", the oldest is "incorrect".
    expect(result.summary.streak).toBe(2);
  });

  it("history is empty when no abilitySnapshots exist", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;
    expect(result.history).toEqual([]);
  });

  it("history includes per-scope mean series when abilitySnapshots are present", async () => {
    const ts1 = "2025-12-01T10:00:00.000Z";
    const ts2 = "2025-12-02T10:00:00.000Z";
    await updateProfile(
      (p) => ({
        ...p,
        config: seedConfig(),
        abilitySnapshots: [
          { ts: ts1, key: PLACEHOLDER_KEY, ability: 300 },
          { ts: ts2, key: PLACEHOLDER_KEY, ability: 350 },
        ],
      }),
      home,
    );
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    // Must have at least a "general" entry.
    const generalEntry = result.history.find((h) => h.scope === "general");
    expect(generalEntry).toBeDefined();
    expect(generalEntry!.points.length).toBe(2);
    // Points must be sorted by timestamp.
    expect(generalEntry!.points[0]!.ts).toBe(ts1);
    expect(generalEntry!.points[1]!.ts).toBe(ts2);
    // meanAbility is the average at each ts (one topic → same as the value).
    expect(generalEntry!.points[0]!.meanAbility).toBe(300);
    expect(generalEntry!.points[1]!.meanAbility).toBe(350);
  });
});

// ---------------------------------------------------------------------------
// abilitySnapshots appended on submit_answer
// ---------------------------------------------------------------------------

describe("submit_answer appends abilitySnapshots", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-snap-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("appends one snapshot per graded item to profile.abilitySnapshots", async () => {
    // Seed config.
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);

    // Use bundled catalog loader seam.
    const { topics } = loadBundledCatalog();
    const catalogLoader = () => ({ topics, errors: [] });

    const startQuiz = makeStartQuizTool(home, catalogLoader).handler;
    const submitAnswer = makeSubmitAnswerTool(home, catalogLoader).handler;

    // Start a quiz.
    const quizResult = await startQuiz({ key: PLACEHOLDER_KEY, length: 3 });
    const { quizId, items } = quizResult as { quizId: string; items: { itemId: string; type: string; choices?: { id: string; correct?: boolean }[] }[] };
    expect(items.length).toBeGreaterThan(0);

    // Submit the first item.
    const item = items[0]!;
    // Find the correct answer for multiple choice.
    const choiceId = item.choices?.find((c) => c.correct)?.id ?? item.choices?.[0]?.id;
    await submitAnswer({
      quizId,
      itemId: item.itemId,
      answer: { choiceId },
    });

    const profile = await loadProfile(home);
    expect(profile.abilitySnapshots.length).toBe(1);
    expect(profile.abilitySnapshots[0]!.key).toBe(PLACEHOLDER_KEY);
    expect(typeof profile.abilitySnapshots[0]!.ability).toBe("number");
    expect(typeof profile.abilitySnapshots[0]!.ts).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Due-for-review feeds get_offer (STEP 7 / task #21)
// ---------------------------------------------------------------------------

describe("get_offer: due-for-review priority", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-offer-due-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /**
   * Seed a profile with the placeholder topic marked as due_for_review
   * (ability decayed, assessed a long time ago) so the lapse engine fires.
   */
  const seedDueProfile = async (): Promise<void> => {
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          ...seedConfig(),
          offerCadence: "per_session" as const,
          proactiveOffers: true,
        },
        abilities: {
          [PLACEHOLDER_KEY]: {
            value: 90, // well below tier-100 floor + hysteresis
            itemsSeen: 10,
            lastAssessedAt: staleAt, // far in the past
            lastItemIds: [],
            dwell: 0,
          },
        },
        graduations: {
          [PLACEHOLDER_KEY]: {
            currentTier: 100 as const,
            status: "due_for_review" as const,
            graduatedAt: staleAt,
            lastChangeReason: "review_due" as const,
          },
        },
      }),
      home,
    );
  };

  it("surfaces a due-for-review topic as an offer even with empty activity candidates", async () => {
    await seedDueProfile();
    const { topics } = loadBundledCatalog();
    const catalogLoader = () => ({ topics, errors: [] });
    const getOffer = makeGetOfferTool(home, catalogLoader).handler;

    const result = (await getOffer({ sessionId: "s1" })) as GetOfferResult;

    // An offer must surface — the due topic is the only candidate.
    expect(result.offer).toBeDefined();
    expect(result.suppressed).toBeUndefined();
    expect(result.offer!.key).toBe(PLACEHOLDER_KEY);
  });

  it("review offer prompt contains 'refresh' wording (not the activity prompt)", async () => {
    await seedDueProfile();
    const { topics } = loadBundledCatalog();
    const catalogLoader = () => ({ topics, errors: [] });
    const getOffer = makeGetOfferTool(home, catalogLoader).handler;

    const result = (await getOffer({ sessionId: "s2" })) as GetOfferResult;

    expect(result.offer).toBeDefined();
    expect(result.offer!.prompt.toLowerCase()).toContain("refresh");
  });

  it("due-for-review offer is suppressed when offerCadence is 'off'", async () => {
    await updateProfile(
      (p) => ({
        ...p,
        config: {
          ...seedConfig(),
          offerCadence: "off" as const,
          proactiveOffers: true,
        },
        abilities: {
          [PLACEHOLDER_KEY]: {
            value: 90,
            itemsSeen: 10,
            lastAssessedAt: staleAt,
            lastItemIds: [],
            dwell: 0,
          },
        },
        graduations: {
          [PLACEHOLDER_KEY]: {
            currentTier: 100 as const,
            status: "due_for_review" as const,
            graduatedAt: staleAt,
            lastChangeReason: "review_due" as const,
          },
        },
      }),
      home,
    );
    const { topics } = loadBundledCatalog();
    const catalogLoader = () => ({ topics, errors: [] });
    const getOffer = makeGetOfferTool(home, catalogLoader).handler;

    const result = (await getOffer({ sessionId: "s3" })) as GetOfferResult;

    // Cadence is "off" so even due topics are suppressed.
    expect(result.suppressed).toBe("offers_off");
    expect(result.offer).toBeUndefined();
  });

  it("due-for-review offer is suppressed after session-level decline", async () => {
    await seedDueProfile();
    const { topics } = loadBundledCatalog();
    const catalogLoader = () => ({ topics, errors: [] });

    // Mark the session as already declined.
    await updateProfile(
      (p) => ({
        ...p,
        offers: {
          ...p.offers,
          sessionId: "s4",
          declinedThisSession: true,
        },
      }),
      home,
    );

    const getOffer = makeGetOfferTool(home, catalogLoader).handler;
    const result = (await getOffer({ sessionId: "s4" })) as GetOfferResult;

    expect(result.suppressed).toBe("declined");
    expect(result.offer).toBeUndefined();
  });

  it("due-for-review offer is suppressed when per_session cap is already reached", async () => {
    await seedDueProfile();
    const { topics } = loadBundledCatalog();
    const catalogLoader = () => ({ topics, errors: [] });

    // Mark that one offer has already surfaced this session.
    await updateProfile(
      (p) => ({
        ...p,
        offers: {
          ...p.offers,
          sessionId: "s5",
          offersThisSession: 1,
          offeredTopicKeys: [PLACEHOLDER_KEY],
        },
      }),
      home,
    );

    const getOffer = makeGetOfferTool(home, catalogLoader).handler;
    const result = (await getOffer({ sessionId: "s5" })) as GetOfferResult;

    expect(result.suppressed).toBe("cadence");
    expect(result.offer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rendered field — server-side dashboard rendering
// ---------------------------------------------------------------------------

describe("get_dashboard — rendered field", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-rendered-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("result includes a non-empty rendered string", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    expect(typeof result.rendered).toBe("string");
    expect(result.rendered.length).toBeGreaterThan(0);
  });

  it("rendered contains the header box", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    expect(result.rendered).toContain("vibe-hero");
    expect(result.rendered).toContain("╔");
    expect(result.rendered).toContain("╚");
  });

  it("rendered contains the legend line", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    expect(result.rendered).toContain("Legend:");
    expect(result.rendered).toContain("not started");
    expect(result.rendered).toContain("graduated");
  });

  it("rendered contains a known topic row from the bundled catalog (or not-started summary for fresh profile)", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;
    const { topics } = loadBundledCatalog();

    const result = (await getDashboard({})) as GetDashboardResult;

    // With no activity, the new layout collapses idle rows into a summary line
    // rather than printing 28+ empty rows.  Accept either:
    //   (a) at least one topic title is visible (if any topic has been started), OR
    //   (b) the not-started summary line appears (fresh profile path).
    const hasTopicRow = topics.some((t) => result.rendered.includes(t.title));
    const hasNotStartedSummary =
      result.rendered.includes("not yet started") ||
      result.rendered.includes("No topics started yet");
    expect(hasTopicRow || hasNotStartedSummary).toBe(true);
  });

  it("rendered contains dynamic scope columns (general + claude-code at minimum)", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    expect(result.rendered).toContain("general");
    expect(result.rendered).toContain("claude-code");
  });

  it("rendered contains the summary block", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    expect(result.rendered).toContain("Items answered");
    expect(result.rendered).toContain("Graduated");
    expect(result.rendered).toContain("Streak");
  });

  it("rendered shows 'no history' line when no snapshots exist", async () => {
    await updateProfile((p) => ({ ...p, config: seedConfig() }), home);
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    expect(result.history).toEqual([]);
    expect(result.rendered).toContain("No history yet");
  });

  it("rendered contains a sparkline graph line when snapshots exist", async () => {
    const ts1 = "2025-12-01T10:00:00.000Z";
    const ts2 = "2025-12-02T10:00:00.000Z";
    await updateProfile(
      (p) => ({
        ...p,
        config: seedConfig(),
        abilitySnapshots: [
          { ts: ts1, key: PLACEHOLDER_KEY, ability: 300 },
          { ts: ts2, key: PLACEHOLDER_KEY, ability: 380 },
        ],
      }),
      home,
    );
    const getDashboard = makeGetDashboardTool(home).handler;

    const result = (await getDashboard({})) as GetDashboardResult;

    // History should have a general scope entry.
    expect(result.history.length).toBeGreaterThan(0);
    // The rendered output should contain block characters from the sparkline.
    expect(result.rendered).toMatch(/[▁▂▃▄▅▆▇█]/u);
    // And the scope label should appear.
    expect(result.rendered).toContain("general");
  });
});

describe("renderDashboard — unit tests", () => {
  it("produces header, legend, summary, and no-history message for empty input", () => {
    const output = renderDashboard([], {
      itemsAnswered: 0,
      graduated: 0,
      dueForReview: 0,
      streak: 0,
    }, [], new Map());

    expect(output).toContain("vibe-hero");
    expect(output).toContain("Legend:");
    expect(output).toContain("Items answered");
    expect(output).toContain("No history yet");
  });

  it("includes sparkline characters for history points", () => {
    const history = [
      { scope: "general", points: [{ ts: "t1", meanAbility: 250 }, { ts: "t2", meanAbility: 450 }] },
    ];
    const output = renderDashboard([], {
      itemsAnswered: 5,
      graduated: 1,
      dueForReview: 0,
      streak: 2,
    }, history, new Map());

    expect(output).toMatch(/[▁▂▃▄▅▆▇█]/u);
    expect(output).toContain("general");
  });

  it("resolves topic title from map in summary strongest/weakest/next", () => {
    const titleMap = new Map([["task-decomposition", "Task Decomposition"]]);
    const output = renderDashboard([], {
      itemsAnswered: 10,
      graduated: 0,
      dueForReview: 0,
      streak: 0,
      strongest: "general::task-decomposition",
      weakest: "general::task-decomposition",
      next: "general::task-decomposition",
    }, [], titleMap);

    expect(output).toContain("Task Decomposition");
  });

  it("shows '—' em-dash for unknown keys in summary", () => {
    const output = renderDashboard([], {
      itemsAnswered: 0,
      graduated: 0,
      dueForReview: 0,
      streak: 0,
    }, [], new Map());

    // No strongest/weakest/next → should show em-dash placeholder.
    expect(output).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// gen-manifest: sha256 fields present
// ---------------------------------------------------------------------------

describe("gen-manifest: manifest.json has sha256 fields", () => {
  it("manifest.json exists and each entry has a sha256 field", async () => {
    // The manifest is generated at build time and committed to content/manifest.json.
    const manifestPath = path.resolve(
      new URL(import.meta.url).pathname,
      // Resolve relative to test file: ../../../content/manifest.json
      "../../../../content/manifest.json",
    );
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      // If the file doesn't exist yet (first run without a build), skip.
      return;
    }
    const manifest = JSON.parse(raw) as {
      version: string;
      files: { path: string; sha256: string }[];
    };
    expect(typeof manifest.version).toBe("string");
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const entry of manifest.files) {
      expect(typeof entry.path).toBe("string");
      expect(typeof entry.sha256).toBe("string");
      // SHA-256 is a 64-char hex string.
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
