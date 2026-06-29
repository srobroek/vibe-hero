#!/usr/bin/env python3
"""Emit the most recent context of one agent session, newest turn first.

Reads a Claude Code or Codex transcript and renders a small, filtered window of
the latest turns so the caller can understand where work left off WITHOUT
loading the whole conversation. Designed to be paged: read the newest window,
and only widen (--offset / --turns) if the leftoff state is still ambiguous.

Filtered out: reasoning/thinking blocks (unless --include-thinking), base64
attachments, encrypted content, and oversized tool output (truncated). Kept:
real user prompts, assistant text, tool calls (name + brief args), truncated
tool results, session metadata, and the latest todo/plan state.

Usage:
    read-session.py (--session ID | --file PATH) [--project PATH]
                    [--agent claude|codex] [--turns N] [--offset M]
                    [--max-chars N] [--include-thinking]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

CLAUDE_ROOT = os.path.expanduser("~/.claude/projects")
CODEX_ROOT = os.path.expanduser("~/.codex/sessions")


def default_project() -> str:
    """The repo the user is working in -- the git toplevel, not the skill dir.

    Skill scripts often run with cwd set to the skill folder, so os.getcwd()
    points at the wrong place; the git root resolves the actual project even
    when invoked from inside .claude/skills/...
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

TURN_CHARS = 2000      # max chars rendered per user/assistant text body
TOOL_ARG_CHARS = 220   # max chars of a tool call's brief args
TOOL_RESULT_CHARS = 320  # max chars of a truncated tool result


def encode_project(path: str) -> str:
    return re.sub(r"[/.]", "-", path)


def parse_ts(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def fmt_ts(epoch):
    if not epoch:
        return "?"
    return datetime.fromtimestamp(epoch, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")


def est_tokens(text: str) -> int:
    """Rough token estimate for an English/code mix (~4 chars per token).

    Reports the uncached context cost of the emitted window -- this output is
    freshly generated each call, so every token of it is uncached input.
    """
    return (len(text) + 3) // 4


def clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) > limit:
        return text[:limit].rstrip() + f" …[+{len(text) - limit} chars]"
    return text


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


# ---------------------------------------------------------------------------
# Session resolution
# ---------------------------------------------------------------------------

def resolve_file(args) -> tuple[str, str]:
    if args.file:
        path = os.path.expanduser(args.file)
        if not os.path.isfile(path):
            sys.exit(f"error: file not found: {path}")
        agent = args.agent or ("codex" if ".codex" in path else "claude")
        return path, agent

    if not args.session:
        sys.exit("error: provide --session ID or --file PATH")

    sid = args.session
    project = os.path.realpath(os.path.expanduser(args.project or default_project()))

    if args.agent in (None, "claude"):
        proj_dir = os.path.join(CLAUDE_ROOT, encode_project(project))
        if os.path.isdir(proj_dir):
            matches = [
                os.path.join(proj_dir, n)
                for n in os.listdir(proj_dir)
                if n.endswith(".jsonl") and n.startswith(sid)
            ]
            if len(matches) == 1:
                return matches[0], "claude"
            if len(matches) > 1:
                sys.exit(f"error: session prefix '{sid}' is ambiguous: {len(matches)} matches")

    if args.agent in (None, "codex"):
        for root, _, files in os.walk(CODEX_ROOT):
            for name in files:
                if name.startswith("rollout-") and name.endswith(".jsonl") and sid in name:
                    return os.path.join(root, name), "codex"
        # Fall back to matching session_meta id inside files.
        for root, _, files in os.walk(CODEX_ROOT):
            for name in files:
                if not (name.startswith("rollout-") and name.endswith(".jsonl")):
                    continue
                path = os.path.join(root, name)
                for rec in iter_json_lines(path):
                    if rec.get("type") == "session_meta":
                        if rec.get("payload", {}).get("id", "").startswith(sid):
                            return path, "codex"
                        break

    sys.exit(f"error: no session matching '{sid}' (try list-sessions.py first)")


# ---------------------------------------------------------------------------
# Turn model -- a normalized list of {role, ts, text, tools[]} chronological.
# ---------------------------------------------------------------------------

def load_claude(path: str, include_thinking: bool):
    meta = {"agent": "claude", "session_id": os.path.splitext(os.path.basename(path))[0],
            "cwd": "", "branch": "", "version": "", "title": "", "last_ts": None}
    turns: list[dict] = []
    latest_todos = None

    for rec in iter_json_lines(path):
        rtype = rec.get("type")
        ts = parse_ts(rec.get("timestamp"))
        if ts:
            meta["last_ts"] = ts if meta["last_ts"] is None else max(meta["last_ts"], ts)
        if rec.get("cwd"):
            meta["cwd"] = rec["cwd"]
        if rec.get("gitBranch"):
            meta["branch"] = rec["gitBranch"]
        if rec.get("version"):
            meta["version"] = rec["version"]
        if rtype == "ai-title" and rec.get("aiTitle"):
            meta["title"] = rec["aiTitle"]
        elif rtype == "user":
            content = rec.get("message", {}).get("content")
            if isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            ):
                # Attach truncated tool result to the most recent assistant tool.
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        res = block.get("content")
                        if isinstance(res, list):
                            res = " ".join(
                                b.get("text", "") for b in res if isinstance(b, dict)
                            )
                        if turns and turns[-1]["tools"]:
                            turns[-1]["tools"][-1]["result"] = clip(str(res), TOOL_RESULT_CHARS)
                continue
            text = content if isinstance(content, str) else " ".join(
                b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"
            )
            turns.append({"role": "user", "ts": ts, "text": text, "tools": []})
        elif rtype == "assistant":
            blocks = rec.get("message", {}).get("content", [])
            text_parts, tools, thinking = [], [], []
            for block in blocks if isinstance(blocks, list) else []:
                if not isinstance(block, dict):
                    continue
                bt = block.get("type")
                if bt == "text":
                    text_parts.append(block.get("text", ""))
                elif bt == "thinking" and include_thinking:
                    thinking.append(block.get("thinking", ""))
                elif bt == "tool_use":
                    name = block.get("name", "tool")
                    tinp = block.get("input", {}) or {}
                    if name == "TodoWrite" and isinstance(tinp.get("todos"), list):
                        latest_todos = tinp["todos"]
                        tools.append({"name": name, "brief": f"{len(tinp['todos'])} todos (see latest plan above)", "result": ""})
                    else:
                        tools.append({"name": name, "brief": brief_args(tinp), "result": ""})
            body = " ".join(p for p in text_parts if p)
            if include_thinking and thinking:
                body = "[thinking] " + clip(" ".join(thinking), 400) + ("\n" + body if body else "")
            turns.append({"role": "assistant", "ts": ts, "text": body, "tools": tools})

    return meta, drop_empty(turns), latest_todos


