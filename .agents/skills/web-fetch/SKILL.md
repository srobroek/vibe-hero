---
name: web-fetch
description: Retrieve current or URL-specific information from the web with source-aware tool routing. Use when the user asks to fetch, open, browse, cite, verify online, inspect a URL, or answer a question whose facts may have changed.
---

# Web Fetch

Use this skill when the task needs current online facts, a specific URL, or
source-backed evidence. For broad multi-source synthesis, use a research skill
after fetching the needed sources.

## Tool Selection

| Need | Tool |
|------|------|
| GitHub issues, PRs, releases, repo data | `gh` CLI or GitHub MCP |
| OpenAI product/API docs | OpenAI docs MCP or official OpenAI docs |
| Library or framework docs | Context7 MCP or official docs |
| Known JSON/REST endpoint | `curl` or product CLI |
| Static webpage or PDF | Simple web fetch |
| JS-heavy page, login flow, bot block, visual state | Browser/rendered fetch |

Context7 is an MCP server that serves versioned library/framework documentation
(installed via the `mcp-context7` package). MCP tools in this table are
optional: when one is not installed, use the next-best row for that need (CLI,
`curl`, or plain web fetch of the official docs).

## Rules

- Prefer primary sources: official docs, vendor APIs, standards, repository
  metadata, release notes, or the exact URL the user gave.
- Start with the lowest-overhead structured source that can answer the question.
- Escalate immediately to browser rendering when simple fetch returns a 403,
  bot block, empty shell, client-rendered page, or missing target content.
- Quote sparingly. Summarize only the parts needed for the user question and
  include source links or file/URL identifiers.
- Do not use stale model memory for facts that are likely to have changed when
  fetching is available.
- Do not dump raw page content, scrape unrelated pages, or broaden a URL task
  into open-ended research unless the user asks for that.

## References

- For detailed fetch tool comparison and options, LOAD references/tool-selection.md
