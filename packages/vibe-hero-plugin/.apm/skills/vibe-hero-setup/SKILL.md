---
name: vibe-hero-setup
description: Run when the user is starting with vibe-hero for the first time, when any vibe-hero MCP tool returns SETUP_REQUIRED, or when the user asks to configure or reconfigure vibe-hero learning preferences. Works across Claude Code, Codex, and Kiro.
---

# vibe-hero Setup

This skill collects the user's learning preferences and persists them via the
`save_config` MCP tool. Until setup completes once, every other vibe-hero tool
returns `SETUP_REQUIRED` — nothing else proceeds. Re-running setup updates
preferences only; it never touches learning progress (FR-033).

## When to invoke

- A vibe-hero MCP tool returned `{ "status": "SETUP_REQUIRED" }`.
- The user asks to set up, configure, or reconfigure vibe-hero.
- First interaction in a new environment with no vibe-hero config present.

## Q&A flow

Ask the four questions below in sequence. Keep the tone conversational. Accept
natural-language answers and map them to the values shown.

### Q1 — Which tool(s) are you learning?

> "Which agentic coding tool(s) are you currently learning or using day-to-day?"

Accept any combination. Map to `toolsLearning: ToolId[]`:

| Answer | ToolId |
|---|---|
| Claude Code / claude-code / CC | `"claude-code"` |
| Codex | `"codex"` |
| Kiro CLI / kiro-cli | `"kiro-cli"` |
| Kiro IDE / kiro-ide | `"kiro-ide"` |

Multiple tools are allowed. At least one is required.

### Q2 — How often should vibe-hero offer quizzes?

> "How often should vibe-hero offer you a knowledge check — never, once per
> session, or whenever a relevant topic comes up?"

Map to `offerCadence`:

| Answer | Value |
|---|---|
| Never / off / no offers | `"off"` |
| Once per session / one a day / session | `"per_session"` |
| Per topic / whenever / as they come up | `"per_topic"` |

Default if unclear: `"per_session"`.

### Q3 — Enable proactive quiz offers?

> "Should vibe-hero proactively offer you a quick quiz at natural end-of-work
> breakpoints, or would you prefer to request quizzes yourself?"

Map to `proactiveOffers: boolean`:

| Answer | Value |
|---|---|
| Yes / proactive / sure / offer them | `true` |
| No / manual / I'll ask / on demand | `false` |

If Q2 answered `"off"`, set `proactiveOffers: false` automatically (no need to
ask).

### Q4 — Quiz length (optional)

> "How many questions per quiz session — 3, 4, or 5? (default is 4)"

Map to `quizLength: 3 | 4 | 5`. If the user says "default" or skips, omit the
field and let the server apply the default of 4.

## Calling `save_config`

Once all answers are collected, call the MCP tool:

```
save_config({
  toolsLearning: [...],       // ToolId[], e.g. ["claude-code"]
  offerCadence: "...",        // "off" | "per_session" | "per_topic"
  proactiveOffers: true/false,
  quizLength: 3|4|5           // omit to use server default of 4
})
```

On success (`{ ok: true }`) confirm to the user, for example:

> "All set! vibe-hero is configured for [tool(s)]. Quizzes will be offered
> [cadence summary]. You can re-run setup at any time to change these
> preferences — your learning progress is never affected."

## Notes for the host agent

- Do not skip or pre-fill answers on the user's behalf; each preference is
  meaningful and the user must choose.
- If `save_config` returns an error, report it and offer to retry.
- After `save_config` succeeds, any vibe-hero tool that previously returned
  `SETUP_REQUIRED` can now be called normally — continue with whatever action
  was originally requested.
- This skill does not start a quiz or fetch status; its only job is configuration.
