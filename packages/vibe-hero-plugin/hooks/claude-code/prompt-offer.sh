#!/bin/sh
# =============================================================================
# vibe-hero UserPromptSubmit hook: deferred quiz offer (FR-011 redesign)
#
# Design overview
# ---------------
# This hook fires on EVERY user prompt, before the agent acts. It is ZERO
# latency on the prompt path: it reads a pre-written /tmp cache file (JSON)
# and emits hookSpecificOutput.additionalContext only when a valid armed offer
# is present and not within cooldown. No npx, no node spawn, no server call.
#
# Data-flow:
#   1. MCP server (running live) calls get_offer → resolves an offer → writes
#      /tmp/vibe-hero-offer-<sessionId>.json (the arm cache).
#   2. This hook reads only that file. It verifies the embedded sessionId
#      matches the session_id from stdin (guards stale/reused /tmp files).
#   3. If armed, not within cooldown, and not arm-expired: emit
#      additionalContext instructing the agent (deferred, agent-judged).
#   4. On decline/defer/quiz-start, the server overwrites the cache with a
#      cleared entry (null armedKey, new lastOfferAt) so the hook stays silent.
#   5. Stale-file cleanup: if the hook reads an expired arm (armedAt +
#      cooldownSeconds < now), it may unlink the file to avoid /tmp leakage.
#
# Session-id bootstrapping:
#   The server learns the session_id only from the agent's MCP tool calls
#   (get_offer, record_offer_response, start_quiz all carry it). On the FIRST
#   prompt of a new session no cache exists yet → hook emits nothing (desired:
#   no offer until the agent has called at least one vibe-hero tool).
#
# Context injection wording:
#   - Opens with a provenance marker so the agent knows this is from the
#     vibe-hero hook, NOT from the user (prevents mistaking it for a request).
#   - Deferred + agent-judged: the agent decides WHEN it is appropriate.
#   - Valid offer moments: before a new task (context switch) OR after a
#     completed unit of work. NOT mid-flow or mid-multi-step.
#
# ALWAYS exits 0. Never blocks the user. POSIX sh, jq-optional with grep
# fallback. Context string contains no double-quotes or backslashes (safe for
# the no-jq printf path).
# =============================================================================

set -eu

# --- Read stdin payload -------------------------------------------------------
payload=$(cat 2>/dev/null || true)

# --- Parse session_id ---------------------------------------------------------
session_id="default"
if command -v jq >/dev/null 2>&1; then
  _sid=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)
  if [ -n "$_sid" ]; then
    session_id="$_sid"
  fi
