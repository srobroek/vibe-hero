import { describe, expect, it } from "vitest";

import { matchSignalHits } from "../../src/observation/offers.js";
import type { ObservedSignal } from "../../src/observation/source.js";
import type { Topic } from "../../src/schemas/content.js";

// ---------------------------------------------------------------------------
// Regression: overlapping triggers within one topic must not shadow the seam.
//
// The git-and-version-control topic declares a broad `during` trigger
// (`^git (add|commit|...)`) AND a narrower `seam`+bypass trigger
// (`^git (commit|push|merge)`). A `git commit` signal matches both. The
// original first-match-wins collector returned the `during` trigger, so
// pending offers never promoted at commit time (live-verified failure:
// session 0cef4230, 2026-07-07). The collector must prefer the most
// consequential trigger: seam > during > start, bypass breaks ties.
// ---------------------------------------------------------------------------

/** Mirrors the real git topic's overlapping trigger declarations. */
const GIT_LIKE_TOPIC: Topic = {
  id: "git-and-version-control",
  class: { kind: "general" },
  title: "Git & Version Control",
  summary: "Everyday git workflows.",
  triggerSignals: [
    {
      tool: "claude-code",
      match: { inputPattern: "^git (add|commit|rebase|merge|stash)\\b" },
      weight: 1,
      phase: "during",
      bypass: false,
    },
    {
      tool: "claude-code",
      match: { inputPattern: "^git (commit|push|merge)\\b" },
      weight: 1,
      phase: "seam",
      bypass: true,
    },
  ],
  items: [],
};

const signal = (inputText: string): ObservedSignal => ({
  toolName: "Bash",
  inputText,
  success: true,
  toolUseId: "toolu_shadow",
});

describe("matchSignalHits — overlapping triggers in one topic (seam shadowing)", () => {
  it("a signal matching both a during and a seam trigger yields the seam hit", () => {
    const hits = matchSignalHits([GIT_LIKE_TOPIC], "claude-code", [
      signal("git commit -m 'done'"),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.phase).toBe("seam");
    expect(hits[0]?.bypass).toBe(true);
  });

  it("a signal matching only the during trigger keeps its during phase", () => {
    const hits = matchSignalHits([GIT_LIKE_TOPIC], "claude-code", [
      signal("git add -A"),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.phase).toBe("during");
    expect(hits[0]?.bypass).toBe(false);
  });

  it("still emits exactly one hit per (signal x topic) pair", () => {
    const hits = matchSignalHits([GIT_LIKE_TOPIC], "claude-code", [
      signal("git commit -m 'a'"),
      signal("git push origin main"),
      signal("git stash"),
    ]);

    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.phase)).toEqual(["seam", "seam", "during"]);
  });
});
