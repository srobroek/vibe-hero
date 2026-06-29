# TypeScript References

Use these in this order:

1. Local project conventions and existing code patterns
2. Context7 for framework and library docs
3. Canonical TypeScript language docs for type-system and API-design questions

## Context7

- Use Context7 when the question depends on the current framework or library version.
- Start with the relevant package docs, then narrow to the exact topic:
  - TypeScript: `microsoft/typescript`
  - React: the installed React docs source for the project
  - Next.js, Vite, Zod, Vitest, etc.: the exact package used by the repo

## Canonical Docs

- TypeScript Handbook: https://www.typescriptlang.org/docs/handbook/intro.html
- TSConfig Reference: https://www.typescriptlang.org/tsconfig/
- TypeScript API design notes should prefer:
  - narrow public types
  - discriminated unions over boolean mode flags
  - explicit nullability
  - inference-friendly function signatures

## Steering Notes

- Prefer modeling invalid states out of the type space.
- Keep exported types smaller and more intentional than internal implementation types.
- Prefer plain objects and composable functions over deep class hierarchies unless the codebase already leans heavily on classes.
- Avoid widening to `any`; prefer `unknown` plus narrowing.
