/**
 * @file Offer engine (T035) — cadence + anti-fatigue decision logic.
 *
 * This is the brain behind the observation → offer pipeline. It does two
 * trigger-only jobs (it NEVER scores — FR-005 / SC-003):
 *
 *  1. **Match** derived activity signals to candidate topic keys by scanning the
 *     loaded topics' {@link TriggerSignal}s ({@link matchCandidates}).
 *  2. **Decide** whether an offer may surface at an end-of-work breakpoint, and
 *     for which key, honoring the configured cadence and the full anti-fatigue
 *     stack ({@link resolveOffer}) — within-session decline suppression
 *     (FR-020), configurable cadence off / per_session / per_topic (FR-020a),
 *     and cross-session decline backoff + global mute (FR-020b).
 *
 * Design: the decision core is **pure**. {@link resolveOffer},
 * {@link matchCandidates}, {@link applyDecline}, and {@link applyAccept} take
 * plain state + a `now` timestamp and return plain results — no IO, no clock, no
 * randomness — so they are trivially testable and deterministic. The tool layer
 * (`tools/offers.ts`, `tools/recordObservation.ts`) is the thin wrapper that
 * reads the clock, loads the catalog, and persists via `updateProfile`.
 *
 * Arm/cache data-flow (UserPromptSubmit redesign):
 *   The MCP server (running as the agent's live connection) is the ONLY writer
 *   of arm state. On each `get_offer` call that resolves a real offer, the tool
 *   layer calls `armSession`, persists the result into `profile.offerArms[sid]`,
 *   and writes a cheap /tmp cache file. The UserPromptSubmit hook reads ONLY
 *   that /tmp file — no npx, no node spawn on the prompt path. On quiz start,
 *   decline, or defer, the tool layer calls `clearArm` to reset the arm and
 *   stamp `lastOfferAt` so the cooldown restarts. Arms also expire autonomously:
 *   `isArmExpired` returns true once the cooldown window has elapsed since the
 *   arm was written (user abandoned the session); re-arming resumes next call.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-005, FR-015..017,
 * FR-019/020/020a/020b, SC-003), specs/001-vibe-hero-mvp/data-model.md
 * (§ OfferLedger), specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`record_observation` / `get_offer` / `record_offer_response`),
 * src/config.ts (ASSESSMENT_CONFIG.declineMuteThreshold / backoff*).
 */

import { ASSESSMENT_CONFIG } from "../config.js";
import { abilityKey, type AbilityKey, type ToolId } from "../schemas/common.js";
import type {
  Config,
  OfferArm,
  OfferBackoff,
  OfferLedger,
} from "../schemas/profile.js";
import type { Topic, TriggerSignal } from "../schemas/content.js";
import type { OfferCandidate } from "../schemas/tools.js";

// ---------------------------------------------------------------------------
// Cooldown helpers (pure — read env once per call; no IO)
// ---------------------------------------------------------------------------

/** Default cooldown window in seconds (matches the legacy Stop-hook default). */
export const DEFAULT_COOLDOWN_SECONDS = 900;

/**
 * Upper bound on the cooldown window (7 days). Guards against an absurd value
 * (e.g. a typo like `9999999999999999999`) silently muting offers effectively
 * forever — the arm would never expire and no new offer could ever surface.
 */
export const MAX_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

/**
 * Lower bound on a POSITIVE cooldown window (60 s). A tiny positive typo (e.g.
 * `1`) would let offers surface almost every turn — spammy. `0` is left
 * untouched: it is the explicit "no throttle" sentinel the hook/tests rely on.
 */
export const MIN_COOLDOWN_SECONDS = 60;

/**
 * Read the configured cooldown window in seconds from the environment
 * (`VIBE_HERO_OFFER_COOLDOWN_SECONDS`). Falls back to 900 s (15 min); clamps to
 * {@link MAX_COOLDOWN_SECONDS} so an outsized value cannot mute offers
 * indefinitely; and floors a positive value to {@link MIN_COOLDOWN_SECONDS} so a
 * tiny typo cannot spam offers. `0` is preserved as the explicit no-throttle
 * value. Pure.
 */
