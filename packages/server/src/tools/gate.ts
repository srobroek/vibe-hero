/**
 * @file Setup-gate wrapper for MCP tool handlers (T021).
 *
 * Every vibe-hero tool except `get_config` / `save_config` is gated behind
 * first-run setup: until the learner profile has a `config` block, a gated tool
 * returns the {@link SETUP_REQUIRED_RESULT} sentinel instead of running its
 * handler (FR-032). This scopes the gate to vibe-hero's own actions only — it
 * never blocks the host agent's normal work (FR-028).
 *
 * The two exempt tools are exactly the ones the setup skill needs to *clear* the
 * gate (`save_config`) and to *inspect* gate state (`get_config`); gating those
 * would deadlock setup.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md (SETUP_REQUIRED
 * sentinel), spec.md FR-028 / FR-032.
 */

import type { SetupRequired } from "../schemas/tools.js";
import { SetupRequiredSchema } from "../schemas/tools.js";
import { loadProfile } from "../profile/store.js";
import type { ToolHandler, ToolResult } from "./types.js";

/**
 * Tools that bypass the setup gate. `get_config` reports gate state and
 * `save_config` writes the `config` that clears the gate, so both must run
 * before setup completes. Every other tool is gated.
 */
export const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "get_config",
  "save_config",
]);

/** Is `toolName` allowed to run while the profile is unconfigured? */
export const isExempt = (toolName: string): boolean => EXEMPT_TOOLS.has(toolName);

/**
 * The canonical SETUP_REQUIRED sentinel returned by gated tools when
 * `profile.config` is absent. Validated against {@link SetupRequiredSchema} at
 * module load so the shape can never drift from the contract.
 */
export const SETUP_REQUIRED_RESULT: SetupRequired = SetupRequiredSchema.parse({
  status: "SETUP_REQUIRED",
  message: "Run vibe-hero setup first.",
  setupSkill: "vibe-hero-setup",
});

/**
 * Wrap a tool handler with the first-run setup gate (FR-032).
 *
 * Before invoking `handler`, the wrapper loads the profile. If the tool is not
 * exempt ({@link EXEMPT_TOOLS}) and `profile.config` is absent, it short-circuits
 * with {@link SETUP_REQUIRED_RESULT} and the handler never runs. Otherwise the
 * handler runs normally.
 *
 * `loadProfile` never throws (a missing/corrupt profile degrades to an empty,
 * unconfigured profile), so an unconfigured first run reliably gates.
 *
 * @param toolName - The tool's registered name (used for the exempt check).
 * @param handler - The wrapped tool handler.
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @returns A handler that enforces the gate before delegating.
 */
export const withSetupGate = <Args>(
  toolName: string,
  handler: ToolHandler<Args>,
  dirOverride?: string,
): ToolHandler<Args> => {
  return async (args: Args): Promise<ToolResult> => {
    if (!isExempt(toolName)) {
      const profile = await loadProfile(dirOverride);
      if (profile.config === undefined) {
        return SETUP_REQUIRED_RESULT;
      }
    }
    return handler(args);
  };
};
