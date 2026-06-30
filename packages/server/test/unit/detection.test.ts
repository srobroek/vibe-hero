/**
 * @file Unit tests for client tool auto-detection and the unsupported-tool gate.
 *
 * Covers:
 *  - {@link detectToolFromClientName}: pure mapping from MCP clientInfo.name → ToolId
 *  - Module-level state: {@link getDetectedTool} / {@link setDetectedTool},
 *    {@link getRawClientName} / {@link setRawClientName}
 *  - {@link withToolGate}: unknown host (no detection + no toolsLearning) →
 *    UNSUPPORTED_TOOL sentinel; known host or configured toolsLearning → handler runs
 *  - {@link makeUnsupportedToolResult}: correct shape and message
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-031), src/detection.ts,
 * src/tools/gate.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectToolFromClientName,
  getDetectedTool,
  setDetectedTool,
  getRawClientName,
  setRawClientName,
} from "../../src/detection.js";
import {
  withToolGate,
  makeUnsupportedToolResult,
  SUPPORTED_TOOL_IDS,
} from "../../src/tools/gate.js";
import { saveProfile } from "../../src/profile/store.js";
import { emptyProfile } from "../../src/schemas/profile.js";
import type { Profile } from "../../src/schemas/profile.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a configured profile with an optional toolsLearning override. */
const configuredProfile = (toolsLearning: Profile["config"] extends { toolsLearning: infer T } | undefined ? T : never = [] as never): Profile => {
  const base = emptyProfile();
  const now = base.createdAt;
  return {
    ...base,
    config: {
      toolsLearning,
      offerCadence: "per_session" as const,
      proactiveOffers: true,
      quizLength: 4,
      createdAt: now,
      updatedAt: now,
    },
  };
};

/** A trivially passing tool handler (the gate should call this when allowed). */
const passThroughHandler = async (_args: unknown): Promise<Record<string, unknown>> =>
  ({ ok: true });

// ---------------------------------------------------------------------------
// Reset module state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setDetectedTool(undefined);
  setRawClientName(undefined);
});

// ---------------------------------------------------------------------------
// detectToolFromClientName — known mappings
// ---------------------------------------------------------------------------

describe("detectToolFromClientName — claude-code", () => {
  it('maps "claude-code" → "claude-code"', () => {
    expect(detectToolFromClientName("claude-code")).toBe("claude-code");
  });

  it('maps "Claude Code" → "claude-code" (case-insensitive)', () => {
    expect(detectToolFromClientName("Claude Code")).toBe("claude-code");
  });

  it('maps "claude" → "claude-code" (substring match)', () => {
    expect(detectToolFromClientName("claude")).toBe("claude-code");
  });
});

describe("detectToolFromClientName — codex", () => {
  it('maps "codex" → "codex"', () => {
    expect(detectToolFromClientName("codex")).toBe("codex");
  });

  it('maps "Codex CLI" → "codex" (case-insensitive substring)', () => {
    expect(detectToolFromClientName("Codex CLI")).toBe("codex");
  });
});

describe("detectToolFromClientName — kiro variants", () => {
  it('maps "kiro" → "kiro-cli" (no "ide" suffix)', () => {
    expect(detectToolFromClientName("kiro")).toBe("kiro-cli");
  });

  it('maps "kiro-cli" → "kiro-cli"', () => {
    expect(detectToolFromClientName("kiro-cli")).toBe("kiro-cli");
  });

  it('maps "Kiro IDE" → "kiro-ide" (contains "ide")', () => {
    expect(detectToolFromClientName("Kiro IDE")).toBe("kiro-ide");
  });

  it('maps "kiro ide" → "kiro-ide" (lowercase, contains "ide")', () => {
    expect(detectToolFromClientName("kiro ide")).toBe("kiro-ide");
  });
});

// ---------------------------------------------------------------------------
// detectToolFromClientName — unknown / unmatched hosts → undefined
// ---------------------------------------------------------------------------