export const cooldownSeconds = (): number => {
  const raw = process.env["VIBE_HERO_OFFER_COOLDOWN_SECONDS"];
  if (raw === undefined || raw === "") return DEFAULT_COOLDOWN_SECONDS;
  const n = Number(raw);
  // Math.trunc so fractional values (e.g. 900.5) never reach the cache JSON as
  // a float — the hook does POSIX integer arithmetic on cooldownSeconds and
  // `$((900.5 * 1))` crashes under set -eu on every prompt.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COOLDOWN_SECONDS;
  const secs = Math.min(Math.trunc(n), MAX_COOLDOWN_SECONDS);
  // Preserve 0 (no throttle); floor any other positive value to the minimum.
  return secs === 0 ? 0 : Math.max(secs, MIN_COOLDOWN_SECONDS);
};

/**
 * Whether the offer cooldown throttle is disabled — i.e. the resolved
 * {@link cooldownSeconds} is `0`, the explicit "no throttle" sentinel. A small
 * named predicate so callers don't hard-code the `=== 0` comparison. Pure.
 */
export const isThrottleDisabled = (): boolean => cooldownSeconds() === 0;

// ---------------------------------------------------------------------------
// Arm lifecycle helpers (pure — no IO, clock injected as `now: Date`)
// ---------------------------------------------------------------------------

/**
 * Write an armed offer into the per-session arm record. Called by `get_offer`
 * when it resolves a real offer: records the key + title + arm timestamp so
 * the hook can read the /tmp cache WITHOUT calling back to the server. Also
 * stamps `lastOfferAt` to start the cooldown clock.
 *
 * Preserves `lastQuizAt` and `hasWorkSinceLastQuiz` from the existing arm so
 * the semantic "work-after-quiz" history is not lost when the arm refreshes.
 *
 * Pure: returns the updated {@link OfferArm}. The tool layer persists it.
 *
 * @param key      - The resolved offer key.
 * @param title    - Human-readable topic title (cached in the arm for the hook).
 * @param now      - The arm instant.
 * @param existing - The existing arm record (carry forward quiz/work history).
 */
export const armSession = (
  key: AbilityKey,
  title: string,
  now: Date,
  existing: OfferArm = {},
): OfferArm => ({
  armedKey: key,
  armedTitle: title,
  armedAt: now.toISOString(),
  // IMPORTANT: do NOT stamp lastOfferAt to now here. lastOfferAt records the
  // last quiz/decline/defer event time (the "cooldown clock start") and is only
  // written by clearArmOnQuiz and clearArm. Setting it to now would make the
  // two gates mutually exclusive:
  //   - expiry gate fires when (now - armedAt) >= cooldown (arm abandoned)
  //   - cooldown gate fires when (now - lastOfferAt) < cooldown
  // With armedAt == lastOfferAt the hook is silent at every instant: before
  // cooldown elapses it's within-cooldown; at/after cooldown the arm expires.
  // Correct: carry forward the existing lastOfferAt (undefined on a fresh arm
  // → hook can emit immediately; set by prior quiz/decline → cooldown enforced).
  lastOfferAt: existing.lastOfferAt,
  // Carry forward quiz/work history so it isn't erased by re-arming.
  lastQuizAt: existing.lastQuizAt,
  hasWorkSinceLastQuiz: existing.hasWorkSinceLastQuiz,
});

/**
 * Clear the arm for a session on quiz start, preserving `lastOfferAt` to
 * enforce the cooldown before the next re-arm, and stamping `lastQuizAt` to
 * start the semantic "work-required-after-quiz" gate. `hasWorkSinceLastQuiz`
 * is reset to `false` so the next arm requires a real work signal first.
 *
 * Called when a quiz STARTS (not just offered). Pure.
 *
 * @param _existing - The current arm (intentionally replaced except cooldown).
 * @param now       - The quiz-start instant.
 */
export const clearArmOnQuiz = (_existing: OfferArm, now: Date): OfferArm => ({
  lastOfferAt: now.toISOString(),
  lastQuizAt: now.toISOString(),
  hasWorkSinceLastQuiz: false,
});

