/**
 * @file Organic arming state machine: evidence → pending → armed.
 *
 * Pure decision core for the drain pipeline (observation/drain.ts). Takes the
 * per-session organic state, a batch of drain-time {@link SignalHit}s, and the
 * eagerness preset, and returns the updated state plus an arming decision.
 * No IO, no clock reads — `now` is injected — mirroring the offers.ts style.
 *
 * State machine (agreed design):
 *
 *   evidence ledger  --threshold crossed-->  PENDING  --seam signal-->  ARMED
 *        ^                                      |            (or quiet-promotion:
 *        |                                      |             no signals for
 *   rolling window prune                        +--window expiry--> (dropped)
 *                                                            QUIET_PROMOTION_SECONDS)
 *
 * Phases:
 *  - `start` signals add evidence AND hold promotion (they prove the user is
 *    heads-down; quiet-promotion timing restarts like any signal arrival).
 *  - `during` signals add evidence.
 *  - `seam` signals add evidence and PROMOTE any pending offer. A seam signal
 *    with `bypass: true` (⚡) can arm its own topic immediately, subject to the
 *    preset's bypass rules.
 *
 * Threshold semantics: evidence WEIGHT (not count) accumulated per topic within
 * the rolling window must reach `params.threshold`. Failure ×2 is already baked
 * into hit weights by `matchSignalHits`.
 */

import type { AbilityKey } from "../schemas/common.js";
import type {
  EvidenceEntry,
  OrganicSession,
  PendingOffer,
} from "../schemas/profile.js";
import type { SignalHit } from "./offers.js";
import { quietPromotionSeconds, type EagernessParams } from "./eagerness.js";

/** The outcome of applying one drain batch to a session's organic state. */
export interface ArmingDecision {
  /** The updated per-session organic state (persist this). */
  readonly state: OrganicSession;
  /** When set, the drain should arm this topic for the session NOW. */
  readonly armKey: AbilityKey | undefined;
}

/** Sum of in-window evidence weight for one topic. */
const evidenceWeight = (
  evidence: readonly EvidenceEntry[],
  key: AbilityKey,
): number =>
  evidence.reduce((sum, e) => (e.key === key ? sum + e.weight : sum), 0);

/**
 * Per-key in-window evidence weight for one session's ledger. Used by the
 * drain to build the sibling-session (external) weight map that
 * {@link applyDrainBatch} folds into threshold checks.
 */
export const inWindowWeightByKey = (
  evidence: readonly EvidenceEntry[],
  now: Date,
  windowSeconds: number,
): Map<AbilityKey, number> => {
  const weights = new Map<AbilityKey, number>();
  for (const e of pruneEvidence(evidence, now, windowSeconds)) {
    weights.set(e.key, (weights.get(e.key) ?? 0) + e.weight);
  }
  return weights;
};

/** Prune ledger entries older than the rolling window. */
const pruneEvidence = (
  evidence: readonly EvidenceEntry[],
  now: Date,
  windowSeconds: number,
): EvidenceEntry[] => {
  const cutoff = now.getTime() - windowSeconds * 1_000;
  return evidence.filter((e) => Date.parse(e.timestamp) >= cutoff);
};

/** Drop a pending offer that has outlived the rolling window. */
const pruneExpiredPending = (
  pending: PendingOffer | undefined,
  now: Date,
): PendingOffer | undefined =>
  pending !== undefined && Date.parse(pending.expiresAt) <= now.getTime()
    ? undefined
    : pending;

/**
 * Apply a drained batch of hits to one session's organic state.
 *
 * Order of operations:
 *  1. Prune the ledger to the rolling window; expire a stale pending offer.
 *  2. QUIET-PROMOTION check (before ingesting this batch): if a pending offer
 *     exists and the gap between the batch's earliest signal and the previous
 *     `lastSignalAt` exceeds {@link QUIET_PROMOTION_SECONDS}, the turn ended —
 *     promote the pending offer. (An empty batch with a silent gap measured
 *     against `now` also promotes; the drain calls with `hits = []` for that.)
 *  3. Ingest hits into the ledger (all phases add evidence).
 *  4. ⚡ BYPASS: a seam hit with `bypass: true` arms its topic immediately when
 *     the preset allows bypasses and (if required) prior evidence for that
 *     topic existed before this batch.
 *  5. SEAM promotion: any seam-phase hit promotes an existing pending offer.
 *  6. THRESHOLD: topics whose in-window weight now crosses the threshold become
 *     pending (held until a seam or quiet gap) — unless something already armed
 *     this call. `start`-phase hits in the batch hold promotion but still count.
 *
 * At most ONE topic arms per call (armKey). Ties resolve to the topic with the
 * highest in-window weight.
 */
