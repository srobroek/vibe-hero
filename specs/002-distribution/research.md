# Research: vibe-hero Distribution (spec 002)

Resolves the open decisions (OD-001/004/005) and the concrete packaging/CI mechanics. Grounded in the verified investigation of `srobroek/agentic-packages` (origin/main) and the current vibe-hero code. Format: **Decision / Rationale / Alternatives**.

## OD-001 — Generator: reuse agentic-packages' `build-native-plugins.py` vs plain `apm pack` → **plain `apm pack` + a tiny marketplace.json (single-plugin, no Python generator)**

**Decision**: vibe-hero is a SINGLE plugin, not a 100-package monorepo, so do NOT port agentic-packages' `build-native-plugins.py`. Use the APM layout conventions directly: author the plugin's `.apm/` layout + `apm.yml`, let `apm pack` (or a thin committed `marketplace.json` + `.claude-plugin/plugin.json`) produce the native plugin manifest, `.mcp.json`, and `hooks/hooks.json`. A short repo script regenerates the marketplace entry from `apm.yml` if needed; no general-purpose Python inventory generator.

**Rationale**: The Python generator exists to manage ~100 heterogeneous packages and a release-please monorepo; for one plugin it's overkill and inherits the name-only-dep bug. A single plugin's manifests are small and stable. Critically, a standalone (non-bundle) plugin has NO first-party APM `dependencies`, so it entirely sidesteps the `{name:...}` plugin.json bug.

**Alternatives**: Port `build-native-plugins.py` (rejected — overkill, drags in the dep-shape bug); fully hand-author manifests (rejected — drift risk; FR-010 wants generated-not-hand-authored, satisfied by `apm pack`).

## OD-004 — Cross-publish into agentic-packages → **direct remote-git marketplace `source` entry pointing at the vibe-hero repo** *(authoritative, supersedes earlier framings)*

**Decision**: vibe-hero's plugin lives in THIS repo (root `.claude-plugin/marketplace.json`), independently installable (`apm marketplace add srobroek/vibe-hero`) — the v1 path. To ALSO surface it in `srobroek/agentic-packages`, add a marketplace **PackageEntry** there whose `source` is the **remote git coordinate of the vibe-hero repo** with a `ref`:
```yaml
- name: vibe-hero
  source: srobroek/vibe-hero      # remote git source (default host github.com)
  ref: vibe-hero-v<version>       # branch / tag / sha
  category: ...
  tags: [...]
```
No stub package, no APM dependency, no npm dependency, no source copy. The entry references vibe-hero's repo directly; the npm package `@vibe-hero/server` is referenced ONLY inside vibe-hero's own `.mcp.json`.

**Authoritative basis (corrects critique E1)**: APM **core** supports remote git marketplace sources as a first-class `PackageEntry.source` — `yml_schema.py` accepts `owner/repo`, `host.tld/owner/repo`, `https://host.tld/owner/repo[.git]`, and `./local`; `is_local` is derived from a leading `./`, so a non-`./` source resolves as remote git with `ref`/`subdir`/`tag_pattern`. My critique E1 ("sources must be local, impossible") was WRONG about APM core — it conflated agentic-packages' *current usage* (only `./packages/...`) with APM's capability. Remote git sources are valid.

**Real blocker (the actual constraint)**: agentic-packages' LOCAL generators — `build_inventory.py` + `render-docs.py` — rebuild the marketplace `packages` block by walking `packages/*/` and OVERWRITE it (`block["packages"] = entries`), so a hand-added external-source entry not backed by a local dir is dropped on the next regenerate AND fails the PR staleness gate. Cross-publish therefore depends on **refactoring those generators to inject/preserve external-source entries** (the user is doing this). Until then, cross-publish can't land in agentic-packages.

**Consequence**: cross-publish stays a **fast-follow**, gated on the agentic-packages generator refactor — NOT part of vibe-hero's v1 critical path. vibe-hero's own remote-git marketplace (`srobroek/vibe-hero`) ships first and is itself the same first-class mechanism (a remote marketplace add).

**Alternatives**: stub package + cross-repo APM dependency (workable but heavier — unnecessary now that a direct remote `source` entry is confirmed valid); vendor/copy the plugin (rejected — duplication/drift).

