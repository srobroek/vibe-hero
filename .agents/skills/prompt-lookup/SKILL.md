---
name: prompt-lookup
description: Find, compare, and improve prompt templates and prompt-engineering patterns. Use when the user says "find me a prompt", "what prompts are available", "get prompt X", "make this prompt better", or mentions prompt libraries or prompt engineering.
---

# Prompt Lookup

Search for and improve AI prompts: **$ARGUMENTS**

When invoked as a command (`/prompt-lookup <request>`), `$ARGUMENTS` above is
replaced with the user's request text. If it is empty or still reads literally
`$ARGUMENTS`, derive the request from the conversation or ask what to look up.

## Operations

### Search for prompts

Search by keyword with optional filters:
- **query**: search keywords from the user's request
- **limit**: number of results (default 10)
- **type**: TEXT, STRUCTURED, IMAGE, VIDEO, or AUDIO
- **category**: category slug (e.g., "coding", "writing")
- **tag**: tag slug

Present results showing: title, description, author, category, tags, and link.

### Get a specific prompt

Retrieve by ID. If the prompt contains variables (`${variable}` or `${variable:default}`), prompt the user to fill in values. Variables without defaults are required.

### Improve a prompt

Submit prompt text for enhancement. Specify output type (text, image, video, sound) and format (text, structured_json, structured_yaml). Return the enhanced version and explain what was improved.

## Guidelines

- Always search before suggesting the user write from scratch
- Present search results in a readable format with links
- When improving prompts, explain what was enhanced and why
- Suggest relevant categories and tags for discoverability
