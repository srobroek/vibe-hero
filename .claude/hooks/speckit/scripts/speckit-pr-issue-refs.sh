#!/usr/bin/env bash
# Hook: PreToolUse:Bash - PR creation guidance
# 1. Always: remind about user-facing PR titles (they become changelog entries)
# 2. If spec branch: query open issues, present "Fixes #N" lines and spec context

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Only trigger on PR/MR creation (gh directly or via gh-api.py wrapper)
if ! echo "$COMMAND" | grep -qE '(gh pr create|gh-api\.py.*pr create|glab mr create)'; then
  exit 0
fi

# Base guidance -- always applies
read -r -d '' CONTEXT << 'GUIDANCE'
PR TITLE = CHANGELOG ENTRY (via squash merge). Write for end users.

TITLE FORMAT:
- Minor fix: "fix: catalog refresh fails when offline"
- Minor feature: "feat: show version at startup for diagnostics"
- Major feature: "feat: automatic software detection via Windows registry and WMI"
- Breaking change: "feat!: migrate config from TOML to SQLite-backed storage"
- NEVER include spec IDs, task refs, phase names, or internal jargon

PR BODY FORMAT -- scale detail to significance:

MAJOR FEATURES (new capability, large scope):
## Summary
<2-3 sentences: what this adds and why users care>

## What's new
- Bullet points of user-visible changes
- Each bullet is a concrete capability, not an implementation detail

## Breaking changes
<only if applicable -- what breaks, what users need to do>

MINOR CHANGES & BUG FIXES (targeted fix or small enhancement):
## Summary
- Short bullet(s) describing what changed and why

BREAKING CHANGES -- always flag explicitly:
- Add `!` after type in title: "feat!: ..." or "fix!: ..."
- Include a "## Breaking changes" section explaining what breaks and migration steps

Spec context goes at the bottom under "## Spec Context" (not in the title).
The release-please draft PR will be manually curated before publish -- raw material matters.
GUIDANCE

# Detect current branch
BRANCH=$(git branch --show-current 2>/dev/null)
if [ -z "$BRANCH" ]; then
  jq -n --arg ctx "$CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $ctx
    }
  }'
  exit 0
fi

# Extract spec number from branch name (e.g., 023-lifecycle-testing -> 023)
SPEC_ID=$(echo "$BRANCH" | grep -oE '[0-9]{3}' | head -1)

if [ -z "$SPEC_ID" ]; then
  jq -n --arg ctx "$CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $ctx
    }
  }'
  exit 0
fi

# Detect repo from git remote.
# Handles both SSH (git@host:owner/repo.git) and HTTPS (https://host/owner/repo.git)
# forms. BSD sed has no '+?'; use a portable greedy slug regex with a [/:] anchor.
REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#.*[/:]([^/]+/[^/]+)$#\1#; s#\.git$##')
if [ -z "$REPO" ]; then
  jq -n --arg ctx "$CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $ctx
    }
  }'
  exit 0
fi

# Query GitHub for open issues with this spec label
ISSUES_JSON=$(gh issue list -R "$REPO" --label "spec:$SPEC_ID" --state open --json number,title --limit 100 2>/dev/null)

# Build spec context section for PR body
SPEC_CONTEXT="

SPEC CONTEXT FOR PR BODY: This branch is for spec $SPEC_ID. Include at the bottom:

## Spec Context
- Spec: $SPEC_ID
- Branch: $BRANCH"

if [ -n "$ISSUES_JSON" ] && [ "$ISSUES_JSON" != "[]" ]; then
  FIXES_LINES=$(echo "$ISSUES_JSON" | jq -r '.[] | "Fixes #\(.number) -- \(.title)"')
  ISSUE_COUNT=$(echo "$ISSUES_JSON" | jq 'length')
  SPEC_CONTEXT="$SPEC_CONTEXT

PR ISSUE REFS: $ISSUE_COUNT open issue(s) for spec:$SPEC_ID.
Include each relevant \"Fixes #N\" on its own line in the PR body. Only include issues actually resolved by this PR.

$FIXES_LINES

IMPORTANT: Each \"Fixes #N\" MUST be on its own line -- do NOT combine as \"Fixes #1 #2 #3\"."
fi

FULL_CONTEXT="$CONTEXT$SPEC_CONTEXT"

jq -n --arg ctx "$FULL_CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'

exit 0
