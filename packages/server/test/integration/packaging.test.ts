/**
 * @file Packaging / built-artifact integration test (T006 / quickstart V1–V3).
 *
 * Verifies packaging CORRECTNESS against the BUILT + PACKED artifact, not just
 * `src` (FR-019a). The package is built ONCE in `beforeAll` (so the suite is
 * self-contained and order-independent), then three concerns are checked:
 *
 *   1. bin dispatch (V2 / FR-002) — spawn the built `dist/cli/index.js`:
 *        - no args         → starts the stdio MCP server; an MCP `initialize` +
 *                            `tools/list` handshake returns exactly 10 tools.
 *        - `get-offer …`   → prints ONE JSON line, exits 0 (suppressed on an
 *                            unconfigured profile under a temp VIBE_HERO_HOME).
 *        - `bogus`         → usage to stderr, nonzero exit.
 *   2. pack contents (V1 / FR-003) — `npm pack --dry-run --json` INCLUDES
 *        `dist/` (incl. `dist/cli/index.js` and real `dist/catalog/bundled/**`)
 *        and EXCLUDES `src/`, `test/`, and tsconfig.
 *   3. offline bundled content (V3 / FR-004) — the BUILT `loadBundledCatalog`
 *        returns ≥3 real topics with 0 errors (proves real curriculum shipped,
 *        not the placeholder).
 *
 * These tests spawn child processes and shell out to `npm pack`, so they are
 * deliberately slower than the pure-handler suites; per-test timeouts are set
 * explicitly and every spawned process / temp dir is cleaned up.
 *
 * Source of truth: specs/002-distribution/spec.md (FR-002/003/004/019a),
 * quickstart.md V1–V3, contracts/cli-and-plugin.md.
 */

import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

/** Absolute path to the `packages/server` package root (this file is test/integration/). */
const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** The built bin entrypoint under test. */
const CLI_DIST = path.join(PKG_ROOT, "dist", "cli", "index.js");

/** Expected MCP tool count (spec-001 server — unchanged). */
const EXPECTED_TOOL_COUNT = 10;

/** Generous build budget; the rest of the suite uses tight per-test timeouts. */
const BUILD_TIMEOUT_MS = 120_000;

/** Spawn / handshake budgets — tight, but tolerant of a cold node start. */
const SPAWN_TIMEOUT_MS = 30_000;

describe("packaging: built + packed artifact (T006 / V1–V3 / FR-019a)", () => {
  /**
   * Build the package ONCE before the suite. We rely on the package's own
   * `build` script (tsc + copy-assets), so the bundled-content copy step is
   * exercised exactly as a real publish would run it.
   */
  beforeAll(async () => {
    await execFileAsync("pnpm", ["run", "build"], {
      cwd: PKG_ROOT,
      // Inherit env so pnpm/node resolve from the workspace.
      env: process.env,
    });
  }, BUILD_TIMEOUT_MS);

  // ── 1. bin dispatch ───────────────────────────────────────────────────────

  it(
    "no subcommand → starts the stdio MCP server with all 10 tools",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "vibe-hero-pkg-mcp-"));
      // The SDK transport spawns the child and owns its lifecycle; closing the
      // transport kills the process, so no manual SIGKILL is needed.
      const transport = new StdioClientTransport({
        command: process.execPath, // node
        args: [CLI_DIST],
        env: { ...process.env, VIBE_HERO_HOME: home } as Record<string, string>,
      });
      const client = new Client({ name: "packaging-test", version: "0.0.0" });

      try {
        await client.connect(transport); // performs the MCP `initialize` handshake
        const { tools } = await client.listTools(); // → `tools/list`
        expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        await rm(home, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "get-offer --session … --tool … → one JSON line, exit 0",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "vibe-hero-pkg-offer-"));
      try {
        const { stdout, exitCode } = await runNode(
          [CLI_DIST, "get-offer", "--session", "s1", "--tool", "claude-code"],
          home,
        );
        expect(exitCode).toBe(0);

        const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
        expect(lines).toHaveLength(1);

        // Valid JSON; on an unconfigured profile the offer is suppressed.
        const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(typeof parsed).toBe("object");
        expect("offer" in parsed || "suppressed" in parsed).toBe(true);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "unknown subcommand → usage to stderr, nonzero exit",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "vibe-hero-pkg-bogus-"));
      try {
        const { stderr, exitCode } = await runNode([CLI_DIST, "bogus"], home);
        expect(exitCode).not.toBe(0);
        expect(stderr).toMatch(/usage:/i);
        expect(stderr).toContain("bogus");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  // ── 2. pack contents ──────────────────────────────────────────────────────

  it(
    "npm pack includes dist (cli + bundled content), excludes src/test/tsconfig",
    async () => {
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--dry-run", "--json"],
        { cwd: PKG_ROOT, env: process.env, maxBuffer: 16 * 1024 * 1024 },
      );

      // `npm pack --json` prints a JSON array of pack results.
      const result = JSON.parse(stdout) as Array<{
        files?: Array<{ path: string }>;
      }>;
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(1);

      const files = (result[0]?.files ?? []).map((f) => f.path);
      expect(files.length).toBeGreaterThan(0);

      // INCLUDES: the bin entrypoint, the bundled-content loader, and real
      // bundled topic YAML (proves dist + content shipped).
      expect(files).toContain("dist/cli/index.js");
      expect(files).toContain("dist/catalog/bundled/index.js");
      const bundledYaml = files.filter(
        (f) => f.startsWith("dist/catalog/bundled/") && f.endsWith(".yaml"),
      );
      expect(bundledYaml.length).toBeGreaterThanOrEqual(3);

      // EXCLUDES: sources, tests, and the tsconfig (the `files: ["dist"]`
      // allowlist plus npm's default ignores keep these out).
      expect(files.some((f) => f.startsWith("src/"))).toBe(false);
      expect(files.some((f) => f.startsWith("test/"))).toBe(false);
      expect(files).not.toContain("tsconfig.json");
    },
    BUILD_TIMEOUT_MS,
  );

  // ── 3. offline bundled content ────────────────────────────────────────────

  it("built loadBundledCatalog returns ≥3 real topics, 0 errors (offline)", async () => {
    // Import from the BUILT dist (not src) so this asserts the shipped artifact.
    const built = (await import(
      path.join(PKG_ROOT, "dist", "catalog", "bundled", "index.js")
    )) as {
      loadBundledCatalog: () => {
        topics: ReadonlyArray<{ id: string }>;
        errors: ReadonlyArray<unknown>;
      };
    };

    const { topics, errors } = built.loadBundledCatalog();
    expect(errors).toEqual([]);
    expect(topics.length).toBeGreaterThanOrEqual(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Spawn `node <args>` under a temp `VIBE_HERO_HOME`, capturing stdout/stderr and
 * the exit code. Used for the one-shot bin cases (`get-offer`, unknown) that run
 * to completion on their own — the long-lived MCP server case uses the SDK
 * transport instead. A watchdog kills a process that never exits.
 *
 * @param args - Arguments passed to `node` (the first is the script path).
 * @param home - Temp directory bound to `VIBE_HERO_HOME` for isolation.
 */
const runNode = (args: readonly string[], home: string): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      env: { ...process.env, VIBE_HERO_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`packaging: child ${args.join(" ")} timed out`));
    }, SPAWN_TIMEOUT_MS - 2_000);
    watchdog.unref();

    child.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
