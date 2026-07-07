/**
 * @file Spool intake: the file mailbox between Claude Code hooks and the
 * resident MCP server.
 *
 * The spool-writer hook (plugin `hooks/claude-code/spool-signal.sh`) appends
 * one JSON line per hook event to `~/.vibe-hero/spool/<sessionId>.jsonl`
 * (0600). The server's drain timer claims each spool by ATOMIC RENAME to
 * `<sessionId>.jsonl.draining-<pid>` — rename is atomic on POSIX, so two
 * server processes (two concurrent Claude Code sessions share the profile
 * but each runs its own server) can never double-process a spool, and a
 * crashed drainer leaves a `.draining-*` file that a later sweep reclaims
 * by age.
 *
 * PRIVACY BOUNDARY (FR-018 extension). A spool line carries the FULL tool
 * input string (`input`) and/or `file_path` (`path`) so drain-time regex
 * matching can classify activity (git vs test vs debug...). These raw strings
 * are TRANSIT-ONLY: {@link parseSpoolLine} hands them to the matcher, and
 * nothing downstream of `matchSignalHits` ever sees them. They are never
 * written to the profile, logs, or any output. `tool_output` is never spooled
 * at all. The spool file itself is user-private (0600, under $HOME — not
 * world-readable /tmp) and short-lived (deleted after each drain).
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { debug } from "../log.js";

/** Spool directory under the vibe-hero home. */
export const spoolDir = (home: string = vibeHeroHome()): string =>
  path.join(home, "spool");

/** Resolve the vibe-hero home (mirrors profile/store.ts convention). */
const vibeHeroHome = (): string =>
  process.env["VIBE_HERO_HOME"] ?? path.join(os.homedir(), ".vibe-hero");

/**
 * One spooled hook event, as written by the spool-writer hook. Loose by
 * design: the hook is dumb and versions drift, so unknown fields are ignored
 * and any malformed line is skipped (never crashes the drain).
 *
 * `kind` values: `pre` (PreToolUse), `post` (PostToolUse), `event` (any
 * non-tool hook event; `event` field carries which).
 */
export const SpoolLineSchema = z
  .object({
    kind: z.enum(["pre", "post", "event"]),
    session: z.string().min(1),
    /** Epoch seconds stamped by the hook (`date +%s`). */
    ts: z.number().int().nonnegative(),
    tool: z.string().optional(),
    id: z.string().optional(),
    /** TRANSIT-ONLY raw tool input string (see privacy boundary above). */
    input: z.string().optional(),
    /** TRANSIT-ONLY tool input file path. */
    path: z.string().optional(),
    /** Hook event name for kind=event (SubagentStop, TaskCompleted, ...). */
    event: z.string().optional(),
  })
  .passthrough();
/** One spooled hook event. */
export type SpoolLine = z.infer<typeof SpoolLineSchema>;

/** Parse one spool line, returning `undefined` for malformed input. */
export const parseSpoolLine = (raw: string): SpoolLine | undefined => {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const result = SpoolLineSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};

/** A claimed spool: the session it belongs to and its parsed lines. */
export interface ClaimedSpool {
  readonly sessionId: string;
  readonly lines: readonly SpoolLine[];
}

/**
 * Age (ms) after which an orphaned `.draining-*` file (a drainer that died
 * mid-claim) is reclaimed by the next sweep.
 */
const ORPHAN_RECLAIM_MS = 5 * 60 * 1_000;

/** Spool filename pattern: `<sessionId>.jsonl` (sessionId is pre-sanitised by the hook). */
const SPOOL_RE = /^([A-Za-z0-9_-]{1,64})\.jsonl$/;
const DRAINING_RE = /^([A-Za-z0-9_-]{1,64})\.jsonl\.draining-\d+$/;

/**
 * Claim and read every pending spool file. For each `<sid>.jsonl`:
 * rename → read → delete. Rename-to-claim makes concurrent drainers safe;
 * losing the rename race (ENOENT) simply skips the file. Orphaned
 * `.draining-*` files older than {@link ORPHAN_RECLAIM_MS} are re-read the
 * same way so a crashed drainer never strands signals.
 *
 * All IO errors are logged and swallowed per-file — a bad spool must never
 * break the drain loop for the others.
 */
export const claimSpools = async (
  dir: string = spoolDir(),
): Promise<ClaimedSpool[]> => {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return []; // No spool dir yet — nothing has been recorded.
  }

  const claimed: ClaimedSpool[] = [];
  const now = Date.now();

  for (const entry of entries) {
    const fresh = SPOOL_RE.exec(entry);
    const orphan = DRAINING_RE.exec(entry);

    let sessionId: string;
    let claimPath: string;

    if (fresh !== null) {
      sessionId = fresh[1] as string;
      claimPath = path.join(dir, `${entry}.draining-${process.pid}`);
      try {
        await fs.rename(path.join(dir, entry), claimPath);
      } catch {
        continue; // Lost the claim race (or file vanished) — someone else has it.
      }
    } else if (orphan !== null) {
      sessionId = orphan[1] as string;
      claimPath = path.join(dir, entry);
      try {
        const stat = await fs.stat(claimPath);
        if (now - stat.mtimeMs < ORPHAN_RECLAIM_MS) continue; // Still being drained.
      } catch {
        continue;
      }
    } else {
      continue;
    }

    try {
      const content = await fs.readFile(claimPath, "utf8");
      const lines = content
        .split("\n")
        .map(parseSpoolLine)
        .filter((l): l is SpoolLine => l !== undefined);
      claimed.push({ sessionId, lines });
    } catch (err) {
      debug(`spool: failed reading ${claimPath}`, { err: String(err) });
    } finally {
      // Delete regardless: a spool we cannot read is a spool we must not
      // reprocess forever.
      await fs.unlink(claimPath).catch(() => undefined);
    }
  }

  return claimed;
};
