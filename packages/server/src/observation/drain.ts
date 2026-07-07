/**
 * @file Drain pipeline: the resident server's autonomous organic intake.
 *
 * Every {@link drainIntervalMs} (default 15s, `VIBE_HERO_DRAIN_INTERVAL_MS`
 * to tune) the server claims pending spool files
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
import { applyDrainBatch, inWindowWeightByKey } from "./arming.js";
import { eagernessParams } from "./eagerness.js";
import {
  armSession,
  canArm,
  isArmExpired,
  ledgerForSession,
  matchSignalHits,
  resolveOffer,
  type ObservedSignal,
} from "./offers.js";
import { writeArmCache } from "./armCache.js";
import type { AbilityKey as EvidenceKey } from "../schemas/common.js";

/** Default drain tick interval. Idle ticks cost one readdir, so a short
 * interval is cheap; 15s keeps spool-to-evidence lag low without churn. */
export const DEFAULT_DRAIN_INTERVAL_MS = 15_000;

/** Lower bound on the drain interval — a sub-second timer is pure churn. */
export const MIN_DRAIN_INTERVAL_MS = 1_000;

/** Upper bound (10 min) — beyond this the intake is effectively off. */
export const MAX_DRAIN_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Resolve the drain tick interval from `VIBE_HERO_DRAIN_INTERVAL_MS`, clamped
 * to [{@link MIN_DRAIN_INTERVAL_MS}, {@link MAX_DRAIN_INTERVAL_MS}]. Falls back
 * to {@link DEFAULT_DRAIN_INTERVAL_MS} when unset or unparseable. Read once at
 * timer start — changing the env var requires a server restart.
 */
export const drainIntervalMs = (): number => {
  const raw = process.env["VIBE_HERO_DRAIN_INTERVAL_MS"];
  if (raw === undefined || raw === "") return DEFAULT_DRAIN_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DRAIN_INTERVAL_MS;
  return Math.min(Math.max(Math.trunc(n), MIN_DRAIN_INTERVAL_MS), MAX_DRAIN_INTERVAL_MS);
};

/**
 * Backward-compatible alias for the default interval (tests and older callers
 * import this name).
 */
export const DRAIN_INTERVAL_MS = DEFAULT_DRAIN_INTERVAL_MS;

/**
 * Age after which a session's organic state (evidence ledger, pending offer,
 * arm) is considered abandoned and pruned from the profile: no signal for 24h
 * means the Claude Code session is gone — session ids are never reused.
 */
export const SESSION_PRUNE_MS = 24 * 60 * 60 * 1_000;

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

      // HYGIENE PASS 1 — prune abandoned sessions: no signal for
      // SESSION_PRUNE_MS means the host session is gone (ids are never
      // reused). Drops the evidence ledger, pending offer, AND the arm so
      // profile.offerArms cannot grow forever.
      for (const [sid, s] of Object.entries(next.organicSessions)) {
        const lastMs =
          s.lastSignalAt !== undefined ? Date.parse(s.lastSignalAt) : undefined;
        if (lastMs !== undefined && now.getTime() - lastMs >= SESSION_PRUNE_MS) {
          delete next.organicSessions[sid];
          if (next.offerArms[sid] !== undefined) {
            const arms = { ...next.offerArms };
            delete arms[sid];
            next.offerArms = arms;
          }
        }
      }

      // HYGIENE PASS 2 — expire stale arms (isArmExpired was previously
      // dead code; the module comments always claimed the server pruned).
      // An expired arm is dropped from the profile and its hook cache is
      // overwritten cleared so the relay falls silent.
      for (const [sid, arm] of Object.entries(next.offerArms)) {
        if (arm.armedKey !== undefined && isArmExpired(arm, now)) {
          const cleared = {
            lastOfferAt: arm.lastOfferAt,
            lastQuizAt: arm.lastQuizAt,
            hasWorkSinceLastQuiz: arm.hasWorkSinceLastQuiz,
          };
          next.offerArms = { ...next.offerArms, [sid]: cleared };
          void writeArmCache(sid, cleared);
          debug("drain: expired stale arm", { sessionId: sid });
        }
      }

      // Every session with signals — plus every persisted session holding a
      // pending offer (quiet-promotion needs ticks even without new signals).
      const sessionIds = new Set<string>([
        ...signalsBySession.keys(),
        ...Object.entries(next.organicSessions)
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
        // SIBLING EVIDENCE: concurrent sessions against one home (e.g. two
        // Claude Code windows in the same project) split hook signals across
        // session ids, so no single pot may ever cross the threshold. Fold the
        // in-window weight of every OTHER session into this one's threshold
        // check. Arms stay strictly per-session: a session still needs its own
        // evidence for a topic to become pending (see applyDrainBatch), and
        // each sibling gets the same boost on its own drain turn — sharing
        // evidence weight is not a race, it is double-counting by design.
        const externalWeight = new Map<EvidenceKey, number>();
        for (const [sid, s] of Object.entries(next.organicSessions)) {
          if (sid === sessionId) continue;
          for (const [k, w] of inWindowWeightByKey(
            s.evidence,
            now,
            params.windowSeconds,
          )) {
            externalWeight.set(k, (externalWeight.get(k) ?? 0) + w);
          }
        }
        const { state, armKey } = applyDrainBatch(
          session,
          hits,
          params,
          now,
          externalWeight,
        );
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
        // Do NOT markOffered here: arming is not surfacing. The cadence caps
        // must count offers the agent actually presented, which happens when
        // get_offer returns the armed key — get_offer marks it then. Marking
        // at arm time made the later get_offer confirmation look like a
        // repeat (per_topic cap) and inflated offersThisSession without any
        // offer reaching the user. Only persist the session rollover.
        if (ledger.sessionId !== next.offers.sessionId) next.offers = ledger;
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
  }, drainIntervalMs());
  interval.unref();
  return {
    stop: (): void => {
      clearInterval(interval);
    },
  };
};
