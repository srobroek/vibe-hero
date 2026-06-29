# Research: vibe-hero MVP

Resolves the Open Design Decisions (OD-001..005) from `spec.md` and the Technical Context unknowns. Format per decision: **Decision / Rationale / Alternatives**.

## OD-001 — Portable surface: Skills vs Agents → **Skills (primary); Agents only for optional CC-only context-isolated flows**

**Decision**: Implement the command-like surface (`setup`, `quiz`, `status`, `learn/guidance`) as **Agent Skills (SKILL.md)**. Reserve Claude Code subagents only for an optional, context-isolated flow if one is later needed (e.g. a long report); never on the portable critical path.

**Rationale**:
- **Portability is a hard requirement (FR-029)**. Agent Skills (SKILL.md) is supported across **Claude Code, Codex, and Kiro** (and the Agent SDK); subagents are **Claude Code + SDK only**. Skills are the only "author once, run everywhere" option.
- **Low friction for frequent, short, interactive flows** (`quiz`, `status`) — skills load into the current context and invoke instantly; subagent delegation adds a separate context + inference round-trip.
- Matches the established "steering points to MCP" pattern: the skill is thin guidance that drives MCP tool calls.

**Alternatives**:
- *Agents as primary* (the user-floated option): rejected for the portable surface because it bifurcates the codebase (CC-only) and breaks Codex/Kiro. Kept as an option only for a future context-heavy, CC-specific flow.
- *Hybrid everywhere*: unnecessary complexity for the MVP; skills cover all four MVP surfaces.

## OD-001b — Enforcing the first-run hard gate (FR-032) portably → **MCP server is the chokepoint**

**Decision**: The **MCP server enforces** the gate, not the skill. Every MCP tool (`get_question`, `submit_answer`, `get_status`, `get_guidance`, observation intake) returns a structured `SETUP_REQUIRED` result when no `config` exists in the profile. The host agent, on seeing it, invokes the `setup` skill, which runs the Q&A and calls `save_config`. On Claude Code, an optional `SessionStart` hook *reminds* the user, but the real gate is the MCP error (portable to all hosts).

**Rationale**: Hosts do not auto-run skills, so a skill cannot self-enforce "must run first." The MCP is the single chokepoint every action passes through, so gating there is both real and portable. Avoids depending on a CC-only `initialPrompt`/`permissionMode` agent mechanism.

**Alternatives**: CC-only subagent with `initialPrompt: dontAsk` (truly auto-gated but non-portable) — rejected for the same portability reason.

## OD-002 — Free-form judging: v1 vs fast-follow → **Deterministic loop in v1; free-form handshake behind a flag, populated as fast-follow**

**Decision**: v1 ships the **deterministic** grading loop (multiple-choice + short-answer) end-to-end. The **host-agent judging handshake** for free-form items (FR-012/013/014) is built as a defined tool contract (`get_question` may return a `rubric`, `submit_answer` accepts a `verdict`) but the **v1 Claude Code curriculum is authored with deterministic items only**, so free-form is exercised by tests/fixtures and lights up when free-form content is added — no rework.

**Rationale**: Satisfies the MVP success criterion (SC-009 full loop) with objective, reproducible grading (SC-004), while the handshake contract is cheap to define now and avoids a later breaking change. Free-form depth (tiers 400–500) is genuinely valuable but not required to prove the loop.

**Alternatives**: Ship free-form in v1 (more content + judging UX work, slower to first proof) — deferred. Omit the handshake contract entirely (would force a breaking tool-schema change later) — rejected.

## OD-003 — Spaced-review / lapse model → **Staleness threshold + exponential ability decay** (reuse Elo, no separate scheduler)

**Decision**: Use a topic-level **staleness + ability-decay** model rather than SM-2/FSRS per-item scheduling.
```
θ_effective(t) = tier_center + (θ_last − tier_center) · exp(−days_since_last / H)
H = 60 days (per-tier tunable; e.g. 90 for tier 500)
due_for_review when:  days_since_last ≥ 30  AND  θ_effective < (tier_boundary_below + hysteresis_margin)
```
A correct review resets the clock and restores ability; a wrong review lets normal Elo demote.

**Rationale**: Least complexity that still gives durable-knowledge semantics, and it **reuses the Elo ability already stored** — no separate ease-factor/interval/17-param memory state. FSRS is most accurate but heavyweight; SM-2 adds per-item scheduling state we don't need at topic granularity.

**Alternatives**: SM-2 (per-card scheduling state, redundant at topic level), FSRS (heavyweight for MVP) — both deferred; the engine can swap the lapse policy behind an interface later.

## OD-004 — Content serialization format → **YAML authored, Zod-validated on load**

**Decision**: Author content as **YAML**, one file per `(topic × class)` (FR-004a), validated by Zod after parse.