export const applyDrainBatch = (
  session: OrganicSession,
  hits: readonly SignalHit[],
  params: EagernessParams,
  now: Date,
  externalWeight: ReadonlyMap<AbilityKey, number> = new Map(),
): ArmingDecision => {
  let evidence = pruneEvidence(session.evidence, now, params.windowSeconds);
  let pending = pruneExpiredPending(session.pending, now);
  let armKey: AbilityKey | undefined;

  // --- 2. Quiet-promotion (gap since last signal, measured before this batch).
  const lastSignalMs =
    session.lastSignalAt !== undefined
      ? Date.parse(session.lastSignalAt)
      : undefined;
  const batchStartMs =
    hits.length > 0
      ? Math.min(...hits.map(() => now.getTime())) // Hits carry no per-hit clock; the drain batch time is `now`.
      : now.getTime();
  if (
    pending !== undefined &&
    lastSignalMs !== undefined &&
    batchStartMs - lastSignalMs >= quietPromotionSeconds() * 1_000
  ) {
    armKey = pending.key;
    pending = undefined;
  }

  // --- 3. Ingest hits into the ledger.
  const priorWeightByKey = new Map<AbilityKey, number>();
  for (const hit of hits) {
    if (!priorWeightByKey.has(hit.key)) {
      priorWeightByKey.set(hit.key, evidenceWeight(evidence, hit.key));
    }
  }
  const nowIso = now.toISOString();
  evidence = evidence.concat(
    hits.map((hit, i) => ({
      key: hit.key,
      weight: hit.weight,
      phase: hit.phase,
      success: hit.success,
      timestamp: nowIso,
      correlationId:
        hit.correlationId !== "" ? hit.correlationId : `drain:${nowIso}#${i}`,
    })),
  );

  // --- 4. ⚡ Bypass arming.
  if (armKey === undefined && params.bypass) {
    const bypassHit = hits.find(
      (h) =>
        h.phase === "seam" &&
        h.bypass &&
        (!params.bypassNeedsPriorEvidence ||
          (priorWeightByKey.get(h.key) ?? 0) +
            (externalWeight.get(h.key) ?? 0) >
            0),
    );
    if (bypassHit !== undefined) {
      armKey = bypassHit.key;
      if (pending?.key === bypassHit.key) pending = undefined;
    }
  }

  // --- 5. Seam promotion of an existing pending offer.
  if (armKey === undefined && pending !== undefined) {
    const seamArrived = hits.some((h) => h.phase === "seam");
    if (seamArrived) {
      armKey = pending.key;
      pending = undefined;
    }
  }

  // --- 6. Threshold crossing → pending (only when nothing armed this call and
  // no pending offer already waits; one pending at a time keeps offers scarce).
  if (armKey === undefined && pending === undefined) {
    let best: { key: AbilityKey; weight: number } | undefined;
    // Sibling-session evidence (same home, different session id) counts toward
    // the threshold: concurrent sessions in one project split hook signals
    // across session ids, and without merging neither pot ever crosses. Own
    // evidence still gates candidacy — a topic with zero in-session signals is
    // never armed here purely on external weight (that would let one session's
    // activity arm every idle sibling).
    const keys = new Set(evidence.map((e) => e.key));
    for (const key of keys) {
      const weight =
        evidenceWeight(evidence, key) + (externalWeight.get(key) ?? 0);
      if (weight >= params.threshold && (best === undefined || weight > best.weight)) {
        best = { key, weight };
      }
    }
    if (best !== undefined) {
      pending = {
        key: best.key,
        createdAt: nowIso,
        expiresAt: new Date(
          now.getTime() + params.windowSeconds * 1_000,
        ).toISOString(),
      };
    }
  }

  const state: OrganicSession = {
    evidence,
    lastSignalAt: hits.length > 0 ? nowIso : session.lastSignalAt,
    ...(pending !== undefined ? { pending } : {}),
  };
  return { state, armKey };
};
