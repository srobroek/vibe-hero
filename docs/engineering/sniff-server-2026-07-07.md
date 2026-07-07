# Sniff Refactoring Plan — packages/server

**Target:** module `packages/server` (src + test, TypeScript)
**Scope mode:** full (advisory — nothing applied)  ·  **Base ref:** none (working tree, branch `feat/perf-and-batch-submit`)
**Languages:** TypeScript  ·  **Date:** 2026-07-07

## Summary

- Findings: 13 kept (after adversarial filter; 2 dropped, 17 downgraded to none/low from 32 raw)
- By severity: high 1 · medium 2 · low 10
- Headline: fix the `SERVER_VERSION` drift — the server advertises v0.1.0 to every MCP host while the package is v0.12.0, and the version-sync test doesn't cover it.

## Tool coverage

| Dimension | Tool | Class | Ran? | Notes |
|-----------|------|-------|------|-------|
| security patterns | semgrep (auto) | local | yes | 1 finding (ReDoS surface — downgraded, trusted catalog) |
| duplication | jscpd | relational | yes | 2 clones confirmed |
| cycles | madge | global | yes | clean |
| dead exports/files | knip | global | yes | several hits; most are public-API-by-convention |
| types | tsc --noEmit (strict) | local | yes | clean |
| complexity | eslint+sonarjs / lizard / scc | local | SKIPPED (not installed) | `npm i -D eslint typescript-eslint eslint-plugin-sonarjs` |
| any-leakage | type-coverage | local | SKIPPED (not installed) | low priority; tsconfig is already strict |
| reading layer | 2× bloodhound agents | — | yes | full src/ read |

No eslint/biome config exists in the repo — tsconfig strict mode is the only lint authority (honored).

## Prioritized refactoring plan