describe("detectToolFromClientName — unknown hosts return undefined", () => {
  it.each([
    "Cursor",
    "Windsurf",
    "Cline",
    "Visual Studio Code",
  ])('"%s" → undefined', (name) => {
    expect(detectToolFromClientName(name)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectToolFromClientName — edge cases
// ---------------------------------------------------------------------------

describe("detectToolFromClientName — edge cases", () => {
  it('empty string "" → undefined', () => {
    expect(detectToolFromClientName("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getDetectedTool / setDetectedTool — module state
// ---------------------------------------------------------------------------

describe("getDetectedTool / setDetectedTool", () => {
  it("returns undefined before any setDetectedTool call", () => {
    expect(getDetectedTool()).toBeUndefined();
  });

  it("returns the value set by setDetectedTool", () => {
    setDetectedTool("codex");
    expect(getDetectedTool()).toBe("codex");
  });

  it("clears the state when set to undefined", () => {
    setDetectedTool("claude-code");
    setDetectedTool(undefined);
    expect(getDetectedTool()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getRawClientName / setRawClientName — raw name state
// ---------------------------------------------------------------------------

describe("getRawClientName / setRawClientName", () => {
  it("returns undefined before any setRawClientName call", () => {
    expect(getRawClientName()).toBeUndefined();
  });

  it("returns the value set by setRawClientName", () => {
    setRawClientName("Cursor");
    expect(getRawClientName()).toBe("Cursor");
  });

  it("clears the state when set to undefined", () => {
    setRawClientName("Windsurf");
    setRawClientName(undefined);
    expect(getRawClientName()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeUnsupportedToolResult — sentinel shape
// ---------------------------------------------------------------------------

describe("makeUnsupportedToolResult", () => {
  it("returns status UNSUPPORTED_TOOL", () => {
    const result = makeUnsupportedToolResult("Cursor");
    expect(result.status).toBe("UNSUPPORTED_TOOL");
  });

  it("surfaces the raw detected name in detectedName and message", () => {
    const result = makeUnsupportedToolResult("Windsurf");
    expect(result.detectedName).toBe("Windsurf");
    expect(result.message).toContain("Windsurf");
  });

  it("lists all supported tools in the message", () => {
    const result = makeUnsupportedToolResult("Cline");
    expect(result.message).toContain("Claude Code");
    expect(result.message).toContain("Codex");
    expect(result.message).toContain("Kiro CLI");
    expect(result.message).toContain("Kiro IDE");
  });

  it("includes supported tool IDs in the supported array", () => {
    const result = makeUnsupportedToolResult("Visual Studio Code");
    expect(result.supported).toEqual(expect.arrayContaining(SUPPORTED_TOOL_IDS as string[]));
  });

  it('uses "(unknown)" in the message when rawName is empty', () => {
    const result = makeUnsupportedToolResult("");
    expect(result.message).toContain("(unknown)");
    expect(result.detectedName).toBe("");
  });
});

// ---------------------------------------------------------------------------
// withToolGate — unknown host → UNSUPPORTED_TOOL (no fall-through to claude-code)
// ---------------------------------------------------------------------------

describe("withToolGate — unsupported host", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-tool-gate-"));
    // Write a configured profile with empty toolsLearning so setup gate is cleared
    // but no explicit tool is configured (the tool gate must enforce detection).
    await saveProfile(configuredProfile([]), home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns UNSUPPORTED_TOOL when detection is undefined and no toolsLearning is configured", async () => {
    // detection stays undefined (reset in beforeEach); profile has empty toolsLearning
    const gated = withToolGate("get_status", passThroughHandler, home);
    const result = await gated({});
    expect(result["status"]).toBe("UNSUPPORTED_TOOL");
  });

  it.each(["Cursor", "Windsurf", "Cline", "Visual Studio Code"])(
    '"%s" detected name appears in the UNSUPPORTED_TOOL message',
    async (hostName) => {
      setRawClientName(hostName);
      // detection still undefined — unknown host didn't map to a ToolId
      const gated = withToolGate("get_status", passThroughHandler, home);
      const result = await gated({});
      expect(result["status"]).toBe("UNSUPPORTED_TOOL");
      expect(result["message"] as string).toContain(hostName);
      expect(result["detectedName"]).toBe(hostName);
    },
  );

  it("does NOT fall back to claude-code for an unknown host", async () => {
    setRawClientName("Cursor");
    const gated = withToolGate("get_status", passThroughHandler, home);
    const result = await gated({});
    // Must be UNSUPPORTED_TOOL, not a pass-through to the handler
    expect(result["status"]).toBe("UNSUPPORTED_TOOL");
    expect(result["ok"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// withToolGate — supported host or configured toolsLearning → pass through
// ---------------------------------------------------------------------------

describe("withToolGate — supported scenarios pass through", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vibe-hero-tool-gate-pass-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("passes through when auto-detected tool is set (known host)", async () => {
    setDetectedTool("claude-code");
    // Empty toolsLearning — detection alone is sufficient
    await saveProfile(configuredProfile([]), home);
    const gated = withToolGate("get_status", passThroughHandler, home);
    const result = await gated({});
    expect(result["ok"]).toBe(true);
    expect(result["status"]).toBeUndefined();
  });

  it("passes through when no detection but toolsLearning[0] is configured", async () => {
    // detection stays undefined — configured toolsLearning covers it
    await saveProfile(configuredProfile(["codex"]), home);
    const gated = withToolGate("get_status", passThroughHandler, home);
    const result = await gated({});
    expect(result["ok"]).toBe(true);
    expect(result["status"]).toBeUndefined();
  });

  it("exempt tools bypass the tool gate even with unknown host", async () => {
    setRawClientName("Cursor");
    // detection stays undefined
    await saveProfile(configuredProfile([]), home);
    const gated = withToolGate("get_config", passThroughHandler, home);
    const result = await gated({});
    // Exempt: gate is skipped entirely, handler runs
    expect(result["ok"]).toBe(true);
    expect(result["status"]).toBeUndefined();
  });
});
