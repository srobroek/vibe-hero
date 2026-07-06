/**
 * @file Drain pipeline: the resident server's autonomous organic intake.
 *
 * Every {@link DRAIN_INTERVAL_MS} the server claims pending spool files
 * (observation/spool.ts), turns their lines into privacy-safe
 * {@link ObservedSignal}s, matches them against catalog trigger signals
 * (offers.ts `matchSignalHits`), feeds the hits through the arming state
 * machine (arming.ts), and — when a topic arms and survives the existing
 * cadence gates — writes the arm cache the UserPromptSubmit hook reads.
 *
 * FAILURE CORRELATION. PostToolUse hooks never fire for failed tool calls
 * (verified empirically), so failure = a `pre` line whose `id` never gets a
 * matching `post`. Unmatched pres are held IN MEMORY (never persisted — the
 * raw input string is transit-only) for {@link PRE_DANGLE_TIMEOUT_MS}; when
 * the timeout lapses the pre is drained as a `success: false` signal (weight
 * ×2 downstream). A matching post consumes its pre (the post itself carries
 * the same input and becomes the `success: true` signal).
 *
 * TOCTOU: all read-decide-write against the profile happens inside ONE
 * `updateProfile` closure, so drain writes serialize correctly against
 * concurrent MCP tool handlers (profile/store.ts advisory lock).
 *
 * TIMER LIFECYCLE. `startDrainTimer` returns a handle with `stop()`; the
 * interval is `unref()`d so it never keeps the process alive after stdio
 * closes. The first precedent for a background timer in this server — keep
 * any future timer to this pattern (unref + explicit stop).
 */

import { abilityKey, type AbilityKey, type ToolId } from "../schemas/common.js";
import type { Topic } from "../schemas/content.js";
import type { OrganicSession } from "../schemas/profile.js";
import { debug } from "../log.js";
import { updateProfile } from "../profile/store.js";
import { claimSpools, type SpoolLine } from "./spool.js";
import { applyDrainBatch } from "./arming.js";
import { eagernessParams } from "./eagerness.js";
import {
  armSession,
  canArm,
  ledgerForSession,
  markOffered,
  matchSignalHits,
  resolveOffer,
  type ObservedSignal,
} from "./offers.js";
import { writeArmCache } from "./armCache.js";

/** Drain tick interval. */
export const DRAIN_INTERVAL_MS = 30_000;

/** How long a `pre` may dangle without its `post` before it counts as failed. */
export const PRE_DANGLE_TIMEOUT_MS = 5 * 60 * 1_000;

/** An unmatched PreToolUse line held in memory awaiting its post (or timeout). */
interface DanglingPre {
  readonly line: SpoolLine;
  readonly heldSinceMs: number;
}

/**
 * Project one spool line into an {@link ObservedSignal}. The raw `input`/`path`
 * strings ride along ONLY for matching; `matchSignalHits` is their last stop.
 */
const toSignal = (line: SpoolLine, success: boolean): ObservedSignal => {
  const tool = line.tool;
  const isMcp = tool !== undefined && tool.startsWith("mcp__");
  return {
    ...(tool !== undefined && !isMcp ? { toolName: tool } : {}),
    ...(tool !== undefined && isMcp ? { mcpTool: tool } : {}),
    success,
    ...(line.id !== undefined ? { toolUseId: line.id } : {}),
    ...(line.input !== undefined ? { inputText: line.input } : {}),
    ...(line.path !== undefined ? { filePath: line.path } : {}),
    ...(line.event !== undefined ? { event: line.event } : {}),
  };
};

/**
 * One drain pass for accumulated spool lines of a single session: correlate
 * pre/post, time out dangling pres, and return the drained signals.
 * `pending` is mutated (it is the per-session in-memory dangle store).
 */
export const correlateLines = (
  lines: readonly SpoolLine[],
  pending: Map<string, DanglingPre>,
  nowMs: number,
): ObservedSignal[] => {
  const signals: ObservedSignal[] = [];

  for (const line of lines) {
    if (line.kind === "post") {
      // A post proves success; consume its pre (if held) and signal once.
      if (line.id !== undefined) pending.delete(line.id);
      signals.push(toSignal(line, true));
    } else if (line.kind === "pre") {
      if (line.id !== undefined) {
        pending.set(line.id, { line, heldSinceMs: nowMs });
      }
      // A pre without an id can never correlate — ignore it.
    } else {
      // Non-tool hook events are their own signals (SubagentStop, ...).
      signals.push(toSignal(line, true));
    }
  }

  // Time out dangling pres → failure signals.
  for (const [id, held] of pending) {
    if (nowMs - held.heldSinceMs >= PRE_DANGLE_TIMEOUT_MS) {
      pending.delete(id);
      signals.push(toSignal(held.line, false));
    }
  }

  return signals;
};

