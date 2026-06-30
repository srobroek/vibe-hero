# Quickstart / Validation Guide: vibe-hero Distribution (spec 002)

How to prove the packaging + release works. References `data-model.md` and `contracts/cli-and-plugin.md` for shapes.

## Prerequisites

- Node ≥18, pnpm, `npx` available.
- Maintainer bootstrap done once (out-of-band): `@vibe-hero` org created, first manual `npm publish` done, Trusted Publisher configured. (Validation scenarios that need a published package assume the bootstrap publish has happened; pre-publish scenarios use `npm pack` / a local tarball.)

## Validation scenarios (map to Success Criteria)

### V1 — Package is publishable & well-formed (FR-001/003, SC-002) — pre-publish, no network
1. `pnpm --filter @vibe-hero/server build` → `dist/` contains `cli/index.js`, `index.js`, and `catalog/bundled/**` with REAL topics (not just `_placeholder`).
2. `pnpm --filter @vibe-hero/server pack` (or `npm pack --dry-run`) → inspect the tarball: includes `dist/` (incl. bundled content), excludes `src/`, `test/`, configs. `package.json` has `bin.vibe-hero`, no `private`, `publishConfig.access=public`.
3. **Expect**: a clean publishable tarball; `bin` present; tests/sources absent.

### V2 — CLI bin dispatches correctly (FR-002) — local
1. From the built package: `node dist/cli/index.js` (no subcommand) → starts an MCP stdio server (send `initialize` + `tools/list` → 10 tools).
2. `node dist/cli/index.js get-offer --session s1 --tool claude-code` → prints one JSON line (`{suppressed:...}` on an unconfigured profile), exit 0.
3. `node dist/cli/index.js bogus` → usage to stderr, nonzero exit.
4. **Expect**: one bin, both behaviors; matches the contract.

### V3 — Offline curriculum ships in the package (FR-004, SC-003)
1. With the built `dist`, point the bundled-catalog loader at `dist/catalog/bundled` (or run the server with no `VIBE_HERO_CONTENT_URL` and no network) → loads the real claude-code + general topics, 0 errors.
2. **Expect**: ≥3 real topics available offline (not the placeholder).

### V4 — Plugin install wiring (FR-005/006/007/008, SC-001) — manifest-level
1. Generate the plugin artifacts (`apm pack` or the repo's generate step) → `.mcp.json` has `mcpServers.vibe-hero` = `npx -y @vibe-hero/server`; `hooks/hooks.json` has a `Stop` hook with a `${CLAUDE_PLUGIN_ROOT}` command; `plugin.json` carries identity + skills path, NO `mcpServers` block, and NO name-only deps.
2. **Expect**: manifests are generated (not hand-authored), wire MCP + hook + skills, and contain no `{name:...}`-only dependency entries.
3. (Full end-to-end install in a real Claude Code is a manual acceptance step — confirm: add marketplace → install → MCP tools present, skills present, Stop hook fires at end of work, all with zero config edits.)

### V5 — Stop hook is agent-mediated, spawns nothing (FR-011, SC-006)
1. Run `hooks/claude-code/stop-offer.sh` with a synthetic Stop payload → it prints a `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…call get_offer…"}}` JSON and exits 0; assert it invokes NO subprocess (no `npx`/`node`) — e.g. trace/strace or assert the script has no spawn, and references no `dist/cli/getOffer.js`.
2. With `stop_hook_active` set in the payload → it emits nothing (loop guard).
3. **Expect**: zero process spawn; the offer is fetched by the agent calling the MCP tool, not by the hook. (Full end-to-end — agent acts on the nudge and calls `get_offer` — is a manual Claude Code acceptance step.)

### V6 — Release pipeline (FR-013/014/016, SC-004/005) — CI dry-run / inspection
1. Inspect the publish workflow: triggers on the release-please release (not arbitrary merges); requests `permissions: id-token: write`; runs `pnpm publish --access public --provenance`; references NO `NPM_TOKEN` secret.
2. Inspect ordering: npm publish precedes the marketplace-pointer commit; a failed publish aborts before the marketplace advances.
3. **Expect**: OIDC-only auth (no secret), provenance flag present, atomic ordering. (A real publish is gated on the bootstrap + Trusted Publisher config; CI can be validated with `--dry-run`/`act` or a no-op first run.)

### V7 — Staleness gate (FR-010/015, SC-008)
1. Hand-edit a generated artifact (e.g. `.mcp.json`) and open a PR (or run the gate locally) → the CI staleness job regenerates and FAILS because committed ≠ regenerated.
2. **Expect**: drift is caught, not shipped.

### V8 — No spec-001 regression (FR-018/019, SC-009)
1. `pnpm --filter @vibe-hero/server test` → all 144 spec-001 tests still pass after packaging changes (bin dispatcher, build script, files, hook rewire).
2. **Expect**: 0 regressions; runtime behavior unchanged.

## Done = V1–V8 pass

The distribution is shippable when V1–V3 (package), V4–V5 (plugin + hook), V6–V7 (release + gate), and V8 (no regression) all pass. The one-time manual bootstrap publish + Trusted Publisher config are maintainer prerequisites, documented but performed out-of-band.
