/**
 * @file US-2 status / guidance / list_topics integration test (T029).
 *
 * Proves the quickstart "pull path" end-to-end against a real temp profile home
 * (no mocks), driving the actual US-2 read-tool handlers (`get_status`,
 * `list_topics`, `get_guidance`) and the real bundled catalog:
 *
 *   - get_status returns per-tool standing scoped to the requested tool; topics
 *     with no graduation read as `not_started`; a graduation marked
 *     `due_for_review` surfaces in `dueForReview`; suggestions surface weak /
 *     not-started topics.
 *   - list_topics enumerates the bundled catalog topics + a `catalogVersion`.
 *   - get_guidance with a key returns guidance + a next step for THAT topic;
 *     with NO key it returns guidance for the weakest/stale topic.
 *   - The WHOLE path works WITHOUT any observation/telemetry (SC-011): the only
 *     state seeded is `config` + abilities/graduations + the bundled content —
 *     no hook events, no offer ledger writes.
 *
 * The bundled catalog v1 ships a single general topic (`general|_placeholder`),
 * which is sufficient for these assertions; extra tool-scoped keys are seeded to
 * prove the profile store accepts them and that `get_status` enumeration stays
 * catalog-driven (it lists only topics that actually exist in the catalog).
 *
 * Each test uses its own `VIBE_HERO_HOME` under `os.tmpdir()`, injected via the
 * store's `dirOverride` seam (which every US-2 tool factory takes), so tests
 * stay isolated from process env and from each other.
 *
 * Source of truth: specs/001-vibe-hero-mvp/quickstart.md (US-2 / pull path),
 * spec.md US-2 / FR-021 / SC-011, contracts/mcp-tools.md.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBundledCatalog } from "../../src/catalog/bundled/index.js";
import { makeGetGuidanceTool } from "../../src/tools/guidance.js";
import { makeListTopicsTool } from "../../src/tools/listTopics.js";
import { makeGetStatusTool } from "../../src/tools/status.js";
import { updateProfile } from "../../src/profile/store.js";
import { abilityKey } from "../../src/schemas/common.js";
import type {
  GetGuidanceResult,
  GetStatusResult,
  ListTopicsResult,
} from "../../src/schemas/tools.js";

/** The single bundled general topic key the v1 catalog ships. */
const PLACEHOLDER_KEY = abilityKey({ kind: "general" }, "_placeholder");
/** A tool-scoped key seeded into the profile but absent from the catalog. */
const TOOL_KEY = abilityKey({ kind: "tool", tool: "claude-code" }, "subagents");

/** A valid config that clears the setup gate (the pull path's only precondition). */
const seedConfig = () => {
  const now = "2026-06-01T00:00:00.000Z";
  return {
    toolsLearning: ["claude-code" as const],
    offerCadence: "per_session" as const,
    proactiveOffers: true,
    quizLength: 4,
    createdAt: now,
    updatedAt: now,
  };
};