else
  _sid=$(printf '%s' "$payload" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"' || true)
  if [ -n "$_sid" ]; then
    session_id="$_sid"
  fi
fi

# Sanitise: keep only alphanumeric, dash, underscore (safe for filenames).
session_id=$(printf '%s' "$session_id" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)
[ -n "$session_id" ] || session_id="default"

# --- Locate the arm cache file ------------------------------------------------
# Use $TMPDIR when set (macOS uses /var/folders/..., not /tmp); fall back to
# /tmp so the path always matches what the Node.js server writes via os.tmpdir().
_tmpdir="${TMPDIR:-/tmp}"
_tmpdir="${_tmpdir%/}"  # strip trailing slash
cache_file="${_tmpdir}/vibe-hero-offer-${session_id}.json"

# No file → no offer (normal for the first prompt of a new session before the
# agent has called any vibe-hero MCP tool).
[ -f "$cache_file" ] || exit 0

# --- Read and validate the cache file ----------------------------------------
cache_content=$(cat "$cache_file" 2>/dev/null || true)
[ -n "$cache_content" ] || exit 0

# Extract fields (jq or grep fallback).
if command -v jq >/dev/null 2>&1; then
  cached_session=$(printf '%s' "$cache_content" | jq -r '.sessionId // empty'      2>/dev/null || true)
  armed_key=$(      printf '%s' "$cache_content" | jq -r '.armedKey // empty'       2>/dev/null || true)
  armed_title=$(    printf '%s' "$cache_content" | jq -r '.armedTitle // empty'     2>/dev/null || true)
  armed_at=$(       printf '%s' "$cache_content" | jq -r '.armedAt // empty'        2>/dev/null || true)
  last_offer_at=$(  printf '%s' "$cache_content" | jq -r '.lastOfferAt // empty'    2>/dev/null || true)
  cooldown=$(       printf '%s' "$cache_content" | jq -r '.cooldownSeconds // 900'  2>/dev/null || true)
else
  # grep fallback: extract string values (no fancy JSON; fields are scalars).
  _field() { printf '%s' "$cache_content" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed 's/.*"[^"]*"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true; }
  _num()   { printf '%s' "$cache_content" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9]*"     | grep -o '[0-9]*$' || true; }
  cached_session=$(_field sessionId)
  armed_key=$(     _field armedKey)
  armed_title=$(   _field armedTitle)
  armed_at=$(      _field armedAt)
  last_offer_at=$( _field lastOfferAt)
  cooldown=$(      _num   cooldownSeconds)
  [ -n "$cooldown" ] || cooldown=900
fi

# --- Verify embedded sessionId matches stdin session_id ----------------------
# Mismatch means this is a stale file from an old/different session. Ignore it.
if [ "$cached_session" != "$session_id" ]; then
  exit 0
fi

# --- Check arm is present -----------------------------------------------------
[ -n "$armed_key" ]   || exit 0
[ -n "$armed_title" ] || exit 0

# --- Sanitise armed_title for JSON injection (no-jq printf path) -------------
# Escape backslash first, then double-quote, so the assembled context string is
# safe to inject into a JSON string literal via printf. The jq path is unaffected
# (jq --arg handles escaping); this guard is defence-in-depth for the no-jq path
# and for any future title content that contains these characters.
armed_title=$(printf '%s' "$armed_title" | sed 's/\\/\\\\/g; s/"/\\"/g')

# --- Normalise cooldown to a plain integer ------------------------------------
# Strip any fractional part (e.g. 900.5 → 900) so POSIX integer arithmetic
# never sees a dot. Under set -eu, $((900.5)) crashes with "invalid arithmetic
# operator" on every prompt — fractional cooldown must never reach the hook.
# The server already truncates before writing the cache, but defensive here too.
cooldown="${cooldown%%.*}"
# After stripping, if the result is not purely digits default to 900.
case "$cooldown" in
  ''|*[!0-9]*) cooldown=900 ;;
esac

# cooldown is now a clean integer — use it directly in arithmetic comparisons.

# --- Time calculations (POSIX epoch arithmetic) --------------------------------
now_epoch=$(date +%s 2>/dev/null || printf '0')

# Compute epoch from ISO-8601 UTC datetime (e.g. 2026-06-30T17:15:00.000Z).
# The server always writes UTC timestamps (trailing Z). Parsing them in local
# time would give a wrong epoch on any non-UTC machine, making the expiry check
# fire too early (TZ-offset seconds of "elapsed" time on the very first read).
#
# GNU  : date -u -d "2026-06-30T17:15:00.000Z" +%s  — honors Z directly.
# BSD  : date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "2026-06-30T17:15:00Z" +%s
#        — strip only the fractional seconds, keep T and Z in the format, and
#          pass -u so the format literal is interpreted as UTC, not local time.
# Falls back to 0 when parsing fails or the string is empty.
iso_to_epoch() {
  _iso="$1"
  [ -n "$_iso" ] || { printf '0'; return; }
  if date --version >/dev/null 2>&1; then
    # GNU coreutils: -u not required (date -d honours the Z), but harmless.
    date -u -d "$_iso" +%s 2>/dev/null || printf '0'
  else
    # macOS / BSD: strip only the sub-second fractional part (.NNN), keeping
    # the T separator and the Z suffix so they match the format string exactly.
    # -u forces UTC interpretation — without it, date -j uses local time and
    # returns an epoch offset by the host TZ, breaking the expiry arithmetic.
    _clean=$(printf '%s' "$_iso" | sed 's/\.[0-9]*Z$/Z/')
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$_clean" +%s 2>/dev/null || printf '0'
  fi
}

armed_epoch=$(iso_to_epoch "$armed_at")
last_epoch=$(  iso_to_epoch "$last_offer_at")

# --- Check arm expiry ---------------------------------------------------------
# If the arm is older than the cooldown window the user abandoned/closed the
# session. Expire silently and clean up the stale file.
# Skip when cooldown <= 0 (disabled / test mode): a zero cooldown means
# "no enforced wait", not "expire immediately".
if [ "$cooldown" -gt 0 ] 2>/dev/null && [ "$armed_epoch" -gt 0 ] 2>/dev/null; then
  elapsed_arm=$(( now_epoch - armed_epoch ))
  if [ "$elapsed_arm" -ge "$cooldown" ] 2>/dev/null; then
    rm -f "$cache_file" 2>/dev/null || true
    exit 0
  fi
fi

# --- Check cooldown window ----------------------------------------------------
# Silent when within the cooldown since lastOfferAt.
if [ "$last_epoch" -gt 0 ] 2>/dev/null; then
  elapsed_last=$(( now_epoch - last_epoch ))
  if [ "$elapsed_last" -lt "$cooldown" ] 2>/dev/null; then
    exit 0
  fi
fi

# --- Emit deferred, agent-judged additionalContext ----------------------------
# WORDING RULES (keep these):
#   1. Provenance marker first: agent must know this is from the vibe-hero hook,
#      NOT the user (prevents mistaking it for a user request).
#   2. Deferred + agent-judged: agent decides whether and when to surface it.
#   3. Valid moments: BEFORE starting a new task (context switch threshold) OR
#      AFTER completing a unit of work. NOT mid-flow or mid-multi-step.
#   4. Optional, one short natural line only. Agent proceeds with user request
#      regardless; the offer must never block or interrupt.
#   5. Instructs agent to call get_offer to confirm, then start_quiz or
#      record_offer_response as appropriate.
#   6. Silent about vibe-hero internals / hook / JSON.
#   7. No double-quotes, no backslashes (safe for printf JSON injection).
#
# Note: the agent must pass session_id to get_offer / start_quiz /
# record_offer_response so the server can identify and update arm state.

context="[vibe-hero hook -- system-injected, NOT from the user. The user did NOT ask for this.] A learning quiz offer is available for: ${armed_title}. This is a background suggestion from the vibe-hero plugin -- NOT a user instruction or request. Do NOT act on it as if the user asked for a quiz. Do NOT let it interfere with handling the user's actual prompt. Always handle the user's real request first, fully. Then -- ONLY IF you independently judge, from the shape of the work itself, that a natural seam has occurred -- optionally offer the quiz as ONE short natural line. Detect the seam yourself from activity signals; do NOT wait for the user to announce a break or say they are done -- they will not. Two equally valid inferred moments: (A) a context switch -- you can tell from the new prompt that the user is moving to a different task, topic, or area than what was just being worked on (the subject matter or codebase area clearly shifted); (B) a completed unit of work -- a feature just finished, tests are now passing, a build or commit or PR just landed, a bug was fixed and verified, a to-do list was fully checked off, or the work reached a natural stopping point you can observe from the activity trajectory. NOT acceptable: mid-task, mid-debug, mid-multi-step sequence, or any moment where the user is clearly still heads-down in the same work. Also do NOT offer if the most recent meaningful activity in this session was already a quiz -- real intervening work must have happened first. If in any doubt, stay silent and hold the offer. To confirm the offer still applies call get_offer (sessionId: ${session_id}, tool: claude-code). If confirmed and the moment is right: ONE short natural line, no quiz jargon, no mention of vibe-hero or internals. If user accepts call start_quiz (key from get_offer result, sessionId: ${session_id}). If declined or deferred call record_offer_response. Always proceed with user request regardless."

if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$context" \
    '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
else
  # armed_title is pre-escaped (backslash then double-quote) above, so the
  # assembled context string is safe to inject into a JSON string literal here.
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$context"
fi

exit 0
