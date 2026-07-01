/**
 * @file UserPromptSubmit hook integration test (redesign of T015 / FR-011).
 *
 * The new prompt-offer.sh UserPromptSubmit hook:
 *   - Reads the /tmp arm cache file written by the server (no npx/node spawn).
 *   - Verifies the embedded sessionId in the file matches stdin session_id
 *     (guards against stale/reused /tmp files from other sessions).
 *   - Only emits additionalContext when:
 *       * a cache file exists for the session,
 *       * armedKey and armedTitle are present (non-null),
 *       * the arm has NOT expired (armedAt + cooldownSeconds >= now),
 *       * and the cooldown window since lastOfferAt has elapsed.
 *   - The emitted context MUST:
 *       * open with a provenance marker identifying it as vibe-hero hook
 *         system-injected content, NOT from the user,
 *       * instruct the agent to judge the right moment (before starting a new
 *         task / context switch, OR after completing a unit of work),
 *       * tell the agent to call get_offer to confirm, then start_quiz or
 *         record_offer_response as appropriate,
 *       * never reveal vibe-hero internals or hook details.
 *   - Is silent (emits nothing, exits 0) when:
 *       * no cache file exists (bootstrapping: first prompt before any MCP call),
 *       * armedKey is absent/null (arm cleared by quiz start / decline / defer),
 *       * sessionId in file does not match stdin session_id,
 *       * within the cooldown window,
 *       * arm has expired.
 *   - ALWAYS exits 0.
 *   - No npx or node invocation in the script body.
 *   - dev-source and plugin copies are byte-identical.
 *   - hookEventName is "UserPromptSubmit" (not "Stop").
 *
 * Tests run against the REAL shell script (no mocks). The /tmp cache file is
 * written by the test harness (simulating what the MCP server writes).
 *
 * Source of truth: specs/002-distribution/spec.md (FR-007/FR-011, SC-006),
 * contracts/cli-and-plugin.md.
 */

import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** repo root = up from packages/server/test/integration */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
);

/** The dev-source hook script under test. */
const HOOK = path.join(REPO_ROOT, "hooks", "claude-code", "prompt-offer.sh");

/** The plugin copy that ships at ${CLAUDE_PLUGIN_ROOT}/hooks/claude-code/prompt-offer.sh. */
const PLUGIN_HOOK = path.join(
  REPO_ROOT,
  "packages", "vibe-hero-plugin", "hooks", "claude-code", "prompt-offer.sh",
);

/** Max time to allow each shell-script test. */
const RUN_TIMEOUT_MS = 12_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the hook with `payload` piped to stdin.
 *
 * @param payload  - JSON string piped to stdin.
 * @param extraEnv - Additional env vars.
 */
function runHook(
  payload: string,
  extraEnv?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
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

/** Build a JSON arm-cache string (mirrors ArmCacheEntry from tools/offers.ts). */
function makeCache(overrides: {
  sessionId?: string;
  armedKey?: string | null;
  armedTitle?: string | null;
  armedAt?: string | null;
  lastOfferAt?: string | null;
  cooldownSeconds?: number;
}): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    sessionId:      overrides.sessionId ?? "test-session",
    armedKey:       overrides.armedKey       !== undefined ? overrides.armedKey       : "general|task-decomposition",
    armedTitle:     overrides.armedTitle     !== undefined ? overrides.armedTitle     : "Task Decomposition",
    armedAt:        overrides.armedAt        !== undefined ? overrides.armedAt        : now,
    lastOfferAt:    overrides.lastOfferAt    !== undefined ? overrides.lastOfferAt    : null,
    cooldownSeconds: overrides.cooldownSeconds ?? 900,
  });
}

