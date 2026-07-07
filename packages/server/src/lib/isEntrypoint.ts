/**
 * @file Shared process-entrypoint guard.
 *
 * One definition for the "am I the process entrypoint?" check that previously
 * lived as three copies (src/index.ts, src/cli/index.ts, src/cli/getOffer.ts)
 * — one of which had drifted and lacked the symlink fallback, silently failing
 * under npx launches (sniff finding, 2026-07-07).
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

/**
 * Is the module at `moduleUrl` (pass `import.meta.url`) the process
 * entrypoint (`node <script>`), as opposed to being imported by tests?
 *
 * Direct comparison handles `node dist/index.js`. But npx (and any
 * node_modules/.bin install) launches bins through a SYMLINK, so `argv[1]` is
 * the symlink path while `import.meta.url` is the realpath — a naive string
 * compare fails and the entrypoint silently does nothing. Both sides are
 * resolved through realpath so the guard holds under the standard npx launch.
 */
export const isEntrypoint = (moduleUrl: string): boolean => {
  const entry = argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(moduleUrl);
  if (self === entry) return true;
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    return false;
  }
};
