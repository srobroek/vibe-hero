# Research: vibe-hero Distribution (spec 002)

Resolves the open decisions (OD-001/004/005) and the concrete packaging/CI mechanics. Grounded in the verified investigation of `srobroek/agentic-packages` (origin/main) and the current vibe-hero code. Format: **Decision / Rationale / Alternatives**.

## OD-001 — Generator: reuse agentic-packages' `build-native-plugins.py` vs plain `apm pack` → **plain `apm pack` + a tiny marketplace.json (single-plugin, no Python generator)**

**Decision**: vibe-hero is a SINGLE plugin, not a 100-package monorepo, so do NOT port agentic-packages' `build-native-plugins.py`. Use the APM layout conventions directly: author the plugin's `.apm/` layout + `apm.yml`, let `apm pack` (or a thin committed `marketplace.json` + `.claude-plugin/plugin.json`) produce the native plugin manifest, `.mcp.json`, and `hooks/hooks.json`. A short repo script regenerates the marketplace entry from `apm.yml` if needed; no general-purpose Python inventory generator.

**Rationale**: The Python generator exists to manage ~100 heterogeneous packages and a release-please monorepo; for one plugin it's overkill and inherits the name-only-dep bug. A single plugin's manifests are small and stable. Critically, a standalone (non-bundle) plugin has NO first-party APM `dependencies`, so it entirely sidesteps the `{name:...}` plugin.json bug.

**Alternatives**: Port `build-native-plugins.py` (rejected — overkill, drags in the dep-shape bug); fully hand-author manifests (rejected — drift risk; FR-010 wants generated-not-hand-authored, satisfied by `apm pack`).

## OD-004 — Cross-publish into agentic-packages → **marketplace entry referencing this repo by source; no source duplication**

**Decision**: vibe-hero's plugin lives in THIS repo (root `.claude-plugin/marketplace.json`). To cross-publish, add a marketplace/package entry in `srobroek/agentic-packages` that REFERENCES the vibe-hero plugin by its published location (a marketplace `source` pointing at the vibe-hero repo/tag), NOT a copy of the source. Same version, single source of truth (the vibe-hero release tag).

**Rationale**: Avoids version divergence and duplicate maintenance (SC-010). The agentic-packages marketplace.json already lists plugins by `source`; a remote source (repo/ref) is the established mechanism. The npm server is the same `@vibe-hero/server` regardless of which marketplace surfaces the plugin.

**Alternatives**: Vendor/copy the plugin into agentic-packages (rejected — duplication + drift); git submodule (rejected — heavier, brittle). Exact reference syntax (remote `source` vs an APM dependency on the vibe-hero package) is finalized in the plan's CI section; both avoid duplication.

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
- **hook**: `.apm/hooks/vibe-hero-claude-hooks.json` declaring the **Stop** hook with a command using the **`${PLUGIN_ROOT}`** token (verified: agentic-packages uses `${PLUGIN_ROOT}`, NOT `${CLAUDE_PLUGIN_ROOT}`), auto-registered on install (FR-007) — retires the manual README.
- **content**: bundled offline snapshot ships inside the npm package (above); the plugin itself doesn't need a content copy since the server (npx) carries it.

**Rationale**: Matches the verified agentic-packages plugin conventions; install gives MCP + skills + hook with zero manual config (SC-001).

## Stop-hook rewiring for npx (FR-011 — the npx consequence)

**Decision**: The Stop hook must NOT call a plugin-local `dist/cli/getOffer.js` (no such file in an npx-only install). Rewire it to invoke the published CLI: `npx -y @vibe-hero/server get-offer --session <id> --tool <tool>`. Because npx-resolving on every Stop could be slow, the hook keeps its current defensive guards (skip silently on any failure) and may prefer a cached npx. The `VIBE_HERO_SERVER_DIST` override stays for local dev/testing (call the local `dist` when set).

**Rationale**: Puts the offer logic in the same published package as the server (no separately-bundled script to rot, FR-011); both server and hook float to the same `@vibe-hero/server` latest (FR-012). The getOffer logic already lives in the package's CLI — only the hook's invocation path changes.

**Alternatives**: Ship a `${PLUGIN_ROOT}/scripts/stop-offer.sh` wrapper inside the plugin that shells to npx (acceptable variant — decide in tasks whether the hook command is the raw `npx … get-offer` or a wrapper script; wrapper gives a place for the guards). Either way the logic is in the npm package.

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
- **Constraints**: no spec-001 behavior change (FR-018); all 144 tests stay green (FR-019); `${PLUGIN_ROOT}` token; floating-latest npx; one-time manual bootstrap publish (FR-014a).
- **Bootstrap (out-of-band, maintainer)**: create `@vibe-hero` org → manual first `npm publish` → configure Trusted Publisher (repo + publish workflow) → CI thereafter.

No `NEEDS CLARIFICATION` remain.
