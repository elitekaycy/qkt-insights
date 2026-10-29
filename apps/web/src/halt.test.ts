import { describe, expect, it } from "vitest";
import type { StrategyRow } from "./api";
import { haltClearing, haltReasonText, haltSince, haltSummary, resumeCommand } from "./halt";

const HALTED_AT = Date.UTC(2026, 8, 21, 14, 2, 11);
const LATER = Date.UTC(2026, 8, 23, 9, 0, 0);

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
    expect(haltClearing(row({ halted: true, haltScope: "DAILY", haltPersistent: false }))).toBe("resumes 00:00 UTC");
    expect(haltClearing(row({ halted: true, haltScope: null, haltPersistent: null }))).toBe("scope unknown: sent by a qkt engine before v0.52");
  });

  it("summarizes a halt for a tooltip, and nothing for a running or shared-link row", () => {
    expect(haltSummary(row({ halted: true, haltReason: "loss streak 3", haltScope: "PERSISTENT", haltPersistent: true, haltedAt: HALTED_AT }), LATER))
      .toBe("Halted: loss streak 3 at 2026-09-21 14:02 UTC · stays halted until an operator resumes it · qkt resume gold_paper");
    expect(haltSummary(row({ halted: true, haltReason: null, haltScope: "DAILY", haltPersistent: false, haltedAt: null })))
      .toBe("Halted: no reason given · resumes 00:00 UTC");
    expect(haltSummary(row({ halted: false }))).toBeNull();
    expect(haltSummary(row({}))).toBeNull();
  });

  it("says 'before' when only a restart's re-assertion dates the halt, never 'since' the restart", () => {
    const reasserted = row({ halted: true, haltReason: "strategy drawdown 0.0896 exceeds max 0.05", haltScope: "PERSISTENT", haltPersistent: true, haltedAt: HALTED_AT, haltedBefore: true });
    expect(haltSince(reasserted, LATER)).toBe("before 2026-09-21 14:02 UTC");
    expect(haltSummary(reasserted, LATER)).toBe("Drawdown 8.96% hit the 5.00% cap before 2026-09-21 14:02 UTC (re-asserted at a restart; its start is not stored)"
      + " · stays halted until an operator resumes it · qkt resume gold_paper");
    expect(haltSince(row({ halted: true, haltedAt: HALTED_AT, haltedBefore: false }), LATER)).toBe("at 2026-09-21 14:02 UTC");
    expect(haltSince(row({ halted: true, haltedAt: HALTED_AT, haltedBefore: false }), HALTED_AT + 3_600_000)).toBe("at 14:02 UTC");
    expect(haltSince(row({ halted: true, haltedAt: null }))).toBeNull();
  });

  it("reads the engine's limit reasons without raw floats, and keeps any other reason as sent", () => {
    expect(haltReasonText("strategy daily loss 3.49900000 exceeds max 3")).toBe("Daily loss 3.50 hit the 3.00 cap");
    expect(haltReasonText("strategy daily drawdown 0.0012 exceeds max 0.001")).toBe("Daily drawdown 0.12% hit the 0.10% cap");
    expect(haltReasonText("global drawdown 0.1004 exceeds max 0.1")).toBe("Account drawdown 10.04% hit the 10.00% cap");
    expect(haltReasonText("daily loss 250.5 exceeds max 250")).toBe("Daily loss 250.50 hit the 250.00 cap");
    expect(haltReasonText("engine fault: order id is longer than 64 characters")).toBe("engine fault: order id is longer than 64 characters");
    expect(haltReasonText(null)).toBe("no reason given");
  });

  it("states the soak's daily-loss halt the way an owner reads it", () => {
    const at = Date.UTC(2026, 9, 29, 2, 10, 37);
    expect(haltSummary(row({ halted: true, haltReason: "strategy daily loss 3.49900000 exceeds max 3", haltScope: "DAILY", haltPersistent: false, haltedAt: at }), at + 60_000))
      .toBe("Daily loss 3.50 hit the 3.00 cap at 02:10 UTC · resumes 00:00 UTC");
  });
});