def drop_empty(turns: list[dict]) -> list[dict]:
    """Remove turns with no rendered text and no tool calls (e.g. thinking-only)."""
    return [t for t in turns if (t["text"] or "").strip() or t["tools"]]


def brief_args(tinp: dict) -> str:
    """A short, human-readable summary of a tool call's salient arguments."""
    for key in ("file_path", "path", "command", "pattern", "query", "url", "prompt", "description"):
        if key in tinp and tinp[key]:
            return f"{key}={clip(str(tinp[key]), TOOL_ARG_CHARS)}"
    return clip(json.dumps(tinp, default=str), TOOL_ARG_CHARS) if tinp else ""


def load_codex(path: str, include_thinking: bool):
    meta = {"agent": "codex", "session_id": "", "cwd": "", "branch": "",
            "version": "", "title": "", "last_ts": None}
    turns: list[dict] = []
    latest_todos = None

    for rec in iter_json_lines(path):
        rtype = rec.get("type")
        payload = rec.get("payload", {}) or {}
        ts = parse_ts(rec.get("timestamp"))
        if ts:
            meta["last_ts"] = ts if meta["last_ts"] is None else max(meta["last_ts"], ts)
        if rtype == "session_meta":
            meta["session_id"] = payload.get("id", "")
            meta["cwd"] = payload.get("cwd", "")
            meta["version"] = payload.get("cli_version", "")
        elif rtype == "event_msg" and payload.get("type") == "user_message":
            text = payload.get("message", "")
            turns.append({"role": "user", "ts": ts, "text": text, "tools": []})
            if not meta["title"] and text and not text.startswith("<"):
                meta["title"] = clip(text, 80)
        elif rtype == "event_msg" and payload.get("type") == "agent_message":
            turns.append({"role": "assistant", "ts": ts, "text": payload.get("message", ""), "tools": []})
        elif rtype == "response_item" and payload.get("type") == "reasoning" and include_thinking:
            summary = payload.get("summary") or []
            text = " ".join(
                s.get("text", "") for s in summary if isinstance(s, dict)
            ).strip()
            if text:
                turns.append({"role": "assistant", "ts": ts, "text": "[reasoning] " + clip(text, 400), "tools": []})
        elif rtype == "response_item" and payload.get("type") in (
            "function_call", "local_shell_call", "custom_tool_call",
        ):
            name = payload.get("name") or payload.get("type")
            raw = payload.get("arguments") or payload.get("input") or payload.get("action") or ""
            if name == "update_plan":
                try:
                    plan = json.loads(raw) if isinstance(raw, str) else raw
                    if isinstance(plan, dict) and isinstance(plan.get("plan"), list):
                        latest_todos = [
                            {"content": s.get("step", ""), "status": s.get("status", "")}
                            for s in plan["plan"]
                        ]
                except (ValueError, TypeError):
                    pass
            tool = {"name": name, "brief": clip(str(raw), TOOL_ARG_CHARS), "result": ""}
            if turns and turns[-1]["role"] == "assistant":
                turns[-1]["tools"].append(tool)
            else:
                turns.append({"role": "assistant", "ts": ts, "text": "", "tools": [tool]})

    return meta, drop_empty(turns), latest_todos


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render_todos(todos) -> list[str]:
    glyph = {"completed": "[x]", "in_progress": "[~]", "pending": "[ ]"}
    lines = []
    for t in todos:
        status = t.get("status", "")
        content = t.get("content") or t.get("activeForm") or ""
        lines.append(f"  {glyph.get(status, '[?]')} {content}")
    return lines


