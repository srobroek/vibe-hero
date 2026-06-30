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
 * The assembled catalog ships 28 topics across general, claude-code, codex,
 * kiro-cli, and kiro-ide. The general topic `task-decomposition` is used as the
 * primary test fixture. Extra tool-scoped keys are seeded to prove the profile
 * store accepts them and that `get_status` enumeration stays catalog-driven
 * (it lists only topics that actually exist in the catalog).
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

/** A real bundled general topic key — task-decomposition ships in the assembled catalog. */
const PLACEHOLDER_KEY = abilityKey({ kind: "general" }, "task-decomposition");
/** The topic id string used for row lookups (matches the YAML `id:` field). */
const PLACEHOLDER_TOPIC_ID = "task-decomposition";
/**
 * A tool-scoped key seeded into the profile but ABSENT from the assembled catalog.
 * "non-existent-topic" is not a real topic id, so it exercises the "extra profile
 * keys not in the catalog must not appear in get_status enumeration" contract.
 */
const TOOL_KEY = abilityKey({ kind: "tool", tool: "claude-code" }, "non-existent-topic");

/**
 * High-ability seed used to push other general topics above `task-decomposition`
 * so the weakness ranking reliably surfaces `task-decomposition` as weakest.
 */
const HIGH_ABILITY = { value: 480, itemsSeen: 20, lastAssessedAt: "2026-05-25T00:00:00.000Z", lastItemIds: [] } as const;

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
   * Seed config + MIXED abilities/graduations.
   *
   * `task-decomposition` (PLACEHOLDER_KEY) is marked `due_for_review` at ability 180
   * (the topic under test). ALL other in-scope catalog topics (general + claude-code)
   * are seeded with high ability so they rank as stronger than `task-decomposition`
   * in the weakness ranking — ensuring `task-decomposition` is reliably the
   * weakest/stale pick even with MAX_SUGGESTIONS=3.
   * The non-existent TOOL_KEY is seeded graduated `current` and must NOT appear in
   * `get_status` enumeration (it is absent from the assembled catalog).
   * No observation/offer state is written (SC-011).
   */
  const seedMixedProfile = async (): Promise<void> => {
    // All other in-scope general + claude-code topics — seeded high so task-decomposition
    // is the clear weakest (ranked by due_for_review status, ability 180 < 480).
    const otherKeys = [
      // Other general topics
      abilityKey({ kind: "general" }, "debugging"),
      abilityKey({ kind: "general" }, "git-and-version-control"),
      abilityKey({ kind: "general" }, "refactoring-and-code-review"),
      abilityKey({ kind: "general" }, "testing-and-verification"),
      // All claude-code tool topics
      abilityKey({ kind: "tool", tool: "claude-code" }, "agentic-workflows"),
      abilityKey({ kind: "tool", tool: "claude-code" }, "context-management"),
      abilityKey({ kind: "tool", tool: "claude-code" }, "hooks"),
      abilityKey({ kind: "tool", tool: "claude-code" }, "mcp-servers"),
      abilityKey({ kind: "tool", tool: "claude-code" }, "permissions-and-settings"),
      abilityKey({ kind: "tool", tool: "claude-code" }, "planning"),
      abilityKey({ kind: "tool", tool: "claude-code" }, "slash-commands-and-skills"),
      abilityKey({ kind: "tool", tool: "claude-code" }, "subagents"),
    ] as const;
    const otherAbilities = Object.fromEntries(otherKeys.map((k) => [k, HIGH_ABILITY]));
    const otherGraduations = Object.fromEntries(
      otherKeys.map((k) => [k, { currentTier: 400 as const, status: "current" as const, graduatedAt: "2026-05-25T00:00:00.000Z", lastChangeReason: "graduated" as const }]),
    );

    await updateProfile(
      (current) => ({
        ...current,
        config: seedConfig(),
        abilities: {
          ...otherAbilities,
          [PLACEHOLDER_KEY]: {
            value: 180,
            itemsSeen: 6,
            lastAssessedAt: "2026-05-01T00:00:00.000Z",
            lastItemIds: ["task-decomposition-100-mc-a"],
          },
          [TOOL_KEY]: {
            value: 420,
            itemsSeen: 20,
            lastAssessedAt: "2026-05-20T00:00:00.000Z",
            lastItemIds: [],
          },
        },
        graduations: {
          ...otherGraduations,
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
    // Suggestions surface some not-started topics (capped at MAX_SUGGESTIONS=3).
    // With 28 topics all not_started, task-decomposition may not land in the top 3
    // alphabetically — just verify suggestions is non-empty and all keys are in scope.
    expect(result.suggestions.length).toBeGreaterThan(0);
    const topicKeys = result.topics.map((t) => t.key);
    for (const s of result.suggestions) {
      expect(topicKeys).toContain(s.key);
    }
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
    expect(result.topics.map((t) => t.id)).toContain(PLACEHOLDER_TOPIC_ID);

    const placeholder = result.topics.find((t) => t.id === PLACEHOLDER_TOPIC_ID);
    expect(placeholder?.key).toBe(PLACEHOLDER_KEY);
    expect(placeholder?.class).toBe("general");
    // task-decomposition ships tiers 100–500
    expect(placeholder?.tiers).toEqual([100, 200, 300, 400, 500]);
    expect(placeholder?.itemCount).toBeGreaterThanOrEqual(1);

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
    expect(general.topics.map((t) => t.id)).toContain(PLACEHOLDER_TOPIC_ID);

    // Tool-scoped topics exist in the assembled catalog (claude-code, codex, kiro-cli, kiro-ide).
    const toolOnly = (await listTopics({ class: "tool" })) as ListTopicsResult;
    expect(toolOnly.topics.length).toBeGreaterThan(0);
  });

  it("get_guidance with a key returns guidance + a next step for that topic", async () => {
    await seedMixedProfile();
    const getGuidance = makeGetGuidanceTool(home).handler;

    const result = (await getGuidance({ key: PLACEHOLDER_KEY })) as GetGuidanceResult;

    expect(result.key).toBe(PLACEHOLDER_KEY);
    expect(result.title).toBe("Task Decomposition & Planning");
    expect(result.currentTier).toBe(100);
    // Guidance text is pulled from the topic's authored item content.
    expect(result.guidance.length).toBeGreaterThan(0);
    // Tier-100 guidance for task-decomposition explains decomposition purpose.
    expect(result.guidance.toLowerCase()).toContain("decomposition");
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