## OD-005 — npm org/scope → **`@vibe-hero` scoped public package, Trusted Publishers + 2FA**

**Decision**: Publish as `@vibe-hero/server` (scoped, `--access public`). Maintainer owns the `@vibe-hero` npm org. Auth: npm **Trusted Publishers (OIDC)** for CI; the one-time bootstrap publish is manual (maintainer, 2FA). Verified: `@vibe-hero/server` is currently unregistered (npm 404); maintainer is logged in as `srobroek`.

**Rationale**: A scope gives a clean namespace and room for future packages (e.g. a separate `@vibe-hero/content` if ever split). Trusted Publishers eliminates long-lived tokens (no `NPM_TOKEN` secret) and emits provenance. 2FA is required by npm for publishing.

**Alternatives**: Unscoped `vibe-hero-server` (rejected — no namespace, name-squat risk); user-scoped `@srobroek/...` (rejected — product identity should own the scope).

## Bin / CLI design (FR-002)

**Decision**: One `bin` named `vibe-hero` → `dist/cli/index.js`, a thin dispatcher:
- no subcommand (or `mcp`) → start the stdio MCP server (today's `dist/index.js` `main()`).
- `get-offer` → the Stop-hook offer query (today's `dist/cli/getOffer.js` `main()`).

The current code is already close: `getOffer.ts` parses a `get-offer` subcommand, and `index.ts` has an entrypoint guard. The plan introduces `src/cli/index.ts` as the unified dispatcher that routes argv → the server bootstrap or the getOffer handler (both already exist as importable `main()`s). `package.json` `bin: { "vibe-hero": "dist/cli/index.js" }`.

**Rationale**: A single bin with subcommands (FR-002 decision) keeps one npm entry; both `npx -y @vibe-hero/server` and `npx -y @vibe-hero/server get-offer` resolve the same bin. Reuses existing `main()`s — minimal new code.

## Content packaging (FR-003/004)

**Decision**: The npm build copies the repo's real `content/` (claude-code + general topics) into `dist/catalog/bundled/` as the offline snapshot, EXTENDING the existing `copy-assets` step (which today copies only `src/catalog/bundled/`). `package.json` `files` includes `dist/` only; tests/sources excluded. Runtime GitHub fetch (`VIBE_HERO_CONTENT_URL`) still layers updates over the bundled snapshot (unchanged from 001).

**Rationale**: 001's loader resolves the bundled dir relative to `import.meta.url`, so shipping the real topics there means npx users get real curriculum offline (SC-003). The 001 polish already added a `copy-assets` step — extend it rather than invent a new mechanism. Resolves the "bundled ships only `_placeholder`" gap noted at end of 001.

**Alternatives**: Keep placeholder + rely on fetch (rejected — bad offline UX, FR-004); separate `@vibe-hero/content` npm package (deferred — unnecessary for one product).

## Plugin layout (FR-005/006/007/008)

**Decision**: One Claude Code plugin (APM `.apm/` convention) bundling:
- **skills**: the four `skills/*/SKILL.md` surfaced via the plugin's `skills` path (referenced, not copied).
- **MCP**: `apm.yml` `dependencies.mcp: [{name: vibe-hero, registry: false, transport: stdio, command: npx, args: ["-y","@vibe-hero/server"]}]` → generated top-level `.mcp.json` `{mcpServers:{vibe-hero:{command:"npx",args:["-y","@vibe-hero/server"]}}}` (FR-008, floating latest per FR-012).
- **hook**: `.apm/hooks/vibe-hero-claude-hooks.json` declaring the **Stop** hook with a command using the **`${PLUGIN_ROOT}`** token (the variable Claude Code substitutes in hook commands; working plugins and the official docs use `${PLUGIN_ROOT}`), auto-registered on install (FR-007) — retires the manual README.
- **content**: bundled offline snapshot ships inside the npm package (above); the plugin itself doesn't need a content copy since the server (npx) carries it.

**Rationale**: Matches the verified agentic-packages plugin conventions; install gives MCP + skills + hook with zero manual config (SC-001).

## Stop-hook: agent-mediated, NO process spawn (FR-011 — corrected post-critique E3)

**Decision**: The Stop hook does NOT spawn any process (no `npx`, no `node`, no `get-offer` CLI). **Verified**: a hook cannot reach the running stdio MCP server (Claude Code owns the server's pipes; no socket/IPC is exposed). The idiomatic pattern is **agent-mediated**: the Stop hook emits `hookSpecificOutput.additionalContext` (a short JSON nudge), and the AGENT — which already has the MCP connection live — calls the `get_offer` MCP tool itself against the already-running server. The hook is a tiny pure-shell script that just prints the additionalContext JSON; it spawns nothing.

**Rationale**: Eliminates the per-turn-end process spawn + npx-resolution latency entirely (the E3 concern disappears, not just mitigated). No plugin-local build file is referenced (FR-011 satisfied trivially — there's nothing to reference). The offer logic stays server-side and is reached by the agent's existing MCP connection, not a fresh process.

**Caveat**: `additionalContext` only triggers a follow-up tool call if the agent is still in its loop (if Stop fires after the agent has fully committed to stopping, the nudge may not act). Mitigation: reinforce "offer a check at end of work" in the quiz skill / steering so the behavior isn't solely hook-dependent. The hook's `Stop`-event JSON also keeps a loop guard (don't re-nudge if `stop_hook_active`).

**Consequence for the bin (FR-002)**: the `get-offer` subcommand is NO LONGER needed by the Claude Code Stop hook. Keep it in the bin as an OPTIONAL utility (useful for non-Claude-Code hosts that lack additionalContext, and for debugging/tests), but it is off the critical path. The primary bin behavior is just the MCP server (`npx -y @vibe-hero/server`).

**Alternatives**: hook spawns `npx … get-offer` per stop (rejected — E3 latency/hang on hot path); dual-transport server with a local HTTP port for the hook to curl (rejected — added complexity, two transports to manage); hook reads `~/.vibe-hero` offer state directly (rejected — duplicates server logic in shell, drift risk).

## Release pipeline (FR-013–017)

**Decision**: Two GitHub Actions workflows, release-please-gated (matches agentic-packages):
1. **release-please workflow** (on push to `main`): maintains the release PR + version (single source of truth, FR-017). Tag pattern aligned with agentic-packages (`{name}-v{version}` or a simple `v{version}` — finalize in tasks).
2. **publish workflow** (on the release tag / release-please release event): `pnpm build` → `pnpm publish --access public --provenance --no-git-checks` authenticating via **OIDC Trusted Publishers** (`permissions: id-token: write`, no `NPM_TOKEN`), then regenerate + commit the marketplace/plugin artifacts. A **PR-time staleness check** (FR-015) regenerates artifacts and fails if the committed ones are out of date. Atomic ordering: publish to npm BEFORE advancing the marketplace pointer, and fail the job if publish fails (FR-016).

**Rationale**: Reuses the proven agentic-packages release model; OIDC removes secret management; the staleness gate prevents drift; ordering makes a failed publish non-corrupting.

**Alternatives**: changesets (rejected — release-please matches the sibling repo + cross-publish); manual tag workflow (rejected — FR-013 wants automation). Provenance requires the package to opt in and the workflow to run on a supported runner — confirmed standard for public npm.

## Technical Context (resolved)

- **Language/tooling**: TypeScript (existing `packages/server`), pnpm, Node ≥18. No new runtime deps (npx uses the published package; `js-yaml`/`zod`/SDK already present).
- **Packaging**: npm scoped public package `@vibe-hero/server` with one `vibe-hero` bin; `files: ["dist"]`; build = `tsc` + extended `copy-assets` (bundled real content).
- **Distribution**: root `.claude-plugin/marketplace.json` + APM plugin (`apm.yml` + `.apm/{skills,hooks}` + generated `.mcp.json`); cross-listed in agentic-packages by reference.
- **CI**: GitHub Actions — release-please + OIDC publish + staleness gate. No long-lived secrets.
- **Constraints**: no spec-001 behavior change (FR-018); all 144 tests stay green (FR-019); `${PLUGIN_ROOT}` hook token; floating-latest npx; one-time manual bootstrap publish (FR-014a).
- **Bootstrap (out-of-band, maintainer)**: create `@vibe-hero` org → manual first `npm publish` → configure Trusted Publisher (repo + publish workflow) → CI thereafter.

No `NEEDS CLARIFICATION` remain.
