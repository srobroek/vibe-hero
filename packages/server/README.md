# @vibe-hero/server

The vibe-hero MCP server. Exposes 10 MCP tools over stdio that a host agent
(Claude Code, Codex, Kiro) calls to drive adaptive learning sessions: quiz
delivery, Elo-style ability tracking, tier graduation, telemetry intake, and
offer management. All learning state lives here — the host model is stateless.

## Requirements

- Node >= 18
- pnpm (workspace root manages dependencies)

## Build and run

```sh
# From the repository root — install all workspace deps first
pnpm install

# Compile the server
pnpm --filter @vibe-hero/server build

# Run tests
pnpm --filter @vibe-hero/server test

# Start the MCP server over stdio (for manual inspection / MCP inspector)
VIBE_HERO_HOME="$(mktemp -d)" pnpm --filter @vibe-hero/server start
```

`start` executes `node dist/index.js`. The server communicates over stdio using
the MCP protocol; it is not a long-running HTTP service.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VIBE_HERO_HOME` | `~/.vibe-hero` | Root directory for the user profile (`profile.json`) and the content cache (`content/`). Point at a temp dir during tests to avoid touching a real profile. |
| `VIBE_HERO_CONTENT_URL` | *(disabled)* | URL of a remote content catalog to fetch and cache. When unset, the server serves only the bundled baseline content that ships with the package. |

## Profile location

The learner profile is stored at `$VIBE_HERO_HOME/profile.json`
(default `~/.vibe-hero/profile.json`). It records per-(topic × tool) ability
estimates, tier graduation state, the review schedule, quiz history, and the
offer ledger. The profile is global per user — it is not per-project.

Profile writes are atomic (write-temp + rename under an advisory lock) so
concurrent host sessions cannot clobber each other's updates.

## The 10 MCP tools

Every tool except `get_config` and `save_config` returns a
`{ "status": "SETUP_REQUIRED" }` sentinel when the profile has no
configuration. The host agent should respond by running the `vibe-hero-setup`
skill.

| Tool | Description |
|---|---|
| `get_status` | Per-topic standing and tier for a tool (or all tools). Read-only; never requires telemetry. |
| `list_topics` | Enumerate catalog topics, optionally filtered by tool or class. Returns `catalogVersion`. |
| `get_guidance` | Teaching text and a suggested next step for a topic, or the weakest/stalest area if no topic is named. |
| `start_quiz` | Begin a quiz session: selects 3–5 items by difficulty-targeting near current ability. Returns `PresentedItem[]` — answer keys are never included for deterministic items; `rubric` + `referenceAnswer` are included for free-form items so the host agent can judge. |
| `submit_answer` | Grade one item and update the ability estimate. Deterministic types (multiple-choice, short-answer) are graded by the engine; free-form types accept a per-criterion verdict from the host agent and the engine computes the score. Returns grade, guidance, ability delta, and any graduation change. |
| `save_config` | Persist the configuration produced by the setup Q&A. Clears the setup gate. Safe to re-run; never wipes learning progress. |
| `get_config` | Read current configuration (or absence). Used by skills and the Stop hook to check gate state. |
| `record_observation` | Intake for the Stop hook / telemetry source. Maps observed tool activity to candidate topics for offers. Stores only derived signals — never raw tool input/output. Awards nothing (usage never scores). |
| `get_offer` | Resolve whether to surface an end-of-work offer for the current session. Called by the Stop hook. Returns an offer or a suppression reason. |
| `record_offer_response` | Record accept / decline / defer so cadence and anti-nag rules are honored. A decline suppresses further offers for the session; repeated cross-session declines increase backoff and eventually mute offers globally. |

Full input/output shapes: `specs/001-vibe-hero-mvp/contracts/mcp-tools.md`.

## Content model

Content is organized as a matrix of (topic × class × tier):

- **Tier** — 100 to 500 on a cognitive-depth scale (100 = introductory, 500 = expert).
- **Class** — `general` (tool-agnostic agentic-coding concepts) or `tool:<id>`
  (e.g. `tool:claude-code`). Graduation is tracked independently per tool.
- **Topic** — one YAML file per (topic × class) under `content/`. Each file
  contains all tier items for that topic plus trigger-signal declarations (the
  tool names the engine uses to attribute observed activity to the topic).

Bundled baseline content ships with the package (offline-capable). If
`VIBE_HERO_CONTENT_URL` is set, the server fetches and caches an updated
catalog; on failure it falls back to the cached or bundled copy.

v1 content: `content/claude-code/` (subagents, context-management, planning)
and `content/general/` (task-decomposition).

## Assessment model

- **Ability estimates** are per-(topic × class) and update on every graded
  answer using an Elo-style formula against fixed item difficulty ratings.
  Item difficulty is authored and never self-updates.
- **Graduation** to a tier requires crossing the tier boundary by a margin
  (hysteresis band); demotion requires crossing a separate lower threshold.
  Both require holding the crossing for 2 consecutive graded items (dwell),
  preventing flip-flopping at the boundary.
- **Lapse / review scheduling** — if ability decays below the demotion
  threshold or 30 days pass without assessment, the topic is surfaced for
  review.
- Tunable parameters (K-factor, tier boundaries, hysteresis margin, decay
  half-life, etc.) live in `src/config.ts`.

## Privacy

The server never persists raw prompts, tool inputs, tool outputs, or any user
content. Observation intake extracts only derived signals:
`{ tool_name, topicKeys, success, timestamp, tool_use_id }`. The profile
contains only ability estimates, scores, timestamps, and configuration — no
content the user typed.

## Wiring into Claude Code

### MCP server

Add to `.claude/settings.json` (project) or `~/.claude/settings.json` (global):

```jsonc
{
  "mcpServers": {
    "vibe-hero": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/vibe-hero/packages/server/dist/index.js"]
    }
  }
}
```

### Stop hook (end-of-work offers)

See `hooks/claude-code/README.md` for how to register `hooks/claude-code/stop-offer.sh`
as a Claude Code Stop hook. The hook requires `jq` on `PATH` and the server
built (dist present). It is advisory-only: it exits 0 silently on any error.

### Skills (portable agent surface)

Copy or reference the four skills from `skills/` into your agent skill path:

| Skill | Purpose |
|---|---|
| `vibe-hero-setup` | Required first-run Q&A; collects preferences and calls `save_config`. Must run before any other skill works. |
| `vibe-hero-quiz` | Drives the `start_quiz` / `submit_answer` loop; judges free-form items against the MCP-supplied rubric. |
| `vibe-hero-status` | Calls `get_status` and renders per-topic standing and suggestions. |
| `vibe-hero-learn` | Calls `get_guidance` (and optionally `list_topics`) to surface teaching text and a next step. |

## Distribution

npm publishing and Claude Code plugin/marketplace bundling are planned as a
follow-up (spec 002). Currently the server is set up manually as described
above.