/** Dependencies injectable for tests. */
export interface DrainDeps {
  readonly loadTopics: () => Promise<readonly Topic[]>;
  readonly tool: () => ToolId | undefined;
  readonly now: () => Date;
}

/** Per-session in-memory dangle stores, keyed by sessionId. */
const dangleStores = new Map<string, Map<string, DanglingPre>>();

const dangleStoreFor = (sessionId: string): Map<string, DanglingPre> => {
  let store = dangleStores.get(sessionId);
  if (store === undefined) {
    store = new Map();
    dangleStores.set(sessionId, store);
  }
  return store;
};

/**
 * Run one drain pass: claim spools, correlate, match, arm. Sessions with no
 * spool file still get a quiet-promotion check when they hold a pending offer
 * and dangling state exists — covered by calling `applyDrainBatch` with an
 * empty hit batch for every session that has in-memory dangle state or a
 * pending offer (cheap: profile is already loaded inside the update closure).
 *
 * Never throws: every failure is logged and swallowed — an intake fault must
 * never take down the MCP server.
 */
export const drainOnce = async (deps: DrainDeps): Promise<void> => {
  try {
    const spools = await claimSpools();
    const now = deps.now();
    const nowMs = now.getTime();

    // Correlate per session (also times out dangles for spool-less sessions).
    const signalsBySession = new Map<string, ObservedSignal[]>();
    for (const spool of spools) {
      const store = dangleStoreFor(spool.sessionId);
      signalsBySession.set(
        spool.sessionId,
        correlateLines(spool.lines, store, nowMs),
      );
    }
    for (const [sessionId, store] of dangleStores) {
      if (!signalsBySession.has(sessionId) && store.size > 0) {
        signalsBySession.set(sessionId, correlateLines([], store, nowMs));
      }
    }

    if (signalsBySession.size === 0 && dangleStores.size === 0) return;

    const topics = await deps.loadTopics();
    const tool = deps.tool();
    const titleByKey = new Map<AbilityKey, string>(
      topics.map((t) => [abilityKey(t.class, t.id), t.title]),
    );

    await updateProfile((profile) => {
      const config = profile.config;
      if (config === undefined || config.offerCadence === "off") return profile;
      const cadence = config.offerCadence;
      const params = eagernessParams(config.organicEagerness);

      const next = { ...profile, organicSessions: { ...profile.organicSessions } };

      // Every session with signals — plus every persisted session holding a
      // pending offer (quiet-promotion needs ticks even without new signals).
      const sessionIds = new Set<string>([
        ...signalsBySession.keys(),
        ...Object.entries(profile.organicSessions)
          .filter(([, s]) => s.pending !== undefined)
          .map(([sid]) => sid),
      ]);

      for (const sessionId of sessionIds) {
        const signals = signalsBySession.get(sessionId) ?? [];
        // PRIVACY: raw input/path strings end their journey inside
        // matchSignalHits — hits carry only derived data.
        const hits = matchSignalHits(topics, tool, signals);
        const session: OrganicSession =
          next.organicSessions[sessionId] ?? { evidence: [] };
        const { state, armKey } = applyDrainBatch(session, hits, params, now);
        next.organicSessions[sessionId] = state;

        if (armKey === undefined) continue;

        // Existing gates still rule: cooldown/work-after-quiz + cadence stack.
        const arm = next.offerArms[sessionId] ?? {};
        if (!canArm(arm, now)) continue;
        const ledger = ledgerForSession(next.offers, sessionId);
        const decision = resolveOffer(
          {
            proactiveOffers: next.config?.proactiveOffers ?? false,
            offerCadence: cadence,
            ledger,
            backoff: next.backoff,
            candidates: [armKey],
          },
          now,
        );
        if (decision.kind !== "offer") continue;

        const title = titleByKey.get(armKey) ?? armKey;
        const armed = armSession(armKey, title, now, arm);
        next.offerArms = { ...next.offerArms, [sessionId]: armed };
        next.offers = markOffered(ledger, armKey);
        // Fire-and-forget: cache write failures are logged inside, and the
        // profile remains the source of truth.
        void writeArmCache(sessionId, armed);
        debug("drain: armed organic offer", { sessionId, key: armKey });
      }

      return next;
    });
  } catch (err) {
    debug("drain: pass failed", { err: String(err) });
  }
};

/** Handle for a running drain timer. */
export interface DrainTimer {
  stop(): void;
}

/**
 * Start the periodic drain. The interval is `unref()`d so the timer never
 * keeps the process alive; call `stop()` on shutdown paths that outlive it.
 */
export const startDrainTimer = (deps: DrainDeps): DrainTimer => {
  const interval = setInterval(() => {
    void drainOnce(deps);
  }, DRAIN_INTERVAL_MS);
  interval.unref();
  return {
    stop: (): void => {
      clearInterval(interval);
    },
  };
};
