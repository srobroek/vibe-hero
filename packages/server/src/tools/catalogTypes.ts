/**
 * @file Shared catalog loader/resolver types for the tool layer.
 *
 * Previously duplicated verbatim in startQuiz.ts, recordObservation.ts, and
 * offers.ts (code-review finding: contract changes had to be applied three
 * times). Single source of truth now; the `instanceof Promise` normalization
 * helper lives here too.
 */

import type { CatalogLoadResult } from "../catalog/loader.js";
import type { ResolvedCatalog } from "../catalog/resolve.js";

/**
 * Sync catalog loader (test seam): returns topics synchronously from a fixture
 * dir. Tests inject this form; production uses {@link CatalogResolver}.
 * The optional arg is unused by sync loaders but makes the type compatible
 * with the {@link CatalogResolver} union so both can be called as
 * `fn(dirOverride)`.
 */
export type CatalogLoader = (dirOverride?: string) => CatalogLoadResult;

/**
 * Async catalog resolver (production path): resolves via fresh-fetch → cache →
 * bundled. Mirrors `resolveCatalog`'s signature.
 */
export type CatalogResolver = (dirOverride?: string) => Promise<ResolvedCatalog>;

/**
 * Normalize a sync loader (tests) or async resolver (production) call result
 * to a promise of its topics-bearing payload.
 */
export const loadCatalog = async (
  loaderOrResolver: CatalogLoader | CatalogResolver,
  dirOverride?: string,
): Promise<CatalogLoadResult | ResolvedCatalog> => {
  const raw = loaderOrResolver(dirOverride);
  return raw instanceof Promise ? await raw : raw;
};
