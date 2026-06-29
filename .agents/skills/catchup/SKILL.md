---
name: catchup
description: Recover interrupted project work by locating and following the best handover file before doing fresh discovery. Use when starting in an existing repo/worktree, after context loss or /clear, when the user says catchup or asks to continue from a handover, what changed, or what is next.
---

# Catchup

Recover the current project state from an existing handover before rebuilding context from scratch.

## Workflow

1. Identify the live context: repo root, current branch, worktree path, user-stated target, and fresh `git status`/dirty state when available.
2. Search handover locations in order: explicit repo-local untracked-state conventions, then `~/.local/state/agentic-tools/handovers/`. Include project, branch, worktree, feature/spec id, and recent timestamp signals.
3. Choose the best candidate: filter by filename and YAML frontmatter first; for ranking and tie-breaking, LOAD references/selection.md. If multiple plausible candidates remain, ask the user to choose.
4. Read the selected handover fully before planning or editing. Treat its Next Session Prompt and explicit recovery instructions as the high-priority starting point, then verify them against current state.
5. If the selected handover is only an unfilled scaffold or still contains placeholder TODOs as the operative content, say it is incomplete and fall back to bounded live repo discovery.
6. Verify the handover against current reality with lightweight checks such as `git status`, branch, worktree path, referenced files, and running sessions if relevant. If the recorded branch or worktree differs from the current checkout, surface it and proceed carefully when the user intent still matches; ask before editing when intent is unclear.
7. If no matching handover exists, say so before doing bounded live repo discovery.
8. Continue from the recovered next step, or give a concise status report if the user asked only to catch up.

## Rules

- Prefer handover evidence over memory and broad rediscovery, but do not trust stale paths or commands without checking them.
- Do not overwrite or revert existing work while catching up.
- Never commit handover files; they are ephemeral local state.
- Do not summarize a handover as a substitute for following it when the user asked to continue.
- Keep recovery factual: what was found, what still applies, what changed, and the next action.
- Fall back to git/spec/file inspection only when no suitable handover exists.
- Use memory only after handovers and live repo evidence, and label memory-derived facts unless verified locally.
- Load minimal repo-local steering before acting on the selected handover.
- Resolve repo-relative paths from the handover against the current verified checkout; surface recorded/current root mismatches before editing.
- Current user instructions override instructions recorded in a handover.
