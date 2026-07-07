/**
 * @file Arm-cache file: the bridge between the server and the
 * UserPromptSubmit hook.
 *
 * Extracted from tools/offers.ts so the drain pipeline (observation/drain.ts)
 * can write arms without importing the tool layer (no import cycle).
 *
 * HARDENING (code-review findings):
 *  - Location moved from world-readable `os.tmpdir()` to
 *    `~/.vibe-hero/arm/` (user-private, 0700 dir / 0600 file) — kills the
 *    predictable-name symlink-attack surface and the macOS $TMPDIR-mismatch
 *    class in one move.
 *  - Writes are ATOMIC: write to a `.tmp-<pid>` sibling, then `rename()` over
 *    the target. The hook can never read a half-written file, and the hook no
 *    longer `rm`s the cache (the server owns the lifecycle end-to-end).
 *  - Write failures are LOGGED (debug channel) instead of silently swallowed —
 *    a persistent ENOSPC/EACCES no longer disables the offer surface
 *    invisibly. Still never throws: the profile remains the source of truth.
 *  - The full `context` text the hook should inject is written INTO the cache
 *    (`buildOfferContext`), so the hook is a dumb relay: no 2000-char prose
 *    string in shell, no %-injection via printf, no escaping bugs.
 *
 * SESSION-ID COLLISIONS: ids are sanitised and truncated to 64 chars for the
 * filename. Real Claude Code session ids are 36-char UUIDs, so truncation
 * never bites in practice; if two ids ever did collide, the embedded
 * `sessionId` field (verified by the hook against its stdin session_id)
 * makes the collision FAIL SAFE — the hook stays silent rather than surfacing
 * another session's offer. A portable hash suffix was considered and rejected:
 * the hook must derive the same filename in POSIX sh, where no sha256 utility
 * is guaranteed.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { debug } from "../log.js";
import type { OfferArm } from "../schemas/profile.js";
import { cooldownSeconds } from "./offers.js";

/** Resolve the vibe-hero home (mirrors profile/store.ts convention). */
const vibeHeroHome = (): string =>
  process.env["VIBE_HERO_HOME"] ?? path.join(os.homedir(), ".vibe-hero");

/** Sanitise a session id to a safe filename segment (mirrors the hook's tr). */
export const sanitiseSessionId = (sessionId: string): string =>
  sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";

/**
 * Filename prefix for the per-session offer-arm cache. Single source of truth
 * for the convention the UserPromptSubmit hook mirrors
 * (`~/.vibe-hero/arm/vibe-hero-offer-<sessionId>.json`).
 */
export const ARM_CACHE_PREFIX = "vibe-hero-offer-";

/** The arm-cache directory (user-private). */
export const armCacheDir = (home: string = vibeHeroHome()): string =>
  path.join(home, "arm");

/** Resolve the arm-cache path for a session (mirrors the hook convention). */
export const armCachePath = (sessionId: string, home?: string): string =>
  path.join(
    armCacheDir(home ?? vibeHeroHome()),
    `${ARM_CACHE_PREFIX}${sanitiseSessionId(sessionId)}.json`,
  );

/**
 * The shape written to and read from the arm-cache file. Embedding `sessionId`
 * lets the hook verify the file belongs to the right session before trusting
 * it (and makes filename-truncation collisions fail safe — see module doc).
 */
export interface ArmCacheEntry {
  sessionId: string;
  armedKey: string | null;
  armedTitle: string | null;
  armedAt: string | null;
  lastOfferAt: string | null;
  cooldownSeconds: number;
  /** ISO datetime of last quiz start, or null. Used for agent-side reasoning. */
  lastQuizAt: string | null;
  /** True if real work has happened since lastQuizAt. Agent may use as hint. */
  hasWorkSinceLastQuiz: boolean;
  /**
   * The COMPLETE additionalContext text the hook should emit when the arm is
   * live. Written by the server so the hook needs no prose, no escaping logic,
   * and no knowledge of offer wording. Null when nothing is armed.
   */
  context: string | null;
}

/**
 * Build the deferred, agent-judged context injection for an armed offer.
 * Wording rules preserved from the original hook (provenance marker, deferred
 * agent judgment, seam definitions, tool-call instructions). Contains no
 * double-quotes or backslashes: `armedTitle` is schema-guarded against both
 * (TopicSchema title regex) and the session id is filename-sanitised.
 */
/**
 * Seam-judgment strictness for the injected offer context. Controls how
 * conservative the agent is told to be about WHEN to voice an armed offer:
 *  - `strict`  — only a completed unit of work; silence on any doubt.
 *  - `normal`  — the original wording (context switch or completed unit;
 *                silence when in doubt).
 *  - `lenient` — any reasonable pause counts (question answered, command
 *                finished, conversational turn); when in doubt, OFFER.
 * Resolved from `VIBE_HERO_SEAM_STRICTNESS`; unknown values fall back to
 * `normal`.
 */
