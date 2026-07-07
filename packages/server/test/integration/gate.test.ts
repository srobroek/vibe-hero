/**
 * @file Integration tests for the setup gate + tool gate + tool registry (T020 / T021).
 *
 * Proves both gates end-to-end against a real temp profile directory (no mocks),
 * exercising the actual handlers from {@link TOOL_REGISTRY} through
 * {@link withSetupGate}, {@link withToolGate}, and {@link withGates}:
 *
 *   1. No config               → gated tool returns SETUP_REQUIRED.
 *   2. No config               → exempt tool (get_config / save_config) still runs.
 *   3. Config set, no tool     → gated tool returns UNSUPPORTED_TOOL (unknown host,
 *                                no toolsLearning configured).
 *   4. Config set, tool set    → gated tool runs its handler normally.
 *   5. Config set, toolsLearning configured, no host detection
 *                              → gated tool runs (toolsLearning overrides unknown host).
 *   6. Gate precedence         → SETUP_REQUIRED fires before UNSUPPORTED_TOOL when
 *                                both conditions hold.
 *
 * Each test uses its own `VIBE_HERO_HOME` under `os.tmpdir()`, passed via the
 * store's injectable `dirOverride` seam, so tests stay isolated from process env
 * and from each other.
 *
 * Detection state (getDetectedTool / getRawClientName) is reset per test to
 * avoid cross-test leakage.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXEMPT_TOOLS,
  SETUP_REQUIRED_RESULT,
  makeUnsupportedToolResult,
  SUPPORTED_TOOL_IDS,
  withSetupGate,
  withToolGate,
  withGates,
} from "../../src/tools/gate.js";
import { TOOL_REGISTRY } from "../../src/tools/placeholders.js";
import { makeGetConfigTool, makeSaveConfigTool } from "../../src/tools/config.js";
import { makeGetStatusTool } from "../../src/tools/status.js";
import { saveProfile } from "../../src/profile/store.js";
import { emptyProfile, type Profile } from "../../src/schemas/profile.js";
import {
  setDetectedTool,
  setRawClientName,
} from "../../src/detection.js";

/** Look up a tool module from the registry by name (fails the test if absent). */
const toolByName = (name: string) => {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  expect(tool, `tool "${name}" should be registered`).toBeDefined();
  return tool!;
};

