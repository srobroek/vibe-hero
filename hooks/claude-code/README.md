# vibe-hero Claude Code hooks

## stop-offer.sh — End-of-work quiz offer (Stop hook, agent-mediated)

`stop-offer.sh` is a Claude Code **Stop hook** that surfaces a non-interrupting
learning offer at the end of each agent turn.

It is **agent-mediated and spawns nothing** (FR-011). A Stop hook cannot reach
the running stdio MCP server — Claude Code owns the server's pipes — and
spawning a process every turn-end would add latency and hang risk on a hot
path. So the hook does NOT call any CLI or launch `node`/`npx`. It only:

1. Reads the Stop-hook JSON payload from stdin.
2. Honors the `stop_hook_active` loop guard (if true → emits nothing, exit 0).
3. Otherwise prints a single `additionalContext` nudge:

   ```json
   {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…call the get_offer MCP tool…"}}
   ```

4. Always exits 0 (advisory only — it never blocks the user).

The **agent** then decides whether to act on the nudge: it already holds the
live MCP connection, so it calls the `get_offer` tool on the
already-running server and, if an offer is returned, presents it. The offer
logic stays entirely server-side; the hook carries no offer logic at all.

```
Claude finishes a turn
       │
       ▼
Stop hook fires → stop-offer.sh reads payload (stop_hook_active)
       │
       ├─ stop_hook_active=true? ──► exit 0, emit nothing (loop guard)
       │
       ▼
emit {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"… call get_offer …"}}
       │
       ▼
Agent (still in its loop) calls the get_offer MCP tool on the running server
       │
       ├─ suppressed (cadence/declined/off/no_candidate)? ─► say nothing
       │
       ▼
Agent presents the offer non-interruptingly
```

## Installation: automatic via the plugin (the norm)

You do **not** edit `settings.json`. Installing the **vibe-hero plugin** from
the marketplace auto-registers this Stop hook (FR-007). The plugin ships the
script and a generated `hooks.json` that points at it via the `${PLUGIN_ROOT}`
token:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "${PLUGIN_ROOT}/hooks/claude-code/stop-offer.sh", "timeout": 10 } ] }
    ]
  }
}
```

`${PLUGIN_ROOT}` resolves to the installed plugin directory, where the script
ships at `hooks/claude-code/stop-offer.sh`. No manual hook registration, no MCP
config by hand, no `settings.json` edit — the single plugin install wires it up.

> The hook source lives in this repo at `hooks/claude-code/stop-offer.sh` (dev
> source) and is shipped inside the plugin at
> `packages/vibe-hero-plugin/hooks/claude-code/stop-offer.sh` (the path
> `${PLUGIN_ROOT}` resolves to). Both are kept byte-identical.

## Degrade-safe behavior

The `additionalContext` nudge only triggers a follow-up tool call while the
agent is still in its loop. If Stop fires after the agent has fully committed
to stopping, the nudge may not act — that is fine and produces no error; the
offer is simply not shown that turn. The **vibe-hero-quiz** skill carries an
end-of-work backstop instruction so the offer still surfaces in that case.

The hook is advisory only and always exits 0. If `jq` is absent it degrades
(it falls back to a tiny pure-shell read and still emits the nudge). It depends
on **no** plugin-local build artifact and references **no** `get-offer` CLI.

## Dev-only manual install

You only need a manual `settings.json` hook entry when developing this repo
WITHOUT installing the plugin (e.g. iterating on the script itself). It is not
part of the shipped install path.

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

Replace `/absolute/path/to/vibe-hero` with the real path on your machine. `jq`
is recommended on PATH for the most robust loop-guard parsing (`brew install jq`
on macOS), but the script degrades safely without it.
