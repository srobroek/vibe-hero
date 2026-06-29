#!/usr/bin/env python3
"""List prior agent sessions for a repository, newest first.

Discovers Claude Code transcripts (~/.claude/projects/<encoded>/*.jsonl) and
Codex rollouts (~/.codex/sessions/**/rollout-*.jsonl) whose working directory
matches the target project, then prints a compact, selectable table.

Only the metadata needed to choose a session is emitted -- never full bodies.

Usage:
    list-sessions.py [--project PATH] [--agent claude|codex|all]
                     [--limit N] [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

CLAUDE_ROOT = os.path.expanduser("~/.claude/projects")
CODEX_ROOT = os.path.expanduser("~/.codex/sessions")
LAST_SNIPPET_CHARS = 160  # high-level "where it left off" snippet per session


def default_project() -> str:
    """The repo the user is working in -- NOT the skill/script directory.

    A skill's scripts often run with cwd set to the skill folder, so a plain
    os.getcwd() points at the wrong place. The git toplevel resolves to the
    actual project root even when invoked from inside .claude/skills/...
    """
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return os.getcwd()


def encode_project(path: str) -> str:
    """Claude encodes a project path by replacing every '/' and '.' with '-'."""
    return re.sub(r"[/.]", "-", path)


def parse_ts(value) -> float | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        # Codex sometimes uses epoch seconds.
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def rel_time(epoch: float | None) -> str:
    if not epoch:
        return "unknown"
    delta = max(0, time.time() - epoch)
    for unit, secs in (("d", 86400), ("h", 3600), ("m", 60)):
        if delta >= secs:
            return f"{int(delta // secs)}{unit} ago"
    return "just now"


def abs_time(epoch: float | None) -> str:
    if not epoch:
        return "unknown"
    return datetime.fromtimestamp(epoch, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")


def iter_json_lines(path: str):
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except (ValueError, TypeError):
                continue


def _text_from_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("text", "input_text"):
                parts.append(block.get("text", ""))
        return " ".join(p for p in parts if p)
    return ""


def _is_tool_result(content) -> bool:
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    )


def scan_claude(path: str) -> dict:
    """Extract selection metadata from one Claude transcript."""
    first_prompt = ""
    ai_title = ""
    branch = ""
    last_ts = None
    turns = 0
    last_assistant = ""
    session_id = os.path.splitext(os.path.basename(path))[0]
    for rec in iter_json_lines(path):
        rtype = rec.get("type")
        ts = parse_ts(rec.get("timestamp"))
        if ts:
            last_ts = ts if last_ts is None else max(last_ts, ts)
        if rec.get("gitBranch"):
            branch = rec["gitBranch"]
        if rtype == "ai-title" and rec.get("aiTitle"):
            ai_title = rec["aiTitle"]
        elif rtype == "user":
            content = rec.get("message", {}).get("content")
            if _is_tool_result(content):
                continue
            turns += 1
            if not first_prompt:
                text = _text_from_content(content).strip()
                if text and not text.startswith("<"):
                    first_prompt = text
        elif rtype == "assistant":
            turns += 1
            text = _text_from_content(rec.get("message", {}).get("content")).strip()
            if text:
                last_assistant = text  # keep the most recent assistant prose
    if last_ts is None:
        last_ts = os.path.getmtime(path)
    return {
        "agent": "claude",
        "session_id": session_id,
        "title": ai_title or first_prompt,
        "goal": first_prompt,
        "last": last_assistant,
        "branch": branch,
        "last_ts": last_ts,
        "turns": turns,
        "path": path,
    }


def collect_claude(project: str) -> list[dict]:
    proj_dir = os.path.join(CLAUDE_ROOT, encode_project(project))
    if not os.path.isdir(proj_dir):
        return []
    out = []
    for name in os.listdir(proj_dir):
        if name.endswith(".jsonl"):
            out.append(scan_claude(os.path.join(proj_dir, name)))
    return out


def scan_codex(path: str, project: str) -> dict | None:
    """Return metadata only if this rollout's cwd matches the project."""
    meta_cwd = None
    session_id = ""
    first_prompt = ""
    last_agent = ""
    last_ts = None
    turns = 0
    for rec in iter_json_lines(path):
        rtype = rec.get("type")
        payload = rec.get("payload", {})
        ts = parse_ts(rec.get("timestamp"))
        if ts:
            last_ts = ts if last_ts is None else max(last_ts, ts)
        if rtype == "session_meta":
            meta_cwd = payload.get("cwd")
            session_id = payload.get("id", "")
            if meta_cwd and os.path.realpath(meta_cwd) != os.path.realpath(project):
                return None  # cheap early-out before scanning the body
        elif rtype == "event_msg" and payload.get("type") == "user_message":
            turns += 1
            if not first_prompt:
                msg = (payload.get("message") or "").strip()
                if msg and not msg.startswith("<"):
                    first_prompt = msg
        elif rtype == "event_msg" and payload.get("type") == "agent_message":
            turns += 1
            msg = (payload.get("message") or "").strip()
            if msg:
                last_agent = msg
    if meta_cwd is None or os.path.realpath(meta_cwd) != os.path.realpath(project):
        return None
    if last_ts is None:
        last_ts = os.path.getmtime(path)
    return {
        "agent": "codex",
        "session_id": session_id or os.path.basename(path),
        "title": first_prompt,
        "goal": first_prompt,
        "last": last_agent,
        "branch": "",
        "last_ts": last_ts,
        "turns": turns,
        "path": path,
    }


