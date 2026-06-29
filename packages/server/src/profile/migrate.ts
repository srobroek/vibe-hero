/**
 * @file Profile schema-version / migration policy (T056, analyze finding E6).
 *
 * Centralizes how a persisted {@link Profile} of *some* on-disk schema version is
 * brought up to the version this build understands ({@link CURRENT_PROFILE_SCHEMA_VERSION}).
 * Before this module the only version handling was an implicit Zod `safeParse`
 * inside the store; there was no explicit forward/back-compat policy, so a
 * profile written by a *newer* build would simply fail validation and be treated
 * as "corrupt" — silently discarding data we don't understand (E6).
 *
 * The policy, expressed as one function ({@link migrateProfile}), is:
 *
 *   1. **Same version, valid** → pass through unchanged (`migrated: false`).
 *   2. **Older known version** → run the ordered {@link MIGRATIONS} steps from the
 *      on-disk version up to current, then validate (`migrated: true`). For v1
 *      there is exactly one version so the registry is empty (a documented stub);
 *      the SHAPE exists so future `v1 → v2` etc. steps slot in without touching
 *      callers. Additive fields already default via Zod (e.g. `dwell`,
 *      `candidateKeys`), so a forward-compatible additive change needs no step at
 *      all — the registry is for *structural* migrations that Zod defaults can't
 *      express.
 *   3. **Newer (future) version** → do NOT crash and do NOT discard (FR-023
 *      "tolerate gracefully"). We can't safely read a shape this build predates,
 *      so we fall back to a fresh empty profile for *this* run and signal
 *      `reset: true` with `preserved: true`. The store leaves the on-disk file
 *      untouched — overwriting a newer profile we don't understand would destroy
 *      a forward-compatible user's data, so we explicitly refuse to.
 *   4. **Corrupt / invalid** (bad shape at the resolved version) → fresh empty
 *      profile (`reset: true`), consistent with the store's prior behavior of
 *      degrading an unreadable file to {@link emptyProfile}.
 *
 * `migrateProfile` is pure (no IO): the store decides what to persist based on
 * the returned flags. This keeps the version policy unit-testable in isolation.
 *
 * Source of truth: specs/001-vibe-hero-mvp/spec.md (FR-023), data-model.md
 * (§ Profile `schemaVersion` "migration guard"), tasks.md T056.
 */

import {
  ProfileSchema,
  emptyProfile,
  PROFILE_SCHEMA_VERSION,
  type Profile,
} from "../schemas/profile.js";

/**
 * The profile schema version this build understands. Centralized here (re-exported
 * from the single source, {@link PROFILE_SCHEMA_VERSION}) so version policy lives
 * in one place; the store and tests import it from this module.
 */
export const CURRENT_PROFILE_SCHEMA_VERSION = PROFILE_SCHEMA_VERSION;

/**
 * A single forward migration step: transforms a parsed profile document from
 * `from` to `from + 1`. Steps operate on `unknown` (the raw parsed JSON, not a
 * validated {@link Profile}) because an older document is, by definition, NOT yet
 * shaped like the *current* schema — the step's job is to reshape it. The final
 * shape is validated once, after all steps run.
 */
export interface MigrationStep {
  /** The schema version this step upgrades FROM (it produces `from + 1`). */
  readonly from: number;
  /** Pure transform of the raw document toward the next version. */
  readonly up: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Ordered registry of forward migration steps, keyed by their `from` version.
 *
 * **v1 is the only version**, so this is intentionally empty — a documented stub.
 * The registry SHAPE exists so a future schema bump is purely additive here:
 * add a `{ from: 1, up }` step that reshapes a v1 document into v2 and bump
 * {@link CURRENT_PROFILE_SCHEMA_VERSION} (via the source `PROFILE_SCHEMA_VERSION`).
 * {@link migrateProfile} will then automatically chain `from` → current.
 *
 * Note: purely *additive* fields that a new field's Zod `.default(...)` can fill
 * (the pattern already used for `dwell` and `candidateKeys`) need NO step — an old
 * document validates forward for free. Steps are reserved for structural changes
 * (renames, splits, type changes) Zod defaults cannot express.
 */
export const MIGRATIONS: readonly MigrationStep[] = [];

/** Result of {@link migrateProfile}. Discriminated on `reset`. */
export type MigrateResult =
  | {
      /** No reset: the document was usable at (or migrated up to) current. */
      readonly reset: false;
      /** The validated, current-version profile. */
      readonly profile: Profile;
      /** `true` iff at least one migration step ran (older → current). */
      readonly migrated: boolean;
    }
  | {
      /** Reset: the document was unreadable at the current version. */
      readonly reset: true;
      /** A fresh empty profile to use for this run. */
      readonly profile: Profile;
      /**
       * `true` when the reset is because the document is a NEWER version than
       * this build understands — the on-disk file MUST be preserved (not
       * overwritten). `false` for a corrupt/invalid document, which the store
       * may overwrite on its next write as before.
       */
      readonly preserved: boolean;
    };

/**
 * Read the declared `schemaVersion` from a parsed-JSON document, or `undefined`
 * if the value is missing or not a positive integer. We read it leniently (not
 * via the full {@link ProfileSchema}) precisely so we can route a *newer* document
 * to the tolerate path rather than failing it as "corrupt".
 */
const readDeclaredVersion = (raw: unknown): number | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
};