/**
 * Clear the arm for a session on decline or defer, preserving `lastOfferAt`
 * for the cooldown but NOT stamping `lastQuizAt` (the user didn't do a quiz).
 * Carry forward `lastQuizAt` and `hasWorkSinceLastQuiz` so the semantic gate
 * remains intact.
 *
 * Called when the user declines or defers an offer. Pure.
 *
 * @param existing - The current arm (lastQuizAt/hasWorkSinceLastQuiz carried).
 * @param now      - The decline/defer instant.
 */
export const clearArm = (existing: OfferArm, now: Date): OfferArm => ({
  lastOfferAt: now.toISOString(),
  // Carry forward quiz/work state so the semantic gate isn't reset by a decline.
  lastQuizAt: existing.lastQuizAt,
  hasWorkSinceLastQuiz: existing.hasWorkSinceLastQuiz,
});

/**
 * Mark that a real work/activity signal has arrived for this session after
 * `lastQuizAt`, satisfying the semantic "intervening work" gate. The tool
 * layer calls this from `record_observation` for each session that has
 * `lastQuizAt` set and `hasWorkSinceLastQuiz` not yet true.
 *
 * The signal chosen for "real work" is a `record_observation` call — it is
 * already the canonical activity intake path; tying the gate to it requires
 * no new hook or API surface. Pure.
 *
 * @param existing - The current arm.
 * @returns The updated arm with `hasWorkSinceLastQuiz = true`.
 */
export const markWorkSinceQuiz = (existing: OfferArm): OfferArm => ({
  ...existing,
  hasWorkSinceLastQuiz: true,
});

/**
 * True when the arm is set but `armedAt` is older than the cooldown window.
 * An expired arm means the user left the session without acting; it expires
 * silently so re-arming can resume on the next `get_offer`.
 *
 * Pure: `armedAt` absent ⇒ false (nothing to expire).
 */
export const isArmExpired = (arm: OfferArm, now: Date): boolean => {
  const { armedAt } = arm;
  if (armedAt === undefined) return false;
  const windowMs = cooldownSeconds() * 1_000;
  return now.getTime() - Date.parse(armedAt) >= windowMs;
};

/**
 * True when `lastOfferAt` is set and the cooldown window has NOT yet elapsed.
 * The server checks this before deciding to re-arm; the hook reads the same
 * value from the /tmp cache.
 *
 * Pure: `lastOfferAt` absent ⇒ false (cooldown not running).
 */
export const isWithinCooldown = (arm: OfferArm, now: Date): boolean => {
  const { lastOfferAt } = arm;
  if (lastOfferAt === undefined) return false;
  const windowMs = cooldownSeconds() * 1_000;
  return now.getTime() - Date.parse(lastOfferAt) < windowMs;
};

/**
 * True when arming is semantically permitted for this session.
 *
 * Two layers of gates (both must pass):
 *  1. TIMER: cooldown window since `lastOfferAt` has elapsed (or never set).
 *  2. SEMANTIC: either no quiz has been done this session (`lastQuizAt` absent),
 *     OR at least one real work signal has arrived after `lastQuizAt`
 *     (`hasWorkSinceLastQuiz === true`).
 *
 * This prevents immediately re-offering after a quiz regardless of how much
 * wall-clock time passes — the user must actually DO some work first.
 * Pure: no IO.
 */
export const canArm = (arm: OfferArm, now: Date): boolean => {
  // Timer gate: cooldown must have elapsed.
  if (isWithinCooldown(arm, now)) return false;
  // Semantic gate: if a quiz was done, require intervening work first.
  if (arm.lastQuizAt !== undefined && !arm.hasWorkSinceLastQuiz) return false;
  return true;
};

/**
 * A single derived activity signal as accepted by `record_observation`. Mirrors
 * the privacy-safe {@link DerivedSignal} projection — `toolName` (host tool name
 * e.g. `"Bash"`), an optional `mcpTool` (an MCP tool name e.g.
 * `"mcp__github__create_pr"`), an optional derived `success`, and an optional
 * `toolUseId` for correlation. Trigger-only: success/ids never affect scoring.
 */
