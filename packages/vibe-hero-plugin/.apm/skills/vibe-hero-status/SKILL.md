---
name: vibe-hero-status
description: Run when the user asks "where am I with vibe-hero", "what's my progress", "what's my standing on <tool>", "how am I doing with <tool>", "what level am I at", or any question about their current learning status or topic tiers. Works across Claude Code, Codex, and Kiro.
---

# vibe-hero Status

This skill shows the user's full progress dashboard by calling `get_dashboard`
(and optionally `get_status` for a quick text summary). It is pull-based and
read-only — no quiz is started.

## When to invoke

- The user asks where they stand, what their progress is, or what level they are.
- The user asks about their status on a specific tool (e.g. "how am I doing with
  Claude Code?").
- The user asks which topics are weak, stale, or due for review.
- The user asks for a progress dashboard or overview.

## Steps

### 1. Check for a named tool

If the user names a specific tool in their request, pass it as the `tool`
argument. If no tool is named, omit the argument.

### 2. Call `get_dashboard`

```
get_dashboard({ tool?: ToolId })
```

### 3. Handle SETUP_REQUIRED

If the response is `{ "status": "SETUP_REQUIRED" }`, stop and tell the user:

> "vibe-hero isn't configured yet. Run the **vibe-hero-setup** skill first — it
> only takes a minute — then come back to check your status."

Do not proceed further until setup completes.

### 4. Output the dashboard

The `get_dashboard` result contains a `rendered` field — the complete,
server-rendered fixed-width dashboard string.  Output it **verbatim** inside a
fenced code block.  Do NOT reformat, summarise, or add anything to it.

````
```
<result.rendered>
```
````

(Note: acceptance/quiz flows are separate — do not start a quiz here unless the
user explicitly asks.)

### 5. Offer a next action

After the dashboard, offer the user a natural next step. For example:

> "Want guidance on one of these topics, or shall I quiz you on something? You
> can also ask 'what should I learn next?' for a recommendation."

## Notes for the host agent

- This skill is read-only. Do not call `start_quiz` or `get_guidance` unless the
  user explicitly asks for that next step.
- If `matrix` is empty, the user has no content for the requested scope — surface
  that clearly.
- Keep the tone informational and encouraging; the user is checking in on their
  own growth.
