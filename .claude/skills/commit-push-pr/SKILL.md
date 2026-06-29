---
name: commit-push-pr
description: Publish a branch by committing local changes when needed, pushing, and opening or updating a pull request. Use when the user explicitly asks to commit and push with a PR, open a PR, or publish the current branch for review.
---

# Commit Push PR

Use this skill only for an explicit PR publication workflow. For local-only
commits use `quick-commit`; for direct merge requests use `commit-push-merge`.

## Workflow

1. Inspect branch, target base, status, staged changes, unstaged diff, and recent
   commit style.
2. Identify whether there are local changes, unpushed commits, or nothing to
   publish. Stop if there is nothing to publish.
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
10. Push the current branch, setting upstream if needed.
11. Create or update the PR with a factual title, summary, and test plan. For
   structure, LOAD references/pr-template.md.
12. Check initial PR status when available and start non-blocking CI monitoring
    if the runtime supports it.
13. Run `git status --short`.
14. Report the PR URL, pushed branch, pushed head SHA, verification, and any
    remaining local work.

## Steering

- Treat PR creation as explicit user-directed publication, not a default end state.
- In the final report, distinguish unrelated remaining work from leftovers tied
  to the published task when possible.
- Infer the PR base from an existing PR, explicit user request, repo config,
  branch/worktree naming, or default branch. Ask only when evidence conflicts or
  the current branch appears to be the wrong branch or `main`.
- If the branch appears stacked, infer the parent branch from existing PRs,
  branch naming, merge-base, or ancestry; ask if uncertain.
- Do not merge the PR unless the user separately asks for merge behavior.
- If upstream or base divergence exists, assess the impact of pull, rebase, or
  merge before acting; ask the user when the impact is non-trivial or rewrites
  history.
- If fetch cannot run, report that branch/base decisions used local
  remote-tracking state.
- Never force-push unless the user specifically instructs it after the impact is
  clear.
- Do not amend, fixup, rebase, or otherwise rewrite history unless the user asks
  or confirms after impact assessment.
- If only unpushed commits exist, skip staging and commit creation.
- If the branch has no new local changes or unpushed commits and an existing PR
  already represents the branch, stop and report the current PR state.
- Already-staged changes may be committed only after `git diff --cached` shows
  they match the intended scope.
- Prefer authoritative source files over generated or runtime copies; include
  generated outputs only when the repo expects them.
- Never commit files likely to contain secrets: `.env`, credentials, tokens, or
  machine-local config.
- Do not bypass hooks with `--no-verify` unless the user explicitly asks.
- Do not hide broad or risky staging inside a generic commit message.
- Do not use broad staging commands such as `git add -A` or `git add .`.
- Use Conventional Commits format.
- Do not add AI-branded footers, co-authorship, or attribution to commits or
  the PR body unless the user explicitly asks.
- For a single-commit branch, use the commit message as the default PR title.
- For a multi-commit branch, write a concise Conventional Commit-style PR title
  that summarizes the branch.
- If a PR already exists, update routine title/body details only when they align
  with the current branch state.
- Ask before overwriting substantial human-written PR context or changing base
  branch, labels, reviewers, draft state, or merge settings.
- Do not retarget an existing PR base branch unless the user asks or confirms.
- Do not add reviewers, labels, milestones, projects, or assignees unless the
  user asks or confirms after you surface the convention.
- Create a regular ready-for-review PR by default. Use draft only when the user
  asks, repo convention is clear, or publication is requested despite incomplete
  verification.
- Do not block waiting for CI unless the user asks; monitor in the background
  when possible and surface failures if they arrive during the session.
- Prefer a short, factual PR body over template bloat.
- Follow the active Git hosting steering and available runtime tools for PR
  creation, updates, and status checks.
