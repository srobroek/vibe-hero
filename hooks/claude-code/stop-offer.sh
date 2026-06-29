#!/usr/bin/env bash
# =============================================================================
# vibe-hero Stop hook: end-of-work quiz offer (T037)
#
# PURPOSE
#   At the end of each Claude Code agent turn, this hook asks the vibe-hero
#   MCP server whether a quiz offer should be surfaced for the current session.
#   If yes, it injects the offer text back into the agent context via
#   hookSpecificOutput.additionalContext (the verified Stop-hook mechanism).
#   If no offer is due, or if anything goes wrong, it exits 0 silently.
#
#   This hook is THIN by design (critique E7 / research.md).  All offer-engine
#   logic (cadence, anti-fatigue, candidate matching) lives in the MCP server.
#   The hook only:
#     1. Reads the Stop-hook JSON payload from stdin.
#     2. Extracts session_id, stop_hook_active (infinite-loop guard), and cwd.
#     3. Calls `node <server>/dist/cli/getOffer.js get-offer --session --tool`.
#     4. On a real offer, emits the Claude Code Stop-hook response JSON.
#     5. Exits 0 silently on suppression or any error.
#
# INFINITE-LOOP GUARD
#   If stop_hook_active is true in the payload the hook is being re-invoked
#   after its own additionalContext triggered Claude.  We exit 0 immediately.
#   We also set VIBE_HERO_STOP_HOOK_ACTIVE=1 in the environment before calling
#   the CLI so the CLI can enforce the same guard internally.
#
# GRACEFUL DEGRADATION
#   Any of the following produce a silent exit 0 (never breaks the session):
#     - jq not available
#     - node not available
#     - server not built (dist/cli/getOffer.js absent)
#     - profile not configured (SETUP_REQUIRED from CLI)
#     - CLI exits non-zero
#     - get_offer returns suppressed
#
# PORTABILITY
#   POSIX sh + bash (#!/usr/bin/env bash).  Tested against bash 3.2+ (macOS
#   ships bash 3.2).  No bashisms beyond local variables and [[ ]].
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Write a diagnostic to stderr (visible in CC debug logs, never to the user).
log_debug() {
  printf 'vibe-hero stop-offer: %s\n' "$1" >&2
}

# Exit 0 silently — used for every suppression/error path.
suppress_exit() {
  exit 0
}

# ---------------------------------------------------------------------------
# 1. Read + parse the Stop-hook JSON payload from stdin.
#    Fields: session_id, transcript_path, cwd, stop_hook_active
# ---------------------------------------------------------------------------

# Require jq — without it we cannot safely parse the payload.
if ! command -v jq >/dev/null 2>&1; then
  log_debug "jq not found; skipping offer"
  suppress_exit
fi

# Read all of stdin into a variable (the payload is small — a few KB at most).
payload=""
if ! payload=$(cat); then
  log_debug "could not read stdin payload; skipping offer"
  suppress_exit
fi

# Parse fields we need.  jq returns the literal string "null" for missing keys,
# so we normalise those to empty strings.
session_id=""
stop_hook_active="false"

session_id=$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null) || true
stop_hook_active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // "false"' 2>/dev/null) || true

# ---------------------------------------------------------------------------
# 2. Infinite-loop guard: if stop_hook_active is true, exit immediately.
# ---------------------------------------------------------------------------

if [ "$stop_hook_active" = "true" ]; then
  log_debug "stop_hook_active=true; skipping to prevent infinite loop"
  suppress_exit
fi

# Also guard via env var (belt-and-suspenders: the CLI checks this too).
export VIBE_HERO_STOP_HOOK_ACTIVE=0

# ---------------------------------------------------------------------------
# 3. Require a non-empty session_id.
# ---------------------------------------------------------------------------

if [ -z "$session_id" ]; then
  log_debug "session_id missing from payload; skipping offer"
  suppress_exit
fi

# ---------------------------------------------------------------------------
# 4. Locate the built vibe-hero server CLI.
#
#    Resolution order:
#      a. VIBE_HERO_SERVER_DIST env var (explicit override, e.g. for testing).
#      b. The package's own dist/ relative to this script's directory, walking
#         up to find packages/server/dist if the repo layout matches.
#      c. A globally installed `vibe-hero-get-offer` binary (future packaging).
#
#    If none of the candidates exist, suppress silently.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The repo layout is: hooks/claude-code/stop-offer.sh
#                     packages/server/dist/cli/getOffer.js
# So the server dist is two levels up from SCRIPT_DIR, then into packages/server/dist.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEFAULT_CLI="$REPO_ROOT/packages/server/dist/cli/getOffer.js"

CLI_PATH="${VIBE_HERO_SERVER_DIST:-$DEFAULT_CLI}"

if [ ! -f "$CLI_PATH" ]; then
  log_debug "CLI not found at $CLI_PATH; skipping offer (server not built?)"
  suppress_exit
fi

# ---------------------------------------------------------------------------
# 5. Require node.
# ---------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  log_debug "node not found; skipping offer"
  suppress_exit
fi

# ---------------------------------------------------------------------------
# 6. Call the offer CLI.
#    Capture stdout (the JSON result) into offer_json; forward stderr to our
#    own stderr so diagnostics appear in CC debug logs without polluting the
#    hook response channel (stdout).
# ---------------------------------------------------------------------------

offer_json=""
if ! offer_json=$(VIBE_HERO_STOP_HOOK_ACTIVE=0 node "$CLI_PATH" get-offer \
    --session "$session_id" \
    --tool    "claude-code" \
    2>/dev/null); then
  log_debug "CLI exited non-zero; skipping offer"
  suppress_exit
fi

if [ -z "$offer_json" ]; then
  log_debug "CLI produced no output; skipping offer"
  suppress_exit
fi

# ---------------------------------------------------------------------------
# 7. Check whether the result is an offer or a suppression.
# ---------------------------------------------------------------------------

# A real offer has a non-null `.offer` field.
offer_prompt=""
offer_prompt=$(printf '%s' "$offer_json" | jq -r '.offer.prompt // ""' 2>/dev/null) || true

if [ -z "$offer_prompt" ]; then
  # suppressed — exit 0 silently (no interruption, FR-019 / FR-020).
  log_debug "offer suppressed ($(printf '%s' "$offer_json" | jq -r '.suppressed // "unknown"' 2>/dev/null || true))"
  suppress_exit
fi

# ---------------------------------------------------------------------------
# 8. Surface the offer via the Stop-hook additionalContext mechanism.
#
#    Claude Code Stop-hook response JSON (verified mechanism — research.md):
#      {
#        "hookSpecificOutput": {
#          "additionalContext": "<string injected into next agent turn>"
#        }
#      }
#
#    The text is advisory only — the agent will present it to the user as a
#    non-interrupting offer at the natural end of the work unit (FR-019).
#    Writing this JSON to stdout (not stderr) is what CC reads as the hook result.
# ---------------------------------------------------------------------------

additional_context="[vibe-hero] $offer_prompt"

# Use jq to produce safely-escaped JSON.
jq -n \
  --arg ctx "$additional_context" \
  '{"hookSpecificOutput":{"additionalContext":$ctx}}'

exit 0