export interface ObservedSignal {
  readonly toolName?: string;
  readonly mcpTool?: string;
  readonly success?: boolean;
  readonly toolUseId?: string;
}

/**
 * Does a single {@link TriggerSignal} match a single {@link ObservedSignal} for
 * the given tool? A match requires the tool to agree and at least one of the
 * signal's selectors to hit:
 *  - `match.toolName` — exact (case-sensitive) equality against `signal.toolName`.
 *  - `match.toolNamePattern` — regex tested against `signal.toolName`.
 *  - `match.mcpToolPattern` — regex tested against `signal.mcpTool`.
 *
 * A malformed regex pattern fails closed (no match) rather than throwing — a bad
 * trigger declaration must never crash the observation intake path.
 */
const triggerMatchesSignal = (
  trigger: TriggerSignal,
  signal: ObservedSignal,
): boolean => {
  const { match } = trigger;

  if (
    match.toolName !== undefined &&
    signal.toolName !== undefined &&
    match.toolName === signal.toolName
  ) {
    return true;
  }

  if (match.toolNamePattern !== undefined && signal.toolName !== undefined) {
    if (safeRegexTest(match.toolNamePattern, signal.toolName)) return true;
  }

  if (match.mcpToolPattern !== undefined && signal.mcpTool !== undefined) {
    if (safeRegexTest(match.mcpToolPattern, signal.mcpTool)) return true;
  }

  return false;
};

/** Test `pattern` against `value`, failing closed on an invalid regex. */
const safeRegexTest = (pattern: string, value: string): boolean => {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
};

/**
 * Match derived signals against the loaded topics' trigger declarations and
 * return the distinct candidate topics (deduped by {@link AbilityKey}, in
 * topic-iteration order). Trigger-only (FR-015): this selects *which topic to
 * offer* and never scores.
 *
 * Only triggers whose `tool` equals the observation's `tool` are considered, so
 * a Claude Code Bash signal never trips a Codex topic. A topic with no matching
 * trigger is omitted.
 *
 * @param topics - The loaded catalog topics (each carrying `triggerSignals`).
 * @param tool - The host tool the activity belongs to.
 * @param signals - The derived signals observed this turn.
 * @returns The distinct offer candidates `{ key, title, reason }`.
 */
export const matchCandidates = (
  topics: readonly Topic[],
  tool: ToolId | undefined,
  signals: readonly ObservedSignal[],
): OfferCandidate[] => {
  const candidates: OfferCandidate[] = [];
  const seen = new Set<AbilityKey>();

  for (const topic of topics) {
    const key = abilityKey(topic.class, topic.id);
    if (seen.has(key)) continue;

    // Find a trigger for THIS tool that some observed signal satisfies.
    const hit = topic.triggerSignals.find(
      (trigger) =>
        trigger.tool === tool &&
        signals.some((signal) => triggerMatchesSignal(trigger, signal)),
    );
    if (hit === undefined) continue;

    seen.add(key);
    candidates.push({
      key,
      title: topic.title,
      reason: describeMatch(hit),
    });
  }

  return candidates;
};

/** A short, privacy-safe human reason for why a topic became a candidate. */
const describeMatch = (trigger: TriggerSignal): string => {
  const { match } = trigger;
  if (match.toolName !== undefined) {
    return `Observed ${match.toolName} activity, which exercises this topic.`;
  }
  if (match.toolNamePattern !== undefined) {
    return `Observed tool activity matching this topic's trigger.`;
  }
  return `Observed MCP tool activity matching this topic's trigger.`;
};

/**
 * Why an offer was suppressed, mirroring the `get_offer` contract's
 * `suppressed` enum. `cadence` covers the per_session / per_topic exhaustion and
 * the cross-session backoff/mute cases.
 */
export type SuppressionReason =
  | "offers_off"
  | "declined"
  | "cadence"
  | "no_candidate";

/** A resolved offer decision: either a chosen key, or a suppression reason. */
export type OfferDecision =
  | { readonly kind: "offer"; readonly key: AbilityKey }
  | { readonly kind: "suppressed"; readonly reason: SuppressionReason };

