#!/usr/bin/env python3
"""Create a scaffolded handover markdown file.

The script writes to the shared handover store by default:
~/.local/state/agentic-tools/handovers/

It uses only the Python standard library and replaces the active handover for
the same project/branch-or-task slug.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_HANDOVER_DIR = Path.home() / ".local" / "state" / "agentic-tools" / "handovers"


def run_git(args: list[str], cwd: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None

    if result.returncode != 0:
        return None

    value = result.stdout.strip()
    return value or None


def slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[\\/\s]+", "-", value)
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip(".-_") or "handover"


def discover(cwd: Path) -> dict[str, str]:
    repo_root = run_git(["rev-parse", "--show-toplevel"], cwd)
    branch = run_git(["branch", "--show-current"], cwd)

    if not branch:
        short_sha = run_git(["rev-parse", "--short", "HEAD"], cwd)
        branch = f"detached-{short_sha}" if short_sha else "unknown-branch"

    worktree = repo_root or str(cwd)
    project = Path(worktree).name

    return {
        "project": project,
        "repo_root": repo_root or str(cwd),
        "worktree": worktree,
        "branch": branch,
    }


def build_content(*, project: str, repo_root: str, worktree: str, branch: str, task: str) -> str:
    updated = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return f"""---
project: {project}
repo_root: {repo_root}
worktree: {worktree}
branch: {branch}
task: {task}
updated: {updated}
---

# Handover: {project} / {task or branch}

## Summary

- TODO

## Read First

- TODO

## Changed Areas

- TODO

## Complete

- TODO

## Incomplete

- TODO

## Blockers

None known

## Decisions

- TODO

## Verification / Commands

Not run

## Runtime State

None known

## Avoid / Do Not Redo

None

## Next Session Prompt

TODO: Continue from this handover. First inspect the referenced files and fresh git status, then proceed with the next concrete step.
"""


def write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass

    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        try:
            tmp_path.chmod(0o600)
        except OSError:
            pass
        tmp_path.replace(path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="Project directory to inspect")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_HANDOVER_DIR, help="Handover output directory")
    parser.add_argument("--project", help="Project slug/name for frontmatter and filename")
    parser.add_argument("--branch", help="Branch name for frontmatter and filename")
    parser.add_argument("--task", help="Task/spec/issue id for frontmatter and filename")
    parser.add_argument("--repo-root", help="Repo root for frontmatter")
    parser.add_argument("--worktree", help="Worktree path for frontmatter")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    cwd = args.cwd.resolve()
    discovered = discover(cwd)

    project = args.project or discovered["project"]
    branch = args.branch or discovered["branch"]
    task = args.task or branch
    repo_root = args.repo_root or discovered["repo_root"]
    worktree = args.worktree or discovered["worktree"]

    filename = f"{slug(project)}__{slug(task)}.md"
    path = args.out_dir.expanduser() / filename
    content = build_content(
        project=project,
        repo_root=repo_root,
        worktree=worktree,
        branch=branch,
        task=task,
    )
    write_private(path, content)

    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
