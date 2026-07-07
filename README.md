# vibe-hero

Practice and track your agentic-coding skills while you work. vibe-hero is a Claude
Code plugin that tracks what you're good at, offers short knowledge checks at
natural breakpoints in your work (never mid-task), grades them, and shows you a
progress dashboard — an Elo rating and tier system for working with AI coding tools.

It bundles an MCP server (the engine), four skills (setup, quiz, status, learn), and
background hooks that observe your activity (privately, on your machine) to time
quiz offers. You don't call it directly — you talk to Claude (*"quiz me on
subagents"*, *"how am I doing?"*) and it does the rest.

---

## Install (globally — recommended)

Install vibe-hero once, globally (the default `user` scope), so it's available in
every Claude Code session without reinstalling per project:

```bash
claude plugin marketplace add srobroek/vibe-hero
claude plugin install vibe-hero@vibe-hero          # --scope user is the default (global)
```

Your learning profile is the same either way — it lives at `~/.vibe-hero/profile.json`
regardless of how the plugin is installed — so a global install just saves you from
re-installing in each project.

The plugin's `.mcp.json` launches the server on demand via `npx -y @vibe-hero/server`
(downloaded once, then cached), so there's nothing to build.

> **Host support.** The packaged plugin — skills, hooks, automatic offers — is
> **Claude Code only** today. The underlying MCP server auto-detects its host and
> also recognizes Codex, Kiro CLI, and Kiro IDE (question content for all four is
> bundled), so you can wire the server into those hosts manually and quiz/status
> tools will work — but there is no packaged plugin, no hooks, and no organic
> offer flow outside Claude Code. Unknown hosts get a clear "unsupported tool"
> message rather than a guess.

To remove it:

```bash
claude plugin uninstall vibe-hero
claude plugin marketplace remove vibe-hero
```

## First run

In any Claude session, say **"set up vibe-hero."** It asks three questions (how often
to offer quizzes, whether to offer proactively, and quiz length) — the tool you're
learning is detected automatically. After that:

| Say this | What happens |
|---|---|
| *"Quiz me on subagents"* | A 3–5 question quiz; your ability updates as you answer |
| *"How am I doing?"* | The progress dashboard — a topics × tools matrix, scores, and trend graphs |
| *"What should I learn next?"* | Guidance toward your weakest or stalest topic |
| *(just work)* | Activity hooks accumulate evidence per topic; at a natural seam (a commit, a finished task, a quiet pause) a relevant quiz may be offered |

You level up by answering progressively harder questions correctly, graduating tiers
100 → 500 (Introductory → Expert), tracked independently per tool and for general
skills.

Full walkthrough: [`docs/runbooks/testing-vibe-hero.md`](docs/runbooks/testing-vibe-hero.md).

---

## Your data stays on your machine

Everything vibe-hero records about you — abilities, tiers, quiz history, the
dashboard's trend data — lives in a single file at `~/.vibe-hero/profile.json` and is
never uploaded. That file holds only grades, Elo numbers, and topic ids, never your
prompts, code, or any tool input/output, which you can confirm by opening it. The
activity hooks write derived signals to a short-lived local spool that is consumed
and deleted within seconds; raw command text never reaches the profile or any log.
The only network request vibe-hero makes is download-only (see below); nothing about
your activity is transmitted.

## How the question catalog is pulled and verified

vibe-hero ships its full question catalog bundled inside the package, so it works
offline — no network needed to take a quiz.

To get curriculum updates without reinstalling, point it at a published catalog with
one environment variable:

```bash
export VIBE_HERO_CONTENT_URL="https://your-host/content"   # serves manifest.json + topic files
```

When set, updates are download-only:

1. It fetches `manifest.json` with an HTTP `ETag`; a `304 Not Modified` means nothing
   changed, so nothing is downloaded.
2. The manifest lists a SHA-256 hash for every topic file. Each downloaded file is
   checked against its hash; a mismatch (corruption or tampering) rejects the update,
   and corrupt content is never cached or served.
3. On a cold fetch, per-topic hashes are compared against the bundled copy, so
   unchanged topics are not re-downloaded.
4. On any failure (offline, DNS, timeout, bad content) it falls back to the local
   cache, then to the bundled catalog — without an error, and a quiz still works.

### Catalog schema

A published catalog is a static directory: one `manifest.json` plus one YAML file
per topic. The manifest (generated at build/CI time from `content/<class>/*.yaml`):

```json
{
  "version": "0.13.0",
  "publishedAt": "2026-07-07T11:50:54.505Z",
  "topics": [
    {
      "id": "testing-and-verification",
      "class": { "kind": "general" },
      "file": "general/testing-and-verification.yaml",
      "itemCount": 100,
      "tiers": [100, 200, 300, 400, 500],
      "sha256": "d7ab616f…"
    }
  ]
}
```

`class` is either `{ "kind": "general" }` or `{ "kind": "tool", "tool":
"claude-code" | "codex" | "kiro-cli" | "kiro-ide" }`. Each topic file:

