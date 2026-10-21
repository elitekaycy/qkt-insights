import { describe, expect, it } from "vitest";
import type { StrategyRow } from "./api";
import { haltClearing, haltSince, haltSummary, resumeCommand } from "./halt";

const HALTED_AT = Date.UTC(2026, 8, 21, 14, 2, 11);

function row(halt: Partial<StrategyRow>, metadata: Record<string, unknown> | null = { deployName: "gold_paper" }): StrategyRow {
  return {
    strategyId: "gold", firstSeen: 1, lastSeen: 2, startingBalance: null, definedCapital: null, metadata,
    realizedNet: null, dealCount: 0, active: true, ...halt,
  };
}

describe("halt display", () => {
  it("gives the resume command only for a persistent halt, addressed by deploy name", () => {
    expect(resumeCommand(row({ halted: true, haltScope: "PERSISTENT", haltPersistent: true }))).toBe("qkt resume gold_paper");
    expect(resumeCommand(row({ halted: true, haltScope: "PERSISTENT", haltPersistent: true }, { deployName: "book/leg_a" }))).toBe("qkt resume book/leg_a");
    expect(resumeCommand(row({ halted: true, haltScope: "PERSISTENT", haltPersistent: true }, null))).toBe("qkt resume gold");
    expect(resumeCommand(row({ halted: true, haltScope: "DAILY", haltPersistent: false }))).toBeNull();
    expect(resumeCommand(row({ halted: true, haltScope: null, haltPersistent: null }))).toBeNull();
    expect(resumeCommand(row({ halted: false }))).toBeNull();
  });

  it("says how each kind of halt ends, and never guesses an unknown scope", () => {
    expect(haltClearing(row({ halted: true, haltScope: "PERSISTENT", haltPersistent: true }))).toBe("stays halted until an operator resumes it");
    expect(haltClearing(row({ halted: true, haltScope: "DAILY", haltPersistent: false }))).toBe("clears at the next UTC day");
    expect(haltClearing(row({ halted: true, haltScope: null, haltPersistent: null }))).toBe("scope unknown: sent by a qkt engine before v0.52");
  });

  it("summarizes a halt for a tooltip, and nothing for a running or shared-link row", () => {
    expect(haltSummary(row({ halted: true, haltReason: "loss streak 3", haltScope: "PERSISTENT", haltPersistent: true, haltedAt: HALTED_AT })))
      .toBe("Halted: loss streak 3 · since 2026-09-21 14:02:11 UTC · stays halted until an operator resumes it · qkt resume gold_paper");
    expect(haltSummary(row({ halted: true, haltReason: null, haltScope: "DAILY", haltPersistent: false, haltedAt: null })))
      .toBe("Halted: no reason given · clears at the next UTC day");
    expect(haltSummary(row({ halted: false }))).toBeNull();
    expect(haltSummary(row({}))).toBeNull();
  });

  it("says 'before' when only a restart's re-assertion dates the halt, never 'since' the restart", () => {
    const reasserted = row({ halted: true, haltReason: "strategy drawdown 0.0896 exceeds max 0.05", haltScope: "PERSISTENT", haltPersistent: true, haltedAt: HALTED_AT, haltedBefore: true });
    expect(haltSince(reasserted)).toBe("before 2026-09-21 14:02:11 UTC");
    expect(haltSummary(reasserted)).toBe("Halted: strategy drawdown 0.0896 exceeds max 0.05 · before 2026-09-21 14:02:11 UTC (re-asserted at a restart; its start is not stored)"
      + " · stays halted until an operator resumes it · qkt resume gold_paper");
    expect(haltSince(row({ halted: true, haltedAt: HALTED_AT, haltedBefore: false }))).toBe("since 2026-09-21 14:02:11 UTC");
    expect(haltSince(row({ halted: true, haltedAt: null }))).toBeNull();
  });
});
