/**
 * @file US-0 first-run setup integration test (T024).
 *
 * Proves the quickstart V0 flow end-to-end against a real temp profile home
 * (no mocks), driving the actual gate wrapper and the real `save_config` /
 * `get_config` handlers:
 *
 *   1. Empty home → a GATED tool (`get_status` placeholder) returns
 *      SETUP_REQUIRED (FR-032).
 *   2. `save_config` with a valid config returns `{ ok: true, config }`.
 *   3. The gated tool now runs (gate cleared).
 *   4. `get_config` reflects `configured: true` with the saved values.
 *   5. Re-config: seed learning progress, call `save_config` again with new
 *      prefs → config updates AND the seeded progress is preserved (FR-033).
 *
 * Each test uses its own `VIBE_HERO_HOME` under `os.tmpdir()`, injected via the
 * store's `dirOverride` seam (both the gate and the config-tool factories take
 * it), so tests stay isolated from process env and from each other.
 *
 * Source of truth: specs/001-vibe-hero-mvp/quickstart.md (V0), spec.md
 * FR-031 / FR-032 / FR-033.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SETUP_REQUIRED_RESULT, withSetupGate, withGates } from "../../src/tools/gate.js";
import { makeGetConfigTool, makeSaveConfigTool } from "../../src/tools/config.js";
import { makeGetStatusTool } from "../../src/tools/status.js";
import { loadProfile, updateProfile } from "../../src/profile/store.js";
import { setDetectedTool, setRawClientName } from "../../src/detection.js";
import type { AbilityEstimate } from "../../src/schemas/profile.js";
import type { SaveConfigInput } from "../../src/schemas/tools.js";

/** A valid initial setup config (the quickstart "valid config"). */
const initialConfig: SaveConfigInput = {
  toolsLearning: ["claude-code"],
  offerCadence: "per_session",
  proactiveOffers: true,
  quizLength: 4,
};

/** A seeded ability estimate, standing in for accumulated learning progress. */
const seededAbility: AbilityEstimate = {
  value: 357,
  itemsSeen: 9,
  lastAssessedAt: "2026-01-15T10:00:00.000Z",
  lastItemIds: ["i-1", "i-2"],
  // `dwell` is the consecutive promotion-crossing counter (T043/T046); it
  // defaults to 0 on load, so spell it out here for round-trip equality.
  dwell: 0,
};

