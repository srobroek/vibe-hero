#!/bin/sh
# =============================================================================
# vibe-hero UserPromptSubmit hook: deferred quiz offer — DUMB RELAY.
#
# Redesigned (code-review findings): the server now writes the COMPLETE
# additionalContext text into the arm cache (`context` field, built by
# observation/armCache.ts). This hook only:
#
#   1. Reads ~/.vibe-hero/arm/vibe-hero-offer-<session_id>.json
#      (moved from world-readable $TMPDIR — symlink-attack + macOS TMPDIR
#      mismatch both gone; server writes it atomically via tmp+rename so a
#      partial read is impossible).
#   2. Verifies the embedded sessionId matches stdin's session_id.
#   3. Checks armed / cooldown / arm-expiry via epoch arithmetic.
#   4. Emits {hookSpecificOutput:{additionalContext: <context from cache>}}.
#
# No prose lives here anymore; no %-injection (printf format string is fixed
# and the value goes through jq or vh_json_escape); no `rm` of the cache (the
# server owns its lifecycle end-to-end).
#
# Zero latency: file read + arithmetic. No jq REQUIRED, no node, no npx.
# ALWAYS exits 0.
# =============================================================================

set -eu

. "${CLAUDE_PLUGIN_ROOT}/hooks/claude-code/_lib.sh"

payload=$(cat 2>/dev/null || true)
session_id=$(vh_session_id "$payload")

cache_file="$(vh_home)/arm/vibe-hero-offer-${session_id}.json"

# No file → no offer (normal before the server has armed anything).
[ -f "$cache_file" ] || exit 0

cache_content=$(cat "$cache_file" 2>/dev/null || true)
[ -n "$cache_content" ] || exit 0

cached_session=$(vh_json_field "$cache_content" "sessionId")
armed_key=$(vh_json_field "$cache_content" "armedKey")
context=$(vh_json_field "$cache_content" "context")
armed_at=$(vh_json_field "$cache_content" "armedAt")
last_offer_at=$(vh_json_field "$cache_content" "lastOfferAt")
cooldown=$(vh_json_num "$cache_content" "cooldownSeconds" 900)

# Stale/foreign file (or truncation collision): fail safe, stay silent.
[ "$cached_session" = "$session_id" ] || exit 0

# Not armed (cleared entry) or no context to relay.
[ -n "$armed_key" ] || exit 0
[ -n "$context" ]   || exit 0

now_epoch=$(date +%s 2>/dev/null || printf '0')
armed_epoch=$(vh_iso_to_epoch "$armed_at")
last_epoch=$(vh_iso_to_epoch "$last_offer_at")

# Arm expiry: an arm older than the cooldown window means the user abandoned
# the session. Defence-in-depth only — the server prunes stale arms itself;
# never delete here (server owns the file lifecycle).
# Skipped when cooldown <= 0 (explicit no-throttle sentinel).
if [ "$cooldown" -gt 0 ] 2>/dev/null && [ "$armed_epoch" -gt 0 ] 2>/dev/null; then
  if [ $(( now_epoch - armed_epoch )) -ge "$cooldown" ] 2>/dev/null; then
    exit 0
  fi
fi

# Cooldown window since the last offer surface.
if [ "$cooldown" -gt 0 ] 2>/dev/null && [ "$last_epoch" -gt 0 ] 2>/dev/null; then
  if [ $(( now_epoch - last_epoch )) -lt "$cooldown" ] 2>/dev/null; then
    exit 0
  fi
fi

# Relay the server-built context verbatim.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$context" \
    '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' \
    "$(vh_json_escape "$context")"
fi

exit 0
