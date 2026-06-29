# Fetch Tool Selection

Choose the most structured source that can answer the question. MCP servers
named below (GitHub MCP, Context7) are optional: when a tool is not installed,
drop to the next option in the same line (CLI, `curl`, or plain web fetch).

## Routing

- Product or SaaS resource: use its CLI, API, or MCP before scraping pages.
- GitHub resource: use `gh` or GitHub MCP for issues, PRs, releases, files, and
  repository metadata.
- API or SDK behavior: use official docs first. Use the Context7 MCP server
  (versioned library/framework docs, `mcp-context7` package) when it is
  installed and current enough; otherwise fetch the official docs directly.
- Exact URL: fetch that URL first. Follow only links needed to answer the
  user's question.
- Static page or PDF: use simple fetch/open.
- JS-heavy page, interactive state, bot block, or empty HTML shell: use a
  rendered browser fetch.

## Output

- State which source answered the question.
- Include links or stable identifiers.
- Separate fetched facts from inferences.
- Note access limits, missing content, or authentication blockers.