/** Write a /tmp cache file for the given sessionId. Returns the file path. */
async function writeCacheFile(sessionId: string, content: string): Promise<string> {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";
  const file = path.join(tmpdir(), `vibe-hero-offer-${safe}.json`);
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// Static contract checks
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — static contract", () => {
  let scriptBody = "";

  beforeEach(async () => {
    scriptBody = await readFile(HOOK, "utf8");
  });

  it("dev-source and plugin copy are byte-identical", async () => {
    expect(existsSync(PLUGIN_HOOK), "plugin must ship the hook script").toBe(true);
    const dev = await readFile(HOOK, "utf8");
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

  it("reads from a /tmp cache file (server-written, no npx)", () => {
    expect(scriptBody).toMatch(/vibe-hero-offer-/);
    expect(scriptBody).toMatch(/cache_file/);
  });

  it("hookEventName is UserPromptSubmit (not Stop)", () => {
    expect(scriptBody).toMatch(/UserPromptSubmit/);
    expect(scriptBody).not.toMatch(/hookEventName.*Stop/);
  });

  it("context string contains provenance marker (system-injected, NOT from the user)", () => {
    expect(scriptBody).toMatch(/vibe-hero hook/i);
    expect(scriptBody).toMatch(/NOT from the user/i);
    expect(scriptBody).toMatch(/system-injected/i);
  });

  it("context string instructs agent to infer break from work shape (not wait for user to signal)", () => {
    // The agent must detect a seam from activity signals, NOT wait for the user
    // to announce they are done or taking a break — they will not.
    expect(scriptBody).toMatch(/infer|detect|observe|activity|shape of the work/i);
    expect(scriptBody).toMatch(/do not wait|will not|they will not/i);
    // Both moments (context switch and completed work) must be present.
    expect(scriptBody).toMatch(/context switch|different task|topic.*shift|area.*shift/i);
    expect(scriptBody).toMatch(/unit of work|complete|finished|landed|fixed/i);
  });

  it("context string mentions not re-offering after a quiz without intervening work", () => {
    expect(scriptBody).toMatch(/quiz/i);
    expect(scriptBody).toMatch(/real intervening work|intervening work must|real work|work.*first/i);
  });

  it("context string instructs agent to call get_offer to confirm", () => {
    expect(scriptBody).toContain("get_offer");
  });

  it("verifies embedded sessionId against stdin session_id", () => {
    expect(scriptBody).toMatch(/cached_session/);
  });
});

// ---------------------------------------------------------------------------
// No cache file (bootstrapping)
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — no cache file (bootstrapping)", () => {
  it("emits nothing and exits 0 when no /tmp file exists for the session", async () => {
    const sessionId = `boot-${Date.now()}`;
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    try { await rm(path.join(tmpdir(), `vibe-hero-offer-${safe}.json`), { force: true }); } catch { /* ok */ }

    const { code, stdout } = await runHook(JSON.stringify({ session_id: sessionId }));
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
    const fileId  = `verify-file-${Date.now()}`;

    // Write cache named for stdin id but with a DIFFERENT embedded sessionId.
    const content = makeCache({
      sessionId: fileId,   // embedded ≠ stdin
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: null,
      cooldownSeconds: 0,
    });
    const cacheFile = await writeCacheFile(stdinId, content);

    try {
      const { code, stdout } = await runHook(JSON.stringify({ session_id: stdinId }));
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(cacheFile, { force: true });
    }
  }, RUN_TIMEOUT_MS);

  it("reads ONLY the cache file path matching its session_id (other session unaffected)", async () => {
    const sessionA = `id-a-${Date.now()}`;
    const sessionB = `id-b-${Date.now()}`;

    // Write a valid cache for session A (armed, cooldown=0).
    const contentA = makeCache({
      sessionId: sessionA,
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: null,
      cooldownSeconds: 0,
    });
    const fileA = await writeCacheFile(sessionA, contentA);

    // No cache for session B.
    const safB = sessionB.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    try { await rm(path.join(tmpdir(), `vibe-hero-offer-${safB}.json`), { force: true }); } catch { /* ok */ }

    try {
      // Hook run for session B must NOT see session A's offer.
      const { code, stdout } = await runHook(JSON.stringify({ session_id: sessionB }));
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(fileA, { force: true });
    }
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Offer emission
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — offer emission", () => {
  async function runWithCache(
    sessionId: string,
    cacheOpts: Parameters<typeof makeCache>[0],
  ): Promise<RunResult> {
    const content = makeCache({ sessionId, ...cacheOpts });
    const cacheFile = await writeCacheFile(sessionId, content);
    try {
      return await runHook(JSON.stringify({ session_id: sessionId }));
    } finally {
      await rm(cacheFile, { force: true });
    }
  }

  it("emits additionalContext with provenance marker when armed, cooldown=0", async () => {
    const sessionId = `emit-armed-${Date.now()}`;
    const { code, stdout } = await runWithCache(sessionId, {
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: null,
      cooldownSeconds: 0,
    });
    expect(code).toBe(0);
    expect(stdout.trim()).not.toBe("");

    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");

    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";
    // 1. Provenance: system-injected, not user.
    expect(ctx).toMatch(/vibe-hero hook/i);
    expect(ctx).toMatch(/NOT from the user|not from the user/i);
    // 2. Agent infers break from work shape — not waiting for user to signal.
    expect(ctx).toMatch(/infer|detect|observe|activity|shape of the work/i);
    expect(ctx).toMatch(/do not wait|will not/i);
    // 3. Both valid moments: context switch AND completed unit of work.
    expect(ctx).toMatch(/context switch|different task/i);
    expect(ctx).toMatch(/unit of work|complete|finished|landed|fixed/i);
    // 4. Topic title present.
    expect(ctx).toContain("Task Decomposition");
    // 5. Agent instructed to call get_offer.
    expect(ctx).toContain("get_offer");
  }, RUN_TIMEOUT_MS);

  it("is silent when armedKey is null (arm was cleared)", async () => {
    const sessionId = `emit-cleared-${Date.now()}`;
    const { code, stdout } = await runWithCache(sessionId, {
      armedKey: null,
      armedTitle: null,
      armedAt: null,
      lastOfferAt: new Date().toISOString(),
      cooldownSeconds: 0,
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("is silent within cooldown window (lastOfferAt recent, large cooldown)", async () => {
    const sessionId = `emit-cooldown-${Date.now()}`;
    const { code, stdout } = await runWithCache(sessionId, {
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: new Date().toISOString(),
      lastOfferAt: new Date().toISOString(),
      cooldownSeconds: 9999,
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);

  it("is silent when arm has expired (armedAt older than cooldown window)", async () => {
    const sessionId = `emit-expired-${Date.now()}`;
    // Arm was set 2000 s ago; cooldown is 1000 s → expired.
    const oldArmedAt = new Date(Date.now() - 2_000_000).toISOString();
    const { code, stdout } = await runWithCache(sessionId, {
      armedKey: "general|task-decomposition",
      armedTitle: "Task Decomposition",
      armedAt: oldArmedAt,
      lastOfferAt: null,
      cooldownSeconds: 1000,
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, RUN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Always exits 0
// ---------------------------------------------------------------------------

describe("Prompt-offer hook — always exits 0", () => {
  it("exits 0 on empty stdin", async () => {
    const { code } = await runHook("");
    expect(code).toBe(0);
  }, RUN_TIMEOUT_MS);

  it("exits 0 on malformed JSON stdin", async () => {
    const { code } = await runHook("this is not json {{{");
    expect(code).toBe(0);
  }, RUN_TIMEOUT_MS);
});
