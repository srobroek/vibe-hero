#!/usr/bin/env bash
# Hook: Stop - Warn if speckit workflow has unresolved items
# Checks for unchecked checklist items, pending iterations, open questions

# Only activate in speckit projects
[ -d ".specify" ] || exit 0

WARNINGS=""

# Check for pending iteration files
if ls specs/*/pending-iteration.md &>/dev/null 2>&1; then
  PENDING=$(ls specs/*/pending-iteration.md 2>/dev/null | head -3 | tr '\n' ', ')
  WARNINGS="${WARNINGS}- Pending iteration(s) not yet applied: ${PENDING%, }"$'\n'
fi

# Check for active spec with unchecked tasks
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
ACTIVE_SPEC=""
if echo "$CURRENT_BRANCH" | grep -qE '[0-9]{3}-'; then
  ACTIVE_SPEC=$(echo "$CURRENT_BRANCH" | grep -oE '[0-9]{3}-[a-z0-9-]+' | head -1)
fi

if [ -n "$ACTIVE_SPEC" ] && [ -f "specs/$ACTIVE_SPEC/tasks.md" ]; then
  SPEC_ID=$(echo "$ACTIVE_SPEC" | grep -oE '^[0-9]{3}')

  # Check if spec has a GitHub project (HAS_PROJECT)
  HAS_PROJECT=false
  if [ -f "specs/$ACTIVE_SPEC/spec.md" ]; then
    if grep -qE '^\*\*Project\*\*:' "specs/$ACTIVE_SPEC/spec.md" && \
       ! grep -qE '^\*\*Project\*\*:\s*none' "specs/$ACTIVE_SPEC/spec.md"; then
      HAS_PROJECT=true
    fi
  fi

  if [ "$HAS_PROJECT" = true ]; then
    # Query GitHub for spec parent issue and its open sub-issues
    REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null)
    if [ -n "$REPO" ]; then
      PARENT_NUM=$(gh issue list -R "$REPO" --state open --label "type:spec" --label "spec:${SPEC_ID}" --json number -q '.[0].number' 2>/dev/null)
      if [ -n "$PARENT_NUM" ]; then
        # One query for all sub-issue states; derive open/total locally.
        SUB_STATES=$(gh api graphql -f query="
          query {
            repository(owner: \"$(echo "$REPO" | cut -d/ -f1)\", name: \"$(echo "$REPO" | cut -d/ -f2)\") {
              issue(number: $PARENT_NUM) {
                subIssues(first: 50) {
                  nodes { state }
                }
              }
            }
          }
        " --jq '[.data.repository.issue.subIssues.nodes[].state]' 2>/dev/null)
        if [ -n "$SUB_STATES" ]; then
          OPEN_SUBS=$(printf '%s' "$SUB_STATES" | jq '[.[] | select(. == "OPEN")] | length' 2>/dev/null)
          TOTAL_SUBS=$(printf '%s' "$SUB_STATES" | jq 'length' 2>/dev/null)
          if [ -n "$OPEN_SUBS" ] && [ "$OPEN_SUBS" -gt 0 ] 2>/dev/null; then
            CLOSED_SUBS=$((TOTAL_SUBS - OPEN_SUBS))
            WARNINGS="${WARNINGS}- Spec $ACTIVE_SPEC: $OPEN_SUBS open sub-issues ($CLOSED_SUBS closed) on spec parent #${PARENT_NUM}"$'\n'
          fi
        fi
      fi
    fi
  else
    # Fallback: tasks.md checkmarks for non-project specs.
    # `grep -c` prints 0 AND exits 1 on no match. The old `|| echo 0` produced a
    # second 0 ("0\n0"), breaking the `-gt` tests below. Use `|| true` so grep's
    # own 0 stands; then default.
    UNCHECKED=$(grep -c '^\- \[ \]' "specs/$ACTIVE_SPEC/tasks.md" 2>/dev/null || true); UNCHECKED=${UNCHECKED:-0}
    CHECKED=$(grep -c '^\- \[X\]\|^\- \[x\]' "specs/$ACTIVE_SPEC/tasks.md" 2>/dev/null || true); CHECKED=${CHECKED:-0}
    if [ "$UNCHECKED" -gt 0 ] && [ "$CHECKED" -gt 0 ]; then
      WARNINGS="${WARNINGS}- Spec $ACTIVE_SPEC: $UNCHECKED tasks remaining ($CHECKED completed)"$'\n'
    fi
  fi
fi

if [ -n "$WARNINGS" ]; then
  # Warn via stderr but do NOT block -- user may intentionally be stopping
  cat <<EOF >&2
SPECKIT STOP CHECK: Open items detected:
$WARNINGS
Consider running /handover to save context for next session.
EOF
fi

exit 0
