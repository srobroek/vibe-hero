/**
 * @file Unit tests for the organic arming state machine (observation/arming.ts).
 *
 * All tests are pure: `applyDrainBatch` takes plain data + injected `now`.
 */

import { describe, it, expect } from "vitest";
import { applyDrainBatch } from "../../src/observation/arming.js";
import { QUIET_PROMOTION_SECONDS, type EagernessParams } from "../../src/observation/eagerness.js";
import type { SignalHit } from "../../src/observation/offers.js";
import type { OrganicSession } from "../../src/schemas/profile.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-01T12:00:00.000Z");
const ms = (seconds: number): Date =>
  new Date(NOW.getTime() + seconds * 1_000);

/** A tight EagernessParams for tests — threshold=2, window=600s. */
const PARAMS: EagernessParams = {
  threshold: 2,
  windowSeconds: 600,
  cooldownSeconds: 60,
  bypass: true,
  bypassNeedsPriorEvidence: true,
};

/** A params variant that disables bypass. */
const PARAMS_NO_BYPASS: EagernessParams = { ...PARAMS, bypass: false };

/** A params variant that allows bypass without prior evidence. */
const PARAMS_BYPASS_NO_PRIOR: EagernessParams = {
  ...PARAMS,
  bypass: true,
  bypassNeedsPriorEvidence: false,
};

const emptySession = (): OrganicSession => ({ evidence: [] });

