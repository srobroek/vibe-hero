# Contract: vibe-hero MCP tools

The MCP server is the product's external interface and the **enforcement chokepoint** (gating, scoring, persistence). The host agent calls these tools; portable skills steer when/how. All inputs/outputs are Zod-validated. Tools are pure with respect to the model — **no MCP sampling is used** (unsupported in CC/Codex); free-form grading is a two-call host-agent handshake.

Every tool may return a gate sentinel instead of its normal result. Two sentinels exist; they are checked in this order for non-exempt tools:

```jsonc
// SETUP_REQUIRED gate (FR-032) — returned when profile.config is absent
{ "status": "SETUP_REQUIRED",
  "message": "Run vibe-hero setup first.",
  "setupSkill": "vibe-hero-setup" }

// UNSUPPORTED_TOOL gate (FR-031) — returned when the MCP host is not one of the
// four supported tools (claude-code, codex, kiro-cli, kiro-ide) AND no valid
// toolsLearning is configured. vibe-hero fails loudly for unknown hosts rather
// than silently defaulting. detectedName is the raw clientInfo.name from the
// MCP handshake (empty string if absent).
{ "status": "UNSUPPORTED_TOOL",
  "detectedName": "<raw clientInfo.name or empty string>",
  "message": "vibe-hero does not support \"<name>\" yet. Supported: Claude Code, Codex, Kiro CLI, Kiro IDE.",
  "supported": ["claude-code", "codex", "kiro-cli", "kiro-ide"] }
```

Gate precedence: SETUP_REQUIRED is checked first (config must exist before tool resolution makes sense), then UNSUPPORTED_TOOL. Exempt tools (`get_config`, `save_config`) bypass both gates.

## `get_status`
Show the user's standing for a tool (or all). Read-only.
- **in**: `{ tool?: ToolId }`
- **out**: `{ tool: ToolId, topics: Array<{ key, title, tier, status: "current"|"due_for_review"|"not_started", ability }>, dueForReview: string[], suggestions: Array<{ key, reason }> }`
- Covers US-2 status; never requires telemetry (SC-011).

## `list_topics`
Enumerate catalog topics, optionally filtered. Read-only.
- **in**: `{ tool?: ToolId, class?: "general"|"tool" }`
- **out**: `{ topics: Array<{ key, id, class, title, tiers: Tier[], itemCount }>, catalogVersion: string }`

## `get_guidance`
Return teaching guidance + what-to-learn-next for a topic or the weakest area. Read-only.
- **in**: `{ key?: AbilityKey, tool?: ToolId }`  (no `key` ⇒ pick weakest/stale for `tool`)
- **out**: `{ key, title, currentTier, guidance: string, nextStep: { action: "quiz"|"read", detail } }`
- Covers US-2 guidance.

## `start_quiz`
Begin a quiz session for a topic (offered or on-demand). Selects 3–5 items by difficulty-targeting (research §OD-005).
- **in**: `{ key: AbilityKey, length?: 3|4|5, allowFreeForm?: boolean }`
  - `allowFreeForm` (default true) is the graceful-degradation switch (FR-014): when the host cannot judge free-form answers, pass `false` and selection excludes `free_form` items so the quiz still completes on deterministic items.
- **out**: `{ quizId: string, items: PresentedItem[] }`
  - `PresentedItem` = `{ itemId, tier, type, prompt, choices?: Choice[], rubric?: { criteria: {id,text}[] }, referenceAnswer?: string }` — for deterministic items, **answer keys are NOT included** and `rubric`/`referenceAnswer` are absent; for `free_form` items, `rubric` (criteria with ids) **and** `referenceAnswer` ARE included so the host agent can judge (see `submit_answer`).
- Covers US-1/US-2 quiz start; partial sessions never count (only completed via `submit_answer` accumulate).

## `submit_answer`
Grade one item and update ability. The core scoring entry point.
- **in (deterministic)**: `{ quizId, itemId, answer: { choiceId?: string, text?: string } }`
- **in (free-form, host-agent verdict)**: `{ quizId, itemId, verdict: { criteria: Array<{ id: string, met: boolean, justification: string }> } }`
  - The host agent judges the user's answer against the **MCP-supplied** rubric criteria + reference answer (returned by `start_quiz`) and reports a **per-criterion** verdict (FR-012/013). The **MCP computes the score** from the criteria (e.g. fraction met vs `passThreshold`) — the agent does NOT return a bare pass/score. A single-boolean verdict is rejected as non-conformant (anti-gaming, critique E2). Steering mandates strict judging with justifications.
- **out**: `{ grade: Grade, score: number, correctAnswer?: string, guidance: string, ability: { before, after }, graduation?: { changed: boolean, tier?: Tier, status?: string, reason?: string } }`
  - `score` is the **continuous** result (0..1) that drives the Elo update; `grade` is the **derived binary projection** (`score ≥ pass ⇒ "correct"`). Both are returned; only the binary `Grade` + `score` are persisted (no raw answer text). (Reconciles data-model `Grade` enum with partial credit — analyze I1.)
- Engine grades deterministic types itself (FR-011, instant, reproducible). Updates Elo, applies hysteresis+dwell, may emit a `graduation` change. Persists only the derived `Grade` (no raw answer text — FR-018).

## `save_config`
Persist the configuration produced by the setup skill Q&A. Clears the gate.
- **in**: `{ toolsLearning: ToolId[], offerCadence: "off"|"per_session"|"per_topic", proactiveOffers: boolean, quizLength?: 3|4|5 }`
- **out**: `{ ok: true, config: Config }`
- Covers US-0 (FR-031/033). Re-callable to update prefs; never wipes learning progress.

## `get_config`
Read current config (or absence). Used by skills/hooks to know gate state.
- **in**: `{}` → **out**: `{ configured: boolean, config?: Config }`

## `record_observation` (trigger-only; never scores)
Intake for the hook/transcript observation source. Maps activity → candidate topics for offers.
- **in**: `{ tool: ToolId, signals: Array<{ toolName?, mcpTool?, success?: boolean, toolUseId?: string }>, sessionId: string }`
- **out**: `{ offerCandidates: Array<{ key, title, reason }> }`  (empty if cadence exhausted / proactiveOffers off / topic recently offered)
- Stores only derived signals (FR-018); applies `OfferLedger` cadence (FR-020a). Awards **nothing** (FR-005, SC-003).

## `get_offer`
Resolve whether to surface an end-of-work offer (called by the Stop hook path).
- **in**: `{ sessionId: string, tool: ToolId }`
- **out**: `{ offer?: { key, title, prompt: string }, suppressed?: "cadence"|"declined"|"offers_off"|"no_candidate" }`

## `record_offer_response`
Record accept/decline so cadence + anti-nag are honored.
- **in**: `{ sessionId, key, response: "accept"|"decline"|"defer" }`
- **out**: `{ ok: true }` — a `decline` suppresses further offers this session (FR-020).

---

### Notes
- All tool results are JSON-serializable and Zod-validated both directions.
- `AbilityKey` is the serialized `(class, topicId)`; `ToolId`/`Tier` per `data-model.md`.
- Two gate sentinels (SETUP_REQUIRED, UNSUPPORTED_TOOL) precede every behavior except `get_config`/`save_config` (see gate block above). SETUP_REQUIRED is checked first.
- Grading determinism: identical deterministic answer ⇒ identical grade (SC-004). Free-form verdicts are host-judged and recorded verbatim as a binary/continuous `score`.
