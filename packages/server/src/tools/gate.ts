/**
 * @file Gate wrappers for MCP tool handlers (T021).
 *
 * Two gates run in sequence before any gated handler is invoked:
 *
 *   1. **Setup gate** ({@link withSetupGate}, FR-032): profile must have a
 *      `config` block; returns {@link SETUP_REQUIRED_RESULT} otherwise.
 *   2. **Tool gate** ({@link withToolGate}): a supported tool must be resolvable
 *      — either auto-detected from the host's MCP `clientInfo.name` or present in
 *      `config.toolsLearning`. Returns {@link UNSUPPORTED_TOOL_RESULT} when the
 *      host is unrecognised and no configured tool is available, naming the raw
 *      client name and the supported tools. vibe-hero only supports Claude Code,
 *      Codex, Kiro CLI, and Kiro IDE; unknown hosts must fail clearly.
 *
 * The two exempt tools (`get_config` / `save_config`) bypass both gates — they
 * are needed to clear the setup gate and to inspect gate state, and they do not
 * depend on tool detection.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (SETUP_REQUIRED + UNSUPPORTED_TOOL sentinels), spec.md FR-028 / FR-031 / FR-032.
 */

import type { SetupRequired, UnsupportedTool } from "../schemas/tools.js";
import { SetupRequiredSchema, UnsupportedToolSchema } from "../schemas/tools.js";
import { loadProfile } from "../profile/store.js";
import { getDetectedTool, getRawClientName } from "../detection.js";
import type { ToolHandler, ToolResult } from "./types.js";
import type { ToolId } from "../schemas/common.js";

/**
 * Tools that bypass both gates. `get_config` reports gate state and
 * `save_config` writes the `config` that clears the setup gate, so both must
 * run before setup completes. Every other tool is gated.
 */
export const EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "get_config",
  "save_config",
]);

/** Is `toolName` allowed to run while the profile is unconfigured? */
export const isExempt = (toolName: string): boolean => EXEMPT_TOOLS.has(toolName);

/**
 * The canonical SETUP_REQUIRED sentinel returned by gated tools when
 * `profile.config` is absent. Validated at module load so shape cannot drift.
 */
export const SETUP_REQUIRED_RESULT: SetupRequired = SetupRequiredSchema.parse({
  status: "SETUP_REQUIRED",
  message: "Run vibe-hero setup first.",
  setupSkill: "vibe-hero-setup",
});

/**
 * Human-readable labels for the supported tools, used in the UNSUPPORTED_TOOL
 * error message surfaced to the user.
 */
const SUPPORTED_TOOL_LABELS: readonly string[] = [
  "Claude Code",
  "Codex",
  "Kiro CLI",
  "Kiro IDE",
];

/**
 * Supported ToolIds (machine form), included in the UNSUPPORTED_TOOL sentinel
 * so callers can programmatically check the list.
 */
export const SUPPORTED_TOOL_IDS: readonly ToolId[] = [
  "claude-code",
  "codex",
  "kiro-cli",
  "kiro-ide",
];

/**
 * Build the UNSUPPORTED_TOOL sentinel for a given raw client name. Constructed
 * fresh each call so `detectedName` reflects the actual handshake value.
 *
 * @param rawName - Raw `clientInfo.name` from the MCP handshake, or empty string
 *   when the client provided no name.
 */
export const makeUnsupportedToolResult = (rawName: string): UnsupportedTool =>
  UnsupportedToolSchema.parse({
    status: "UNSUPPORTED_TOOL",
    detectedName: rawName,
    message:
      `vibe-hero does not support "${rawName || "(unknown)"}" yet. ` +
      `Supported: ${SUPPORTED_TOOL_LABELS.join(", ")}.`,
    supported: SUPPORTED_TOOL_IDS,
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
 * @returns A handler that enforces the setup gate before delegating.
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

/**
 * Wrap a tool handler with the unsupported-host tool gate.
 *
 * After the setup gate passes (config is present), this gate checks whether a
 * supported tool can be resolved:
 *   1. auto-detected from the host's MCP `clientInfo.name` ({@link getDetectedTool}), or
 *   2. explicitly configured in `profile.config.toolsLearning[0]`.
 *
 * If neither yields a supported tool, the handler is blocked and
 * {@link makeUnsupportedToolResult} is returned with the raw client name so the
 * user sees a clear error message naming their host.
 *
 * Exempt tools bypass this gate (same exemption as the setup gate).
 *
 * @param toolName - The tool's registered name (used for the exempt check).
 * @param handler - The wrapped tool handler (already passed through setup gate).
 * @param dirOverride - Profile-directory override (test seam).
 * @returns A handler that enforces the tool gate before delegating.
 */
export const withToolGate = <Args>(
  toolName: string,
  handler: ToolHandler<Args>,
  dirOverride?: string,
): ToolHandler<Args> => {
  return async (args: Args): Promise<ToolResult> => {
    if (!isExempt(toolName)) {
      const detected = getDetectedTool();
      if (detected === undefined) {
        // No auto-detected tool. Check if a configured toolsLearning provides one.
        const profile = await loadProfile(dirOverride);
        const configured = profile.config?.toolsLearning?.[0];
        if (configured === undefined) {
          // Neither detection nor config can supply a tool — reject with a clear error.
          const rawName = getRawClientName() ?? "";
          return makeUnsupportedToolResult(rawName);
        }
      }
    }
    return handler(args);
  };
};

/**
 * Compose both gates around a handler: setup gate first, then tool gate.
 *
 * This is the production wrapper applied to every non-exempt tool in
 * `index.ts`. Exempt tools bypass both.
 */
export const withGates = <Args>(
  toolName: string,
  handler: ToolHandler<Args>,
  dirOverride?: string,
): ToolHandler<Args> =>
  withSetupGate(
    toolName,
    withToolGate(toolName, handler, dirOverride),
    dirOverride,
  );