**Rationale**: Validation rigor is identical across YAML/JSON/TOML (Zod validates the parsed object, not file syntax), so the deciding factor is **authoring ergonomics for prose-heavy content** (questions, MC options, multi-line rubrics, guidance). YAML wins: block scalars (`|`) for multi-line prose, comments, and clean nested arrays-of-objects. Classic YAML type footguns (Norway problem, etc.) are neutralized because Zod re-validates/coerces types after parse. A JSON Schema is also emitted from the Zod schemas for editor validation.

**Alternatives**: JSON (worst for prose — escaped newlines, no comments), TOML (good comments/multiline but verbose for nested object arrays) — rejected for ergonomics.

## OD-005 — Elo parameters & tier thresholds → **resolved (config-ready defaults)**

**Decision** (all live in a single tunable config module; not hard-coded across the codebase):

| Param | Default |
|---|---|
| Logistic scale `S` | 400 |
| Starting ability `θ₀` | 300 (mid-scale) |
| Item difficulty seed | by tag: easy 200 / med 300 / hard 400 |
| K (provisional) | 64 |
| K (settled) | 24 |
| provisional→settled | after 15 graded items (per topic×tool) |
| Update | `θ' = θ + K·(score − E)`, `E = 1/(1+10^((d−θ)/400))`, `score ∈ [0,1]` |
| Tier centers | 100, 200, 300, 400, 500 |
| Tier boundaries | 150, 250, 350, 450 |
| Hysteresis margin | ±30 (promote at boundary+30; demote/review below boundary−30) |
| Dwell | crossing must hold for 2 consecutive graded items |
| Decay constant `H` | 60 days (tier-tunable) |
| Staleness window | 30 days |
| Item-selection target | `min(θ+50, next_boundary+30)`, window ±60, one anchor within ±20 of θ, weight ∝ p·(1−p) |

**Rationale**: Elo is the only model that **jointly self-calibrates learner ability and item difficulty online** with a single cheap update and **no calibration corpus** — exactly the single-learner, low-volume, no-dataset situation here. The hysteresis band (±30) + dwell (2 items) directly satisfy the user's anti-flip-flop requirement (FR-008, SC-014). Difficulty-targeting at the promotion bar (not raw ability) means "passing a set" ≈ "ready to graduate," and the ±60 window + information-weighted sampling avoids always serving the hardest item.

**Alternatives**: Rasch/1PL (needs a calibration dataset — none available), BKT (needs per-skill learn/slip/guess fitting; latent-binary, no continuous tradeable score), Glicko-2 (adds an uncertainty term but the provisional/settled K already approximates its main benefit) — Glicko-2 noted as a clean drop-in upgrade if uncertainty estimates later matter.

## Observation & hook correlation (verified earlier) → **Stop hook (offer) + PostToolUse (events), correlate by `tool_use_id`**

**Decision**: Real-time observation via a Claude Code **Stop hook** to surface end-of-work offers (verified: SessionEnd can't inject, SubagentStop is subagents-only, UserPromptSubmit is too early) and **PostToolUse** events to detect exercised topics. Hook events carry `session_id`, `transcript_path`, `tool_name`, `tool_input`, `tool_output`, and **`tool_use_id`** — the same id in transcript `tool_use`/`tool_result` blocks — giving deterministic hook↔log correlation (FR-017). All behind an `ObservationSource` interface (FR-016); a self-report path always works.

**Rationale / Alternatives**: see spec FR-015..021 and the verified design notes; MCP **sampling is unavailable** in Claude Code/Codex, which is *why* grading uses the host-agent handshake rather than server→model callback.

## Technical Context (resolved)

- **Language/Version**: TypeScript (ES2022), Node ≥18 (dev on Node 25). 
- **Primary Dependencies**: `@modelcontextprotocol/sdk` (MCP server), `zod` (all schemas/validation). Content fetch via Node `fetch` (no heavy HTTP dep). No web framework (MCP stdio server).
- **Storage**: JSON documents under `~/.vibe-hero/` (profile + cached content); bundled baseline content snapshot in the package. SQLite is a deferred optimization.
- **Testing**: `vitest` (unit + integration); deterministic-grading and Elo math are pure-function unit-tested; an end-to-end fixture exercises the full loop incl. the free-form handshake contract.
- **Target Platform**: local developer machine; MCP stdio server launched by the host agent (Claude Code v1; Codex/Kiro architecture-ready).
- **Project Type**: monorepo; MCP server in `packages/server`; portable skills + Claude Code hook shipped alongside; content in `content/`.
- **Performance**: deterministic grading and status are synchronous/instant (no network); content refresh is async/cached with bundled fallback.
- **Constraints**: offline-capable (bundled content); privacy — never persist raw prompts/tool I/O (FR-018/024), no network transmission of user content; download-only curriculum fetch.
- **Scale/Scope**: single user per profile; small catalog in v1 (general + Claude Code, ~3–5 topics proven); architecture supports N tools and the general/tool-specific split.