/**
 * The full state the pure {@link resolveOffer} decision needs. Bundles the
 * relevant config flags, the current per-session ledger, the cross-session
 * backoff, and the ordered candidate keys (most-relevant first) for the session.
 */
export interface OfferState {
  /** Master proactive-offers switch (FR-031); `false` ⇒ never offer. */
  readonly proactiveOffers: boolean;
  /** Configured cadence (FR-020a). */
  readonly offerCadence: Config["offerCadence"];
  /** The current per-session offer ledger (anti-fatigue, FR-020/020a). */
  readonly ledger: OfferLedger;
  /** Cross-session decline backoff + global mute (FR-020b). */
  readonly backoff: OfferBackoff;
  /**
   * Candidate keys eligible this turn, most-relevant first. Typically the
   * `offeredTopicKeys` accumulated by `record_observation`, or freshly matched
   * candidates. `resolveOffer` picks the first key that survives every gate.
   */
  readonly candidates: readonly AbilityKey[];
}

/**
 * Decide whether an end-of-work offer may surface, and for which key (FR-019
 * non-interrupting timing is the caller's concern; this is the *whether/which*).
 *
 * Gates, in order (first failure wins):
 *  1. `offerCadence === "off"` ⇒ `offers_off` (FR-020a).
 *  2. `proactiveOffers === false` ⇒ `offers_off` (master switch, FR-031).
 *  3. `mutedUntil` in the future ⇒ `cadence` (global mute, FR-020b).
 *  4. `declinedThisSession` ⇒ `declined` (within-session suppression, FR-020).
 *  5. `per_session` and an offer already surfaced this session ⇒ `cadence`
 *     (≤1 offer/session, FR-020a).
 *  6. No candidate keys at all ⇒ `no_candidate`.
 *  7. Otherwise pick the first candidate that is BOTH not already offered this
 *     session under `per_topic` (≤1 per distinct key/session, FR-020a) AND not
 *     within its cross-session `perTopicNextEligibleAt` backoff window
 *     (FR-020b). If none survives ⇒ `cadence`.
 *
 * Pure: no clock, no IO. `now` is supplied by the caller.
 *
 * @param state - The bundled offer state (config flags, ledger, backoff, candidates).
 * @param now - The current instant, for muted/backoff comparisons.
 * @returns An {@link OfferDecision}.
 */
export const resolveOffer = (state: OfferState, now: Date): OfferDecision => {
  const { proactiveOffers, offerCadence, ledger, backoff, candidates } = state;

  // 1 + 2: offers disabled entirely.
  if (offerCadence === "off" || !proactiveOffers) {
    return { kind: "suppressed", reason: "offers_off" };
  }

  // 3: global cross-session mute (FR-020b) — N consecutive declines reached.
  if (isMuted(backoff, now)) {
    return { kind: "suppressed", reason: "cadence" };
  }

  // 4: a decline this session suppresses the rest of the session (FR-020).
  if (ledger.declinedThisSession) {
    return { kind: "suppressed", reason: "declined" };
  }

  // 5: per_session cap — at most one offer for the whole session (FR-020a).
  if (offerCadence === "per_session" && ledger.offersThisSession >= 1) {
    return { kind: "suppressed", reason: "cadence" };
  }

  // 6: nothing to offer.
  if (candidates.length === 0) {
    return { kind: "suppressed", reason: "no_candidate" };
  }

  // 7: pick the first candidate clearing the per-topic + backoff gates.
  const alreadyOffered = new Set(ledger.offeredTopicKeys);
  for (const key of candidates) {
    if (offerCadence === "per_topic" && alreadyOffered.has(key)) {
      // ≤1 offer per distinct key this session (FR-020a).
      continue;
    }
    if (isBackedOff(backoff, key, now)) {
      // Within the cross-session re-offer window for this topic (FR-020b).
      continue;
    }
    return { kind: "offer", key };
  }

  // Every candidate was per-topic-exhausted or backed off.
  return { kind: "suppressed", reason: "cadence" };
};

