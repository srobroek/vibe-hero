# Catchup Selection Rules

Use these rules when more than one handover could apply, or when the newest handover is not obviously correct.

## Candidate Signals

- Location priority: explicit repo-local untracked-state convention, then `~/.local/state/agentic-tools/handovers/`.
- Search markdown handover files (`*.md`) only.
- Filename pattern: `<project-slug>__<branch-or-task-slug>.md`; useful for ranking, but valid frontmatter can still identify a manually named handover.
- YAML frontmatter with `project`, `repo_root`, `worktree`, `branch`, `task`, and `updated` when available.
- Multiple active handovers per project are valid when branch or task slugs differ.
- Exact repo root or worktree path match.
- Exact branch name match.
- User-stated feature, spec id, issue id, or task name.
- Handover timestamp relative to recent git activity.
- Referenced files that still exist in the current checkout.
- Runtime/session clues the user mentioned, such as a dev server, failing command, or dirty worktree.

## Ranking

1. Filter by filename and frontmatter before reading full bodies.
2. Prefer an exact worktree path and branch match.
3. Prefer a handover that names the user-requested feature/spec/task over a merely recent handover.
4. Use `updated` as an ordering hint only; do not reject a handover solely because it is old.
5. Treat stale handovers as usable evidence, but verify paths, branch names, and commands before acting.
6. If multiple candidates remain plausible, ask one question with 2-4 choices, include project/branch/task/updated, and recommend the most likely candidate.
7. If the selected handover branch differs from the current branch and the user did not name a matching task/branch, ask before editing.
8. Treat placeholder-only scaffolds as incomplete, not as recovery prompts.
9. If the recorded `repo_root` no longer exists and the only match is project name, ask before using it unless the user explicitly named the matching task or branch.

## No Handover Found

Inspect only enough context to orient the next step:

- `git branch --show-current`
- `git status --short`
- Recent commits and changed files
- Active spec artifacts when `.specify/`, `specs/`, or similar workflow folders exist
- Repo-local steering or handover conventions
- Memory, only after live repo evidence and labeled as memory-derived unless verified

Report that no matching handover was found before continuing from discovered evidence.
