# Releasing vibe-hero (maintainers)

Maintainer/operator runbook for publishing `@vibe-hero/server` to npm and
managing the Claude Code marketplace plugin. **This file is for maintainers
only** — end users should read [`docs/distribution.md`](docs/distribution.md)
instead. See `specs/002-distribution/` for the full spec, plan, and research.

Distribution channels:

- **npm** — `@vibe-hero/server` (scoped, public). The plugin launches it via
  `npx -y @vibe-hero/server` (floating `latest`), so users never build it.
- **Claude Code marketplace** — the root `.claude-plugin/marketplace.json`
  serves the single `vibe-hero` plugin (skills + auto-registered Stop hook +
  `.mcp.json`).

## Automated releases

After the one-time bootstrap below, **there are no manual publishes**. Releases
flow through release-please + an OIDC Trusted-Publisher workflow:

1. Merges to `main` accumulate into a bot-maintained **release PR**
   (`.github/workflows/release-please.yml`, single-package mode, `v{version}`
   tag — the single source of version truth).
2. Merging that release PR triggers the publish workflow
   (`.github/workflows/release.yml`): `pnpm build` → `pnpm publish --access
   public --provenance --no-git-checks` authenticating via **OIDC Trusted
   Publishers** (`permissions: id-token: write`, no `NPM_TOKEN`), then it
   regenerates and commits the marketplace pointer.
3. Ordering is atomic: publish to npm **first**; only on success advance the
   marketplace pointer. A failed publish fails the job and does not move the
   marketplace (npm is the source of truth; the marketplace is a derived
   pointer — a partial failure reconciles idempotently on the next run).

The release PR is the single human approval point. No maintainer runs
`npm publish` by hand after bootstrap.

## One-time bootstrap (complete)

> **Status: already done.** The `@vibe-hero` org exists, `@vibe-hero/server@0.1.0`
> was published manually, and the Trusted Publisher + 2FA policy are configured.
> This section is the procedure of record — for re-creating the setup or
> onboarding another maintainer. You should not need to repeat it.

A Trusted Publisher can only be attached to a package that **already exists** on
npm, so the very first publish is a one-time manual step (FR-014a). The sequence:

1. **Create the `@vibe-hero` npm org/scope.** On npmjs.com, create the
   `@vibe-hero` organization. The package publishes scoped + public as
   `@vibe-hero/server`.

2. **Publish the first version manually** (logged in as the maintainer, with
   2FA), from `packages/server`:

   ```sh
   pnpm publish --access public --no-git-checks
   ```

   This registers `@vibe-hero/server` and establishes ownership so a Trusted
   Publisher can be attached.

   - **Do NOT set `provenance: true` in `package.json` `publishConfig`.** It
     breaks the local manual publish (`provider: null` — no OIDC token exists
     outside CI). Provenance is applied **only in CI** via the `--provenance`
     flag on the publish workflow. The committed `publishConfig` is therefore
     just `{ "access": "public" }`.
   - **The bootstrap publish has no provenance — this is expected, not a
     regression** (critique E6). Only CI publishes carry a provenance
     attestation; the manually-bootstrapped `0.1.0` does not.

3. **Configure the npm Trusted Publisher.** On the `@vibe-hero/server` package's
   npm settings, add a GitHub Actions Trusted Publisher linking the package to:
   - repository: `srobroek/vibe-hero`
   - workflow: `release.yml`

   This lets CI publish via a short-lived, workflow-scoped OIDC token — no
   long-lived `NPM_TOKEN` is ever created or stored.

4. **Set publishing access to "Require two-factor authentication and disallow
   tokens."** This 2FA-and-disallow-tokens policy is compatible with OIDC
   Trusted Publishing (OIDC is not a token), so CI keeps working while no
   publish token can exist to leak.

After these steps, all subsequent releases go through the automated flow above.

## Rollback

The plugin floats `@latest` via `npx -y @vibe-hero/server` (no version pin), so
a bad publish reaches users on their **next npx resolution** — there is no pin to
shield them (FR-012a / FR-017a). To recover:

1. **Deprecate the bad version** and/or **move `latest` back to the last-good
   version:**

   ```sh
   # Warn anyone who installs the bad version explicitly
   npm deprecate @vibe-hero/server@<bad-version> "broken release — use <good-version>"

   # Repoint the latest dist-tag at the last-good version
   npm dist-tag add @vibe-hero/server@<good-version> latest
   ```

   Moving `latest` is what actually protects floating-`latest` users — npx
   resolves `latest`, so this immediately stops new resolutions from picking up
   the bad version. `deprecate` only emits a warning; it does not change which
   version `latest` points at.

2. **Publish a fixed patch** through the normal release flow (release PR →
   merge → OIDC publish). Once the fixed version is `latest`, users pick it up on
   their next npx resolution; no user action is required.

Note: because users float `latest`, both the breakage and the fix propagate on
the next resolution — fast to break, fast to fix.

## Cross-publishing to agentic-packages (fast-follow, not yet done)

vibe-hero is its own marketplace from this repo (`apm marketplace add
srobroek/vibe-hero`) — that is the v1 path and it ships independently. Surfacing
the **same** plugin in `srobroek/agentic-packages` is a documented **fast-follow,
not implemented yet** (FR-009 / OD-004).

The mechanism is a **direct remote-git marketplace `source` entry** in
agentic-packages — no stub package, no APM/npm dependency, no source copy. APM
core supports remote git marketplace sources first-class:

```yaml
- name: vibe-hero
  source: srobroek/vibe-hero      # remote git source (default host github.com)
  ref: v<version>                 # tag / branch / sha
  category: ...
  tags: [...]
```

**Why it is blocked:** agentic-packages' local marketplace generators
(`build_inventory.py` + `render-docs.py`) rebuild the marketplace `packages`
block by walking local `packages/*/` dirs and **overwrite** it. A hand-added
external-source entry that has no backing local dir is dropped on the next
regenerate and fails the PR staleness gate. Cross-publish is gated on
**refactoring those generators to inject/preserve external-source entries**.

Until that refactor lands, do **not** add the entry to agentic-packages (it
would be reverted by the next generator run). **Do not edit the agentic-packages
repo as part of vibe-hero work** — this is tracked there.
