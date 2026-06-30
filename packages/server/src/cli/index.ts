#!/usr/bin/env node
/**
 * @file vibe-hero `bin` dispatcher (T004) — the published CLI entrypoint.
 *
 * This is the single `bin` target declared in package.json
 * (`bin: { "vibe-hero": "dist/cli/index.js" }`). It is a THIN router over the
 * two existing entry points; it contains NO business logic of its own:
 *
 *   - no subcommand, or `mcp`  → start the stdio MCP server ({@link serverMain}
 *                                from `../index.js`). This is the primary
 *                                invocation (`npx -y @vibe-hero/server`) used by
 *                                the plugin's `.mcp.json` (FR-002, FR-008).
 *   - `get-offer …`            → run the OPTIONAL Stop-hook offer utility
 *                                ({@link getOfferMain} from `./getOffer.js`),
 *                                passing the remaining flags through. The Claude
 *                                Code Stop hook is agent-mediated and does NOT
 *                                call this (FR-011); it is retained only for
 *                                non-Claude-Code hosts and debugging.
 *   - any other subcommand     → a usage line to stderr, nonzero exit.
 *
 * Routing keys off `process.argv[2]` (the first user arg). For `get-offer` the
 * remaining args (`--session`, `--tool`, …) are already on `process.argv`, and
 * {@link getOfferMain} reads them via `argv.slice(2)` itself — so the dispatcher
 * does not re-parse or re-pass them.
 *
 * Import safety (no double-run): `../index.js` and `./getOffer.js` each auto-run
 * their own `main` ONLY when THEY are the process entrypoint, via a
 * `fileURLToPath(import.meta.url) === argv[1]` guard. When this dispatcher is the
 * entrypoint, `argv[1]` is `dist/cli/index.js`, which never equals either of
 * their module URLs — so importing their `main` here triggers nothing. This file
 * carries the SAME guard, so importing IT (e.g. from tests) is likewise
 * side-effect-free.
 *
 * Source of truth: specs/002-distribution/contracts/cli-and-plugin.md,
 * spec.md FR-002 / FR-008 / FR-011, quickstart.md V2.
 */

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { argv, stderr } from "node:process";

import { main as serverMain } from "../index.js";
import { main as getOfferMain } from "./getOffer.js";

/** The bin name, used in the usage line. Matches package.json `bin`. */
const BIN_NAME = "vibe-hero";

/** One-line usage shown on stderr for an unknown subcommand. */
const USAGE = `usage: ${BIN_NAME} [mcp | get-offer --session <id> --tool <toolId>]`;

/**
 * Route `process.argv` to the correct existing `main`. Returns the selected
 * `main`'s promise so the caller can await it (and surface a nonzero exit on an
 * unknown subcommand).
 *
 * @param args - The full `process.argv` (the dispatcher reads `args[2]`).
 * @returns A promise that resolves when the routed entrypoint completes.
 */
export const dispatch = async (args: readonly string[]): Promise<void> => {
  // args[0] = node, args[1] = this script, args[2] = first user subcommand.
  const subcommand = args[2];

  // Default (no subcommand) or explicit `mcp` → the stdio MCP server.
  if (subcommand === undefined || subcommand === "mcp") {
    await serverMain();
    return;
  }

  // `get-offer` → the optional offer utility. It reads its own flags from
  // `argv.slice(2)`, so the remaining args pass through untouched.
  if (subcommand === "get-offer") {
    await getOfferMain();
    return;
  }

  // Anything else is an error: usage line to stderr, nonzero exit.
  stderr.write(
    `${BIN_NAME}: unknown subcommand ${JSON.stringify(subcommand)}\n${USAGE}\n`,
  );
  process.exitCode = 2;
};

/**
 * Entrypoint guard: only auto-dispatch when this module is the process
 * entrypoint (`node .../cli/index.js`), not when imported by tests. Mirrors the
 * `import.meta.url === argv[1]` pattern in `../index.js` and `./getOffer.js`.
 */
const isEntrypoint = (): boolean => {
  const entry = argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  // Direct comparison handles `node dist/cli/index.js`. But npx (and any
  // node_modules/.bin install) launches this bin through a SYMLINK, so `argv[1]`
  // is the symlink path while `import.meta.url` is the realpath — a naive
  // string compare fails and the server silently does nothing. Resolve both
  // sides through realpath so the guard holds under the standard npx launch.
  if (self === entry) return true;
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    return false;
  }
};

if (isEntrypoint()) {
  dispatch(argv).catch((err: unknown) => {
    stderr.write(`${BIN_NAME}: fatal: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
