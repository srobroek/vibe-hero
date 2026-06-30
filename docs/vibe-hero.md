# vibe-hero

Adaptive learning for agentic coding tools.

## What it is

vibe-hero helps a developer learn the agentic coding tool they use every day.
Most users touch only a fraction of a tool's features and never discover the
rest. vibe-hero maintains a per-user competence profile, checks knowledge with
short quizzes at end-of-work breakpoints, awards progress only for demonstrated
knowledge (answering correctly, never for the agent merely invoking a tool), and
guides the user toward the next thing worth learning.

Because the host model is stateless, all learning state lives outside the model
in a profile the MCP server owns. The user interacts in natural language with
their existing coding agent; skills and a Stop hook tell the agent when and how
to consult vibe-hero.

The adaptive loop runs on Claude Code with a general/tool-specific content split.
Content ships for Claude Code, Codex, Kiro CLI, and Kiro IDE, plus general
software-engineering topics.

## How it works

```
User works in Claude Code
        │
        ▼
Stop hook fires at end of turn
        │
        ├─ record_observation (derived signals only, no raw I/O)
        │
        ├─ get_offer → offer? ──► agent presents non-interrupting quiz prompt
        │
        └─ User accepts
                │
                ▼
        vibe-hero-quiz skill
                │
                ├─ start_quiz → 3–5 items selected near current ability
                │
                ├─ submit_answer (each item) → engine grades, updates Elo
                │
                └─ graduation? → tier change announced
```

Pull-based path (always available, no telemetry needed):

- "where am I with Claude Code?" → `vibe-hero-status` → `get_status`
- "what should I learn next?" → `vibe-hero-learn` → `get_guidance`
- "quiz me on subagents" → `vibe-hero-quiz` → `start_quiz` + `submit_answer`

## Repository layout

```
packages/server/          @vibe-hero/server — the MCP server (TypeScript)
  src/
    index.ts              stdio MCP bootstrap; registers all 11 tools
    config.ts             Elo parameters, tier boundaries, hysteresis (OD-005)
    schemas/              Zod schemas — single source of truth for all shapes
    catalog/              YAML loader, GitHub fetcher, bundled baseline
    profile/              Profile store — atomic read-modify-write + locking
    engine/               Pure assessment core (Elo, graduation, lapse, selection)
    grading/              Deterministic grader + free-form handshake contract
    observation/          Trigger-only intake; never scores; offer ledger
    tools/                One module per MCP tool (thin wrappers over engine/store)
  test/                   vitest: unit / integration / e2e

content/                  Curriculum (YAML, one file per topic × class) — ~2,800
  claude-code/            items across 29 topics: 8 claude-code topics
  general/                + 5 general + 4 codex + 6 kiro-cli + 6 kiro-ide
  codex/                  manifest.json   generated index with per-topic sha256
  kiro-cli/
  kiro-ide/

packages/vibe-hero-plugin/   The Claude Code plugin (the distribution unit)
  .claude-plugin/plugin.json identity + skills path (no mcpServers)
  .mcp.json                  launches @vibe-hero/server via npx
  hooks/hooks.json           Stop hook registration (${CLAUDE_PLUGIN_ROOT})
  hooks/claude-code/         stop-offer.sh — surfaces end-of-work quiz offers
  .apm/skills/               the four skills (setup, quiz, status, learn)
```

## Setup

### 1. Install the plugin

```sh
claude plugin marketplace add srobroek/vibe-hero
claude plugin install vibe-hero@vibe-hero
```

This installs the MCP server, the four skills, and the Stop hook together. The
plugin's `.mcp.json` launches the server via `npx -y @vibe-hero/server` (no local
build), and `hooks/hooks.json` registers the Stop hook automatically.

### 2. Run setup

The first time, or any time a vibe-hero tool returns `SETUP_REQUIRED`, ask the
agent to "set up vibe-hero". The vibe-hero-setup skill runs a short Q&A (quiz
offer cadence, proactive offers, quiz length) and calls `save_config` to clear
the gate. The tool being learned is auto-detected from the host; it is not asked.
Every other vibe-hero action is blocked until setup completes once.

### From source (development)

To run against a local build instead of the published package:

```sh
pnpm install
pnpm --filter @vibe-hero/server build
```

Then point an `.mcp.json` entry at `node packages/server/dist/cli/index.js`.

## The setup gate

Every MCP tool except `get_config` and `save_config` returns:

```jsonc
{ "status": "SETUP_REQUIRED", "message": "Run vibe-hero setup first.", "setupSkill": "vibe-hero-setup" }
```

when the profile has no configuration. The gate blocks only vibe-hero actions —
it never interrupts the user's normal coding work.

## The 11 MCP tools

| Tool | What it does |
|---|---|
| `get_status` | Per-topic standing (tier, ability, due-for-review) for a tool or all tools. |
| `list_topics` | Catalog topics, optionally filtered by tool or class. |
| `get_guidance` | Teaching text + next-step recommendation for a topic or the weakest area. |
| `start_quiz` | Start a quiz session. Returns 3–5 `PresentedItem`s selected by difficulty-targeting. Answer keys are never exposed for deterministic items. Free-form items include `rubric` + `referenceAnswer` for host-agent judging. |
| `submit_answer` | Grade one item, update ability, check graduation, append an ability snapshot. Engine grades deterministic types; host agent returns a per-criterion verdict for free-form types and the engine computes the score. |
| `save_config` | Persist setup preferences. Clears the gate. Never wipes learning progress. |
| `get_config` | Read current config or absence. Used by skills and the hook to check gate state. |
| `record_observation` | Telemetry intake. Stores only derived signals; awards nothing. Returns offer candidates. |
| `get_offer` | Resolve whether to surface an end-of-work offer for a session. Due-for-review topics are offered first. |
| `record_offer_response` | Record accept / decline / defer. A decline suppresses further offers for the session; repeated cross-session declines apply backoff and eventually mute globally. |
| `get_dashboard` | Progress dashboard data: a topics × scopes matrix (tier + ability), summary metadata, and per-scope ability-over-time series. |