describe("US-2 status / guidance / list_topics (T029 / quickstart pull path)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-us2-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /**
   * Seed config + MIXED abilities/graduations. The bundled `general|_placeholder`
   * topic is marked `due_for_review` with a graduated tier; a tool-scoped key is
   * seeded graduated `current` (it is NOT in the catalog, so it must not appear
   * in get_status enumeration). Crucially: NO observation/offer state is written
   * — only the profile + bundled content (SC-011).
   */
  const seedMixedProfile = async (): Promise<void> => {
    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(),
        abilities: {
          [PLACEHOLDER_KEY]: {
            value: 180,
            itemsSeen: 6,
            lastAssessedAt: "2026-05-01T00:00:00.000Z",
            lastItemIds: ["placeholder-100-mc"],
          },
          [TOOL_KEY]: {
            value: 420,
            itemsSeen: 20,
            lastAssessedAt: "2026-05-20T00:00:00.000Z",
            lastItemIds: [],
          },
        },
        graduations: {
          [PLACEHOLDER_KEY]: {
            currentTier: 100,
            status: "due_for_review",
            graduatedAt: "2026-04-01T00:00:00.000Z",
            lastChangeReason: "review_due",
          },
          [TOOL_KEY]: {
            currentTier: 400,
            status: "current",
            graduatedAt: "2026-05-20T00:00:00.000Z",
            lastChangeReason: "graduated",
          },
        },
      }),
      home,
    );
  };

  it("get_status returns standing scoped to the requested tool, with due_for_review surfaced", async () => {
    await seedMixedProfile();
    const getStatus = makeGetStatusTool(home).handler;

    const result = (await getStatus({ tool: "claude-code" })) as GetStatusResult;

    // Scoped to the requested tool.
    expect(result.tool).toBe("claude-code");

    // Enumeration is catalog-driven: the bundled general topic is in scope for
    // every tool, the seeded tool-scoped key is NOT in the catalog so it is
    // absent from the rows.
    const keys = result.topics.map((t) => t.key);
    expect(keys).toContain(PLACEHOLDER_KEY);
    expect(keys).not.toContain(TOOL_KEY);

    // The placeholder row reflects the seeded graduation + ability.
    const placeholderRow = result.topics.find((t) => t.key === PLACEHOLDER_KEY);
    expect(placeholderRow).toBeDefined();
    expect(placeholderRow?.tier).toBe(100);
    expect(placeholderRow?.status).toBe("due_for_review");
    expect(placeholderRow?.ability).toBe(180);

    // due_for_review surfaces in the dedicated list.
    expect(result.dueForReview).toContain(PLACEHOLDER_KEY);

    // Suggestions surface the (weak / stale) topic.
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.map((s) => s.key)).toContain(PLACEHOLDER_KEY);
  });

  it("get_status marks topics with no graduation as not_started", async () => {
    // Seed ONLY config (clears the gate) — no abilities, no graduations.
    await updateProfile(
      (current) => ({ ...current, config: seedConfig() }),
      home,
    );
    const getStatus = makeGetStatusTool(home).handler;

    const result = (await getStatus({ tool: "claude-code" })) as GetStatusResult;

    const placeholderRow = result.topics.find((t) => t.key === PLACEHOLDER_KEY);
    expect(placeholderRow).toBeDefined();
    expect(placeholderRow?.status).toBe("not_started");
    expect(placeholderRow?.tier).toBe(0);
    // No graduation anywhere ⇒ nothing due for review.
    expect(result.dueForReview).toEqual([]);
    // A not-started topic is still a valid (and the weakest) suggestion.
    expect(result.suggestions.map((s) => s.key)).toContain(PLACEHOLDER_KEY);
  });

  it("get_status resolves the default tool from config when none is requested", async () => {
    await seedMixedProfile();
    const getStatus = makeGetStatusTool(home).handler;

    const result = (await getStatus({})) as GetStatusResult;

    // toolsLearning[0] === "claude-code".
    expect(result.tool).toBe("claude-code");
  });

  it("list_topics returns the bundled catalog topics + a catalogVersion", async () => {
    // list_topics only needs the gate cleared; seed config.
    await updateProfile(
      (current) => ({ ...current, config: seedConfig() }),
      home,
    );
    const listTopics = makeListTopicsTool(home).handler;

    const result = (await listTopics({})) as ListTopicsResult;

    // Matches the bundled catalog the loader returns.
    const { topics: bundled } = loadBundledCatalog();
    expect(result.topics).toHaveLength(bundled.length);
    expect(result.topics.map((t) => t.id)).toContain("_placeholder");

    const placeholder = result.topics.find((t) => t.id === "_placeholder");
    expect(placeholder?.key).toBe(PLACEHOLDER_KEY);
    expect(placeholder?.class).toBe("general");
    expect(placeholder?.tiers).toEqual([100]);
    expect(placeholder?.itemCount).toBe(1);

    // A non-empty catalog version string is always reported (SC-007).
    expect(typeof result.catalogVersion).toBe("string");
    expect(result.catalogVersion.length).toBeGreaterThan(0);
  });

  it("list_topics filters by class", async () => {
    await updateProfile(
      (current) => ({ ...current, config: seedConfig() }),
      home,
    );
    const listTopics = makeListTopicsTool(home).handler;

    const general = (await listTopics({ class: "general" })) as ListTopicsResult;
    expect(general.topics.map((t) => t.id)).toContain("_placeholder");

    // No tool-scoped topics in the bundled v1 catalog.
    const toolOnly = (await listTopics({ class: "tool" })) as ListTopicsResult;
    expect(toolOnly.topics).toHaveLength(0);
  });

  it("get_guidance with a key returns guidance + a next step for that topic", async () => {
    await seedMixedProfile();
    const getGuidance = makeGetGuidanceTool(home).handler;

    const result = (await getGuidance({ key: PLACEHOLDER_KEY })) as GetGuidanceResult;

    expect(result.key).toBe(PLACEHOLDER_KEY);
    expect(result.title).toBe("Placeholder Topic");
    expect(result.currentTier).toBe(100);
    // Guidance text is pulled from the topic's authored item content.
    expect(result.guidance.length).toBeGreaterThan(0);
    expect(result.guidance).toContain("Placeholder guidance");
    // The topic has gradeable items ⇒ the next step is a quiz.
    expect(result.nextStep.action).toBe("quiz");
    expect(result.nextStep.detail.length).toBeGreaterThan(0);
  });

  it("get_guidance with NO key returns guidance for the weakest/stale topic", async () => {
    await seedMixedProfile();
    const getGuidance = makeGetGuidanceTool(home).handler;

    const result = (await getGuidance({ tool: "claude-code" })) as GetGuidanceResult;

    // The only in-scope catalog topic (and the seeded weak/stale one) is picked.
    expect(result.key).toBe(PLACEHOLDER_KEY);
    expect(result.currentTier).toBe(100);
    expect(result.guidance.length).toBeGreaterThan(0);
    expect(result.nextStep.action).toBe("quiz");
  });

  it("the whole pull path works with ZERO telemetry (SC-011)", async () => {
    // Seed ONLY config + learning progress — NO observation events, NO offer
    // ledger mutations. Assert every pull-path tool still resolves fully.
    await seedMixedProfile();

    const getStatus = makeGetStatusTool(home).handler;
    const listTopics = makeListTopicsTool(home).handler;
    const getGuidance = makeGetGuidanceTool(home).handler;

    const status = (await getStatus({ tool: "claude-code" })) as GetStatusResult;
    const topics = (await listTopics({})) as ListTopicsResult;
    const guidanceByKey = (await getGuidance({
      key: PLACEHOLDER_KEY,
    })) as GetGuidanceResult;
    const guidanceWeakest = (await getGuidance({
      tool: "claude-code",
    })) as GetGuidanceResult;

    // All four produced real results, none of them a gate/not-implemented
    // sentinel, and none required any telemetry to be present.
    expect((status as unknown as Record<string, unknown>)["status"]).toBeUndefined();
    expect(status.topics.length).toBeGreaterThan(0);
    expect(topics.topics.length).toBeGreaterThan(0);
    expect(guidanceByKey.key).toBe(PLACEHOLDER_KEY);
    expect(guidanceWeakest.key).toBe(PLACEHOLDER_KEY);
  });
});
