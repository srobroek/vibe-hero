/**
 * @file Real `get_dashboard` tool module (STEP 5 — tasks #18 / #19).
 *
 * Produces a three-part dashboard view of the learner's progress:
 *
 *  - **matrix** — a topic×scope grid.  Rows are catalog topics (general topics
 *    first, then tool-scoped ones sorted by class+id).  Columns are scopes —
 *    `"general"` plus every tool id present in the catalog OR abilities OR
 *    abilitySnapshots.  Scopes are derived dynamically from the live data; to
 *    add a future category, add it to {@link ToolIdSchema} — the dashboard
 *    will pick it up automatically.
 *
 *  - **summary** — aggregate counts (items answered, graduated, due, streak) and
 *    key spotlight topics (strongest, weakest, next suggested).
 *
 *  - **history** — per-scope mean ability over time, one series per scope that
 *    has ≥1 abilitySnapshot entry.  Each point is the mean ability across all
 *    topics in that scope at the snapshot instant.
 *
 * ## Dynamic scope extension point
 * Add a new ToolId to `ToolIdSchema.options` in `schemas/common.ts` and it will
 * appear as a new column automatically — no changes needed here.
 *
 * Gated (FR-032): uses the standard {@link withSetupGate} wrapper.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md
 * (`get_dashboard`), spec.md FR-021 / SC-011.
 */