def render_turn(turn: dict, index: int) -> str:
    role = "USER" if turn["role"] == "user" else "ASSISTANT"
    icon = "👤" if turn["role"] == "user" else "🤖"
    head = f"### [{index}] {icon} {role} — {fmt_ts(turn['ts'])}"
    body = clip(turn["text"], TURN_CHARS)
    lines = [head]
    if body:
        lines.append(body)
    for tool in turn["tools"]:
        brief = f"({tool['brief']})" if tool["brief"] else ""
        lines.append(f"  ⮑ {tool['name']}{brief}")
        if tool.get("result"):
            lines.append(f"     ↳ {tool['result']}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--session")
    ap.add_argument("--file")
    ap.add_argument("--project", default=None,
                    help="repo the session belongs to (default: the git repo root)")
    ap.add_argument("--agent", choices=["claude", "codex"])
    ap.add_argument("--turns", type=int, default=8, help="turns per window (default 8)")
    ap.add_argument("--offset", type=int, default=0, help="skip this many newest turns (page older)")
    ap.add_argument("--max-chars", type=int, default=14000, help="hard cap on rendered window size")
    ap.add_argument("--include-thinking", action="store_true")
    args = ap.parse_args()

    path, agent = resolve_file(args)
    loader = load_codex if agent == "codex" else load_claude
    meta, turns, latest_todos = loader(path, args.include_thinking)

    total = len(turns)
    end = total - args.offset            # exclusive upper bound (chronological)
    if end <= 0:
        print(f"No turns at offset {args.offset} (session has {total} turns).")
        return 0
    start = max(0, end - args.turns)
    window = turns[start:end]            # chronological slice

    # Render newest first, stopping early if the char budget is exhausted.
    rendered, used, shown = [], 0, 0
    for i in range(len(window) - 1, -1, -1):
        block = render_turn(window[i], start + i + 1)
        if used + len(block) > args.max_chars and rendered:
            break
        rendered.append(block)
        used += len(block)
        shown += 1

    first_shown = start + (len(window) - shown) + 1
    last_shown = end

    out = ["# Session resume context"]
    out.append(
        f"agent: {meta['agent']} | session: {meta['session_id'][:12]} | "
        f"branch: {meta['branch'] or '?'} | turns: {total}"
    )
    out.append(f"cwd: {meta['cwd'] or '?'}")
    if meta["title"]:
        out.append(f"title: {meta['title']}")
    out.append(f"last active: {fmt_ts(meta['last_ts'])}")
    out.append(f"window: turns {first_shown}..{last_shown} of {total} (newest first)\n")

    if latest_todos:
        out.append("## Latest plan / todo state")
        out += render_todos(latest_todos)
        out.append("")

    out.append("## Recent turns (newest first)")
    out += rendered

    older = args.offset + shown
    out.append("\n---")
    if older < total:
        out.append(
            f"Older context remains ({total - older} earlier turns). If the leftoff "
            f"state is still unclear, page back:\n"
            f"  read-session.py --session {meta['session_id'][:8]} "
            f"--offset {older} --turns {args.turns}"
        )
    else:
        out.append("Start of session reached — no older turns.")

    body = "\n".join(out)
    chars = len(body)
    tokens = est_tokens(body)
    body += (
        f"\n\nResume cost (this window): ~{tokens:,} uncached tokens "
        f"(~{chars:,} chars, estimated). Each page adds to the resume; "
        f"sum the windows you read for the total."
    )
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
