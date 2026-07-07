# shellcheck shell=sh
# =============================================================================
# vibe-hero shared hook library. Source from sibling hook scripts:
#   . "${CLAUDE_PLUGIN_ROOT}/hooks/claude-code/_lib.sh"
#
# POSIX sh only. jq-optional (grep fallback). Never exits the caller.
# Extracted from prompt-offer.sh / the legacy stop-offer.sh (code-review
# finding: session-id parsing was duplicated verbatim per hook).
# =============================================================================

# vh_json_field <json> <key>
#   Extract a top-level string field from a JSON document. jq when available,
#   conservative grep/sed fallback otherwise. Prints "" when absent.
vh_json_field() {
  _vh_doc="$1"
  _vh_key="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$_vh_doc" | jq -r --arg k "$_vh_key" '.[$k] // empty' 2>/dev/null || true
  else
    printf '%s' "$_vh_doc" \
      | grep -o "\"$_vh_key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | head -1 \
      | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*"\(.*\)"$/\1/' || true
  fi
}

# vh_json_num <json> <key> <default>
#   Extract a top-level integer field. Anchors on the key (code-review finding:
#   the old _num() grabbed the LAST numeric run on minified JSON). Falls back
#   to <default> when absent or non-numeric.
vh_json_num() {
  _vh_doc="$1"
  _vh_key="$2"
  _vh_def="$3"
  if command -v jq >/dev/null 2>&1; then
    _vh_n=$(printf '%s' "$_vh_doc" | jq -r --arg k "$_vh_key" '.[$k] // empty' 2>/dev/null || true)
  else
    _vh_n=$(printf '%s' "$_vh_doc" \
      | grep -o "\"$_vh_key\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" \
      | head -1 \
      | sed 's/^.*:[[:space:]]*//' || true)
  fi
  # Strip any fractional part, then validate digits-only.
  _vh_n="${_vh_n%%.*}"
  case "$_vh_n" in
    ''|*[!0-9]*) printf '%s' "$_vh_def" ;;
    *) printf '%s' "$_vh_n" ;;
  esac
}

# vh_session_id <payload>
#   Parse and sanitise the hook payload's session_id: only [A-Za-z0-9_-],
#   max 64 chars, "default" when absent. Safe for filenames.
vh_session_id() {
  _vh_sid=$(vh_json_field "$1" "session_id")
  _vh_sid=$(printf '%s' "$_vh_sid" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)
  [ -n "$_vh_sid" ] || _vh_sid="default"
  printf '%s' "$_vh_sid"
}

# vh_json_escape <string>
#   Escape a string for safe embedding inside a JSON string literal:
#   backslash, double-quote, tab, CR; newlines become \n. (Code-review
#   finding: the old sed escaped only backslash and quote, so a newline or
#   tab in content produced malformed JSON on the no-jq path.)
vh_json_escape() {
  printf '%s' "$1" | awk '
    BEGIN { ORS=""; first=1 }
    {
      if (!first) print "\\n"
      first=0
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      gsub(/\t/, "\\t")
      gsub(/\r/, "\\r")
      print
    }'
}

# vh_home
#   The vibe-hero home directory (matches the server's VIBE_HERO_HOME logic).
vh_home() {
  printf '%s' "${VIBE_HERO_HOME:-$HOME/.vibe-hero}"
}

# vh_iso_to_epoch <iso8601>
#   ISO-8601 UTC datetime → epoch seconds. GNU and BSD date supported; prints
#   0 on failure (callers treat 0 as "unknown").
vh_iso_to_epoch() {
  _vh_iso="$1"
  [ -n "$_vh_iso" ] || { printf '0'; return; }
  if date --version >/dev/null 2>&1; then
    date -u -d "$_vh_iso" +%s 2>/dev/null || printf '0'
  else
    _vh_clean=$(printf '%s' "$_vh_iso" | sed 's/\.[0-9]*Z$/Z/')
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$_vh_clean" +%s 2>/dev/null || printf '0'
  fi
}
