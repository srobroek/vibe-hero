#!/usr/bin/env bash
# Hook: PreToolUse:Bash -- Warn on direct issue closure
# Issues should be closed via PR/MR merges (fixes #N in body), not directly.
# Always warns. Only use gh issue close when PR-based closure is not possible
# (e.g., GitLab mirror, cancelled work, duplicate).

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Check for direct issue close commands
if echo "$COMMAND" | grep -qE '(gh issue close|glab issue close)'; then
  ISSUE_REF=$(echo "$COMMAND" | grep -oE '(gh|glab) issue close [^ ]+' | head -1)

  # GitLab-mirrored repos: code merges on GitLab, GitHub issues closed manually
  REMOTE=$(git config --get remote.origin.url 2>/dev/null || echo "")
  if echo "$REMOTE" | grep -q "gitlab.com" && echo "$COMMAND" | grep -q "gh issue close"; then
    cat <<EOF >&2
ISSUE CLOSE: $ISSUE_REF (GitLab mirror -- manual close expected)
EOF
    exit 0
  fi

  cat <<EOF >&2
ISSUE CLOSE WARNING: $ISSUE_REF

Issues should be closed via PR/MR merge (fixes #N in PR body).
Only use direct closure when PR-based closure is not possible
(e.g., no associated code change, cancelled work, duplicate).
EOF
  exit 0
fi

exit 0
