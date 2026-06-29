# Handover Structure

Write handovers to `~/.local/state/agentic-tools/handovers/` unless repo-local instructions define another untracked local-state handover path. Create the directory if missing. Use user-private permissions where supported, such as directory mode `0700` and file mode `0600`. Use `<project-slug>__<branch-or-task-slug>.md` and replace the prior file for the same project/worktree/branch.

Prefer `scripts/new-handover.py` when available; it creates the directory, normalizes slugs, writes frontmatter, and scaffolds the body sections.

Use YAML frontmatter for selection:

```yaml
---
project: project-slug
repo_root: /absolute/repo/root
worktree: /absolute/worktree/path
branch: branch-name
task: task-or-spec-id
updated: <ISO-8601 timestamp>
---
```

The body should capture:

- Summary: 2-4 factual bullets
- what the next session should read first
- Changed Areas: paths, modules, or domains touched
- dirty working tree context when relevant, without recording old git status as durable truth
- what is already complete
- what is still incomplete
- Blockers: external dependencies, access issues, missing decisions, or `None known`
- the important design decisions already made, including task-local user corrections or latest explicit instructions that affect continuation
- Verification / Commands: material commands and outcomes, or `Not run`
- Runtime State: stable URLs, ports, containers, tunnels, or `None known`
- Avoid / Do Not Redo: failed attempts, stale assumptions, and what to do instead
- Next Session Prompt: copy-pastable instructions with exact files to inspect or edit

Use repo-relative plain paths for files inside the repo. Use absolute paths for repo root, worktree metadata, and external local-state paths.

Do not record exact git status as durable truth; `catchup` should check fresh git state. Include commit hashes or branch-base details only when the next session materially depends on them.

Do not include secrets, tokens, private keys, one-time codes, session cookies, or raw credential values. Reference secret locations or profiles instead.

Good handovers are implementation-directed, not narrative, and are never committed by default.
