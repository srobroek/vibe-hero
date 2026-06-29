# Changeset Policy

Create a changeset when the repo uses changesets and the diff includes:

- user-facing behavior changes
- fixes with release impact
- API changes
- breaking changes

Usually skip a changeset for:

- docs-only changes
- tests-only changes
- CI or tooling maintenance
- refactors with no behavior change
