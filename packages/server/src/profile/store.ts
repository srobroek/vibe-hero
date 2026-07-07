/**
 * @file Learner-profile persistence (T013).
 *
 * The profile is a single Zod-validated JSON document at
 * `${VIBE_HERO_HOME}/profile.json` (default `~/.vibe-hero/`). It may be written
 * by multiple concurrent host sessions, so every mutation is **atomic and
 * serialized**: writes go through a temp file + `fs.rename` under an advisory
 * lock acquired via `proper-lockfile` (FR-023a). Reads never throw — a missing,
 * unreadable, or corrupt file degrades to a fresh empty profile (FR-023).
 *
 * The fs/lock boundary is intentionally thin; everything else is pure data
 * shuffling around {@link ProfileSchema}.
 *
 * Source of truth: specs/001-vibe-hero-mvp/data-model.md (§ Storage notes),
 * spec.md FR-022 / FR-023 / FR-023a.
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as lockfile from "proper-lockfile";

import { ProfileSchema, emptyProfile, type Profile } from "../schemas/profile.js";
import { migrateProfile } from "./migrate.js";
import { timed } from "../perf.js";

/** Basename of the profile document within the profile directory. */
const PROFILE_FILENAME = "profile.json";

/** Default profile home when `VIBE_HERO_HOME` is unset (`~/.vibe-hero`). */
const DEFAULT_DIRNAME = ".vibe-hero";

/**
 * Lock-acquisition tuning. `proper-lockfile` treats the lock as *stale* after
 * `stale` ms (so a crashed writer can never wedge the profile forever), and a
 * contending writer retries with exponential backoff up to `retries.retries`
 * times. The window is generous enough to serialize bursts of concurrent
 * `updateProfile` calls (FR-023a / edge case E1) without spuriously failing.
 */
const LOCK_OPTIONS: lockfile.LockOptions = {
  stale: 15_000,
  // Resolve against the literal path we pass; the file is guaranteed to exist
  // before we lock (see `acquireLock`), but skipping realpath avoids symlink
  // surprises (e.g. macOS `/var` → `/private/var` under os.tmpdir()).
  realpath: false,
  retries: {
    retries: 50,
    factor: 1.5,
    minTimeout: 10,
    maxTimeout: 200,
    randomize: true,
  },
};

/**
 * Resolve the directory that holds the profile document.
 *
 * @param dirOverride - Explicit directory (test seam). When omitted, falls back
 *   to `VIBE_HERO_HOME`, then to `~/.vibe-hero`.
 * @returns Absolute path to the profile directory.
 */
export const profileDir = (dirOverride?: string): string => {
  if (dirOverride !== undefined && dirOverride !== "") return path.resolve(dirOverride);
  const fromEnv = process.env["VIBE_HERO_HOME"];
  if (fromEnv !== undefined && fromEnv !== "") return path.resolve(fromEnv);
  return path.join(homedir(), DEFAULT_DIRNAME);
};

/**
 * Resolve the absolute path to the profile JSON document.
 *
 * @param dirOverride - Explicit directory (test seam); see {@link profileDir}.
 * @returns Absolute path to `profile.json`.
 */
export const profilePath = (dirOverride?: string): string =>
  path.join(profileDir(dirOverride), PROFILE_FILENAME);

/**
 * Read and validate the profile.
 *
 * Never throws: a missing, unreadable, or schema-invalid file degrades to a
 * fresh {@link emptyProfile} so the server can always operate (FR-023). Version
 * handling is centralized in {@link migrateProfile} (T056): a same-version doc
 * passes through, an older known version is migrated up, and a *newer* version
 * (written by a future build) degrades to an empty profile for this run WITHOUT
 * overwriting the file — `loadProfile` never writes, so a forward-compatible
 * profile we don't understand is preserved on disk. A corrupt file is logged to
 * stderr (without printing its contents — it may hold profile data) and left on
 * disk untouched; the next successful {@link saveProfile} / {@link updateProfile}
 * overwrites it.
 *
 * @param dirOverride - Explicit directory (test seam); see {@link profileDir}.
 * @returns The validated profile, or an empty profile on any failure.
 */
export const loadProfile = async (dirOverride?: string): Promise<Profile> =>
  timed("profile:load", () => loadProfileUntimed(dirOverride));

const loadProfileUntimed = async (dirOverride?: string): Promise<Profile> => {
  const file = profilePath(dirOverride);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    // ENOENT is the normal first-run path; anything else (perms, etc.) is also
    // non-fatal — we still hand back a usable empty profile.
    if (!isNotFound(err)) {
      process.stderr.write(
        `vibe-hero: could not read profile at ${file}; starting from an empty profile.\n`,
      );
    }
    return emptyProfile();
  }

  const json = parseJson(raw);
  if (json === undefined) {
    process.stderr.write(
      `vibe-hero: profile at ${file} is corrupt or invalid; starting from an empty profile (file left untouched).\n`,
    );
    return emptyProfile();
  }

  // Centralized version policy (T056). migrateProfile owns same/older/newer
  // routing and emits its own newer-version warning. We only add a stderr note
  // for the corrupt-at-version case to preserve the prior diagnostic.
  const result = migrateProfile(json);
  if (result.reset && !result.preserved) {
    process.stderr.write(
      `vibe-hero: profile at ${file} is corrupt or invalid; starting from an empty profile (file left untouched).\n`,
    );
  }
  return result.profile;
};