Tools are gated: until setup completes they return `SETUP_REQUIRED`; on an
unsupported host (one whose `clientInfo.name` does not map to a known tool) they
return `UNSUPPORTED_TOOL` rather than guessing.

Full input/output contracts: `specs/001-vibe-hero-mvp/contracts/mcp-tools.md`.

## The 4 skills

Skills are portable Agent Skills (SKILL.md files). They steer the host agent to
call the MCP tools at the right time and in the right way. They work across
Claude Code, Codex, and Kiro.

| Skill | Trigger / purpose |
|---|---|
| `vibe-hero-setup` | Run first, or when `SETUP_REQUIRED` is returned. Asks three questions (offer cadence, proactive offers, quiz length) and calls `save_config`. The tool being learned is auto-detected from the host's MCP `clientInfo` — it is not asked. |
| `vibe-hero-quiz` | "Quiz me", "test me", or when the user accepts an offer. Drives the `start_quiz` / `submit_answer` loop; judges free-form answers strictly against the MCP-supplied rubric. |
| `vibe-hero-status` | "Where am I with Claude Code?", "what's my progress". Calls `get_status` and presents per-topic standing. |
| `vibe-hero-learn` | "What should I learn next?", "teach me about subagents". Calls `get_guidance`; offers to hand off to the quiz skill if the user wants to practice. |

## Content model

Content is a matrix of **topic × class × tier**:

- **Tier** — 100–500 (100 = introductory, 500 = expert). Items are authored at
  a fixed difficulty; the engine never updates item difficulty at runtime.
- **Class** — `general` (tool-agnostic) or keyed by tool (`claude-code`,
  `codex`, `kiro-cli`, `kiro-ide`). Graduation is tracked independently per
  tool; strong on a concept in Claude Code does not imply a standing in Codex.
- **Topic file** — one YAML file per (topic × class) in `content/`. Each file
  contains all tier items for that topic and the topic's **trigger signals**
  (tool names the engine uses to attribute observed activity to the topic for
  offer-triggering — data-driven, no code change to add topics).

The bundled baseline ships in the package and works offline. If
`VIBE_HERO_CONTENT_URL` is set, the server fetches and caches updates; it falls
back to cached/bundled content silently on failure.

## Assessment model

- **Elo-style ability estimates** — per-(topic × class), starting at 300.
  Correct answers raise ability; incorrect answers lower it. The delta scales
  with item difficulty and a K-factor (64 while provisional, 24 once settled
  after 15 items).
- **Graduation** — when ability crosses a tier boundary + 30-point hysteresis
  margin for 2 consecutive graded items (dwell). Demotion requires crossing the
  boundary − 30 threshold, also for 2 consecutive items. This prevents
  flip-flopping at the boundary (SC-014).
- **Lapse / review** — if 30 days pass without assessment, or ability decays
  below the demotion threshold, the topic is flagged `due_for_review`.
- **Usage never scores** — `record_observation` maps activity to offer
  candidates only. No observed tool call ever changes ability or graduation.

Parameters are in `packages/server/src/config.ts`.

## Privacy

vibe-hero never stores or transmits raw prompts, tool inputs, tool outputs, or
any content from the user's session. The observation layer persists only derived
signals — `{ tool, topicKeys, success, timestamp, correlationId }`. The profile
contains ability estimates, scores, timestamps, and configuration only.

Network activity is limited to downloading the public curriculum catalog
(one-directional, download only). The user profile never leaves the local
machine.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VIBE_HERO_HOME` | `~/.vibe-hero` | Location of `profile.json` and the content cache. |
| `VIBE_HERO_CONTENT_URL` | *(unset)* | Remote catalog URL. When unset, only bundled content is served. |

## Distribution

The server is published to npm as `@vibe-hero/server`, and the plugin is
distributed through the `srobroek/vibe-hero` Claude Code marketplace
(`.claude-plugin/marketplace.json`). `claude plugin install vibe-hero@vibe-hero`
pulls the plugin, which launches the published server via npx. Releases are cut
by release-please and published to npm via OIDC (spec 002).

## Spec and architecture references

| File | Contents |
|---|---|
| `specs/001-vibe-hero-mvp/spec.md` | Full feature specification and user stories |
| `specs/001-vibe-hero-mvp/plan.md` | Architecture, project structure, design decisions |
| `specs/001-vibe-hero-mvp/contracts/mcp-tools.md` | MCP tool input/output contracts |
| `specs/001-vibe-hero-mvp/quickstart.md` | End-to-end validation scenarios (V0–V6) |
| `specs/001-vibe-hero-mvp/data-model.md` | Zod entity model reference |
| `packages/server/README.md` | Server build, run, and wiring instructions |
| `hooks/claude-code/README.md` | Stop hook registration instructions |