```yaml
id: testing-and-verification
class:
  kind: general            # or kind: tool + tool: claude-code
title: Testing & Verification
summary: One-paragraph topic description.
triggerSignals:            # optional — drives organic quiz offers
  - tool: claude-code
    match:                 # at least one selector:
      inputPattern: '\b(pytest|jest|vitest)\b'   # regex on the tool input
      # toolName / toolNamePattern — match the host tool (e.g. Task)
      # mcpToolPattern — regex on an MCP tool name
      # pathPattern — regex on the edited file path
      # event — a hook event kind (e.g. SubagentStop)
    weight: 1.0            # evidence weight per hit
    # phase: seam          # start | during | seam (seam promotes pending offers)
    # bypass: true         # a seam hit that may arm immediately
items:
  - id: tav-100-mc-a
    tier: 100              # 100–500
    bloom: remember        # Bloom's-taxonomy level
    difficulty: 120        # Elo difficulty
    type: multiple_choice  # multiple_choice | short_answer | free_form
    prompt: What is a unit test?
    choices:               # multiple_choice only
      - id: a
        text: A test that exercises one small unit in isolation
      - id: b
        text: A test that drives the whole system through its UI
    answerKey: { kind: choice, correctChoiceId: a }
    guidance: Shown after answering — why the right answer is right.
    # free_form items instead carry a rubric the host agent judges against:
    # rubric:
    #   criteria: [ { id: c1, text: "Names the isolation property" }, … ]
    #   referenceAnswer: The canonical full-credit answer.
```

The SHA-256 in the manifest is computed over each topic file's raw bytes; regenerate
the manifest whenever a topic file changes (`pnpm run gen-manifest` in
`packages/server`).

---

## How it works (under the hood)

- MCP server (`@vibe-hero/server`, in `packages/server`) — the engine: 11 tools for
  setup, quizzing, scoring, status, guidance, offers, observation intake, and the
  dashboard. Elo-based ability estimation with spaced-review decay; deterministic
  grading for multiple-choice, rubric-based judging for free-form items.
- Plugin (`packages/vibe-hero-plugin`) — the skills, hooks, and `.mcp.json` that
  make it usable in Claude Code with no manual config. Two hooks: a lightweight
  activity spool writer (fires on tool use and session events, milliseconds, no
  network) and a UserPromptSubmit relay that surfaces an armed quiz offer.
- Content (`content/`) — the question catalog: ~2,800 items across 29 topics
  (Claude Code, Codex, Kiro CLI, Kiro IDE, and general software engineering),
  authored from primary sources.

## Tuning the organic offer flow

Quiz offers arm organically from observed activity: hook signals accumulate
per-topic evidence, a threshold crossing makes an offer *pending*, and a seam
(commit, subagent finish) or a quiet gap promotes it to *armed* so the next
prompt can surface it. Four environment variables tune the pacing (set them in
the `env` block of the server's `.mcp.json` entry; all optional):

| Variable | Default | Effect |
|---|---|---|
| `VIBE_HERO_DRAIN_INTERVAL_MS` | `15000` | How often the server processes spooled activity signals. Clamped to 1s–10min. |
| `VIBE_HERO_QUIET_PROMOTION_SECONDS` | `60` | Silence needed to promote a pending offer to armed without a seam. Clamped to 5s–30min. |
| `VIBE_HERO_OFFER_COOLDOWN_SECONDS` | `900` | Minimum gap between offer surfacings (after a quiz, decline, or defer). `0` disables throttling entirely (testing only). |
| `VIBE_HERO_SEAM_STRICTNESS` | `normal` | How boldly the agent voices an armed offer: `lenient` (offer at any reasonable pause; when in doubt, offer), `normal` (context switch or completed unit of work; silent when in doubt), `strict` (completed unit of work only). |

How eagerly evidence *arms* in the first place is a profile setting, not an env
var: `organicEagerness` (`often` / `normal` / `rarely`), chosen during setup and
changeable via the `save_config` tool.

## Debugging & logging

### Debugging offers from inside a session

If a quiz you expected never surfaces (or surfaces when it shouldn't), ask Claude:

> Call the vibe-hero `get_offer` tool with `debug: true` and explain the diagnostics.

The diagnostics block shows per-session evidence weights vs. the arming threshold,
the rolling window and cooldown in effect, any pending/armed topic, the candidate
pool, and — when nothing is offered — exactly which gate suppressed it
(`no_candidate`, `cadence`, `declined`, or `offers_off`). This answers "why didn't
my quiz trigger?" in one call, with no file spelunking.

### Server logs

The MCP server has structured logging, off by default. Logs are newline-delimited
JSON written to stderr only (stdout carries the JSON-RPC stream, so logging there
would corrupt the protocol). Two environment variables control it:

| Variable | Effect |
|---|---|
| `VIBE_HERO_DEBUG=1` | Turn logging on at `debug` level. |
| `VIBE_HERO_DEBUG=/path/to/file.log` | Turn logging on and tee every line to that file — use this when a host swallows the server's stderr. |
| `VIBE_HERO_LOG_LEVEL=trace\|debug\|info\|warn\|error\|silent` | Set the level explicitly (overrides the level implied by `VIBE_HERO_DEBUG`). Default is `silent`. |

Run it directly and watch the logs:

```bash
# logs to your terminal (stderr)
VIBE_HERO_DEBUG=1 npx -y @vibe-hero/server

# logs to a file you can tail (pretty-print NDJSON with jq)
VIBE_HERO_DEBUG=/tmp/vibe-hero.log npx -y @vibe-hero/server
tail -f /tmp/vibe-hero.log | jq .
```

You'll see startup (Node version, tool count), the client handshake and detected
tool, and every tool call and result.

### Enabling logs inside Claude Code

The plugin launches the server from its `.mcp.json`. To turn logging on for a
session, add an `env` block there (env vars pass through to the spawned server):

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
block is how you set `VIBE_HERO_CONTENT_URL` (remote catalog), `VIBE_HERO_HOME`
(profile location), or the offer-pacing variables above.

## License

Apache-2.0
