/**
 * @file CLI entrypoint for the Stop-hook offer resolver (T037).
 *
 * Usage:
 *   node dist/cli/getOffer.js get-offer --session <sessionId> --tool <toolId>
 *
 * Prints a single JSON line to stdout and exits 0. Callers treat any non-zero
 * exit or non-JSON stdout as "no offer / suppress silently" — this binary must
 * NEVER produce a non-zero exit that would surface to the user as a hook error.
 *
 * Output shapes (always valid JSON on stdout, then newline):
 *
 *   {"offer":{"key":"…","title":"…","prompt":"…"}}
 *   {"suppressed":"cadence"}        (or "declined" | "offers_off" | "no_candidate")
 *   {"suppressed":"no_candidate"}   (SETUP_REQUIRED or any unexpected result)
 *
 * This module is intentionally thin: it validates argv, delegates to the
 * existing `get_offer` handler (reusing all offer-engine + cadence logic),
 * and serializes the result. It does NOT re-implement any logic.
 *
 * Guard: if VIBE_HERO_STOP_HOOK_ACTIVE=1 is set we are already inside a Stop
 * hook invocation (the Claude Code host is running the hook again after the
 * hook itself triggered an action). In that case we exit 0 immediately with a
 * suppressed result to prevent infinite loops.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (`get_offer`),
 * hooks/claude-code/stop-offer.sh, research.md (§ Observation & hook correlation).
 */

import { argv, env, stdout, stderr } from "node:process";

import { makeGetOfferTool } from "../tools/offers.js";
import type { GetOfferResult } from "../schemas/tools.js";
import { ToolIdSchema, type ToolId } from "../schemas/common.js";

// ---------------------------------------------------------------------------
// Infinite-loop guard
// ---------------------------------------------------------------------------

/**
 * If the Stop hook itself triggers Claude Code activity that fires the Stop
 * hook again, `stop_hook_active` would be `true` in the outer payload. We
 * communicate that via this env var (set by the shell hook before calling us)
 * so the CLI can exit immediately rather than re-entering the offer path.
 */
const isReentrant = (): boolean => env["VIBE_HERO_STOP_HOOK_ACTIVE"] === "1";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly subcommand: string;
  readonly sessionId: string;
  readonly tool: ToolId;
}

/**
 * Parse `argv[2..]` into a {@link CliArgs}. Returns `undefined` (and writes a
 * diagnostic to stderr) when required args are missing or invalid.
 */
const parseArgs = (args: readonly string[]): CliArgs | undefined => {
  const [subcommand, ...rest] = args;
  if (subcommand !== "get-offer") {
    stderr.write(
      `vibe-hero cli: unknown subcommand ${JSON.stringify(subcommand ?? "(none)")}; expected "get-offer"\n`,
    );
    return undefined;
  }

  // Simple --key value flag parser (no external deps).
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length - 1; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag !== undefined && flag.startsWith("--") && value !== undefined && !value.startsWith("--")) {
      flags[flag.slice(2)] = value;
      i++; // skip consumed value
    }
  }

  const sessionId = flags["session"];
  if (!sessionId) {
    stderr.write("vibe-hero cli: --session <sessionId> is required\n");
    return undefined;
  }

  const rawTool = flags["tool"];
  if (!rawTool) {
    stderr.write("vibe-hero cli: --tool <toolId> is required\n");
    return undefined;
  }

  const toolParse = ToolIdSchema.safeParse(rawTool);
  if (!toolParse.success) {
    stderr.write(
      `vibe-hero cli: unknown tool ${JSON.stringify(rawTool)}; valid values: claude-code, codex, kiro-cli, kiro-ide\n`,
    );
    return undefined;
  }

  return { subcommand, sessionId, tool: toolParse.data };
};

// ---------------------------------------------------------------------------
// Suppress result helper
// ---------------------------------------------------------------------------

/** Emit a suppressed result and exit 0 (used on all non-offer paths). */
const suppress = (reason: GetOfferResult["suppressed"] = "no_candidate"): void => {
  stdout.write(JSON.stringify({ suppressed: reason }) + "\n");
  // process.exit is called by the caller after this returns; we don't call it
  // here so the function remains unit-testable without killing the test process.
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point. Called when this module is the process entrypoint (`node dist/cli/getOffer.js`).
 *
 * Resolves an offer for `sessionId` / `tool` by delegating to the existing
 * `get_offer` tool handler, then writes the result as JSON and exits 0.
 * Any error path writes to stderr and falls back to a suppressed result —
 * the hook must NEVER propagate errors back to the user's session.
 */
export const main = async (): Promise<void> => {
  // Infinite-loop guard (FR-019 / research Stop hook).
  if (isReentrant()) {
    suppress("no_candidate");
    return;
  }

  const args = parseArgs(argv.slice(2));
  if (args === undefined) {
    suppress("no_candidate");
    return;
  }

  // Delegate entirely to the real get_offer handler — no logic duplication.
  const tool = makeGetOfferTool();
  let result: unknown;
  try {
    result = await tool.handler({ sessionId: args.sessionId, tool: args.tool });
  } catch (err) {
    stderr.write(
      `vibe-hero cli: get_offer handler threw unexpectedly: ${String(err)}\n`,
    );
    suppress("no_candidate");
    return;
  }

  // The handler may return a SETUP_REQUIRED gate sentinel (profile not
  // configured yet) or a GetOfferResult. In either case we serialize safely.
  if (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as { status: unknown }).status === "SETUP_REQUIRED"
  ) {
    // Setup not done yet — suppress silently; the hook must not break the session.
    suppress("no_candidate");
    return;
  }

  stdout.write(JSON.stringify(result) + "\n");
};

// ---------------------------------------------------------------------------
// Entrypoint guard (shared; includes the npx/symlink realpath fallback the
// old inline copy here lacked)
// ---------------------------------------------------------------------------

import { isEntrypoint } from "../lib/isEntrypoint.js";

if (isEntrypoint(import.meta.url)) {
  main().catch((err: unknown) => {
    stderr.write(
      `vibe-hero cli: fatal: ${String(err)}\n`,
    );
    // Exit 0 — never propagate errors to the Stop hook caller.
    process.exitCode = 0;
  });
}
