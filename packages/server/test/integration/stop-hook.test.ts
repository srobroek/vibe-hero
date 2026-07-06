/**
 * @file UserPromptSubmit hook integration test (dumb-relay architecture).
 *
 * The new prompt-offer.sh is a DUMB RELAY: it reads the arm cache from
 * $VIBE_HERO_HOME/arm/vibe-hero-offer-<session_id>.json (no prose in shell,
 * no npx/node), verifies the embedded sessionId, checks cooldown/expiry, then
 * emits the `context` field verbatim. The full context text lives in
 * src/observation/armCache.ts (buildOfferContext).
 *
 * Every hook invocation in this file sets:
 *   CLAUDE_PLUGIN_ROOT = <repo>/packages/vibe-hero-plugin   (for _lib.sh)
 *   VIBE_HERO_HOME     = per-test tmp dir                    (for arm/ path)
 *
 * Source of truth: specs/002-distribution/spec.md (FR-007/FR-011, SC-006).
 */

import { execFile } from "node:child_process";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildOfferContext,
  armCachePath,
  type ArmCacheEntry,
} from "../../src/observation/armCache.js";

/** repo root = up from packages/server/test/integration */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
);

/** The plugin hook directory (where _lib.sh lives). */
const PLUGIN_ROOT = path.join(REPO_ROOT, "packages", "vibe-hero-plugin");

/** The hook script (in the plugin copy — that's the one that ships). */
const PLUGIN_HOOK = path.join(PLUGIN_ROOT, "hooks", "claude-code", "prompt-offer.sh");

/** Max time to allow each shell-script test. */
const RUN_TIMEOUT_MS = 12_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the hook with the given payload, VIBE_HERO_HOME set to a tmp dir, and
 * CLAUDE_PLUGIN_ROOT pointing at the plugin package so _lib.sh can be sourced.
 */
