---
name: write-a-skill
description: Create or rewrite agent skills with precise triggers, progressive disclosure, references, scripts, and source-of-truth placement. Use when the user asks to create, write, repair, optimize, or package a skill for an APM package or marketplace.
---

# Writing Skills

Canonical workflow for skill authoring. Use this instead of external
skill-writing prompts when source-of-truth placement and APM packaging matter.

## Locate Source

1. Edit the skill's authoritative source under the APM package or marketplace
   repo it belongs to (for example `packages/<skill>/SKILL.md` and its
   `references/` and `scripts/`).
2. Never edit generated runtime copies such as `.agents/skills`,
   `.codex/agents`, `.claude/agents`, `.claude/rules`, compiled `AGENTS.md`, or
   compiled `CLAUDE.md`.

## Gather Requirements

Ask only what cannot be inferred from the source, repo, or prompt:

- task/domain and concrete use cases
- trigger boundaries and non-triggers
- source-of-truth and runtime install target
- whether deterministic scripts are needed
- references, examples, or external package overlap to preserve or replace

## Draft

Create or update:

- `SKILL.md` as the short entry file
- `references/*.md` for stable policy, source catalogues, schemas, or examples
- `scripts/*` for deterministic validation, generation, formatting, or checks

Expected layout (references and scripts only when needed):

```
packages/<skill>/.apm/skills/<skill>/
  SKILL.md
  references/
    <topic>.md
  scripts/
    check.sh
```

## Description Requirements

The description is the trigger surface. Keep it under 1024 characters, third
person, and specific.

## Structure Rules

- Keep `SKILL.md` under 100 lines when practical.
- Split long or rarely used detail into one-level references.
- Prefer ordered workflows over broad advice.
- Use scripts for repeatable deterministic work and explicit error handling.
- Preserve real behavior and source-of-truth rules.
- Remove duplicated, obsolete, vendor-stale, or overbroad instructions.
- For coding/development agents, do not bake MCP use into model metadata; tell
  the parent orchestrator to pass task-specific guidance.

## Review Checklist

- Description includes concrete triggers and is under 1024 characters
- `SKILL.md` is short and progressively discloses details
- Source path is authoritative, not generated runtime output
- Workflow has clear stop/report points
- References are stable and one level deep
- Scripts are executable only when deterministic value exists
- External overlap is recorded as keep, prefer, replace, fork, wrap, or reject
