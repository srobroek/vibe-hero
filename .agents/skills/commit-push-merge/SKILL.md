---
name: commit-push-merge
description: Publish and merge a branch by committing local changes when needed, pushing, and merging after inferring or confirming the target and method. Use when the user asks to commit, push, and merge or to direct-merge a branch.
---

# Commit Push Merge

Use this skill only for explicit direct-merge workflows. Prefer `commit-push-pr`
when the user asks for review or publication without merge.

## Workflow

1. Inspect branch, target base, status, staged changes, unstaged diff, and recent
   commit style.
2. Identify whether there are local changes, branch commits to merge, or nothing
   to merge. Stop if there is nothing to merge.
3. When local changes exist, identify the intended changeset and leave unrelated
   user work untouched, including anything already staged.
4. Stage only the intended files or hunks with explicit paths or patch staging.
5. Review `git diff --cached` before committing.
6. Run relevant verification before publication, including configured pre-commit
   hooks when applicable, or report why a check was not run.
7. Commit local changes with a concise Conventional Commits message that matches
   the committed diff.
8. Fetch remote state when network access is available.
9. Inspect upstream and base-branch divergence before pushing.
10. Push the branch, setting upstream if needed.
11. If merging through a PR, inspect required/status checks.
12. Infer or confirm the target branch and merge method. For the pre-merge
    checks, LOAD references/merge-checklist.md.
13. Merge when the branch/worktree clearly matches the work. Ask first if the
   branch appears wrong, the current branch is `main`, or evidence is ambiguous.
14. If safe, fast-forward the local target branch after a successful merge.
15. Run `git status --short`.
16. Report source head SHA, final target SHA when available, branch state,
    verification, and any remaining local work.

## Steering

- Prefer `commit-push-pr` unless the user clearly wants direct merge behavior.
- In the final report, distinguish unrelated remaining work from leftovers tied
  to the merged task when possible.
- Infer the merge target from an existing PR, explicit user request, repo config,
  branch/worktree naming, or default branch. Ask only when evidence conflicts or
  the current branch appears to be the wrong branch or `main`.
- If the branch appears stacked, infer the parent branch from existing PRs,
  branch naming, merge-base, or ancestry; do not collapse the stack without user
  confirmation.
- If PR checks are failing, pending, or unavailable, ask before merging.
- If upstream or base divergence exists, assess the impact of pull, rebase, or
  merge before acting; ask the user when the impact is non-trivial or rewrites
  history.
- If fetch cannot run, report that branch/target decisions used local
  remote-tracking state.
- Never force-push unless the user specifically instructs it after the impact is
  clear.
- Do not amend, fixup, rebase, or otherwise rewrite history unless the user asks
  or confirms after impact assessment.
- Confirm branch deletion separately; do not assume cleanup preferences.
- Do not switch branches or update the local target branch if doing so would
  disturb local work; report the blocker instead.
- If only branch commits exist, skip staging and commit creation.
- If the branch has no new local changes or unmerged commits, stop and report
  the current merge state.
- Already-staged changes may be committed only after `git diff --cached` shows
  they match the intended scope.
- Prefer authoritative source files over generated or runtime copies; include
  generated outputs only when the repo expects them.
- Never commit files likely to contain secrets: `.env`, credentials, tokens, or
  machine-local config.
- Do not bypass hooks with `--no-verify` unless the user explicitly asks.
- Do not use broad staging commands such as `git add -A` or `git add .`.
- Use Conventional Commits format.
- Do not add AI-branded footers, co-authorship, or attribution unless the user
  explicitly asks.
- Treat this as a high-trust workflow, not a casual default.
- Follow the active Git hosting steering and available runtime tools for PR
  checks, merge execution, and remote status.