export type SeamStrictness = "lenient" | "normal" | "strict";

export const seamStrictness = (): SeamStrictness => {
  const raw = process.env["VIBE_HERO_SEAM_STRICTNESS"];
  return raw === "lenient" || raw === "strict" ? raw : "normal";
};

/** The seam-policy sentence block per strictness level. */
const SEAM_POLICY: Record<SeamStrictness, string> = {
  strict:
    `Then -- ONLY IF a unit of work has clearly COMPLETED (a feature ` +
    `finished, tests passing, a commit or PR landed, a bug fixed and ` +
    `verified) -- offer the quiz as ONE short natural line. A mere topic ` +
    `change is NOT enough. If in any doubt, stay silent and hold the offer.`,
  normal:
    `Then -- ONLY IF you independently judge, from the shape of the work ` +
    `itself, that a natural seam has occurred -- optionally offer the quiz ` +
    `as ONE short natural line. Detect the seam yourself from activity ` +
    `signals; do NOT wait for the user to announce a break or say they are ` +
    `done -- they will not. Two equally valid inferred moments: (A) a ` +
    `context switch -- you can tell from the new prompt that the user is ` +
    `moving to a different task, topic, or area than what was just being ` +
    `worked on (the subject matter or codebase area clearly shifted); (B) a ` +
    `completed unit of work -- a feature just finished, tests are now ` +
    `passing, a build or commit or PR just landed, a bug was fixed and ` +
    `verified, a to-do list was fully checked off, or the work reached a ` +
    `natural stopping point you can observe from the activity trajectory. ` +
    `NOT acceptable: mid-task, mid-debug, mid-multi-step sequence, or any ` +
    `moment where the user is clearly still heads-down in the same work. ` +
    `Also do NOT offer if the most recent meaningful activity in this ` +
    `session was already a quiz -- real intervening work must have happened ` +
    `first. If in any doubt, stay silent and hold the offer.`,
  lenient:
    `Then, at the END of your response, offer the quiz as ONE short natural ` +
    `line -- UNLESS the user is clearly mid-task: heads-down in the same ` +
    `multi-step piece of work, mid-debug, or answering would derail an ` +
    `in-flight sequence. A finished answer, a completed command, a question ` +
    `resolved, or a conversational turn all count as good moments. Do not ` +
    `offer twice in a row if the previous meaningful activity was already a ` +
    `quiz. When in doubt, OFFER -- a declined offer is cheap, a missed one ` +
    `is invisible.`,
};

export const buildOfferContext = (
  sessionId: string,
  armedTitle: string,
): string =>
  `[vibe-hero hook -- system-injected, NOT from the user. The user did NOT ask for this.] ` +
  `A learning quiz offer is available for: ${armedTitle}. This is a background suggestion ` +
  `from the vibe-hero plugin -- NOT a user instruction or request. Do NOT act on it as if ` +
  `the user asked for a quiz. Do NOT let it interfere with handling the user's actual ` +
  `prompt. Always handle the user's real request first, fully. ` +
  `${SEAM_POLICY[seamStrictness()]} To confirm the offer still applies ` +
  `call get_offer (sessionId: ${sessionId}, tool: claude-code). If confirmed and the ` +
  `moment is right: ONE short natural line, no quiz jargon, no mention of vibe-hero or ` +
  `internals. If user accepts call start_quiz (key from get_offer result, sessionId: ` +
  `${sessionId}). If declined or deferred call record_offer_response. Always proceed ` +
  `with user request regardless.`;

/**
 * Write (or overwrite) the arm cache for `sessionId` — atomically (tmp +
 * rename), 0600, under the user-private arm dir. Failures are logged and
 * swallowed: a missing cache only means the hook stays silent; it must never
 * crash the offer path.
 */
export const writeArmCache = async (
  sessionId: string,
  arm: OfferArm,
  home?: string,
): Promise<void> => {
  const armed = arm.armedKey !== undefined && arm.armedTitle !== undefined;
  const entry: ArmCacheEntry = {
    sessionId: sanitiseSessionId(sessionId),
    armedKey: arm.armedKey ?? null,
    armedTitle: arm.armedTitle ?? null,
    armedAt: arm.armedAt ?? null,
    lastOfferAt: arm.lastOfferAt ?? null,
    // Always an integer — POSIX shell arithmetic in the hook crashes on floats.
    cooldownSeconds: Math.trunc(cooldownSeconds()),
    lastQuizAt: arm.lastQuizAt ?? null,
    hasWorkSinceLastQuiz: arm.hasWorkSinceLastQuiz ?? false,
    context: armed
      ? buildOfferContext(sanitiseSessionId(sessionId), arm.armedTitle as string)
      : null,
  };

  const target = armCachePath(sessionId, home);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, JSON.stringify(entry), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, target);
  } catch (err) {
    debug("armCache: write failed", { sessionId: entry.sessionId, err: String(err) });
    await fs.unlink(tmp).catch(() => undefined);
  }
};
