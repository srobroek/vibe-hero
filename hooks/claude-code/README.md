# vibe-hero Claude Code hooks

## stop-offer.sh — End-of-work quiz offer (Stop hook)

`stop-offer.sh` is a Claude Code **Stop hook** that surfaces a non-interrupting
learning offer at the end of each agent turn.  It is thin by design: all offer
logic lives in the vibe-hero MCP server; the script resolves the offer by
calling `node packages/server/dist/cli/getOffer.js` and, when an offer is due,
injects the offer text into the next agent context via `additionalContext`.

### Prerequisites

1. **Build the server** so the CLI is available at `packages/server/dist/`:

   ```sh
   pnpm --filter @vibe-hero/server build
   ```

2. **Configure vibe-hero** (run the setup skill at least once).  Until setup
   completes, `get_offer` returns a gate sentinel and the hook suppresses
   silently.

3. **jq** must be on your PATH (used to parse the hook payload and produce
   safe JSON output).  On macOS: `brew install jq`.

### Registering the hook in Claude Code

Add this to your project `.claude/settings.json` (or your global
`~/.claude/settings.json` if you want it everywhere):

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/vibe-hero/hooks/claude-code/stop-offer.sh"
          }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to/vibe-hero` with the real path on your machine (e.g.
`~/dev/vibe-hero`).

> **Advisory only**: this hook never blocks or interrupts work.  If anything
> goes wrong (missing build, missing jq, profile not configured, offer
> suppressed by cadence) it exits 0 silently.

### How it works

```
Claude finishes a turn
       │
       ▼
Stop hook fires → stop-offer.sh reads payload (session_id, stop_hook_active)
       │
       ├─ stop_hook_active=true? ──► exit 0 (infinite-loop guard)
       │
       ├─ jq / node / dist missing? ─► exit 0 (graceful degradation)
       │
       ▼
node dist/cli/getOffer.js get-offer --session <id> --tool claude-code
       │
       ├─ suppressed (cadence/declined/off/no_candidate)? ─► exit 0 silently
       │
       ▼
emit {"hookSpecificOutput":{"additionalContext":"[vibe-hero] <offer prompt>"}}
       │
       ▼
Claude's next context includes the offer; agent presents it non-interruptingly
```

### Environment overrides

| Variable | Purpose |
|---|---|
| `VIBE_HERO_SERVER_DIST` | Override the path to `dist/cli/getOffer.js` (e.g. for testing a different build). |
| `VIBE_HERO_STOP_HOOK_ACTIVE` | Set to `1` internally to prevent re-entry; do not set manually. |
