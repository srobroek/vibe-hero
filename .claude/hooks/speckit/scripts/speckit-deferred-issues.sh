#!/usr/bin/env bash
# Hook: UserPromptSubmit - Inject deferred issues when speckit workflow starts
# Checks for issues labeled 'deferred' or matching current spec

# Only activate in speckit projects
[ -d ".specify" ] || exit 0

INPUT=$(cat)
USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
PROMPT_LOWER=$(echo "$USER_PROMPT" | tr '[:upper:]' '[:lower:]')

# Only trigger on speckit-related prompts
if ! echo "$PROMPT_LOWER" | grep -qE '(speckit|specify|spec |/speckit|new feature|new spec)'; then
  exit 0
fi

# Cooldown: once per 5 minutes per directory
COOLDOWN_DIR="/tmp/claude-speckit-hooks"
mkdir -p "$COOLDOWN_DIR"
CACHE_KEY=$(echo "$(pwd)" | md5 2>/dev/null || echo "$(pwd)" | md5sum 2>/dev/null | cut -d' ' -f1)
CACHE_FILE="$COOLDOWN_DIR/deferred-$CACHE_KEY"

if [ -f "$CACHE_FILE" ]; then
  LAST_TIME=$(cat "$CACHE_FILE")
  NOW=$(date +%s)
  if [ $((NOW - LAST_TIME)) -lt 300 ]; then
    exit 0
  fi
fi
date +%s > "$CACHE_FILE"

# Check for deferred issues
DEFERRED=""
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  DEFERRED=$(gh issue list --label deferred --state open --json number,title,labels --limit 20 2>/dev/null)
elif command -v glab &>/dev/null; then
  DEFERRED=$(glab issue list --label deferred --json number,title,labels --per-page 20 2>/dev/null)
fi

if [ -z "$DEFERRED" ] || [ "$DEFERRED" = "[]" ]; then
  exit 0
fi

# Format for injection
ISSUE_COUNT=$(echo "$DEFERRED" | jq 'length' 2>/dev/null)
ISSUE_LIST=$(echo "$DEFERRED" | jq -r '.[] | "  - #\(.number): \(.title) [\(.labels | map(.name) | join(", "))]"' 2>/dev/null)

CONTEXT="SPECKIT DEFERRED ISSUES: $ISSUE_COUNT open deferred issue(s) found. Review and incorporate into the current spec if relevant:
$ISSUE_LIST"

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'

exit 0
