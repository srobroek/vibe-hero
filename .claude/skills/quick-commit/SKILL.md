---
name: quick-commit
description: Create a deliberate local git commit without pushing or opening a PR. Use when the user asks to commit local changes, make a checkpoint commit, or run a fast commit-only workflow.
---

# Quick Commit

Create a local commit only. Do not push, open a PR, merge, tag, or publish unless
the user separately asks for that workflow.

## Workflow

1. Inspect branch, status, staged changes, unstaged diff, and recent commit
   style. Use `scripts/status.sh` for the quick status/changeset pass.
2. Stop if there are no staged or unstaged local changes to commit.
3. Identify the intended changeset. Separate unrelated user work from the files
   you plan to commit, including anything already staged.
4. Decide whether a changeset is required; LOAD references/changeset-policy.md.
5. Stage only the intended files or hunks with explicit paths or patch staging.
6. Review `git diff --cached` before committing.
7. Run the smallest relevant verification that matches the risk of the diff,
   including configured pre-commit hooks when applicable, or report why no
   verification was run.
8. Commit with a concise Conventional Commits message that matches the committed
   diff.
9. Run `git status --short`.
10. Show the resulting head commit SHA and any remaining uncommitted work.

## Steering

- Treat existing unrelated changes as user-owned. Do not revert, restage, or
  include them without a clear reason.
- In the final report, distinguish unrelated remaining work from leftovers tied
  to the committed task when possible.
- Prefer authoritative source files over generated or runtime copies; include
  generated outputs only when the repo expects them.
- Already-staged changes may be committed only after `git diff --cached` shows
  they match the intended scope.
- Never commit files likely to contain secrets: `.env`, credentials, tokens, or
  machine-local config.
- Do not bypass hooks with `--no-verify` unless the user explicitly asks.
- Do not hide broad staging behind a generic commit message.
- Do not use broad staging commands such as `git add -A` or `git add .`.
- Do not amend, fixup, rebase, or otherwise rewrite history unless the user
  explicitly asks.
- Keep the commit message aligned with the committed diff, not intended future
  work.
- Use Conventional Commits format.
- Do not add AI-branded footers, co-authorship, or attribution unless the user
  explicitly asks.
- If a changeset is required, create it before committing.
- Stop and ask before committing if the intended scope cannot be separated
  safely.
