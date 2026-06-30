#!/bin/sh
# =============================================================================
# vibe-hero Stop hook: end-of-work quiz offer (FR-011)
#
# Design rationale
# ----------------
# On this Claude Code build, `additionalContext` in a Stop hook response renders
# a visible "Stop hook feedback" line in the UI every single turn — making a
# per-turn nudge pure noise.  The new design:
#
#   1. Honors the `stop_hook_active` loop guard (exit 0 silently if true).
#   2. Throttles via a per-session timestamp file in /tmp so we only call
#      get-offer at most once per COOLDOWN_SECONDS (default 900 = 15 min).
#   3. Short-circuits silently when offerCadence is "off" in the profile.
#   4. Runs `npx -y @vibe-hero/server@latest get-offer` to fetch a real offer.
#   5. Emits `additionalContext` ONLY when there is a genuine offer — making
#      the visible "Stop hook feedback" line rare and meaningful.
#   6. On ANY failure (missing npx, network error, bad JSON) exits 0 silently.
#
# ALWAYS exits 0 — advisory only, never blocks the user.
# Dependency-light: jq is optional (grep fallback). No local build artifacts.
# =============================================================================

set -eu

# --- Read stdin payload -------------------------------------------------------
payload=$(cat 2>/dev/null || true)

# --- Loop guard ---------------------------------------------------------------
stop_hook_active="false"
if command -v jq >/dev/null 2>&1; then
  stop_hook_active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // false' 2>/dev/null || printf 'false')
elif printf '%s' "$payload" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  stop_hook_active="true"
fi
if [ "$stop_hook_active" = "true" ]; then
  exit 0
fi

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

# --- Throttle via /tmp timestamp file ----------------------------------------
COOLDOWN_SECONDS="${VIBE_HERO_OFFER_COOLDOWN_SECONDS:-900}"
ts_file="/tmp/vibe-hero-offer-${session_id}.ts"

now_epoch=$(date +%s 2>/dev/null || printf '0')
last_epoch=0
if [ -f "$ts_file" ]; then
  _raw=$(cat "$ts_file" 2>/dev/null || true)
  case "$_raw" in
    ''|*[!0-9]*) last_epoch=0 ;;
    *) last_epoch="$_raw" ;;
  esac
fi

elapsed=$((now_epoch - last_epoch))
if [ "$elapsed" -lt "$COOLDOWN_SECONDS" ]; then
  exit 0
fi

# --- Short-circuit when offerCadence is "off" --------------------------------
VIBE_HERO_HOME="${VIBE_HERO_HOME:-$HOME/.vibe-hero}"
profile_file="$VIBE_HERO_HOME/profile.json"
if [ -f "$profile_file" ]; then
  cadence_off="false"
  if command -v jq >/dev/null 2>&1; then
    _cadence=$(jq -r '.config.offerCadence // empty' "$profile_file" 2>/dev/null || true)
    [ "$_cadence" = "off" ] && cadence_off="true"
  elif grep -q '"offerCadence"[[:space:]]*:[[:space:]]*"off"' "$profile_file" 2>/dev/null; then
    cadence_off="true"
  fi
  if [ "$cadence_off" = "true" ]; then
    exit 0
  fi
fi

# --- Stamp the timer (before the spawn, so we don't hammer on slow network) --
printf '%s' "$now_epoch" > "$ts_file" 2>/dev/null || true

# --- Run get-offer via npx ---------------------------------------------------
if ! command -v npx >/dev/null 2>&1; then
  exit 0
fi

offer_json=$(npx -y @vibe-hero/server@latest get-offer \
  --session "$session_id" \
  --tool claude-code 2>/dev/null || true)

# --- Parse result and emit only when there is a genuine offer ----------------
# An offer is present when .offer.title is a non-empty string.
has_offer="false"
offer_title=""
if command -v jq >/dev/null 2>&1; then
  _title=$(printf '%s' "$offer_json" | jq -r '.offer.title // empty' 2>/dev/null || true)
  if [ -n "$_title" ]; then
    has_offer="true"
    offer_title="$_title"
  fi
else
  if printf '%s' "$offer_json" | grep -q '"offer"'; then
    _title=$(printf '%s' "$offer_json" | grep -o '"title"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"title"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
    if [ -n "$_title" ]; then
      has_offer="true"
      offer_title="$_title"
    fi
  fi
fi

if [ "$has_offer" = "true" ]; then
  context="[vibe-hero] A quiz offer is ready for the user. Topic: ${offer_title}. Call get_offer (session: ${session_id}, tool: claude-code) and present it to the user now."
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg ctx "$context" \
      '{hookSpecificOutput:{hookEventName:"Stop",additionalContext:$ctx}}'
  else
    # context text contains no characters needing JSON escaping in this path.
    printf '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"%s"}}\n' "$context"
  fi
fi

exit 0
