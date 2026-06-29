/**
 * @file Integration tests for the setup gate + tool registry (T020 / T021).
 *
 * Proves the first-run setup gate (FR-032) end-to-end against a real temp
 * profile directory (no mocks), exercising the actual placeholder handlers from
 * {@link TOOL_REGISTRY} through {@link withSetupGate}:
 *
 *   1. No config  → a gated tool returns the SETUP_REQUIRED sentinel.
 *   2. No config  → an exempt tool (`get_config`/`save_config`) still runs.
 *   3. Config set → a gated tool runs its (placeholder) handler.
 *
 * Each test uses its own `VIBE_HERO_HOME` under `os.tmpdir()`, passed via the
 * store's injectable `dirOverride` seam, so tests stay isolated from process env
 * and from each other.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXEMPT_TOOLS,
  SETUP_REQUIRED_RESULT,
  withSetupGate,
} from "../../src/tools/gate.js";
import { TOOL_REGISTRY } from "../../src/tools/placeholders.js";
import { makeGetConfigTool, makeSaveConfigTool } from "../../src/tools/config.js";
import { saveProfile } from "../../src/profile/store.js";
import { emptyProfile, type Profile } from "../../src/schemas/profile.js";

/** Look up a tool module from the registry by name (fails the test if absent). */
const toolByName = (name: string) => {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  expect(tool, `tool "${name}" should be registered`).toBeDefined();
  return tool!;
};

/** Build a configured profile (clears the gate) from an empty one. */
const configuredProfile = (): Profile => {
  const base = emptyProfile();
  const now = base.createdAt;
  return {
    ...base,
    config: {
      toolsLearning: ["claude-code"],
      offerCadence: "per_session",
      proactiveOffers: true,
      quizLength: 4,
      createdAt: now,
      updatedAt: now,
    },
  };
};

describe("setup gate (T021)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-gate-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("registers exactly the 10 contract tools", () => {
    expect(TOOL_REGISTRY).toHaveLength(10);
    expect(TOOL_REGISTRY.map((t) => t.name)).toEqual([
      "get_status",
      "list_topics",
      "get_guidance",
      "start_quiz",
      "submit_answer",
      "save_config",
      "get_config",
      "record_observation",
      "get_offer",
      "record_offer_response",
    ]);
  });

  it("exempts only get_config and save_config", () => {
    expect([...EXEMPT_TOOLS].sort()).toEqual(["get_config", "save_config"]);
  });

  it("gates a non-exempt tool when no config exists (SETUP_REQUIRED)", async () => {
    const tool = toolByName("get_status");
    const gated = withSetupGate(tool.name, tool.handler, home);

    const result = await gated({});

    expect(result).toEqual(SETUP_REQUIRED_RESULT);
    expect(result["status"]).toBe("SETUP_REQUIRED");
    expect(result["setupSkill"]).toBe("vibe-hero-setup");
  });

  it("runs an exempt tool even when no config exists", async () => {
    // get_config is the real US-0 handler now; build a dir-scoped instance so
    // it reads the test's temp home (the registry default reads env/~).
    const gated = withSetupGate("get_config", makeGetConfigTool(home).handler, home);

    const result = await gated({});

    // Not gated, and not the SETUP_REQUIRED sentinel: it reports gate state.
    expect(result["status"]).toBeUndefined();
    expect(result["configured"]).toBe(false);
  });

  it("runs the other exempt tool (save_config) when no config exists", async () => {
    const gated = withSetupGate("save_config", makeSaveConfigTool(home).handler, home);

    const result = await gated({
      toolsLearning: ["claude-code"],
      offerCadence: "off",
      proactiveOffers: false,
    });

    // Not gated: the real handler persists config and clears the gate.
    expect(result["ok"]).toBe(true);
    expect(result["config"]).toMatchObject({ offerCadence: "off" });
  });

  it("runs a non-exempt tool once config is present", async () => {
    await saveProfile(configuredProfile(), home);

    const tool = toolByName("get_status");
    const gated = withSetupGate(tool.name, tool.handler, home);

    const result = await gated({});

    // Gate cleared → placeholder handler runs.
    expect(result["status"]).toBe("NOT_IMPLEMENTED");
    expect(result["tool"]).toBe("get_status");
  });
});
