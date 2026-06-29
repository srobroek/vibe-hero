# vibe-hero Distribution

Operational notes for publishing `@vibe-hero/server` to npm and managing the
Claude Code marketplace plugin. See `specs/002-distribution/` for the full spec
and plan.

## Maintainer one-time bootstrap

These steps are performed **once** by the maintainer before CI-driven releases
can work. They are out-of-band (not automated) because a Trusted Publisher can
only be attached to an npm package that already exists.

- Create the `@vibe-hero` npm organisation (scope) at npmjs.com
- Perform the first manual `npm publish` (logged in, 2FA active) to register
  `@vibe-hero/server` and establish package ownership (FR-014a)
- Configure the npm Trusted Publisher on npmjs.com: link the package to the
  `srobroek/vibe-hero` repository and the `release.yml` publish workflow
  (enables OIDC authentication for all subsequent CI releases — no long-lived
  `NPM_TOKEN` is ever created or stored)

All subsequent releases are fully automated via CI (see `.github/workflows/`).
See `specs/002-distribution/spec.md` FR-013/014 for the release pipeline spec.