/** Build a configured profile (clears the setup gate) from an empty one. */
const configuredProfile = (toolsLearning?: string[]): Profile => {
  const base = emptyProfile();
  const now = base.createdAt;
  return {
    ...base,
    config: {
      toolsLearning: (toolsLearning ?? ["claude-code"]) as import("../../src/schemas/common.js").ToolId[],
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
    setDetectedTool(undefined);
    setRawClientName(undefined);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    setDetectedTool(undefined);
    setRawClientName(undefined);
  });

  it("registers exactly the 12 contract tools", () => {
    expect(TOOL_REGISTRY).toHaveLength(12);
    expect(TOOL_REGISTRY.map((t) => t.name)).toEqual([
      "get_status",
      "list_topics",
      "get_guidance",
      "start_quiz",
      "submit_answer",
      "submit_answers",
      "save_config",
      "get_config",
      "record_observation",
      "get_offer",
      "record_offer_response",
      "get_dashboard",
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

  it("runs a non-exempt tool once config is present (with detection set)", async () => {
    await saveProfile(configuredProfile(), home);
    setDetectedTool("claude-code");

    // get_status is the real US-2 handler now; build a dir-scoped instance so it
    // reads the test's temp home rather than env/~ (the registry default).
    const gated = withSetupGate("get_status", makeGetStatusTool(home).handler, home);

    const result = await gated({});

    // Gate cleared → the real handler runs and reports standing for the
    // configured tool (no SETUP_REQUIRED / UNSUPPORTED_TOOL sentinel).
    expect(result["status"]).toBeUndefined();
    expect(result["tool"]).toBe("claude-code");
    expect(Array.isArray(result["topics"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool gate — UNSUPPORTED_TOOL sentinel
// ---------------------------------------------------------------------------

describe("tool gate — UNSUPPORTED_TOOL for unknown hosts (FR-031)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-toolgate-"));
    setDetectedTool(undefined);
    setRawClientName(undefined);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    setDetectedTool(undefined);
    setRawClientName(undefined);
  });

  it("returns UNSUPPORTED_TOOL when host is unknown and no toolsLearning configured", async () => {
    // Config present (setup gate cleared), but no detection and no toolsLearning.
    await saveProfile(configuredProfile([]), home);
    // Simulate Cursor connecting: raw name stored, no ToolId resolved.
    setRawClientName("Cursor");
    setDetectedTool(undefined);

    const tool = toolByName("get_status");
    const gated = withToolGate(tool.name, tool.handler, home);

    const result = await gated({});

    expect(result["status"]).toBe("UNSUPPORTED_TOOL");
    expect(result["detectedName"]).toBe("Cursor");
    expect(result["message"]).toMatch(/Cursor/);
    expect(result["message"]).toMatch(/vibe-hero does not support/);
    expect(result["supported"]).toEqual(SUPPORTED_TOOL_IDS);
  });

  it("includes the raw client name in UNSUPPORTED_TOOL for Windsurf", async () => {
    await saveProfile(configuredProfile([]), home);
    setRawClientName("Windsurf");
    setDetectedTool(undefined);

    const tool = toolByName("get_status");
    const gated = withToolGate(tool.name, tool.handler, home);
    const result = await gated({});

    expect(result["status"]).toBe("UNSUPPORTED_TOOL");
    expect(result["detectedName"]).toBe("Windsurf");
    expect(result["message"]).toMatch(/Windsurf/);
  });

  it("includes the raw client name in UNSUPPORTED_TOOL for an empty name", async () => {
    await saveProfile(configuredProfile([]), home);
    setRawClientName("");
    setDetectedTool(undefined);

    const tool = toolByName("get_status");
    const gated = withToolGate(tool.name, tool.handler, home);
    const result = await gated({});

    expect(result["status"]).toBe("UNSUPPORTED_TOOL");
    expect(result["detectedName"]).toBe("");
    // Falls back to "(unknown)" in the human message when name is empty.
    expect(result["message"]).toMatch(/unknown/);
  });

  it("allows a gated tool when detection resolves to a supported tool", async () => {
    await saveProfile(configuredProfile([]), home);
    setRawClientName("Claude Code");
    setDetectedTool("claude-code");

    const gated = withToolGate("get_status", makeGetStatusTool(home).handler, home);
    const result = await gated({});

    // Tool gate passed — normal handler result.
    expect(result["status"]).toBeUndefined();
    expect(result["tool"]).toBe("claude-code");
  });

  it("allows a gated tool when toolsLearning provides a tool (no detection)", async () => {
    // Unknown host but user explicitly configured toolsLearning.
    await saveProfile(configuredProfile(["kiro-cli"]), home);
    setRawClientName("Cursor");
    setDetectedTool(undefined);

    const gated = withToolGate("get_status", makeGetStatusTool(home).handler, home);
    const result = await gated({});

    // toolsLearning[0] = "kiro-cli" satisfies the tool gate.
    expect(result["status"]).toBeUndefined();
    expect(result["tool"]).toBe("kiro-cli");
  });

  it("exempt tools bypass the tool gate on unknown hosts", async () => {
    setRawClientName("Cursor");
    setDetectedTool(undefined);

    const gated = withToolGate("get_config", makeGetConfigTool(home).handler, home);
    const result = await gated({});

    // Exempt: not blocked by tool gate.
    expect(result["status"]).toBeUndefined();
    expect(result["configured"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withGates — composed gate (setup gate first, then tool gate)
// ---------------------------------------------------------------------------

describe("withGates — gate precedence and composition", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-withgates-"));
    setDetectedTool(undefined);
    setRawClientName(undefined);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    setDetectedTool(undefined);
    setRawClientName(undefined);
  });

  it("SETUP_REQUIRED fires before UNSUPPORTED_TOOL when both conditions hold", async () => {
    // No config AND unknown host: setup gate fires first.
    setRawClientName("Cursor");
    setDetectedTool(undefined);

    const tool = toolByName("get_status");
    const gated = withGates(tool.name, tool.handler, home);
    const result = await gated({});

    // Must be SETUP_REQUIRED, not UNSUPPORTED_TOOL.
    expect(result["status"]).toBe("SETUP_REQUIRED");
  });

  it("UNSUPPORTED_TOOL fires after setup passes when host is unknown", async () => {
    // Config present (setup gate cleared) but unknown host, no toolsLearning.
    await saveProfile(configuredProfile([]), home);
    setRawClientName("Windsurf");
    setDetectedTool(undefined);

    const tool = toolByName("get_status");
    const gated = withGates(tool.name, tool.handler, home);
    const result = await gated({});

    expect(result["status"]).toBe("UNSUPPORTED_TOOL");
    expect(result["detectedName"]).toBe("Windsurf");
  });

  it("handler runs when both config present and supported host detected", async () => {
    await saveProfile(configuredProfile(), home);
    setRawClientName("claude-code");
    setDetectedTool("claude-code");

    const gated = withGates("get_status", makeGetStatusTool(home).handler, home);
    const result = await gated({});

    expect(result["status"]).toBeUndefined();
    expect(result["tool"]).toBe("claude-code");
  });

  it("exempt tools bypass withGates entirely (no config, unknown host)", async () => {
    setRawClientName("Cline");
    setDetectedTool(undefined);

    const gated = withGates("get_config", makeGetConfigTool(home).handler, home);
    const result = await gated({});

    expect(result["configured"]).toBe(false);
    expect(result["status"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeUnsupportedToolResult — sentinel shape
// ---------------------------------------------------------------------------

describe("makeUnsupportedToolResult — sentinel shape", () => {
  it("includes the raw name, a human message, and the supported list", () => {
    const result = makeUnsupportedToolResult("Cursor");
    expect(result.status).toBe("UNSUPPORTED_TOOL");
    expect(result.detectedName).toBe("Cursor");
    expect(result.message).toContain("Cursor");
    expect(result.message).toContain("vibe-hero does not support");
    expect(result.supported).toEqual(SUPPORTED_TOOL_IDS);
  });

  it("uses '(unknown)' in the message when raw name is empty", () => {
    const result = makeUnsupportedToolResult("");
    expect(result.detectedName).toBe("");
    expect(result.message).toContain("(unknown)");
  });

  it("supported list contains exactly the four enumerated tools", () => {
    const result = makeUnsupportedToolResult("Whatever");
    expect(result.supported).toEqual(["claude-code", "codex", "kiro-cli", "kiro-ide"]);
  });
});
