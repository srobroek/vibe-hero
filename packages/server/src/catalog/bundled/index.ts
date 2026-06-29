/**
 * @file Bundled catalog snapshot loader (T016).
 *
 * Loads the YAML topic files shipped inside this directory so the server has a
 * baseline catalog with no network and on first run (FR-025). For now the
 * bundle is a single tiny placeholder topic (`general/_placeholder.yaml`); the
 * real curriculum lands in later tasks (T040–T042, T058).
 *
 * Path resolution: the bundled directory is located relative to THIS module via
 * `import.meta.url`, so it works both when running from source (dev / vitest,
 * where this file is `src/catalog/bundled/index.ts` next to the YAML) and from
 * the built output (`dist/catalog/bundled/index.js`).
 *
 * BUILD NOTE / TODO (T056 packaging): `tsc` compiles `.ts` only and does NOT
 * copy `.yaml` assets into `dist/`. The build pipeline MUST copy
 * `src/catalog/bundled/**\/*.yaml` → `dist/catalog/bundled/**` (e.g. a postbuild
 * `cp -R` / copyfiles / a Vite static-assets step) or the built server will find
 * an empty bundled directory at runtime. Until that copy step exists, the built
 * artifact resolves the same relative path under `dist` and would report zero
 * topics — tests run from `src` and are unaffected.
 *
 * Source of truth: spec FR-025, research.md OD-004.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadCatalogFromDir,
  type CatalogLoadResult,
} from "../loader.js";

/** Absolute path to the directory holding the bundled YAML topic files. */
export const BUNDLED_CATALOG_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load the bundled catalog snapshot shipped with the package.
 *
 * Resolves the bundled directory relative to this module (works from both `src`
 * and `dist`) and delegates to {@link loadCatalogFromDir}, so the same
 * per-file validation and error-collection semantics apply: valid topics are
 * returned and any malformed bundled file is reported rather than aborting the
 * load (FR-004). A healthy bundle returns `errors: []`.
 *
 * @returns The bundled topics plus any per-file load errors.
 */
export const loadBundledCatalog = (): CatalogLoadResult =>
  loadCatalogFromDir(join(BUNDLED_CATALOG_DIR));
