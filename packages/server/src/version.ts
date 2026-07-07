/**
 * @file Single source of the server version at runtime.
 *
 * release-please rewrites the literal below on every release (see the
 * `x-release-please-version` marker and the `extra-files` entry in
 * /release-please-config.json), keeping the MCP-handshake version in lockstep
 * with package.json without a runtime package.json read. Guarded by
 * test/integration/version-sync.test.ts.
 */

/** Server version advertised to MCP hosts. */
export const SERVER_VERSION = "0.16.0"; // x-release-please-version
