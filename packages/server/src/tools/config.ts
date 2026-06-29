/**
 * @file Real `save_config` / `get_config` tool modules (T022, US-0).
 *
 * These two tools own the first-run setup gate's lifecycle: `save_config` writes
 * the `config` block that clears the gate (FR-031/032) and `get_config` reports
 * gate state. Both are exempt from {@link withSetupGate} (see
 * {@link EXEMPT_TOOLS}) — gating them would deadlock setup.
 *
 * Clock note: the engine stays pure, but these tools live in the IO/tool layer,
 * so they MAY read the wall clock to stamp `createdAt`/`updatedAt`
 * (`new Date().toISOString()`). The store's atomic read-modify-write
 * ({@link updateProfile}) is reused so a re-config never races a concurrent
 * writer, and only the `config` field is replaced — abilities, graduations,
 * review schedule, quiz history, and offer state are preserved (FR-033).
 *
 * Each tool is exposed as a factory closing over an optional `dirOverride`
 * (the store's test seam): the registry uses the default instances (env /
 * `~/.vibe-hero`), and tests build dir-scoped instances against a temp home.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`save_config` / `get_config`), spec.md FR-031 / FR-032 / FR-033.
 */

import { loadProfile, updateProfile } from "../profile/store.js";
import { ConfigSchema, type Config, type Profile } from "../schemas/profile.js";
import {
  GetConfigInputSchema,
  SaveConfigInputSchema,
  type GetConfigResult,
  type SaveConfigInput,
  type SaveConfigResult,
} from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";

/**
 * Normalize validated `save_config` input into a persisted {@link Config},
 * preserving `createdAt` from any existing config and stamping `updatedAt`
 * (and a first-write `createdAt`) to `now`.
 *
 * `quizLength` is optional on input; {@link ConfigSchema} supplies its default
 * (4) when absent. Parsing through `ConfigSchema` guarantees the result matches
 * the persisted contract before it ever reaches the store.
 *
 * @param input - Validated `save_config` input.
 * @param existing - The current config, if the profile is already configured.
 * @param now - ISO-8601 timestamp for `updatedAt` (and `createdAt` on first save).
 * @returns A schema-valid {@link Config} ready to persist.
 */
const normalizeConfig = (
  input: SaveConfigInput,
  existing: Config | undefined,
  now: string,
): Config =>
  ConfigSchema.parse({
    toolsLearning: input.toolsLearning,
    offerCadence: input.offerCadence,
    proactiveOffers: input.proactiveOffers,
    // Omit when absent so ConfigSchema applies its default (4); otherwise honor it.
    ...(input.quizLength !== undefined ? { quizLength: input.quizLength } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

/**
 * Build the `save_config` tool module (US-0, FR-031/033).
 *
 * Validates input, then atomically replaces only the profile's `config` block
 * via {@link updateProfile}. Because every other field is spread through
 * untouched, re-running setup updates preferences without losing learning
 * progress (FR-033). Returns `{ ok: true, config }` with the persisted config.
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @returns The erased registry entry for `save_config`.
 */
export const makeSaveConfigTool = (dirOverride?: string): AnyToolModule =>
  defineTool({
    name: "save_config",
    description:
      "Persist setup configuration and clear the setup gate. Re-callable to update preferences.",
    inputSchema: SaveConfigInputSchema,
    handler: async (input): Promise<SaveConfigResult> => {
      const now = new Date().toISOString();
      const next: Profile = await updateProfile(
        (current) => ({
          ...current,
          config: normalizeConfig(input, current.config, now),
        }),
        dirOverride,
      );
      // `config` is always present here (we just wrote it); assert for the type.
      const config = next.config;
      if (config === undefined) {
        throw new Error("save_config: profile.config missing after write");
      }
      return { ok: true, config };
    },
  });

/**
 * Build the `get_config` tool module (US-0).
 *
 * Reads the profile (never throws — a missing/corrupt profile degrades to an
 * unconfigured one) and reports whether `config` is present, echoing it when so.
 * Skills/hooks use this to know the gate state without triggering it.
 *
 * @param dirOverride - Profile-directory override (test seam); see `profileDir`.
 * @returns The erased registry entry for `get_config`.
 */
export const makeGetConfigTool = (dirOverride?: string): AnyToolModule =>
  defineTool({
    name: "get_config",
    description:
      "Read the current configuration (or report its absence / gate state).",
    inputSchema: GetConfigInputSchema,
    handler: async (): Promise<GetConfigResult> => {
      const profile = await loadProfile(dirOverride);
      return profile.config === undefined
        ? { configured: false }
        : { configured: true, config: profile.config };
    },
  });

/** Default `save_config` module (env / `~/.vibe-hero`), used by the registry. */
export const saveConfigTool: AnyToolModule = makeSaveConfigTool();

/** Default `get_config` module (env / `~/.vibe-hero`), used by the registry. */
export const getConfigTool: AnyToolModule = makeGetConfigTool();
