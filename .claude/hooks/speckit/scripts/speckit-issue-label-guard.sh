#!/usr/bin/env bash
# Hook: PreToolUse:Bash -- enforce spec: and deferred labels on issue creation
# Blocks (exit 2) if labels missing. Checks both CLI and GraphQL mutations.

# Only activate in speckit projects
[ -d ".specify" ] || exit 0

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Check CLI issue creation (gh/glab)
if echo "$COMMAND" | grep -qE '(gh issue create|glab issue create)'; then
  # Label values must START with the required prefix (reject e.g. myspec:),
  # accepting -l/--label, = or space separators, and optional quoting.
  LABEL_FLAG='(--label|-l)[= ]+["'"'"']?'
  if ! echo "$COMMAND" | grep -qE "${LABEL_FLAG}spec:"; then
    echo "BLOCKED: Issue creation missing spec: label. Add --label 'spec:{spec-id}'." >&2
    exit 2
  fi
  # Require phase: label
  if ! echo "$COMMAND" | grep -qE "${LABEL_FLAG}phase:"; then
    echo "BLOCKED: Issue creation missing phase: label. Add --label 'phase:{name}'." >&2
    exit 2
  fi
  # Deferred issues need: deferred label + TWO spec: labels (source + target).
  # Detect a deferred issue ONLY by a real `deferred` LABEL VALUE -- not a loose
  # substring like `defer`/`deferred` anywhere in the command. The old substring
  # match blocked legitimate titles such as "fix deferred loading". Anchor the
  # value end so `deferred` is the whole label, not a prefix of e.g. `deferred-x`.
  if echo "$COMMAND" | grep -qE "${LABEL_FLAG}deferred([\"', ]|$)"; then
    SPEC_COUNT=$(echo "$COMMAND" | grep -oE "${LABEL_FLAG}spec:[^ \"']*" | wc -l | tr -d ' ')
    if [ "$SPEC_COUNT" -lt 2 ]; then
      echo "BLOCKED: Deferred issues must have TWO spec: labels -- spec:{source} (where discovered) and spec:{blocking} (what must complete before this work can proceed). Found $SPEC_COUNT." >&2
      exit 2
    fi
  fi
fi

# Check GraphQL issue creation
if echo "$COMMAND" | grep -qE 'gh api graphql.*createIssue'; then
  if ! echo "$COMMAND" | grep -qE 'spec:'; then
    echo "BLOCKED: GraphQL issue creation missing spec: label in mutation." >&2
    exit 2
  fi
fi

exit 0
