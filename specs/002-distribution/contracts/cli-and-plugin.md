# Contract: vibe-hero CLI + plugin install interface (spec 002)

The external interfaces vibe-hero exposes once distributed: the npm package's `bin` CLI, and the Claude Code plugin's install-time contract.

## npm CLI — `npx -y @vibe-hero/server [subcommand]`

The single `vibe-hero` bin (`dist/cli/index.js`).

### `npx -y @vibe-hero/server` (no subcommand, or `mcp`)
- **Behavior**: starts the MCP server over **stdio** (the spec-001 server — 10 tools, SETUP_REQUIRED gate, unchanged).
- **Used by**: the plugin's `.mcp.json` (`command: npx, args: ["-y","@vibe-hero/server"]`).
- **I/O**: MCP JSON-RPC over stdio. No args beyond the optional `mcp`.

### `npx -y @vibe-hero/server get-offer --session <id> --tool <toolId>` (OPTIONAL utility)
- **Behavior**: resolves the end-of-work offer for the session (delegates to the offers engine + profile, per spec-001 `get_offer`), prints one JSON line: `{ offer?: {...} } | { suppressed: "..." }`. Always exits 0.
- **Used by**: NOT the Claude Code Stop hook (that is agent-mediated, FR-011). Retained only for non-Claude-Code hosts that lack `additionalContext`, and for debugging/tests.
- **I/O**: flags in, one JSON line out on stdout; debug to stderr.

### `npx -y @vibe-hero/server <unknown>`
- **Behavior**: usage message to stderr, nonzero exit.

**Versioning**: both invocations use the SAME unpinned reference (`@vibe-hero/server`, no version) → both resolve `latest` (FR-012/SC-007). No reproducible pin (accepted tradeoff).

## Claude Code plugin install contract

Installing the `vibe-hero` plugin from the marketplace MUST, with **zero manual config edits** (SC-001), make available:

1. **The MCP server** — via the plugin's generated `.mcp.json` (`mcpServers.vibe-hero` → `npx -y @vibe-hero/server`). The host launches it on demand; no clone/build (SC-002).
2. **The four skills** — `vibe-hero-setup`, `vibe-hero-quiz`, `vibe-hero-status`, `vibe-hero-learn` — discoverable/invocable in the host.
3. **The Stop hook** — auto-registered from the plugin's `hooks/hooks.json` (`Stop` → `${CLAUDE_PLUGIN_ROOT}/hooks/claude-code/stop-offer.sh`), no settings.json edit (FR-007). The script spawns nothing: it emits an `additionalContext` nudge and the agent calls `get_offer` on the running MCP server (FR-011, agent-mediated).
4. **Offline curriculum** — shipped inside the npm package (`dist/catalog/bundled/` with real topics), so quizzes work offline (SC-003); runtime fetch layers updates.

**Gate flow (unchanged from 001)**: first action returns `SETUP_REQUIRED` → the `vibe-hero-setup` skill runs the Q&A → `save_config` clears the gate.

## Marketplace add contract (the install gesture)

A user adds the marketplace and installs the plugin (host-specific add command), where the marketplace is either:
- vibe-hero's own root `.claude-plugin/marketplace.json` (this repo), or
- the `agentic-packages` marketplace (fast-follow), via a direct remote-git `source: srobroek/vibe-hero` entry — same plugin, same `@vibe-hero/server`, same version, no copy (SC-010).

Both routes yield the identical installed plugin.

## Release contract (maintainer/CI)

- A merge of the release-please PR is the ONLY release trigger (FR-013).
- Publish authenticates via OIDC Trusted Publishers — no `NPM_TOKEN` (FR-014); emits provenance.
- Publish to npm precedes advancing the marketplace pointer; a failed publish aborts the release without moving the marketplace (FR-016).
- Generated artifacts (marketplace.json, plugin.json, .mcp.json, hooks.json) are produced by the generator and staleness-gated on PRs (FR-010/015).