describe("US-0 first-run setup (T024 / quickstart V0)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-us0-"));
    // Reset detection state so tests are isolated from any module-level
    // detection left by other tests. After save_config with toolsLearning set,
    // the tool gate resolves via config rather than detection.
    setDetectedTool(undefined);
    setRawClientName(undefined);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("walks the full V0 flow: gate → save_config → cleared → get_config", async () => {
    // dir-scoped real handlers + a gated placeholder bound to the temp home.
    const saveConfig = withSetupGate(
      "save_config",
      makeSaveConfigTool(home).handler,
      home,
    );
    const getConfig = withSetupGate(
      "get_config",
      makeGetConfigTool(home).handler,
      home,
    );
    // Use a dir-scoped get_status instance so the handler reads the test's temp
    // profile (not the global ~/.vibe-hero). withGates exercises both gates; after
    // save_config sets toolsLearning: ["claude-code"], the tool gate resolves via
    // config even with no MCP detection (test environment has no handshake).
    const getStatus = withGates("get_status", makeGetStatusTool(home).handler, home);

    // 1. Empty home → the gated tool is blocked by the setup gate (FR-032).
    const beforeSetup = await getStatus({});
    expect(beforeSetup).toEqual(SETUP_REQUIRED_RESULT);
    expect(beforeSetup["status"]).toBe("SETUP_REQUIRED");

    // get_config (exempt) confirms the gate is engaged.
    expect(await getConfig({})).toEqual({ configured: false });

    // 2. save_config with a valid config clears the gate.
    const saved = await saveConfig(initialConfig);
    expect(saved["ok"]).toBe(true);
    expect(saved["config"]).toMatchObject({
      toolsLearning: ["claude-code"],
      offerCadence: "per_session",
      proactiveOffers: true,
      quizLength: 4,
    });
    // Tool-layer clock stamps both timestamps on first save.
    const savedConfig = saved["config"] as Record<string, unknown>;
    expect(typeof savedConfig["createdAt"]).toBe("string");
    expect(typeof savedConfig["updatedAt"]).toBe("string");

    // 3. The gated tool now runs (gate cleared → the real get_status handler
    //    executes and reports standing for the configured tool).
    const afterSetup = await getStatus({});
    expect(afterSetup["status"]).toBeUndefined();
    expect(afterSetup["tool"]).toBe("claude-code");
    expect(Array.isArray(afterSetup["topics"])).toBe(true);

    // 4. get_config reflects configured:true with the saved values.
    const reported = await getConfig({});
    expect(reported["configured"]).toBe(true);
    expect(reported["config"]).toMatchObject({
      toolsLearning: ["claude-code"],
      offerCadence: "per_session",
      proactiveOffers: true,
      quizLength: 4,
    });
  });

  it("applies the quizLength default (4) when omitted from save_config", async () => {
    const saveConfig = makeSaveConfigTool(home).handler;
    const { proactiveOffers, offerCadence, toolsLearning } = initialConfig;

    const saved = await saveConfig({ proactiveOffers, offerCadence, toolsLearning });

    expect((saved["config"] as Record<string, unknown>)["quizLength"]).toBe(4);
  });

  it("re-runs setup to update prefs WITHOUT losing learning progress (FR-033)", async () => {
    const saveConfig = makeSaveConfigTool(home).handler;

    // First setup.
    await saveConfig(initialConfig);
    const firstConfig = (await loadProfile(home)).config;
    expect(firstConfig).toBeDefined();
    const createdAt = firstConfig!.createdAt;

    // Seed learning progress directly into the profile (an ability estimate,
    // a graduation, a review entry, and a completed quiz record) — exactly the
    // state a re-config must preserve.
    await updateProfile(
      (current) => ({
        ...current,
        abilities: { "general|planning": seededAbility },
        graduations: {
          "general|planning": {
            currentTier: 200,
            status: "current",
            graduatedAt: "2026-01-15T10:00:00.000Z",
            lastChangeReason: "graduated",
          },
        },
        reviewSchedule: [
          { key: "general|planning", dueAt: "2026-02-01T00:00:00.000Z", reason: "spaced" },
        ],
        quizHistory: [
          {
            id: "quiz-1",
            key: "general|planning",
            startedAt: "2026-01-15T09:50:00.000Z",
            completedAt: "2026-01-15T10:00:00.000Z",
            items: [],
            abilityBefore: 300,
            abilityAfter: 357,
          },
        ],
      }),
      home,
    );

    // Re-run setup with NEW preferences.
    const updatedInput: SaveConfigInput = {
      toolsLearning: ["claude-code", "codex"],
      offerCadence: "off",
      proactiveOffers: false,
      quizLength: 5,
    };
    const reconfigured = await saveConfig(updatedInput);

    // Config reflects the new prefs.
    expect(reconfigured["config"]).toMatchObject({
      toolsLearning: ["claude-code", "codex"],
      offerCadence: "off",
      proactiveOffers: false,
      quizLength: 5,
    });

    const after = await loadProfile(home);

    // createdAt is preserved across re-config; updatedAt is (re)stamped.
    expect(after.config?.createdAt).toBe(createdAt);
    expect(after.config?.updatedAt).toBeDefined();

    // FR-033: every piece of seeded learning progress survives the re-config.
    expect(after.abilities["general|planning"]).toEqual(seededAbility);
    expect(after.graduations["general|planning"]?.currentTier).toBe(200);
    expect(after.reviewSchedule).toHaveLength(1);
    expect(after.reviewSchedule[0]?.key).toBe("general|planning");
    expect(after.quizHistory).toHaveLength(1);
    expect(after.quizHistory[0]?.id).toBe("quiz-1");
    expect(after.quizHistory[0]?.abilityAfter).toBe(357);
  });
});