| # | Finding (file:line) | Smell → refactoring | Severity | Impact | Value | Cost | Back-compat | Apply tier |
|---|---------------------|---------------------|----------|--------|-------|------|-------------|------------|
| 1 | `src/index.ts:51` SERVER_VERSION="0.1.0" vs package.json 0.12.0 | version drift → derive from package.json or cover in version-sync test | **high** | every MCP host sees the wrong server version | high | S | version string changes on the wire (bug fix) | mechanical |
| 2 | `src/cli/getOffer.ts:176` isEntrypoint missing realpathSync fallback | Duplicate Code (divergent copy) → [Extract Function](https://refactoring.guru/extract-method) to shared util | **med** | stop-hook CLI can silently not run under npx/symlink launch | high | S | safe (behavior-fixing) | mechanical |
| 3 | whole server: `QuizRecord.completedAt` never written | missing code path → decide: write on batch/last submit, or document open-ended design | **med** | completed-quiz guard is dead; quizzes answerable unboundedly | med | M | behavior-adding — treat as feature decision | manual |
| 4 | `src/index.ts:172` ↔ `src/cli/index.ts:88` isEntrypoint 26-line clone | [Duplicate Code](https://refactoring.guru/smells/duplicate-code) → extract `lib/isEntrypoint.ts` (fixes #2 same step) | low | prevents third-copy divergence recurring | med | S | safe | mechanical |
| 5 | `src/catalog/fetcher.ts:322,874` `new URL(...).pathname` | non-portable path handling → use `fileURLToPath` | low | breaks on Windows / percent-encoded paths | med | S | safe | mechanical |
| 6 | `src/observation/arming.ts:113` `Math.min(...hits.map(() => now.getTime()))` | dead computation → replace with `now.getTime()` | low | removes misleading no-op | med | S | safe | mechanical |
| 7 | 4 files still duplicating CatalogLoader/CatalogResolver + inline Promise-normalization (startQuiz, recordObservation, status, guidance) | [Duplicate Code](https://refactoring.guru/smells/duplicate-code) → import from `catalogTypes.ts` / use `loadCatalog()` | low | completes a half-done migration (2 of 6 files already migrated) | med | S | safe | mechanical |
| 8 | `src/tools/status.ts:72` ≡ `src/tools/guidance.ts:58` resolveTool; `findTopicByKey` ×3 | Duplicate Code → extract to `us2/standing.ts` | low | single definition for tool-resolution logic | low | S | safe | mechanical |
| 9 | `src/tools/placeholders.ts` | misleading name for the real TOOL_REGISTRY → rename `registry.ts` | low | reader comprehension | low | S | safe (2 import sites) | mechanical |
| 10 | `src/catalog/fetcher.ts:81` unused `createReadStream` import | [Dead Code](https://refactoring.guru/smells/dead-code) → remove | low | hygiene | low | S | safe | mechanical |
| 11 | `src/tools/startQuiz.ts:90` `nextBoundaryFor` exported, used only in-file | Dead Code → un-export | low | hygiene | low | S | safe | mechanical |
| 12 | `src/observation/source.ts` unused file (architecture seam) | Dead Code → keep + knip-ignore, or delete deliberately | low | knip noise vs. FR-016 future seam | low | S | safe | assisted |
| 13 | package.json has no `exports` field | implicit public API — every dist/ path deep-importable | low | makes dead-export audits unreliable; blocks safe renames | med | M | breaking for deep-importers if added | manual |

## Detail — top findings

### 1. SERVER_VERSION drift — `src/index.ts:51`
- **Smell:** hardcoded `"0.1.0"` while `package.json` is `0.12.0`; advertised in the MCP handshake to every host. `test/integration/version-sync.test.ts` checks plugin.json/apm.yml/marketplace.json but not this constant.
- **Recommended:** read from package.json at build time (or add `SERVER_VERSION` to the version-sync test so release-please bumps can't miss it).
- **Adversarial note:** confirmed high — "a real bug — the server misidentifies itself."

### 2. Divergent isEntrypoint — `src/cli/getOffer.ts:176`
- **Smell:** the third copy of `isEntrypoint()` lacks the `realpathSync` symlink fallback the other two copies carry; under npx/`node_modules/.bin` launch, `argv[1]` is a symlink and the naive compare fails.
- **Mitigating fact (challenger):** `getOffer` is currently invoked as a subcommand through `cli/index.ts`, so it may not manifest today — but it breaks if ever invoked directly, and it proves the copies diverge.
- **Recommended:** extract one shared, tested `isEntrypoint()` (also resolves the jscpd 26-line clone, finding #4).

### 3. `completedAt` never written — server-wide
- **Smell:** the schema defines it, `applyGradedItem` throws on it, but no production code path sets it. Quizzes stay open forever; the guard is dead code.
- **Recommended:** product decision, not a refactor: either write `completedAt` when the last selected item is graded (the new batch `submit_answers` would be a natural place), or document open-endedness as intended in the spec contract.

## Prevent recurrence

| Smell it prevents | Tool | Rule | Where | One-off churn? |
|-------------------|------|------|-------|----------------|
| duplicate code, complexity creep | eslint + sonarjs | `sonarjs/no-identical-functions`, `sonarjs/cognitive-complexity` | eslint.config.mjs (new) | medium — new lint baseline |
| unused exports/files recurring | knip | knip.json with deliberate `ignore` for schema public API + `source.ts` | repo root | low |
| floating promises, unsafe casts | typescript-eslint | `no-floating-promises`, `no-unnecessary-type-assertion` | eslint.config.mjs | low-medium |

```jsonc
// knip.json — silence deliberate public-API exports so real dead code stays visible
{
  "workspaces": {
    "packages/server": {
      "ignore": ["src/observation/source.ts"],
      "ignoreExportsUsedInFile": true
    }
  }
}
```

Installing eslint was deferred (repo has no config today); adopting it is a deliberate baseline decision, not a quick fix.

## Dropped & downgraded (transparency)

| Finding | Verdict | Reason (refactor-challenger) |
|---------|---------|------------------------------|
| SubmitAnswerToolInputSchema "unused" | DROP | schema/type actively used in-file; only the `export` keyword is excess |
| schema exports (content.ts/tools.ts) "dead" | DROP | published npm package; schemas are the public contract; knip can't see downstream |
| TOCTOU pre-check in submitAnswer | DOWNGRADE→none | locked path fully re-validates; pre-check is benign defense-in-depth |
| renderDashboard 180 lines | DOWNGRADE→none | flat sequential template builder, no branching complexity; extraction adds indirection |
| applyGradedItem 86 lines | DOWNGRADE→none | pure, sequential, interdependent steps; two helpers already extracted |
| sequential topic fetches | DOWNGRADE→low | fail-fast + hash-diff + background execution favor the current design; Promise.all risks hammering one origin |
| 9 silent catches in fetcher.ts | DOWNGRADE→none | FR-027 contract; cache-miss is the normal first-run path, logging it is noise |
| stderr.write in profile/store.ts | DOWNGRADE→none | pino is silent by default; logger.warn would HIDE these always-on user diagnostics |
| `as` casts under noUncheckedIndexedAccess (loader.ts:74, graduation.ts:207) | DOWNGRADE→none | guards are correct; suggested `?? ""`/`?? 0` fallbacks would mask real bugs |
| new RegExp(pattern) ReDoS (semgrep) | DOWNGRADE→none | catalog is trusted (bundled or sha256-verified fetch); fail-closed cache already present |
| cooldownMemo module state | DOWNGRADE→none | idiomatic process-lifetime cache; author-acknowledged tradeoff |
| batch accumulator closure-escape | DOWNGRADE→none | forced by updateProfile API; consistent with persistGrade; documented reset |
| listTopics async-only seam | DOWNGRADE→none | narrower seam is honest, not inconsistent |
| SubmitAnswerResult vs BatchItemResult schema clone | DOWNGRADE→none | coincidental similarity; contracts evolve independently |
| armCache `as string` after guard | DOWNGRADE→none | style nit, sound narrowing |
