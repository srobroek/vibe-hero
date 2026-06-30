# vibe-hero

**Level up your agentic-coding skills while you work.** vibe-hero is a Claude Code
plugin that quietly tracks what you're good at, offers short knowledge checks at the
*end* of a unit of work (never mid-task), grades them, and shows you a progress
dashboard — like an Elo rating and a belt system for working with AI coding tools.

It bundles an **MCP server** (the engine), four **skills** (setup, quiz, status,
learn), and an end-of-work **Stop hook**. You never call it directly — you just talk
to Claude (*"quiz me on subagents"*, *"how am I doing?"*) and it does the rest.

---

## Install (globally — recommended)

vibe-hero tracks **one learning profile for you as a person**, across every project.
Installing it per-project would split your progress into disconnected silos and make
little sense. **Install it once, globally** (the default `user` scope):

```bash
claude plugin marketplace add srobroek/vibe-hero
claude plugin install vibe-hero@vibe-hero          # --scope user is the default (global)
```

That's it — it's now available in every Claude Code session on your machine. The
plugin's `.mcp.json` launches the server on demand via `npx -y @vibe-hero/server`
(downloaded once, then cached), so there's nothing to build.

> **Supported hosts:** Claude Code, Codex, Kiro CLI, Kiro IDE. On any other host
> vibe-hero returns a clear "unsupported tool" message rather than guessing — the
> tool you're using is auto-detected, never asked.

To remove it:

```bash
claude plugin uninstall vibe-hero
claude plugin marketplace remove vibe-hero
```

## First run

In any Claude session, say **"set up vibe-hero."** It asks three quick questions
(how often to offer quizzes, whether to offer proactively, and quiz length) and
nothing else — the tool you're learning is detected automatically. After that:

| Say this | What happens |
|---|---|
| *"Quiz me on subagents"* | A 3–5 question quiz; your ability updates as you answer |
| *"How am I doing?"* | The progress dashboard — a topics × tools matrix, scores, and trend graphs |
| *"What should I learn next?"* | Guidance toward your weakest or stalest topic |
| *(finish some work)* | The Stop hook may offer a relevant or due-for-review quiz |

You level up by answering progressively harder questions correctly, graduating tiers
100 → 500 (Introductory → Expert), tracked **independently per tool and for general
skills**.

Full walkthrough: [`docs/runbooks/testing-vibe-hero.md`](docs/runbooks/testing-vibe-hero.md).

---

## Your data never leaves your machine

This is a core design principle, not a setting:

- **Your profile is local only.** Everything vibe-hero records about you —
  abilities, tiers, quiz history, the dashboard's trend data — lives in a single
  file at `~/.vibe-hero/profile.json` on your machine. It is never uploaded
  anywhere.
- **Only derived scores are stored.** The profile contains grades, Elo numbers, and
  topic ids — **never your prompts, your code, or any tool input/output.** You can
  open `~/.vibe-hero/profile.json` and verify this yourself.
- **No telemetry.** vibe-hero makes exactly one kind of network request, and it's
  *download-only* (see below). Nothing about your activity is ever transmitted.

## How the question catalog is pulled and verified

vibe-hero ships with its full question catalog **bundled inside the package**, so it
works completely offline out of the box — no network needed to take a quiz.

Optionally, you can point it at a published catalog to get curriculum updates without
reinstalling, by setting one environment variable:

```bash
export VIBE_HERO_CONTENT_URL="https://your-host/content"   # serves manifest.json + topic files
```

When set, updates are pulled **safely and one-directionally** (download only):

1. **Change check (cheap).** It fetches `manifest.json` with an HTTP `ETag`; a
   `304 Not Modified` means nothing changed and nothing is downloaded.
2. **Integrity verification.** The manifest lists a **SHA-256 hash for every topic
   file**. Each downloaded file's bytes are checked against that hash — a mismatch
   (corruption or tampering) **rejects the update entirely**; corrupt content is
   never cached or served.
3. **Hash-based diffing.** On a first/cold fetch, per-topic hashes are compared
   against the bundled copy, so topics that haven't actually changed are **not
   re-downloaded**.
4. **Always-safe fallback.** Any failure — offline, DNS, timeout, bad content —
   silently falls back to the local cache, then to the bundled catalog. You never
   see an error, and a quiz always works.

The catalog manifest (`content/manifest.json`, with per-topic `sha256`) is generated
at build/CI time from the source content in `content/<tool>/*.yaml`.

---

## How it works (under the hood)

- **MCP server** (`@vibe-hero/server`, in `packages/server`) — the engine: 11 tools
  for setup, quizzing, scoring, status, guidance, offers, and the dashboard. Pure
  Elo-based ability estimation with spaced-review decay; deterministic grading for
  multiple-choice, rubric-based judging for free-form items.
- **Plugin** (`packages/vibe-hero-plugin`) — the skills + Stop hook + `.mcp.json`
  that make it usable in Claude Code with zero config.
- **Content** (`content/`) — the question catalog: ~2,800 ELO-calibrated items
  across 29 topics (Claude Code, Codex, Kiro CLI, Kiro IDE, and general software
  engineering), authored from primary sources and adversarially reviewed.

## Debugging & logging

The MCP server has structured logging, off by default. Logs are newline-delimited
JSON written to **stderr only** (stdout is reserved for the JSON-RPC stream, so
logging there would corrupt the protocol). Two environment variables control it:

| Variable | Effect |
|---|---|
| `VIBE_HERO_DEBUG=1` | Turn logging on at `debug` level. |
| `VIBE_HERO_DEBUG=/path/to/file.log` | Turn logging on **and** tee every line to that file — the reliable way to capture output when a host swallows the server's stderr. |
| `VIBE_HERO_LOG_LEVEL=trace\|debug\|info\|warn\|error\|silent` | Set the level explicitly (overrides the level implied by `VIBE_HERO_DEBUG`). Default is `silent`. |

Run it directly and watch the logs:

```bash
# logs to your terminal (stderr)
VIBE_HERO_DEBUG=1 npx -y @vibe-hero/server

# logs to a file you can tail (pretty-print NDJSON with jq)
VIBE_HERO_DEBUG=/tmp/vibe-hero.log npx -y @vibe-hero/server
tail -f /tmp/vibe-hero.log | jq .
```

You'll see startup (Node version, tool count), the client handshake + detected tool,
and every tool call + result.

### Enabling logs inside Claude Code

The plugin launches the server from its `.mcp.json`. To turn logging on for a real
session, add an `env` block there (env vars are passed to the spawned server):

```json
{
  "mcpServers": {
    "vibe-hero": {
      "command": "npx",
      "args": ["-y", "@vibe-hero/server"],
      "env": { "VIBE_HERO_DEBUG": "/tmp/vibe-hero.log" }
    }
  }
}
```

Then `tail -f /tmp/vibe-hero.log | jq .` while you use vibe-hero. The same `env`
block is how you'd set `VIBE_HERO_CONTENT_URL` (remote catalog) or `VIBE_HERO_HOME`
(profile location) for the plugin-launched server.

## License

Apache-2.0