/**
 * Persist a profile atomically and serialized (FR-023a).
 *
 * Ensures the directory exists, acquires the advisory lock, writes to a unique
 * temp file in the same directory, then `fs.rename`s it over `profile.json`
 * (atomic on POSIX since both paths share a filesystem). `updatedAt` is bumped
 * to now. The lock is always released, even on failure.
 *
 * Prefer {@link updateProfile} for read-modify-write mutations — calling
 * {@link loadProfile} then `saveProfile` is racy (the load happens outside the
 * lock and a concurrent writer can interleave).
 *
 * @param profile - The profile to persist.
 * @param dirOverride - Explicit directory (test seam); see {@link profileDir}.
 */
export const saveProfile = async (
  profile: Profile,
  dirOverride?: string,
): Promise<void> => {
  const dir = profileDir(dirOverride);
  const file = path.join(dir, PROFILE_FILENAME);
  const release = await acquireLock(dir, file);
  try {
    await writeAtomic(dir, file, profile);
  } finally {
    await release();
  }
};

/**
 * Read-modify-write the profile under the lock so concurrent updaters serialize
 * and no update is lost (FR-023a / edge case E1). This is the primary mutation
 * API.
 *
 * The sequence is: acquire lock → read the *current* on-disk profile (or empty
 * if missing/corrupt) → apply `fn` → atomic write → release. Because both the
 * read and the write happen inside the same lock, two concurrent callers run
 * strictly one-after-another and each sees the other's committed result.
 *
 * @param fn - Pure-ish transform from the current profile to the next one. May
 *   be async. It should return a new profile object rather than mutating the
 *   argument, though either works since the result is what gets written.
 * @param dirOverride - Explicit directory (test seam); see {@link profileDir}.
 * @returns The profile that was written (with `updatedAt` bumped).
 */
export const updateProfile = async (
  fn: (current: Profile) => Profile | Promise<Profile>,
  dirOverride?: string,
): Promise<Profile> => {
  const dir = profileDir(dirOverride);
  const file = path.join(dir, PROFILE_FILENAME);
  const release = await timed("profile:lock-wait", () => acquireLock(dir, file));
  try {
    const current = await timed("profile:read", () => readUnderLock(file));
    const next = await fn(current);
    return await timed("profile:write", () => writeAtomic(dir, file, next));
  } finally {
    await release();
  }
};

// --- internals (thin fs/lock boundary) ------------------------------------

/**
 * Acquire the advisory lock for the profile file.
 *
 * `proper-lockfile` locks by creating `${file}.lock`, but it requires the
 * target path to exist first, so we `mkdir -p` the directory and ensure
 * `profile.json` is present (an empty placeholder is fine — it will be
 * overwritten by the atomic rename, and `readUnderLock` tolerates empty/invalid
 * content).
 */
const acquireLock = async (dir: string, file: string): Promise<() => Promise<void>> => {
  await fs.mkdir(dir, { recursive: true });
  await ensureExists(file);
  return lockfile.lock(file, LOCK_OPTIONS);
};

/**
 * Read the on-disk profile while holding the lock, degrading to an empty
 * profile if the file is missing, unreadable, or invalid. Unlike
 * {@link loadProfile} this stays quiet (no stderr) — it runs inside the
 * write path where a fresh-start is expected on first write. Version handling
 * goes through the same {@link migrateProfile} policy so an older profile is
 * migrated forward before a read-modify-write, and a newer one degrades to
 * empty (the subsequent write is the caller's explicit choice).
 */
const readUnderLock = async (file: string): Promise<Profile> => {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return emptyProfile();
  }
  const json = parseJson(raw);
  if (json === undefined) return emptyProfile();
  return migrateProfile(json).profile;
};

/**
 * Write `profile` (with a refreshed `updatedAt`) atomically: serialize → write
 * a unique temp file in the same directory → `fs.rename` over the target. The
 * rename is atomic on the same filesystem, so a concurrent reader sees either
 * the old or the new file, never a partial one.
 *
 * @returns The exact profile object that was persisted.
 */
const writeAtomic = async (dir: string, file: string, profile: Profile): Promise<Profile> => {
  const toWrite: Profile = { ...profile, updatedAt: new Date().toISOString() };
  // Validate before persisting so we never write a malformed document.
  const validated = ProfileSchema.parse(toWrite);
  const json = `${JSON.stringify(validated, null, 2)}\n`;

  const tmp = path.join(dir, `.${PROFILE_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, json, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename never happened.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return validated;
};

/** Create an empty file if it does not already exist (no-op otherwise). */
const ensureExists = async (file: string): Promise<void> => {
  // wx = create + fail if exists; swallow EEXIST so this is idempotent.
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (err) {
    if (isExists(err)) return;
    throw err;
  } finally {
    await handle?.close();
  }
};

/**
 * Parse raw profile text into a JSON value, or `undefined` if it is not valid
 * JSON. Schema/version validation is deferred to {@link migrateProfile} so the
 * version policy (same/older/newer) is centralized in one place (T056).
 */
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** Type-narrowing helper: is this a Node `ENOENT` error? */
const isNotFound = (err: unknown): boolean => hasCode(err, "ENOENT");

/** Type-narrowing helper: is this a Node `EEXIST` error? */
const isExists = (err: unknown): boolean => hasCode(err, "EEXIST");

const hasCode = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