/** Is `mutedUntil` set and still in the future at `now`? (Global mute, FR-020b.) */
const isMuted = (backoff: OfferBackoff, now: Date): boolean =>
  backoff.mutedUntil !== undefined &&
  Date.parse(backoff.mutedUntil) > now.getTime();

/**
 * Is `key` within its cross-session re-offer backoff window at `now`? A key with
 * no recorded `perTopicNextEligibleAt` entry is always eligible (FR-020b).
 */
const isBackedOff = (
  backoff: OfferBackoff,
  key: AbilityKey,
  now: Date,
): boolean => {
  const nextAt = backoff.perTopicNextEligibleAt[key];
  return nextAt !== undefined && Date.parse(nextAt) > now.getTime();
};

/**
 * The per-session ledger reset to a fresh `sessionId`. The cross-session backoff
 * is intentionally NOT reset here — it persists across sessions until an accept
 * resets it (FR-020b). Used by the tool layer when a new session begins.
 */
export const freshLedger = (sessionId: string): OfferLedger => ({
  sessionId,
  offersThisSession: 0,
  declinedThisSession: false,
  offeredTopicKeys: [],
  candidateKeys: [],
});

/**
 * Reconcile the persisted ledger with the session being observed/queried. If the
 * ledger's `sessionId` differs (or is the empty-string sentinel), the previous
 * session's per-session accounting is stale, so return a {@link freshLedger}.
 * Otherwise return the ledger unchanged. Pure.
 *
 * @param ledger - The persisted per-session ledger.
 * @param sessionId - The session id of the current request.
 */
export const ledgerForSession = (
  ledger: OfferLedger,
  sessionId: string,
): OfferLedger =>
  ledger.sessionId === sessionId ? ledger : freshLedger(sessionId);

/**
 * Record that an offer for `key` surfaced this session: bump the per-session
 * count and add the key to `offeredTopicKeys` (deduped). Pure; the tool layer
 * persists the result. Called when `get_offer` actually returns an offer so the
 * cadence caps are enforced on the *next* `get_offer`.
 */
export const markOffered = (
  ledger: OfferLedger,
  key: AbilityKey,
): OfferLedger => ({
  ...ledger,
  offersThisSession: ledger.offersThisSession + 1,
  offeredTopicKeys: ledger.offeredTopicKeys.includes(key)
    ? ledger.offeredTopicKeys
    : [...ledger.offeredTopicKeys, key],
});

/**
 * Merge freshly-matched candidate keys into the per-session ledger's candidate
 * pool (`candidateKeys`) without counting them as offered. `record_observation`
 * uses this to accumulate candidates across the session as signals arrive;
 * `get_offer` (which receives no signals) later resolves from this pool. New
 * candidates are appended in match order, deduped, after the existing pool so
 * the most-relevant-first ordering of a given turn is preserved. Does NOT touch
 * `offeredTopicKeys` or `offersThisSession` — a candidate is not an offer until
 * {@link markOffered}. Pure.
 *
 * @param ledger - The per-session ledger (already reconciled to this session).
 * @param keys - The candidate keys matched this turn (most-relevant first).
 */
export const noteCandidates = (
  ledger: OfferLedger,
  keys: readonly AbilityKey[],
): OfferLedger => {
  const pool = [...ledger.candidateKeys];
  const seen = new Set(pool);
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      pool.push(key);
    }
  }
  return { ...ledger, candidateKeys: pool };
};

/**
 * The result of applying a decline to the cross-session backoff (FR-020b): the
 * updated per-session ledger (decline flag set, suppressing the rest of the
 * session per FR-020) AND the updated cross-session backoff (consecutive count
 * bumped, this topic's next-eligible time pushed out by exponential backoff,
 * and a global mute set once `declineMuteThreshold` is reached).
 */
export interface DeclineResult {
  readonly ledger: OfferLedger;
  readonly backoff: OfferBackoff;
}

