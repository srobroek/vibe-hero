/**
 * @file Stop-hook integration test (T015 / FR-011, new npx-throttled design).
 *
 * The new Stop hook:
 *   - Runs silently when stop_hook_active is true (loop guard).
 *   - Runs silently when within the throttle cooldown window.
 *   - Runs silently when offerCadence is "off" in the profile.
 *   - Invokes `npx -y @vibe-hero/server@latest get-offer` to fetch a real offer.
 *   - Emits `additionalContext` ONLY when the offer JSON has a non-empty
 *     `.offer.title` (i.e. a genuine offer exists).
 *   - Emits NOTHING (and exits 0) when get-offer returns a suppressed result.
 *   - ALWAYS exits 0 — advisory only.
 *
 * Tests run against the REAL shell script (no mocks where avoidable). The npx
 * invocation is stubbed with a fake `npx` on PATH that prints canned JSON, so
 * the tests are fast, offline, and deterministic.
 *
 * Source of truth: specs/002-distribution/spec.md (FR-007/FR-011, SC-006),
 * contracts/cli-and-plugin.md.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** repo root = up from packages/server/test/integration. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** The dev-source hook script under test. */
const HOOK = path.join(REPO_ROOT, "hooks", "claude-code", "stop-offer.sh");

/** The plugin copy that ships at ${CLAUDE_PLUGIN_ROOT}/hooks/claude-code/stop-offer.sh. */
const PLUGIN_HOOK = path.join(
  REPO_ROOT,
  "packages",
  "vibe-hero-plugin",
  "hooks",
  "claude-code",
  "stop-offer.sh",
);

/** Tight budget for the shell script. Bumped slightly because npx stub writes to disk. */
const RUN_TIMEOUT_MS = 15_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the hook with `payload` piped to stdin.
 *
 * @param payload - JSON string piped to stdin.
 * @param extraPath - Prepended to PATH (used to inject fake `npx` / `jq`).
 * @param extraEnv - Additional env vars (e.g. VIBE_HERO_HOME, VIBE_HERO_OFFER_COOLDOWN_SECONDS).
 */
function runHook(
  payload: string,
  extraPath?: string,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (extraPath) env.PATH = `${extraPath}${path.delimiter}${env.PATH ?? ""}`;
    if (extraEnv) Object.assign(env, extraEnv);
    const child = execFile(
      HOOK,
      [],
      { timeout: RUN_TIMEOUT_MS, env, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          reject(err);
          return;
        }
        const code =
          err && typeof (err as { code?: number }).code === "number"
            ? (err as { code: number }).code
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end(payload);
  });
}

/** Create a temporary directory with a fake `npx` that echoes a canned JSON response. */
async function makeFakeNpxDir(offerJson: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vh-fake-npx-"));
  const script = `#!/bin/sh\nprintf '%s\\n' '${offerJson.replace(/'/g, "'\\''")}'\n`;
  const npxPath = path.join(dir, "npx");
  await writeFile(npxPath, script, "utf8");
  await chmod(npxPath, 0o755);
  return dir;
}

