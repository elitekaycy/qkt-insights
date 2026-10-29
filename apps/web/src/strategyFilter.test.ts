import { describe, expect, it } from "vitest";
import type { StrategyRow } from "./api";
import { asksForRetired, edgeDefault, matchesStrategy } from "./strategyFilter";

const row = (strategyId: string, extra: Partial<StrategyRow> = {}): StrategyRow =>
  ({ strategyId, metadata: { symbols: ["ICMARKETS:XAUUSD"] }, active: true, halted: false, ...extra }) as StrategyRow;

describe("matchesStrategy", () => {
  it("matches free words against the name", () => {
    expect(matchesStrategy(row("gold_rsi_fade"), "rsi")).toBe(true);
    expect(matchesStrategy(row("gold_rsi_fade"), "silver")).toBe(false);
  });

  it("filters by status and instrument, every word at once", () => {
    expect(matchesStrategy(row("a", { halted: true }), "status:halted")).toBe(true);
    expect(matchesStrategy(row("a"), "status:halted")).toBe(false);
    expect(matchesStrategy(row("a", { active: false }), "status:retired")).toBe(true);
    expect(matchesStrategy(row("a"), "status:running symbol:xau")).toBe(true);
    expect(matchesStrategy(row("a"), "status:running symbol:eur")).toBe(false);
  });

  it("keeps the unattributed row for an empty query or its own name only", () => {
    expect(matchesStrategy(null, "")).toBe(true);
    expect(matchesStrategy(null, "unattr")).toBe(true);
    expect(matchesStrategy(null, "status:running")).toBe(false);
  });

  it("knows when the query asks for retired rows", () => {
    expect(asksForRetired("gold status:retired")).toBe(true);
    expect(asksForRetired("gold")).toBe(false);
  });
});

describe("edgeDefault", () => {
  it("opens on the strategy with the most closed trades, never one without any", () => {
    const list = [row("a_idle", { dealCount: 0, lastSeen: 9 }), row("b_gold", { dealCount: 12, lastSeen: 1 }), row("c_fx", { dealCount: 4, lastSeen: 5 })];
    expect(edgeDefault(list)).toBe("b_gold");
    expect(edgeDefault([row("x", { dealCount: 3, lastSeen: 1 }), row("y", { dealCount: 3, lastSeen: 2 })])).toBe("y");
    expect(edgeDefault([])).toBeUndefined();
  });
});