/**
 * Apply a decline for `key` (FR-020 within-session + FR-020b cross-session).
 *
 * Within-session (FR-020): set `declinedThisSession = true` so no further offer
 * surfaces for the rest of the session.
 *
 * Cross-session (FR-020b):
 *  - increment `consecutiveDeclines`;
 *  - push `perTopicNextEligibleAt[key]` out by an exponential backoff:
 *    `backoffBaseHours * backoffFactor^(consecutiveDeclines - 1)` hours from
 *    `now`, so each successive decline lengthens the re-offer interval;
 *  - once `consecutiveDeclines >= declineMuteThreshold`, set a global
 *    `mutedUntil` far in the future (offers globally muted until the user
 *    re-enables — modeled as a long horizon derived from the backoff).
 *
 * Pure: `now` and config are inputs; the tool layer persists the result.
 *
 * @param ledger - The current per-session ledger (for this session).
 * @param backoff - The current cross-session backoff.
 * @param key - The declined topic key.
 * @param now - The decline instant.
 * @param config - Tunables (decline mute threshold + backoff base/factor).
 * @returns The updated ledger + backoff.
 */
export const applyDecline = (
  ledger: OfferLedger,
  backoff: OfferBackoff,
  key: AbilityKey,
  now: Date,
  config: {
    declineMuteThreshold: number;
    backoffBaseHours: number;
    backoffFactor: number;
  } = ASSESSMENT_CONFIG,
): DeclineResult => {
  const consecutiveDeclines = backoff.consecutiveDeclines + 1;

  // Exponential per-topic backoff: base * factor^(n-1) hours from now.
  const backoffHours =
    config.backoffBaseHours *
    Math.pow(config.backoffFactor, consecutiveDeclines - 1);
  const nextEligibleAt = addHours(now, backoffHours).toISOString();

  const perTopicNextEligibleAt = {
    ...backoff.perTopicNextEligibleAt,
    [key]: nextEligibleAt,
  };

  // Global mute once the threshold is hit (FR-020b). Horizon: a generously long
  // multiple of the current backoff so offers stay muted until the user
  // re-enables / requests one.
  const muted = consecutiveDeclines >= config.declineMuteThreshold;
  const mutedUntil = muted
    ? addHours(now, backoffHours * MUTE_HORIZON_MULTIPLIER).toISOString()
    : backoff.mutedUntil;

  const nextBackoff: OfferBackoff = {
    consecutiveDeclines,
    perTopicNextEligibleAt,
    ...(mutedUntil !== undefined ? { mutedUntil } : {}),
  };

  const nextLedger: OfferLedger = {
    ...ledger,
    declinedThisSession: true,
  };

  return { ledger: nextLedger, backoff: nextBackoff };
};

/**
 * Multiplier applied to the current per-topic backoff to derive the global mute
 * horizon when the decline threshold is reached. A large multiple models
 * "muted until the user re-enables" without an unbounded/never-parses date.
 */
const MUTE_HORIZON_MULTIPLIER = 1000;

/**
 * Apply an accept (FR-020b): reset `consecutiveDeclines` to 0 and clear the
 * global `mutedUntil`. Per-topic backoff entries are left as-is (an accept on
 * one topic does not retroactively un-back-off unrelated topics, but the global
 * counter/mute reset means the user is engaged again). The per-session ledger is
 * unchanged by an accept. Pure.
 *
 * @param backoff - The current cross-session backoff.
 * @returns The reset backoff.
 */
export const applyAccept = (backoff: OfferBackoff): OfferBackoff => ({
  consecutiveDeclines: 0,
  perTopicNextEligibleAt: backoff.perTopicNextEligibleAt,
  // mutedUntil intentionally dropped (cleared).
});

/**
 * Apply a defer (FR-020): a defer is treated as "ask me later" — it does NOT
 * count as a decline (no backoff increment, no within-session decline flag) and
 * does NOT reset the consecutive-decline counter. The state is returned
 * unchanged so the next end-of-work breakpoint may re-offer normally. Pure.
 */
export const applyDefer = (
  ledger: OfferLedger,
  backoff: OfferBackoff,
): DeclineResult => ({ ledger, backoff });

/** Add `hours` to a `Date`, returning a new `Date`. */
const addHours = (base: Date, hours: number): Date =>
  new Date(base.getTime() + hours * 3_600_000);