def collect_codex(project: str) -> list[dict]:
    if not os.path.isdir(CODEX_ROOT):
        return []
    out = []
    for root, _, files in os.walk(CODEX_ROOT):
        for name in files:
            if name.startswith("rollout-") and name.endswith(".jsonl"):
                entry = scan_codex(os.path.join(root, name), project)
                if entry:
                    out.append(entry)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", default=None,
                    help="repo to list sessions for (default: the git repo root)")
    ap.add_argument("--agent", choices=["claude", "codex", "all"], default="all")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = ap.parse_args()

    project = os.path.realpath(os.path.expanduser(args.project or default_project()))
    entries: list[dict] = []
    if args.agent in ("claude", "all"):
        entries += collect_claude(project)
    if args.agent in ("codex", "all"):
        entries += collect_codex(project)

    entries.sort(key=lambda e: e["last_ts"], reverse=True)
    entries = entries[: args.limit]

    if args.json:
        print(json.dumps(entries, indent=2, default=str))
        return 0

    if not entries:
        print(f"No prior sessions found for project: {project}")
        print("(searched Claude ~/.claude/projects and Codex ~/.codex/sessions)")
        return 0

    lines = [f"Prior sessions for {project}  (newest first, {len(entries)} shown)\n"]
    for idx, e in enumerate(entries, 1):
        title = (e["title"] or "(no title)").replace("\n", " ")
        if len(title) > 68:
            title = title[:67] + "…"
        branch = f" [{e['branch']}]" if e["branch"] else ""
        lines.append(
            f"{idx:>2}. {e['agent']:<6} {e['session_id'][:8]}  "
            f"{rel_time(e['last_ts']):<10} {abs_time(e['last_ts'])}  "
            f"{e['turns']:>3} turns{branch}"
        )
        lines.append(f"      {title}")
        last = (e.get("last") or "").replace("\n", " ").strip()
        if last and last != title:
            if len(last) > LAST_SNIPPET_CHARS:
                last = last[:LAST_SNIPPET_CHARS - 1] + "…"
            lines.append(f"      ↳ left off: {last}")
        lines.append(f"      id: {e['session_id']}")
    lines.append(
        "\nSelect one, then: read-session.py --session <id> "
        "(add --project if not run from the repo root)"
    )
    body = "\n".join(lines)
    tokens = (len(body) + 3) // 4
    body += f"\n\nDiscovery cost: ~{tokens:,} uncached tokens (~{len(body):,} chars, estimated)."
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
