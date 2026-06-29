---
name: vibe-hero-learn
description: Run when the user asks "what should I learn next", "teach me about <topic>", "help me improve at <tool>", "give me guidance on <topic>", "what's worth studying", or any request for learning direction or topic guidance. Works across Claude Code, Codex, and Kiro.
---

# vibe-hero Learn

This skill retrieves targeted guidance and a suggested next step for a topic (or
the weakest/stalest area) by calling `get_guidance`. It can optionally call
`list_topics` to show the user what is available. It does not start a quiz
itself — it hands off to the `vibe-hero-quiz` skill / `start_quiz` tool if the
user wants to practice.

## When to invoke

- The user asks what to learn or study next.
- The user asks for guidance, an explanation, or teaching on a named topic.
- The user asks how to improve on a specific tool.
- The user wants to see what topics are available.

## Steps

### 1. Identify the topic key (if any)

If the user named a specific topic (e.g. "subagents", "context management"),
pass it as the `key` argument. If no topic is named, omit `key` — the server
will pick the weakest or most stale area automatically.

Optionally pass `tool` if the user has specified or has a configured tool in
context.

### 2. Call `get_guidance`

```
get_guidance({ key?: AbilityKey, tool?: ToolId })
```

### 3. Handle SETUP_REQUIRED

If the response is `{ "status": "SETUP_REQUIRED" }`, stop and tell the user:

> "vibe-hero isn't configured yet. Run the **vibe-hero-setup** skill first —
> it only takes a minute — then come back for guidance."

Do not proceed further until setup completes.

### 4. Present the guidance

From the response, present:

- The **title** of the topic and the **currentTier** the user is at.
- The **guidance** text — this is the teaching explanation for the topic at
  their current tier. Present it in full; do not summarize it away.
- The **nextStep**: if `action` is `"quiz"`, tell the user they can practice
  with a quiz and offer to start one. If `action` is `"read"`, present the
  `detail` as suggested reading.

Example framing:

> "Here's what you should focus on for **[title]** at tier [tier]:
>
> [guidance text]
>
> **Suggested next step**: [quiz offer or reading pointer]"

### 5. Offer to start a quiz

If `nextStep.action` is `"quiz"`, offer explicitly:

> "Want to test yourself on this now? I can start a quick quiz — just say yes."

If the user agrees, hand off to the `vibe-hero-quiz` skill or call `start_quiz`
directly with the topic `key` from the guidance response.

### 6. Optionally show available topics

If the user asked what topics exist, or if `get_guidance` returned nothing
useful (e.g. no weak area found), call `list_topics` to show what is in the
catalog:

```
list_topics({ tool?: ToolId, class?: "general" | "tool" })
```

Present the results as a concise list of topic titles so the user can name one
for a follow-up guidance or quiz request.

## Notes for the host agent

- `get_guidance` with no `key` picks the weakest/stalest topic automatically —
  this is the right default for "what should I learn next?" requests.
- Do not invent guidance text; always use what the server returns.
- The `key` in the response is the `AbilityKey` to pass to `start_quiz` if the
  user wants to practice.
- Keep the tone instructive and motivating; the user is here to learn something.