/** Create a temp VIBE_HERO_HOME with a profile.json containing the given offerCadence. */
async function makeProfileDir(offerCadence: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "vh-profile-"));
  const profile = JSON.stringify({
    config: {
      offerCadence,
      toolsLearning: ["claude-code"],
      proactiveOffers: true,
      quizLength: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    abilities: {},
    graduations: {},
    quizHistory: [],
    abilitySnapshots: [],
  });
  await writeFile(path.join(dir, "profile.json"), profile, "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Static contract checks
// ---------------------------------------------------------------------------

describe("Stop hook — static contract", () => {
  let scriptBody = "";

  beforeAll(async () => {
    scriptBody = await readFile(HOOK, "utf8");
  });

  it("dev-source and plugin copy are byte-identical", async () => {
    expect(existsSync(PLUGIN_HOOK), "plugin must ship the hook script").toBe(true);
    const dev = await readFile(HOOK, "utf8");
    const plugin = await readFile(PLUGIN_HOOK, "utf8");
    expect(plugin).toBe(dev);
  });

  it("invokes npx (not a local node/dist artifact)", () => {
    // Strip comment lines — they may mention old approaches for documentation.
    const code = scriptBody
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // The new hook IS allowed to invoke npx.
    expect(code).toMatch(/\bnpx\s/);
    // But must NOT invoke a local build artifact or raw node path.
    expect(code).not.toMatch(/dist\/cli/);
    expect(code).not.toMatch(/VIBE_HERO_SERVER_DIST/);
  });

  it("uses @vibe-hero/server@latest get-offer as the npx target", () => {
    expect(scriptBody).toMatch(/@vibe-hero\/server@latest/);
    expect(scriptBody).toMatch(/get-offer/);
  });

  it("respects VIBE_HERO_OFFER_COOLDOWN_SECONDS env var", () => {
    expect(scriptBody).toMatch(/VIBE_HERO_OFFER_COOLDOWN_SECONDS/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural tests
// ---------------------------------------------------------------------------

describe("Stop hook — loop guard", () => {
  it("(c) stop_hook_active:true emits nothing, exit 0", async () => {
    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: "sg1", stop_hook_active: true }),
      undefined,
      { VIBE_HERO_OFFER_COOLDOWN_SECONDS: "0" },
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });
});

describe("Stop hook — throttle", () => {
  let tsFile: string;
  const sessionId = "throttle-test-session";

  beforeEach(() => {
    tsFile = `/tmp/vibe-hero-offer-${sessionId}.ts`;
  });

  afterEach(async () => {
    // Clean up the timestamp file.
    try {
      await rm(tsFile, { force: true });
    } catch {
      // ignore
    }
  });

  it("is silent within cooldown window (elapsed < COOLDOWN_SECONDS)", async () => {
    // Write a timestamp that is "just now" so elapsed = 0.
    const nowEpoch = Math.floor(Date.now() / 1000);
    await writeFile(tsFile, String(nowEpoch), "utf8");

    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionId, stop_hook_active: false }),
      undefined,
      { VIBE_HERO_OFFER_COOLDOWN_SECONDS: "9999" },
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("proceeds past throttle when COOLDOWN_SECONDS is 0", async () => {
    // With COOLDOWN=0, any elapsed time >= 0 passes; hook proceeds to npx step.
    // We use a fake npx that returns suppressed so we get silence (not an offer),
    // but the important thing is the hook runs past the throttle check.
    const fakeDir = await makeFakeNpxDir(JSON.stringify({ suppressed: "no_candidate" }));
    try {
      const { code } = await runHook(
        JSON.stringify({ session_id: sessionId, stop_hook_active: false }),
        fakeDir,
        { VIBE_HERO_OFFER_COOLDOWN_SECONDS: "0" },
      );
      expect(code).toBe(0);
      // ts_file should now be written
      expect(existsSync(tsFile)).toBe(true);
    } finally {
      await rm(fakeDir, { recursive: true, force: true });
    }
  });
});

describe("Stop hook — cadence off short-circuit", () => {
  let profileDir: string;
  let tsFile: string;
  const sessionId = "cadence-off-test";

  beforeEach(async () => {
    profileDir = await makeProfileDir("off");
    tsFile = `/tmp/vibe-hero-offer-${sessionId}.ts`;
    // Remove any stale ts file so throttle doesn't fire first.
    try { await rm(tsFile, { force: true }); } catch { /* ignore */ }
  });

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
    try { await rm(tsFile, { force: true }); } catch { /* ignore */ }
  });

  it("exits silently without spawning npx when offerCadence is off", async () => {
    // Shadow npx with a probe to ensure it is NOT invoked.
    const probeDir = await mkdtemp(path.join(tmpdir(), "vh-probe-"));
    const marker = path.join(probeDir, "SPAWNED");
    const probe = `#!/bin/sh\ntouch "${marker}"\nexit 0\n`;
    const npxPath = path.join(probeDir, "npx");
    await writeFile(npxPath, probe, "utf8");
    await chmod(npxPath, 0o755);

    try {
      const { code, stdout } = await runHook(
        JSON.stringify({ session_id: sessionId, stop_hook_active: false }),
        probeDir,
        { VIBE_HERO_HOME: profileDir, VIBE_HERO_OFFER_COOLDOWN_SECONDS: "0" },
      );
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("");
      expect(existsSync(marker), "npx must NOT be invoked when cadence is off").toBe(false);
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
  });
});

describe("Stop hook — offer emission", () => {
  /**
   * Each test uses its own unique session_id to avoid ts_file collisions
   * across parallel or sequential runs.  The ts_file is cleaned up in afterEach.
   */
  const makeSessionId = (suffix: string) => `emit-${suffix}-${Date.now()}`;

  async function runEmitTest(
    sessionId: string,
    offerJson: string,
    overrideEnv?: Record<string, string>,
  ): Promise<{ code: number | null; stdout: string }> {
    const tsFile = `/tmp/vibe-hero-offer-${sessionId}.ts`;
    const fakeDir = await makeFakeNpxDir(offerJson);
    try {
      // Remove any leftover ts_file before running so cooldown doesn't fire.
      try { await rm(tsFile, { force: true }); } catch { /* ignore */ }
      const result = await runHook(
        JSON.stringify({ session_id: sessionId, stop_hook_active: false }),
        fakeDir,
        { VIBE_HERO_OFFER_COOLDOWN_SECONDS: "0", ...overrideEnv },
      );
      return { code: result.code, stdout: result.stdout };
    } finally {
      await rm(fakeDir, { recursive: true, force: true });
      try { await rm(tsFile, { force: true }); } catch { /* ignore */ }
    }
  }

  it("emits additionalContext naming the offer topic when get-offer returns an offer", async () => {
    const sessionId = makeSessionId("offer");
    const offerJson = JSON.stringify({
      offer: {
        key: "general::task-decomposition",
        title: "Task Decomposition",
        prompt: "Ready to test your task decomposition knowledge?",
      },
    });
    const { code, stdout } = await runEmitTest(sessionId, offerJson);
    expect(code).toBe(0);
    expect(stdout.trim()).not.toBe("");
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("Stop");
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("Task Decomposition");
    expect(ctx).toContain("get_offer");
  }, RUN_TIMEOUT_MS);

  it("is silent when get-offer returns suppressed (no offer)", async () => {
    const sessionId = makeSessionId("suppressed");
    const { code, stdout } = await runEmitTest(sessionId, JSON.stringify({ suppressed: "cadence" }));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("is silent when get-offer returns empty JSON (no offer key)", async () => {
    const sessionId = makeSessionId("empty");
    const { code, stdout } = await runEmitTest(sessionId, JSON.stringify({}));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("is silent when npx is not on PATH", async () => {
    const sessionId = makeSessionId("no-npx");
    const tsFile = `/tmp/vibe-hero-offer-${sessionId}.ts`;
    // Shadow npx by putting a dir with no npx FIRST, keeping system dirs for sh.
    const noNpxDir = await mkdtemp(path.join(tmpdir(), "vh-no-npx-"));
    try {
      try { await rm(tsFile, { force: true }); } catch { /* ignore */ }
      const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
      const { code, stdout } = await runHook(
        JSON.stringify({ session_id: sessionId, stop_hook_active: false }),
        noNpxDir,
        {
          PATH: `${noNpxDir}:${systemPath}`,
          VIBE_HERO_OFFER_COOLDOWN_SECONDS: "0",
        },
      );
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(noNpxDir, { recursive: true, force: true });
      try { await rm(tsFile, { force: true }); } catch { /* ignore */ }
    }
  }, RUN_TIMEOUT_MS);
});

describe("Stop hook — always exits 0", () => {
  // With empty or malformed stdin the hook cannot parse a session_id and falls
  // back to "default".  Seed the "default" ts_file to "now" so the throttle
  // fires before any npx spawn (which might hang on a missing network / binary).
  const defaultTsFile = "/tmp/vibe-hero-offer-default.ts";

  beforeEach(async () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    await writeFile(defaultTsFile, String(nowEpoch), "utf8");
  });

  afterEach(async () => {
    try { await rm(defaultTsFile, { force: true }); } catch { /* ignore */ }
  });

  it("exits 0 on empty stdin", async () => {
    const { code } = await runHook(
      "",
      undefined,
      { VIBE_HERO_OFFER_COOLDOWN_SECONDS: "9999" },
    );
    expect(code).toBe(0);
  }, RUN_TIMEOUT_MS);

  it("exits 0 on malformed JSON", async () => {
    const { code } = await runHook(
      "this is not json {{{",
      undefined,
      { VIBE_HERO_OFFER_COOLDOWN_SECONDS: "9999" },
    );
    expect(code).toBe(0);
  }, RUN_TIMEOUT_MS);
});
