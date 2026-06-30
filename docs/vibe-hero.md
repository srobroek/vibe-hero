# vibe-hero

Adaptive learning for agentic coding tools.

## What it is

vibe-hero helps a developer genuinely learn the agentic coding tool they use
every day. Most users touch only a fraction of a tool's capability surface and
never discover the rest. vibe-hero maintains a per-user **competence profile**,
periodically **checks knowledge** with short quizzes at natural end-of-work
breakpoints, **awards progress only for demonstrated knowledge** (answering
correctly — never for the agent merely invoking a tool), and **guides** the
user toward the next thing worth learning.

Because the host model is stateless, all learning state lives outside the model
in a profile the MCP server owns. The user interacts in natural language with
their existing coding agent; lightweight skills and a Stop hook tell the agent
when and how to consult vibe-hero.

v1 proves the full adaptive loop on **Claude Code** for a small set of real
topics. The architecture already supports multiple tools and a
general/tool-specific content split; Codex and Kiro are architecture-ready but
have no v1 content.

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

content/                  Curriculum (YAML, one file per topic × class)
  claude-code/            subagents.yaml, context-management.yaml, planning.yaml
  general/                task-decomposition.yaml

skills/                   Portable Agent Skills (the user-facing surface)
  vibe-hero-setup/        Required first-run setup Q&A
  vibe-hero-quiz/         Quiz driver (start_quiz + submit_answer loop)
  vibe-hero-status/       Standing overview (get_status)
  vibe-hero-learn/        Guidance and what-to-study-next (get_guidance)

hooks/claude-code/        Claude Code-specific additive glue
  stop-offer.sh           Stop hook — surfaces end-of-work quiz offers
  README.md               Hook registration instructions
```

## Setup

### 1. Build the server

```sh
pnpm install
pnpm --filter @vibe-hero/server build
```

### 2. Wire the MCP server into Claude Code

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

### 3. Install the Stop hook (optional — enables proactive offers)

See `hooks/claude-code/README.md`. Requires `jq` on `PATH`. The hook is
advisory-only and exits 0 silently on any error.

### 4. Install the skills

Make the four skill files in `skills/` available to your host agent. In Claude
Code, reference or copy them into your agent skill path.

### 5. Run setup

The first time, or any time a vibe-hero tool returns `SETUP_REQUIRED`, ask the
agent to run the **vibe-hero-setup** skill. It conducts a short Q&A (which
tools you are learning, quiz offer cadence, quiz length) and calls `save_config`
to clear the gate. Every other vibe-hero action is blocked until setup completes
once.

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
any content from the user's session. The observation layer extracts only:
`{ tool_name, topicKeys, success, timestamp, tool_use_id }`. The profile
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

npm publishing and Claude Code plugin/marketplace bundling are planned as a
follow-up (spec 002). Currently the server is set up manually as described
above.

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