/**
 * Apply migration steps in order from `fromVersion` up to `currentVersion`,
 * picking each step from `migrations`. Returns the reshaped raw document and
 * whether any step actually ran. Throws if a required step is missing (a
 * programming error — a known-older version with a gap in the registry).
 */
const applyMigrations = (
  raw: Record<string, unknown>,
  fromVersion: number,
  currentVersion: number,
  migrations: readonly MigrationStep[],
): { readonly doc: Record<string, unknown>; readonly migrated: boolean } => {
  let doc = raw;
  let migrated = false;
  for (let v = fromVersion; v < currentVersion; v++) {
    const step = migrations.find((s) => s.from === v);
    if (step === undefined) {
      throw new Error(
        `no migration step registered for profile schema v${v} → v${v + 1}`,
      );
    }
    doc = step.up(doc);
    migrated = true;
  }
  // Stamp the version the document now conforms to so the post-migration
  // validation sees the current version regardless of what each step set.
  return { doc: { ...doc, schemaVersion: currentVersion }, migrated };
};

/**
 * Dependency-injection seam for {@link migrateProfile}. Both fields default to
 * the shipped values; they exist ONLY so the older→migrated path is genuinely
 * testable while v1 is the only real version (and so future contributors can
 * unit-test a `v2`/`v3` step in isolation before wiring it in). Production
 * callers pass nothing.
 */
export interface MigrateOptions {
  /** Override the schema version this run targets (defaults to current). */
  readonly currentVersion?: number;
  /** Override the migration registry (defaults to {@link MIGRATIONS}). */
  readonly migrations?: readonly MigrationStep[];
}

/**
 * Route a parsed-JSON profile document of unknown schema version through the
 * forward/back-compat policy documented at the top of this file.
 *
 * Pure: performs no IO and never throws for *data* reasons (only the internal
 * programming-error guard in {@link applyMigrations} can throw, and only if the
 * registry is left inconsistent with the current version). The store interprets
 * the result's flags to decide whether to preserve or overwrite the file.
 *
 * @param raw - The already-parsed JSON of the on-disk profile (not the raw text).
 * @param options - Test/forward-dev seam; production callers omit it.
 * @returns A {@link MigrateResult}: pass-through, migrated, or reset (corrupt vs.
 *   newer-preserved).
 */
export const migrateProfile = (
  raw: unknown,
  options: MigrateOptions = {},
): MigrateResult => {
  const currentVersion = options.currentVersion ?? CURRENT_PROFILE_SCHEMA_VERSION;
  const migrations = options.migrations ?? MIGRATIONS;
  const declared = readDeclaredVersion(raw);

  // --- newer than we understand → tolerate, preserve on disk (FR-023) -------
  if (declared !== undefined && declared > currentVersion) {
    process.stderr.write(
      `vibe-hero: profile schema v${declared} is newer than this build supports ` +
        `(v${currentVersion}); using a temporary empty profile and ` +
        `leaving the existing file untouched to avoid downgrading it.\n`,
    );
    return { reset: true, profile: emptyProfile(), preserved: true };
  }

  // --- known version (current or older) → migrate then validate -------------
  if (declared !== undefined) {
    let result: { readonly doc: Record<string, unknown>; readonly migrated: boolean };
    try {
      result = applyMigrations(
        raw as Record<string, unknown>,
        declared,
        currentVersion,
        migrations,
      );
    } catch {
      // A registry gap for a known-older version: treat as unreadable rather
      // than crash the server (consistent with the corrupt-file degrade path).
      return { reset: true, profile: emptyProfile(), preserved: false };
    }
    const parsed = ProfileSchema.safeParse(result.doc);
    if (parsed.success) {
      return { reset: false, profile: parsed.data, migrated: result.migrated };
    }
    // Migrated/same-version doc that still doesn't validate → corrupt.
    return { reset: true, profile: emptyProfile(), preserved: false };
  }

  // --- no usable version (missing field / not an object / corrupt) ----------
  // Last-chance validation: a well-formed current-version doc whose schemaVersion
  // somehow read as non-positive would have been caught above; anything here is
  // genuinely unreadable. Try a direct parse so a structurally-valid doc isn't
  // discarded on a version-read technicality, then degrade to empty.
  const parsed = ProfileSchema.safeParse(raw);
  if (parsed.success) {
    return { reset: false, profile: parsed.data, migrated: false };
  }
  return { reset: true, profile: emptyProfile(), preserved: false };
};