const hit = (
  overrides: Partial<SignalHit> & { key?: string },
): SignalHit => ({
  key: "general|hooks",
  title: "Hooks",
  weight: 1,
  phase: "during",
  bypass: false,
  success: true,
  correlationId: "c1",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Threshold crossing → pending (not armed)
// ---------------------------------------------------------------------------

describe("threshold crossing → pending, not armed", () => {
  it("accumulates evidence without arming when threshold not crossed", () => {
    const { state, armKey } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(armKey).toBeUndefined();
    expect(state.evidence).toHaveLength(1);
    expect(state.pending).toBeUndefined();
  });

  it("crosses threshold → creates pending, does NOT arm", () => {
    const { state, armKey } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(armKey).toBeUndefined();
    expect(state.pending).toBeDefined();
    expect(state.pending?.key).toBe("general|hooks");
  });

  it("pending has createdAt and expiresAt", () => {
    const { state } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(state.pending?.createdAt).toBe(NOW.toISOString());
    expect(Date.parse(state.pending?.expiresAt ?? "")).toBeGreaterThan(NOW.getTime());
  });

  it("only ONE pending offer at a time — second topic below threshold doesn't create second pending", () => {
    // First topic already pending
    const { state: withPending } = applyDrainBatch(
      emptySession(),
      [hit({ key: "general|hooks", weight: 1 }), hit({ key: "general|hooks", weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(withPending.pending).toBeDefined();

    // Add evidence for second topic — no second pending
    const { state } = applyDrainBatch(
      withPending,
      [hit({ key: "general|planning", weight: 1 }), hit({ key: "general|planning", weight: 1 })],
      PARAMS,
      ms(1),
    );
    expect(state.pending?.key).toBe("general|hooks"); // original pending unchanged
  });
});

// ---------------------------------------------------------------------------
// Seam signal promotes pending → armed
// ---------------------------------------------------------------------------

describe("seam signal promotes pending → armed", () => {
  it("seam-phase hit arms the pending topic", () => {
    const { state: withPending } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(withPending.pending).toBeDefined();

    const { state, armKey } = applyDrainBatch(
      withPending,
      [hit({ phase: "seam", weight: 0.5 })],
      PARAMS,
      ms(10),
    );
    expect(armKey).toBe("general|hooks");
    expect(state.pending).toBeUndefined();
  });

  it("start-phase hits do not promote pending", () => {
    const { state: withPending } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    const { armKey } = applyDrainBatch(
      withPending,
      [hit({ phase: "start", weight: 0.5 })],
      PARAMS,
      ms(10),
    );
    expect(armKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⚡ Bypass — seam hit with bypass:true
// ---------------------------------------------------------------------------

describe("⚡ bypass arming", () => {
  it("bypass hit WITHOUT prior evidence does not arm when bypassNeedsPriorEvidence=true", () => {
    const { armKey } = applyDrainBatch(
      emptySession(),
      [hit({ phase: "seam", bypass: true, weight: 1 })],
      PARAMS, // bypassNeedsPriorEvidence: true
      NOW,
    );
    expect(armKey).toBeUndefined();
  });

  it("bypass hit WITHOUT prior evidence arms when bypassNeedsPriorEvidence=false", () => {
    const { armKey } = applyDrainBatch(
      emptySession(),
      [hit({ phase: "seam", bypass: true, weight: 1 })],
      PARAMS_BYPASS_NO_PRIOR,
      NOW,
    );
    expect(armKey).toBe("general|hooks");
  });

  it("bypass hit WITH prior evidence arms when bypassNeedsPriorEvidence=true", () => {
    // Add prior evidence first (below threshold so no pending)
    const { state: withPrior } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 })],
      { ...PARAMS, threshold: 5 }, // high threshold — no pending yet
      NOW,
    );
    expect(withPrior.pending).toBeUndefined();
    expect(withPrior.evidence).toHaveLength(1);

    // Now a bypass seam hit — prior evidence exists → arm
    const { armKey } = applyDrainBatch(
      withPrior,
      [hit({ phase: "seam", bypass: true, weight: 0.5 })],
      PARAMS, // bypassNeedsPriorEvidence: true
      ms(5),
    );
    expect(armKey).toBe("general|hooks");
  });

  it("bypass is ignored when params.bypass=false", () => {
    const { armKey } = applyDrainBatch(
      emptySession(),
      [hit({ phase: "seam", bypass: true, weight: 1 })],
      PARAMS_NO_BYPASS,
      NOW,
    );
    expect(armKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Start-phase holds quiet-promotion
// ---------------------------------------------------------------------------

describe("start-phase holds quiet-promotion timing", () => {
  it("start-phase signal updates lastSignalAt, preventing immediate quiet-promotion", () => {
    // Create pending
    const { state: withPending } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    // Record lastSignalAt
    expect(withPending.lastSignalAt).toBe(NOW.toISOString());

    // A start-phase signal arrives 10s later — updates lastSignalAt
    const { state: afterStart } = applyDrainBatch(
      withPending,
      [hit({ phase: "start" })],
      PARAMS,
      ms(10),
    );
    expect(afterStart.lastSignalAt).toBe(ms(10).toISOString());
    // Not quiet-promoted yet (gap is only 10s, << QUIET_PROMOTION_SECONDS=90)
  });
});

// ---------------------------------------------------------------------------
// Quiet-promotion via lastSignalAt gap
// ---------------------------------------------------------------------------

describe("quiet-promotion via lastSignalAt gap", () => {
  it("promotes pending after QUIET_PROMOTION_SECONDS of silence", () => {
    // Create pending with a lastSignalAt
    const { state: withPending } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(withPending.pending).toBeDefined();
    expect(withPending.lastSignalAt).toBe(NOW.toISOString());

    // Drain with empty hits after QUIET_PROMOTION_SECONDS + 1 gap
    const laterMs = ms(QUIET_PROMOTION_SECONDS + 1);
    const { state, armKey } = applyDrainBatch(withPending, [], PARAMS, laterMs);

    expect(armKey).toBe("general|hooks");
    expect(state.pending).toBeUndefined();
  });

  it("does NOT promote when gap is just below QUIET_PROMOTION_SECONDS", () => {
    const { state: withPending } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    const { armKey } = applyDrainBatch(
      withPending,
      [],
      PARAMS,
      ms(QUIET_PROMOTION_SECONDS - 1),
    );
    expect(armKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Window expiry prunes evidence and pending
// ---------------------------------------------------------------------------

describe("window expiry prunes evidence and pending", () => {
  it("evidence older than windowSeconds is pruned", () => {
    const { state: withEvidence } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(withEvidence.evidence).toHaveLength(1);

    // Run another batch after the window
    const afterWindow = ms(PARAMS.windowSeconds + 1);
    const { state } = applyDrainBatch(withEvidence, [], PARAMS, afterWindow);

    expect(state.evidence).toHaveLength(0);
  });

  it("pending offer that has outlived the window is pruned", () => {
    const { state: withPending } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 1 }), hit({ weight: 1 })],
      PARAMS,
      NOW,
    );
    expect(withPending.pending).toBeDefined();

    const afterWindow = ms(PARAMS.windowSeconds + 1);
    const { state, armKey } = applyDrainBatch(withPending, [], PARAMS, afterWindow);

    expect(armKey).toBeUndefined(); // expired pending does NOT promote
    expect(state.pending).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failure weight already in hits
// ---------------------------------------------------------------------------

describe("failure weight is doubled by matchSignalHits before reaching applyDrainBatch", () => {
  it("a hit with weight=2 (pre-doubled for failure) counts toward threshold", () => {
    // With threshold=2 and one hit of weight=2 → crosses threshold immediately
    const { state, armKey } = applyDrainBatch(
      emptySession(),
      [hit({ weight: 2, success: false })],
      PARAMS,
      NOW,
    );
    // Weight 2 >= threshold 2 → pending
    expect(state.pending).toBeDefined();
    expect(armKey).toBeUndefined(); // still pending, not armed (no seam)
  });
});

// ---------------------------------------------------------------------------
// lastSignalAt tracking
// ---------------------------------------------------------------------------

describe("lastSignalAt tracking", () => {
  it("is set to now when hits are present", () => {
    const { state } = applyDrainBatch(emptySession(), [hit()], PARAMS, NOW);
    expect(state.lastSignalAt).toBe(NOW.toISOString());
  });

  it("is NOT updated when hits is empty (preserves old value)", () => {
    const session: OrganicSession = {
      evidence: [],
      lastSignalAt: "2026-07-01T10:00:00.000Z",
    };
    const { state } = applyDrainBatch(session, [], PARAMS, NOW);
    expect(state.lastSignalAt).toBe("2026-07-01T10:00:00.000Z");
  });
});
