---
name: handover
description: Save a self-contained recovery prompt for a later agent session in the shared handover store. Use when the user asks to save a handover, pause work, switch context, preserve unfinished implementation state, or hand off work to another session, or when ending a session with incomplete work.
---

# Handover

Create a durable recovery prompt that `catchup` can read before doing fresh discovery.

## Workflow

1. Detect repo root, branch, and active worktree if relevant.
2. For complex sessions, consider using `session-review` first to identify corrections, loose ends, and follow-up work.
3. Gather the current implementation state:
   - changed areas and incomplete work, without treating old git status as current
   - active spec/task progress
   - architectural decisions made this session
   - open risks or blockers
   - next concrete steps
4. Invoke `scripts/new-handover.py` to scaffold the file in `~/.local/state/agentic-tools/handovers/`. Pass `--task` when a spec id, issue id, or user-stated task is known; otherwise let the script use the branch.
5. Replace the older handover for the same project/worktree/branch.
6. Verify the written file exists and is readable.
7. Tell the user where the handover was written and what the next session should load first.

## Rules

- The saved handover must be self-contained: no hidden chat context needed to resume.
- Include enough metadata for selection: repo root, worktree path, branch, timestamp, and task/spec/issue identifiers when present.
- Include a short Summary section with 2-4 factual bullets.
- Record exact file paths and next steps, not vague summaries.
- Use repo-relative plain paths for files inside the repo; use absolute paths for repo root, worktree metadata, and external local-state paths.
- Mention dirty working tree context when relevant, without treating old git status as authoritative.
- Include a copy-pastable Next Session Prompt.
- Include Blockers, Verification / Commands, Runtime State, and Avoid / Do Not Redo sections, even when they say `None known`, `Not run`, or `None`.
- Include task-local user corrections or latest explicit instructions in Decisions when they affect continuation; do not dump the transcript.
- Include commit hashes or branch-base details only when the next session materially depends on them.
- Remove or replace TODO placeholders before reporting the handover complete.
- If work is mid-refactor, explain the incomplete state explicitly.
- Do not store volatile session state in global memory. Handover files are the session bridge.
- Never commit handover files. They are ephemeral local state, not project documentation.
- Do not store secrets, tokens, private keys, one-time codes, session cookies, or raw credential values.
- Do not write generated runtime copies or compiled agent files as part of handover creation.

## References

When structuring the handover file, LOAD references/template.md.

## Scripts

`scripts/new-handover.py` creates the shared handover directory, generates the filename and frontmatter, and writes the required markdown sections with user-private permissions where supported. If the script is unavailable, manually create the same file contract: shared handover directory, `<project-slug>__<branch-or-task-slug>.md`, YAML frontmatter, required sections from `references/template.md`, and private permissions.