import { resolveCatalog, type ResolvedCatalog } from "../catalog/resolve.js";
import type { CatalogLoadResult } from "../catalog/loader.js";
import { loadProfile } from "../profile/store.js";
import {
  abilityKey,
  parseAbilityKey,
  ToolIdSchema,
  type AbilityKey,
  type ToolId,
} from "../schemas/common.js";
import type { Topic } from "../schemas/content.js";
import type { AbilitySnapshot, Profile } from "../schemas/profile.js";
import {
  GetDashboardInputSchema,
  type GetDashboardInput,
  type GetDashboardResult,
  type DashboardCell,
  type DashboardRow,
  type DashboardSummary,
  type DashboardHistoryEntry,
} from "../schemas/tools.js";
import { defineTool, type AnyToolModule } from "./types.js";
import { computeStandings, detectLapses, rankByWeakness } from "./us2/standing.js";
import type { TopicStanding } from "./us2/standing.js";
import { ASSESSMENT_CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Catalog loader / resolver seam (mirrors status.ts / offers.ts pattern)
// ---------------------------------------------------------------------------

/** Sync catalog loader (test seam). */
export type CatalogLoader = (dirOverride?: string) => CatalogLoadResult;
/** Async catalog resolver (production path). */
export type CatalogResolver = (dirOverride?: string) => Promise<ResolvedCatalog>;

// ---------------------------------------------------------------------------
// Scope derivation (dynamic — the extension point)
// ---------------------------------------------------------------------------

/**
 * Derive the ordered set of scopes to show as columns.
 *
 * Sources (union, then sort):
 *  1. `ToolIdSchema.options` — all currently declared tool ids (schema-driven).
 *  2. Tool ids mentioned in catalog topics (`topic.class.tool`).
 *  3. Tool ids mentioned in `profile.abilities` keys.
 *  4. Tool ids mentioned in `profile.abilitySnapshots` keys.
 *
 * Result: `["general", ...toolIds]`, sorted `general`-first then
 * lexicographically.  Adding a new ToolId to the schema is the only required
 * change to add a new column; sources 2–4 provide a safety net for live data
 * that predates a schema bump.
 *
 * @returns The ordered scope strings (e.g. `["general", "claude-code", "codex"]`).
 */
export const deriveScopes = (
  topics: readonly Topic[],
  profile: Profile,
): string[] => {
  const toolIds = new Set<string>();

  // 1. Schema-declared tools (the extension point: add to ToolIdSchema.options)
  for (const t of ToolIdSchema.options) {
    toolIds.add(t);
  }

  // 2. Catalog-mentioned tool ids
  for (const topic of topics) {
    if (topic.class.kind === "tool") {
      toolIds.add(topic.class.tool);
    }
  }

  // 3. Ability-key-mentioned tool ids
  for (const key of Object.keys(profile.abilities)) {
    try {
      const parsed = parseAbilityKey(key);
      if (parsed.class.kind === "tool") toolIds.add(parsed.class.tool);
    } catch {
      // ignore malformed keys
    }
  }

  // 4. Snapshot-key-mentioned tool ids
  for (const snap of profile.abilitySnapshots ?? []) {
    try {
      const parsed = parseAbilityKey(snap.key);
      if (parsed.class.kind === "tool") toolIds.add(parsed.class.tool);
    } catch {
      // ignore
    }
  }

  const sortedTools = [...toolIds].sort();
  return ["general", ...sortedTools];
};

// ---------------------------------------------------------------------------
// Matrix computation
// ---------------------------------------------------------------------------

/**
 * Build the markers array for a cell given the graduation status.
 * - `"graduated"` — currentTier > 0 and status === "current"
 * - `"due"` — status === "due_for_review"
 * - `"in_review"` — graduation is present and status is neither current nor due
 *   (e.g. transitional demoted state — modelled as in_review here)
 */
const buildMarkers = (
  tier: number,
  status: DashboardCell["status"],
): Array<"graduated" | "due" | "in_review"> => {
  const markers: Array<"graduated" | "due" | "in_review"> = [];
  if (status === "current" && tier > 0) markers.push("graduated");
  if (status === "due_for_review") markers.push("due");
  // Topics that have a graduation row but are neither current nor due — mark
  // in_review.  In practice this shouldn't arise with v1 graduation logic, but
  // it's a catch-all for any future graduation state.
  if (status !== "current" && status !== "due_for_review" && status !== "not_started" && status !== "not_in_scope") {
    markers.push("in_review");
  }
  return markers;
};

/**
 * Build one cell for topic × scope.  Returns a `not_in_scope` placeholder when
 * the topic doesn't apply to that scope.
 */
const buildCell = (
  standing: TopicStanding | undefined,
  scope: string,
  topic: Topic,
): DashboardCell => {
  // Determine if the topic is in scope for this column.
  const topicScope =
    topic.class.kind === "general" ? "general" : topic.class.tool;
  const inScope = topicScope === scope || topic.class.kind === "general";

  if (!inScope || standing === undefined) {
    return {
      scope,
      tier: 0,
      ability: ASSESSMENT_CONFIG.startingAbility,
      status: "not_in_scope",
      markers: [],
    };
  }

  const { tier, status, ability } = standing.row;
  return {
    scope,
    tier,
    ability,
    status,
    markers: buildMarkers(tier, status),
  };
};

/**
 * Compute the matrix rows from standings, topics, and the scope set.
 */
const buildMatrix = (
  topics: readonly Topic[],
  standingsByKey: Map<AbilityKey, TopicStanding>,
  scopes: readonly string[],
): DashboardRow[] => {
  // Sort topics: general first, then by class+id lexicographically.
  const sorted = [...topics].sort((a, b) => {
    const aClass = a.class.kind === "general" ? "" : a.class.tool;
    const bClass = b.class.kind === "general" ? "" : b.class.tool;
    if (aClass !== bClass) {
      if (a.class.kind === "general") return -1;
      if (b.class.kind === "general") return 1;
      return aClass < bClass ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return sorted.map((topic): DashboardRow => {
    const key = abilityKey(topic.class, topic.id);
    const standing = standingsByKey.get(key);

    const cells = scopes.map((scope) => buildCell(standing, scope, topic));

    return {
      topic: topic.id,
      title: topic.title,
      class: topic.class.kind,
      cells,
    };
  });
};

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

/**
 * Build the summary block from profile + standings.
 */
const buildSummary = (
  profile: Profile,
  allStandings: TopicStanding[],
  tool: ToolId | undefined,
): DashboardSummary => {
  // Items answered = total graded items across all quiz history entries.
  const itemsAnswered = profile.quizHistory.reduce(
    (sum, r) => sum + r.items.length,
    0,
  );

  // Count graduated (currentTier > 0, status === "current") topics.
  const graduated = allStandings.filter(
    (s) => s.row.tier > 0 && s.row.status === "current",
  ).length;

  // Count due for review.
  const dueForReview = allStandings.filter(
    (s) => s.row.status === "due_for_review",
  ).length;

  // Streak: consecutive correct answers across the most recent quiz items,
  // in reverse time order.
  let streak = 0;
  const allItems = profile.quizHistory
    .flatMap((r) => r.items)
    .sort((a, b) => (a.answeredAt > b.answeredAt ? -1 : 1));
  for (const item of allItems) {
    if (item.grade === "correct") streak++;
    else break;
  }

  // Strongest = highest ability among started topics.
  const started = allStandings.filter((s) => s.row.status !== "not_started");
  const strongest =
    started.length > 0
      ? started.reduce((a, b) => (a.row.ability >= b.row.ability ? a : b)).key
      : undefined;

  // Weakest = lowest ability among started topics (or not-started if all are).
  const ranked = rankByWeakness(allStandings);
  const weakest = ranked.length > 0 ? ranked[0]?.key : undefined;

  // Next suggestion = first not-yet-graduated or due topic.
  const next = ranked.find(
    (s) => s.row.status === "not_started" || s.row.status === "due_for_review",
  )?.key ?? (ranked[0]?.key);

  return {
    itemsAnswered,
    graduated,
    dueForReview,
    streak,
    ...(strongest !== undefined ? { strongest } : {}),
    ...(weakest !== undefined ? { weakest } : {}),
    ...(next !== undefined ? { next } : {}),
  };
};

// ---------------------------------------------------------------------------
// History computation
// ---------------------------------------------------------------------------

/**
 * Classify a snapshot key into a scope string.
 * Returns `"general"` for general topics, the tool id for tool-scoped ones,
 * or `undefined` for unparseable keys.
 */
const snapScope = (key: AbilityKey): string | undefined => {
  try {
    const parsed = parseAbilityKey(key);
    return parsed.class.kind === "general" ? "general" : parsed.class.tool;
  } catch {
    return undefined;
  }
};

/**
 * Build the history series from the profile's abilitySnapshots.
 *
 * Algorithm:
 *  1. Group snapshots by scope.
 *  2. Within each scope, group by timestamp (ISO string).
 *  3. At each timestamp, compute the mean ability across all topics in that
 *     scope that have a snapshot at or before that instant (using the most
 *     recent snapshot per topic up to that point).
 *
 * For simplicity — and because snapshots are append-only and sessions are
 * typically linear — we use a per-timestamp mean of all snapshots recorded AT
 * that exact timestamp (same quiz session).  This is the most faithful
 * representation of "mean ability across that scope's topics at each snapshot
 * time" without a full windowed join.
 *
 * Only scopes with ≥1 snapshot are included.  `general` is first in the output
 * array, then tool scopes in lex order.
 */
const buildHistory = (
  snapshots: readonly AbilitySnapshot[],
): DashboardHistoryEntry[] => {
  // Group by scope → ts → ability values
  const byScopeThenTs = new Map<string, Map<string, number[]>>();

  for (const snap of snapshots) {
    const scope = snapScope(snap.key);
    if (scope === undefined) continue;

    let byTs = byScopeThenTs.get(scope);
    if (byTs === undefined) {
      byTs = new Map();
      byScopeThenTs.set(scope, byTs);
    }

    let values = byTs.get(snap.ts);
    if (values === undefined) {
      values = [];
      byTs.set(snap.ts, values);
    }
    values.push(snap.ability);
  }

  const result: DashboardHistoryEntry[] = [];

  // Output "general" first, then tools sorted lex.
  const scopes = [...byScopeThenTs.keys()].sort((a, b) => {
    if (a === "general") return -1;
    if (b === "general") return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const scope of scopes) {
    const byTs = byScopeThenTs.get(scope)!;
    const points = [...byTs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ts, abilities]) => ({
        ts,
        meanAbility:
          abilities.reduce((sum, v) => sum + v, 0) / abilities.length,
      }));

    result.push({ scope, points });
  }

  return result;
};

// ---------------------------------------------------------------------------
// Dashboard renderer (server-side — the agent prints rendered verbatim)
// ---------------------------------------------------------------------------

/**
 * Map a tier number to the emoji shown in the matrix cell.
 * Tier 0 → ⬜ (not started), 100→🟥, 200→🟧, 300→🟨, 400→🟩, 500→🟢.
 */
const tierEmoji = (tier: number): string => {
  if (tier >= 500) return "🟢";
  if (tier >= 400) return "🟩";
  if (tier >= 300) return "🟨";
  if (tier >= 200) return "🟧";
  if (tier >= 100) return "🟥";
  return "⬜";
};

/**
 * Map a normalized value in [0,1] to one of 8 block-element chars.
 * 0 → ▁, 1 → █.
 */
const BLOCKS = "▁▂▃▄▅▆▇█";
const toBlock = (v: number): string => {
  const idx = Math.min(7, Math.max(0, Math.round(v * 7)));
  return BLOCKS[idx]!;
};

/**
 * Build a single-line sparkline string (no label) from an array of ability
 * values.  y-range is clamped to [200, 600] and quantised to 8 levels.
 */
const sparkline = (abilities: readonly number[]): string => {
  if (abilities.length === 0) return "";
  return abilities
    .map((a) => toBlock((Math.max(200, Math.min(600, a)) - 200) / 400))
    .join("");
};

/**
 * Pad a string to `width` chars using trailing spaces.
 * If the string is already at or wider than `width`, return it unchanged.
 *
 * Note: emoji in topic titles are typically 2 grapheme-columns wide.  We
 * intentionally use `.length` (code-unit count) for simplicity — the fixed
 * column widths are chosen conservatively so alignment stays close enough in
 * monospace environments even if a title contains an emoji.
 */
const padEnd = (s: string, width: number): string =>
  s.length >= width ? s : s + " ".repeat(width - s.length);

/**
 * Return true if a row has any activity (non-not_started, non-not_in_scope cell).
 */
const rowHasActivity = (row: DashboardRow): boolean =>
  row.cells.some(
    (c) => c.status !== "not_started" && c.status !== "not_in_scope",
  );

/**
 * Render the complete dashboard as a fixed-width string.
 *
 * Sections:
 *  1. Header box
 *  2. Legend
 *  3. Matrix table  (topics × scopes — active rows only + not-started summary)
 *  4. Summary block
 *  5. History sparklines (one per scope that has data; general first)
 *
 * All data come from the three fields already computed by the handler.
 * The `topicTitleMap` argument allows resolving topic IDs to titles for the
 * strongest/weakest/next cells in the summary block.
 */
export const renderDashboard = (
  matrix: DashboardRow[],
  summary: DashboardSummary,
  history: DashboardHistoryEntry[],
  topicTitleMap: Map<string, string>,
): string => {
  const lines: string[] = [];

  // ---------------------------------------------------------------------------
  // 1. Header box
  // ---------------------------------------------------------------------------
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║  🚀  vibe-hero — Your Progress                               ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");

  // ---------------------------------------------------------------------------
  // 2. Legend
  // ---------------------------------------------------------------------------
  lines.push("Legend:");
  lines.push("  ⬜ not started   🟥 100   🟧 200   🟨 300   🟩 400   🟢 500");
  lines.push("  ▲ graduated   ⚠ due   ▽ in review");
  lines.push("");

  // ---------------------------------------------------------------------------
  // 3. Matrix table
  // ---------------------------------------------------------------------------
  if (matrix.length > 0) {
    // Derive ordered scope list from the first row's cells.
    const scopes = matrix[0]!.cells.map((c) => c.scope);

    // Split rows into active (any started/graduated/due cell) and not-started.
    const activeRows = matrix.filter(rowHasActivity);
    const idleRows = matrix.filter((r) => !rowHasActivity(r));

    // Auto-size title column: widest active-row title, min 5 ("Topic"), max 34.
    const MAX_TITLE_WIDTH = 34;
    const titleWidth = Math.min(
      MAX_TITLE_WIDTH,
      Math.max(
        5,
        ...activeRows.map((r) => r.title.length),
      ),
    );

    // Each scope cell renders: "<emoji> <3-digit-score> <marker-or-space>"
    // Cell content is 7 code-units: emoji(1) + " " + 3-digit + " " + marker(1).
    // CELL_WIDTH must also fit the longest scope name (header row), so we take
    // the max of 8 (comfortable content minimum) and the longest scope name + 1.
    const MIN_CELL_CONTENT = 8;
    const CELL_WIDTH = Math.max(
      MIN_CELL_CONTENT,
      ...scopes.map((s) => s.length + 1),
    );

    // Header row.
    const headerCells = scopes.map((s) => padEnd(s, CELL_WIDTH));
    lines.push(
      padEnd("Topic", titleWidth) + " | " + headerCells.join(" | "),
    );

    // Separator row.
    const sep =
      "-".repeat(titleWidth) +
      "-|-" +
      scopes.map(() => "-".repeat(CELL_WIDTH)).join("-|-");
    lines.push(sep);

    // Render a data cell string.
    const renderCell = (cell: DashboardCell): string => {
      if (cell.status === "not_in_scope") {
        return padEnd("—", CELL_WIDTH);
      }
      const emoji = tierEmoji(cell.tier);
      const score =
        cell.status === "not_started" || cell.ability <= 0
          ? "000"
          : String(Math.round(cell.ability)).padStart(3, "0");
      const marker = cell.markers.includes("graduated")
        ? "▲"
        : cell.markers.includes("due")
          ? "⚠"
          : cell.markers.includes("in_review")
            ? "▽"
            : " "; // pad to keep columns aligned when no marker
      return padEnd(`${emoji} ${score} ${marker}`, CELL_WIDTH);
    };

    if (activeRows.length === 0) {
      // Brand-new user: no activity at all — skip data rows, show guidance.
      // Count idle topics per scope for the informational line.
      const scopeCounts = scopes
        .map((s) => {
          const count = idleRows.filter((r) =>
            r.cells.some((c) => c.scope === s && c.status !== "not_in_scope"),
          ).length;
          return count > 0 ? `${s}: ${count}` : null;
        })
        .filter((x): x is string => x !== null)
        .join(", ");
      lines.push(
        "No topics started yet — say 'quiz me on <topic>' to begin.",
      );
      if (scopeCounts) {
        lines.push(`Available topics — ${scopeCounts}`);
      }
    } else {
      // Active rows — render in full.
      for (const row of activeRows) {
        const titleCell = padEnd(row.title, titleWidth);
        const dataCells = row.cells.map(renderCell);
        lines.push(titleCell + " | " + dataCells.join(" | "));
      }

      // Not-started summary line (skip if zero idle rows).
      if (idleRows.length > 0) {
        // Count per scope (topics that are in-scope for that scope but not started).
        const scopeCounts = scopes
          .map((s) => {
            const count = idleRows.filter((r) =>
              r.cells.some(
                (c) => c.scope === s && c.status === "not_started",
              ),
            ).length;
            return count > 0 ? `${s}: ${count}` : null;
          })
          .filter((x): x is string => x !== null)
          .join(", ");
        const countLabel =
          scopeCounts ? ` (${scopeCounts})` : "";
        lines.push(
          `+ ${idleRows.length} topic${idleRows.length === 1 ? "" : "s"} not yet started${countLabel}`,
        );
      }
    }
    lines.push("");
  }

  // ---------------------------------------------------------------------------
  // 4. Summary block
  // ---------------------------------------------------------------------------
  const resolveTitle = (key: string | undefined): string => {
    if (key === undefined) return "—";
    // key format: "general::topicId" or "tool::toolId::topicId"
    // topicTitleMap is indexed by topicId (the last segment)
    const parts = key.split("::");
    const id = parts[parts.length - 1] ?? key;
    return topicTitleMap.get(id) ?? id;
  };

  lines.push("Summary");
  lines.push("───────────────────────────────────");
  lines.push(`Items answered : ${summary.itemsAnswered}`);
  lines.push(`Graduated      : ${summary.graduated}`);
  lines.push(`Due for review : ${summary.dueForReview}`);
  lines.push(`Streak         : ${summary.streak} correct in a row`);
  lines.push(`Strongest      : ${resolveTitle(summary.strongest)}`);
  lines.push(`Weakest        : ${resolveTitle(summary.weakest)}`);
  lines.push(`Next suggested : ${resolveTitle(summary.next)}`);
  lines.push("");

  // ---------------------------------------------------------------------------
  // 5. History sparklines
  // ---------------------------------------------------------------------------
  lines.push("Ability over time");
  lines.push("───────────────────────────────────");
  if (history.length === 0) {
    lines.push("No history yet — complete a quiz to start tracking ability over time.");
  } else {
    // Label width = max scope name length, at least 11.
    const labelWidth = Math.max(11, ...history.map((h) => h.scope.length));
    for (const entry of history) {
      const label = padEnd(entry.scope, labelWidth);
      const spark = sparkline(entry.points.map((p) => p.meanAbility));
      lines.push(`${label}  ${spark}`);
    }
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Build the `get_dashboard` tool module.
 *
 * @param dirOverride - Profile-directory override (test seam).
 * @param loaderOrResolver - Catalog source seam (defaults to production resolver).
 */
export const makeGetDashboardTool = (
  dirOverride?: string,
  loaderOrResolver: CatalogLoader | CatalogResolver = resolveCatalog,
): AnyToolModule =>
  defineTool({
    name: "get_dashboard",
    description:
      "Show the learner's full progress dashboard: topic×scope matrix, summary stats, and ability-history graphs.",
    inputSchema: GetDashboardInputSchema,
    handler: async (input: GetDashboardInput): Promise<GetDashboardResult> => {
      const profile = await loadProfile(dirOverride);

      // Normalize: sync loader (tests) vs async resolver (production).
      const rawResult = loaderOrResolver(dirOverride);
      const { topics } =
        rawResult instanceof Promise ? await rawResult : rawResult;

      const now = new Date().toISOString();

      // Compute standings for ALL topics (no tool filter — the matrix covers
      // every topic; the optional input.tool controls summary scope).
      const baseStandings = computeStandings(topics, profile);
      const { standings } = detectLapses(baseStandings, profile, now);

      // Index standings by key for O(1) cell lookup.
      const standingsByKey = new Map<AbilityKey, TopicStanding>(
        standings.map((s) => [s.key, s]),
      );

      // Derive dynamic scope set.
      const scopes = deriveScopes(topics, profile);

      // Build matrix.
      const matrix = buildMatrix(topics, standingsByKey, scopes);

      // For summary, scope standings to the requested tool (or all).
      const summaryStandings =
        input.tool === undefined
          ? standings
          : standings.filter(
              (s) =>
                s.topic.class.kind === "general" ||
                s.topic.class.tool === input.tool,
            );

      const summary = buildSummary(profile, summaryStandings, input.tool);

      // Build history from ability snapshots.
      const history = buildHistory(profile.abilitySnapshots ?? []);

      // Build the topic-title lookup used by the renderer.
      const topicTitleMap = new Map<string, string>(
        topics.map((t) => [t.id, t.title]),
      );

      // Server-side render: the agent prints this verbatim.
      const rendered = renderDashboard(matrix, summary, history, topicTitleMap);

      return { matrix, summary, history, rendered };
    },
  });

/** Default `get_dashboard` module (env / `~/.vibe-hero`). */
export const getDashboardTool: AnyToolModule = makeGetDashboardTool();
