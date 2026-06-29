/**
 * @file Stop-hook (agent-mediated) integration test (T015 / quickstart V5).
 *
 * The vibe-hero Stop hook is AGENT-MEDIATED (FR-011): it SPAWNS NOTHING. A
 * Claude Code hook cannot reach the running stdio MCP server, so instead of
 * shelling out to a CLI, the hook only emits a Stop `additionalContext` nudge
 * and the agent — which already holds the live MCP connection — calls the
 * `get_offer` MCP tool itself. This test asserts that contract against the
 * REAL shell script (no mocks):
 *
 *   (a) a normal Stop payload → valid JSON whose
 *       `hookSpecificOutput.additionalContext` mentions `get_offer`, exit 0;
 *   (b) the script spawns NO node/npx subprocess and references NO get-offer
 *       CLI / plugin-local build artifact — asserted by static inspection of
 *       the script body (no `node `/`npx `/`getOffer`/`dist/cli` tokens) AND by
 *       running it under a PATH where `node` and `npx` are shadowed by a probe
 *       that writes a marker file if ever invoked (the marker must stay absent);
 *   (c) a `{"stop_hook_active":true}` payload → empty stdout (loop guard);
 *   (d) the exit code is ALWAYS 0 (advisory only — never blocks the user),
 *       including on empty stdin and malformed JSON.
 *
 * Deterministic + tight timeouts; the script is pure POSIX shell so the only
 * external tool it may use is `jq` (degrades without it).
 *
 * Source of truth: specs/002-distribution/spec.md (FR-007/FR-011, SC-006),
 * quickstart.md V5, contracts/cli-and-plugin.md.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

/** The plugin copy that ships at ${PLUGIN_ROOT}/hooks/claude-code/stop-offer.sh. */
const PLUGIN_HOOK = path.join(
  REPO_ROOT,
  "packages",
  "vibe-hero-plugin",
  "hooks",
  "claude-code",
  "stop-offer.sh",
);

/** Tight budget: a pure-shell script + (optional) jq is fast. */
const RUN_TIMEOUT_MS = 10_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the hook with `payload` piped to stdin. Resolves with code+stdout+stderr.
 * `extraPath`, when set, is PREPENDED to PATH (used to shadow node/npx with a
 * probe). `execFile` (not a shell) so we exercise the script's own shebang.
 */
function runHook(payload: string, extraPath?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (extraPath) env.PATH = `${extraPath}${path.delimiter}${env.PATH ?? ""}`;
    const child = execFile(
      HOOK,
      [],
      { timeout: RUN_TIMEOUT_MS, env, encoding: "utf8" },
      (err, stdout, stderr) => {
        // A nonzero exit surfaces as `err`; capture the code rather than throw,
        // because part of the contract is "always exit 0".
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          // spawn-level failure (e.g. ENOENT) — that's a real test error.
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

describe("Stop hook is agent-mediated and spawns nothing (FR-011, V5)", () => {
  let scriptBody = "";

  beforeAll(async () => {
    scriptBody = await readFile(HOOK, "utf8");
  });

  it("(static) the script invokes no node/npx and no get-offer CLI", () => {
    // Strip comment lines first: a comment may legitimately MENTION the retired
    // CLI to explain what the hook deliberately does NOT do. The hazard is an
    // actual invocation in executable lines.
    const code = scriptBody
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // No process-spawn tokens — the agent-mediated hook must invoke nothing.
    expect(code).not.toMatch(/\bnode\s/);
    expect(code).not.toMatch(/\bnpx\s/);
    // No invocation of the retired CLI / any plugin-local build artifact.
    expect(code).not.toMatch(/getOffer/i);
    expect(code).not.toMatch(/get-offer/);
    expect(code).not.toMatch(/dist\/cli/);
    expect(code).not.toMatch(/VIBE_HERO_SERVER_DIST/);
  });

  it("the dev-source and plugin copy are byte-identical (ship the same hook)", async () => {
    expect(existsSync(PLUGIN_HOOK), "plugin must ship the hook script").toBe(true);
    const dev = await readFile(HOOK, "utf8");
    const plugin = await readFile(PLUGIN_HOOK, "utf8");
    expect(plugin).toBe(dev);
  });

  it("(a) a normal Stop payload emits JSON with a get_offer nudge, exit 0", async () => {
    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: "s1", stop_hook_active: false, cwd: "/tmp" }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput?.additionalContext).toMatch(/get_offer/);
  });

  it("(b) running the hook spawns NO node/npx subprocess", async () => {
    // Shadow node + npx with a probe that records the fact it was invoked.
    const probeDir = await mkdtemp(path.join(tmpdir(), "vh-hook-probe-"));
    const marker = path.join(probeDir, "SPAWNED");
    const probe = `#!/bin/sh\necho invoked >> "${marker}"\nexit 0\n`;
    try {
      for (const bin of ["node", "npx"]) {
        const p = path.join(probeDir, bin);
        await writeFile(p, probe, "utf8");
        await chmod(p, 0o755);
      }
      const { code, stdout } = await runHook(
        JSON.stringify({ session_id: "s1", stop_hook_active: false }),
        probeDir,
      );
      expect(code).toBe(0);
      // Still produces the nudge…
      expect(stdout).toMatch(/get_offer/);
      // …and the probe was NEVER invoked → no node/npx spawn.
      expect(
        existsSync(marker),
        "hook must not spawn node/npx (probe marker would exist)",
      ).toBe(false);
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
  });

  it("(c) stop_hook_active:true emits nothing (loop guard), exit 0", async () => {
    const { code, stdout } = await runHook(
      JSON.stringify({ session_id: "s1", stop_hook_active: true }),
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("(d) exit code is always 0 — empty stdin and malformed JSON included", async () => {
    const empty = await runHook("");
    expect(empty.code).toBe(0);

    const garbage = await runHook("this is not json {{{");
    expect(garbage.code).toBe(0);
  });
});