function runHook(
  payload: string,
  vibeHeroHome: string,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      VIBE_HERO_HOME: vibeHeroHome,
      ...extraEnv,
    };
    const child = execFile(
      PLUGIN_HOOK,
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

/** Build a full ArmCacheEntry JSON (with context field). */
function makeCache(
  sessionId: string,
  overrides: Partial<ArmCacheEntry> = {},
): string {
  const now = new Date().toISOString();
  const armedKey = overrides.armedKey !== undefined ? overrides.armedKey : "general|task-decomposition";
  const armedTitle = overrides.armedTitle !== undefined ? overrides.armedTitle : "Task Decomposition";
  const armed = armedKey !== null && armedTitle !== null;
  const entry: ArmCacheEntry = {
    sessionId: overrides.sessionId ?? sessionId,
    armedKey: armedKey,
    armedTitle: armedTitle,
    armedAt: overrides.armedAt !== undefined ? overrides.armedAt : now,
    lastOfferAt: overrides.lastOfferAt !== undefined ? overrides.lastOfferAt : null,
    cooldownSeconds: overrides.cooldownSeconds ?? 0,
    lastQuizAt: overrides.lastQuizAt ?? null,
    hasWorkSinceLastQuiz: overrides.hasWorkSinceLastQuiz ?? false,
    context: overrides.context !== undefined
      ? overrides.context
      : (armed && armedTitle !== null && armedKey !== null
          ? buildOfferContext(sessionId, armedTitle)
          : null),
  };
  return JSON.stringify(entry);
}

/** Write a cache file into the arm directory under vibeHeroHome. */
async function writeCacheFile(
  vibeHeroHome: string,
  sessionId: string,
  content: string,
): Promise<string> {
  const armDir = path.join(vibeHeroHome, "arm");
  await mkdir(armDir, { recursive: true });
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";
  const file = path.join(armDir, `vibe-hero-offer-${safe}.json`);
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// Per-test tmp home management
// ---------------------------------------------------------------------------

let testHome: string;

beforeEach(async () => {
  testHome = await mkdtemp(path.join(tmpdir(), "vh-hook-"));
});

afterEach(async () => {
  await rm(testHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Static contract checks — these verify what the script DOES (relay contract),
// and what buildOfferContext emits (the context contract lives in armCache.ts).
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — static contract", () => {
  let scriptBody = "";

  beforeEach(async () => {
    scriptBody = await readFile(PLUGIN_HOOK, "utf8");
  });

  it("dev-source and plugin copy are byte-identical", async () => {
    const DEV_HOOK = path.join(REPO_ROOT, "hooks", "claude-code", "prompt-offer.sh");
    expect(existsSync(DEV_HOOK), "dev-source hook must exist under repo hooks/").toBe(true);
    const dev = await readFile(DEV_HOOK, "utf8");
    const plugin = await readFile(PLUGIN_HOOK, "utf8");
    expect(plugin).toBe(dev);
  });

  it("does NOT invoke npx or node in the script body (non-comment lines)", () => {
    const code = scriptBody
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/\bnpx\b/);
    expect(code).not.toMatch(/\bnode\s/);
    expect(code).not.toMatch(/dist\/cli/);
    expect(code).not.toMatch(/@vibe-hero\/server/);
  });

  it("reads from the arm cache file (vibe-hero-offer-)", () => {
    expect(scriptBody).toMatch(/vibe-hero-offer-/);
    expect(scriptBody).toMatch(/cache_file/);
  });

  it("hookEventName is UserPromptSubmit (not Stop)", () => {
    expect(scriptBody).toMatch(/UserPromptSubmit/);
    expect(scriptBody).not.toMatch(/hookEventName.*Stop/);
  });

  it("verifies embedded sessionId against stdin session_id", () => {
    expect(scriptBody).toMatch(/cached_session/);
  });

  it("reads the context field from the cache (dumb relay)", () => {
    expect(scriptBody).toMatch(/\bcontext\b/);
  });

  // Contract lives in buildOfferContext (armCache.ts) — verify it here.
  it("buildOfferContext contains provenance marker (system-injected, NOT from the user)", () => {
    const ctx = buildOfferContext("test-session", "Task Decomposition");
    expect(ctx).toMatch(/vibe-hero hook/i);
    expect(ctx).toMatch(/NOT from the user/i);
    expect(ctx).toMatch(/system-injected/i);
  });

  it("buildOfferContext instructs agent to infer break from work shape (not wait for user)", () => {
    const ctx = buildOfferContext("test-session", "Task Decomposition");
    expect(ctx).toMatch(/infer|detect|observe|activity|shape of the work/i);
    expect(ctx).toMatch(/do not wait|will not|they will not/i);
    expect(ctx).toMatch(/context switch|different task/i);
    expect(ctx).toMatch(/unit of work|complete|finished|landed|fixed/i);
  });

  it("buildOfferContext mentions not re-offering after a quiz without intervening work", () => {
    const ctx = buildOfferContext("test-session", "Task Decomposition");
    expect(ctx).toMatch(/quiz/i);
    expect(ctx).toMatch(/real intervening work|intervening work must|real work|work.*first/i);
  });

  it("buildOfferContext instructs agent to call get_offer to confirm", () => {
    const ctx = buildOfferContext("test-session", "Task Decomposition");
    expect(ctx).toContain("get_offer");
  });
});

// ---------------------------------------------------------------------------
// No cache file (bootstrapping)
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — no cache file (bootstrapping)", () => {
  it("emits nothing and exits 0 when no arm file exists for the session", async () => {
    const sessionId = `boot-${Date.now()}`;
    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionId }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Session-id verification
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — sessionId verification", () => {
  it("ignores a cache file whose embedded sessionId != stdin session_id", async () => {
    const stdinId = `verify-stdin-${Date.now()}`;
    const fileId = `verify-file-${Date.now()}`;

    // Write a cache named for stdinId but embedding a DIFFERENT sessionId
    const content = makeCache(stdinId, {
      sessionId: fileId, // embedded ≠ stdin
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: null,
      cooldownSeconds: 0,
    });
    await writeCacheFile(testHome, stdinId, content);

    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: stdinId }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("reads ONLY the file matching its session_id (other session unaffected)", async () => {
    const sessionA = `id-a-${Date.now()}`;
    const sessionB = `id-b-${Date.now()}`;

    // Session A: valid armed cache
    const contentA = makeCache(sessionA, {
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: null,
      cooldownSeconds: 0,
    });
    await writeCacheFile(testHome, sessionA, contentA);
    // No cache for session B

    // Hook for session B must be silent (no file for B)
    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionB }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Offer emission
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — offer emission", () => {
  it("emits context verbatim when armed, cooldown=0", async () => {
    const sessionId = `emit-armed-${Date.now()}`;
    const armedTitle = "Task Decomposition";
    const content = makeCache(sessionId, {
      armedKey: "general|task-decomposition",
      armedTitle,
      armedAt: new Date().toISOString(),
      lastOfferAt: null,
      cooldownSeconds: 0,
    });
    await writeCacheFile(testHome, sessionId, content);

    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionId }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).not.toBe("");

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");

    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toMatch(/vibe-hero hook/i);
    expect(ctx).toMatch(/NOT from the user|not from the user/i);
    expect(ctx).toContain(armedTitle);
    expect(ctx).toContain("get_offer");
    // Context relay: must match the server-built context exactly
    const expected = buildOfferContext(sessionId, armedTitle);
    expect(ctx).toBe(expected);
  }, RUN_TIMEOUT_MS);

  it("is silent when armedKey is null (arm was cleared)", async () => {
    const sessionId = `emit-cleared-${Date.now()}`;
    const content = makeCache(sessionId, {
      armedKey: null,
      armedTitle: null,
      armedAt: null,
      lastOfferAt: new Date().toISOString(),
      cooldownSeconds: 0,
      context: null,
    });
    await writeCacheFile(testHome, sessionId, content);

    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionId }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("is silent when context field is null", async () => {
    const sessionId = `emit-no-ctx-${Date.now()}`;
    const content = makeCache(sessionId, {
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: null,
      cooldownSeconds: 0,
      context: null,
    });
    await writeCacheFile(testHome, sessionId, content);

    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionId }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("is silent within cooldown window (lastOfferAt recent, large cooldown)", async () => {
    const sessionId = `emit-cooldown-${Date.now()}`;
    const content = makeCache(sessionId, {
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: new Date().toISOString(),
      cooldownSeconds: 9999,
    });
    await writeCacheFile(testHome, sessionId, content);

    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionId }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("is silent when arm has expired (armedAt older than cooldown window)", async () => {
    const sessionId = `emit-expired-${Date.now()}`;
    // armedAt 2000s ago, cooldown 1000s → expired
    const oldArmedAt = new Date(Date.now() - 2_000_000).toISOString();
    const content = makeCache(sessionId, {
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: oldArmedAt,
      lastOfferAt: null,
      cooldownSeconds: 1000,
    });
    await writeCacheFile(testHome, sessionId, content);

    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: sessionId }),
      testHome,
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Always exits 0
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — always exits 0", () => {
  it("exits 0 on empty stdin", async () => {
    const { code } = await runHook("", testHome);
    expect(code).toBe(0);
  }, RUN_TIMEOUT_MS);

  it("exits 0 on malformed JSON stdin", async () => {
    const { code } = await runHook("this is not json {{{", testHome);
    expect(code).toBe(0);
  }, RUN_TIMEOUT_MS);
});
