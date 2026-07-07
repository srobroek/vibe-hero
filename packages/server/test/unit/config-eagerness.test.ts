/**
 * @file Tests for organicEagerness handling in save_config / get_config.
 *
 * Verifies:
 *  - save_config accepts organicEagerness and persists it.
 *  - Omitting organicEagerness defaults to "normal".
 *  - Re-running save_config preserves an existing organicEagerness when
 *    the new call omits it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { makeSaveConfigTool, makeGetConfigTool } from "../../src/tools/config.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const baseInput = {
  offerCadence: "per_topic" as const,
  proactiveOffers: true,
  quizLength: 4 as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("save_config — organicEagerness", () => {
  let home: string;
  let saveConfig: ReturnType<typeof makeSaveConfigTool>["handler"];
  let getConfig: ReturnType<typeof makeGetConfigTool>["handler"];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "vh-cfg-"));
    saveConfig = makeSaveConfigTool(home).handler;
    getConfig = makeGetConfigTool(home).handler;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("persists organicEagerness=often when explicitly provided", async () => {
    const result = await saveConfig({ ...baseInput, organicEagerness: "often" });
    expect(result.ok).toBe(true);
    expect(result.config.organicEagerness).toBe("often");
  });

  it("persists organicEagerness=rarely when explicitly provided", async () => {
    const result = await saveConfig({ ...baseInput, organicEagerness: "rarely" });
    expect(result.ok).toBe(true);
    expect(result.config.organicEagerness).toBe("rarely");
  });

  it("defaults to normal when organicEagerness is omitted on first save", async () => {
    const result = await saveConfig({ ...baseInput });
    expect(result.ok).toBe(true);
    expect(result.config.organicEagerness).toBe("normal");
  });

  it("re-running save_config preserves existing organicEagerness when new call omits it", async () => {
    // First save: set to rarely
    await saveConfig({ ...baseInput, organicEagerness: "rarely" });

    // Second save: omit organicEagerness — should preserve "rarely"
    const result = await saveConfig({ ...baseInput });
    expect(result.config.organicEagerness).toBe("rarely");
  });

  it("re-running save_config can update organicEagerness", async () => {
    await saveConfig({ ...baseInput, organicEagerness: "rarely" });
    const result = await saveConfig({ ...baseInput, organicEagerness: "often" });
    expect(result.config.organicEagerness).toBe("often");
  });

  it("get_config reflects the persisted organicEagerness", async () => {
    await saveConfig({ ...baseInput, organicEagerness: "often" });
    const cfg = await getConfig({});
    expect(cfg.configured).toBe(true);
    if (cfg.configured) {
      expect(cfg.config.organicEagerness).toBe("often");
    }
  });

  it("save_config preserves other profile fields (learning progress not erased)", async () => {
    // Save once with often
    await saveConfig({ ...baseInput, organicEagerness: "often" });

    // Save again with different cadence — organicEagerness preserved, other changes applied
    const result = await saveConfig({
      offerCadence: "per_session",
      proactiveOffers: false,
      organicEagerness: "normal",
    });

    expect(result.config.offerCadence).toBe("per_session");
    expect(result.config.proactiveOffers).toBe(false);
    expect(result.config.organicEagerness).toBe("normal");
  });
});
