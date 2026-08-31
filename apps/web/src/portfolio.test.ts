import { describe, expect, it } from "vitest";
import type { StrategyRow } from "./api";
import { logicalPortfolioId, portfolioGroupId, strategyDisplayName, summarizePortfolio } from "./portfolio";

function child(
  strategyId: string,
  capital: number,
  realizedNet: number | null,
  dealCount: number,
): StrategyRow {
  return {
    strategyId,
    firstSeen: 1,
    lastSeen: strategyId === "book:a" ? 10 : 20,
    startingBalance: capital,
    metadata: { portfolioId: "book", allocatedCapital: capital },
    realizedNet,
    dealCount,
    active: true,
  };
}

describe("summarizePortfolio", () => {
  it("groups generated shard portfolio ids under one logical portfolio", () => {
    const row = child("forward_bench_2:s0", 1000, null, 0);
    row.metadata = { portfolioId: "forward_bench_2", allocatedCapital: 1000 };

    expect(logicalPortfolioId("forward_bench_2")).toBe("forward_bench");
    expect(logicalPortfolioId("forward_bench")).toBe("forward_bench");
    expect(portfolioGroupId(row)).toBe("forward_bench");
  });

  it("combines child allocation and attributed PnL without broker account equity", () => {
    const summary = summarizePortfolio(
      "book",
      [child("book:a", 6_000, 120, 2), child("book:b", 4_000, -30, 1)],
      new Map([
        ["book:a", 15],
        ["book:b", -5],
      ]),
      true,
    );

    expect(summary).toMatchObject({
      allocatedCapital: 10_000,
      realizedPnl: 90,
      openPnl: 10,
      netPnl: 100,
      dealCount: 3,
      childCount: 2,
      tradedCount: 2,
      lastSeen: 20,
    });
  });

  it("counts only children that actually traded, not every registered sleeve", () => {
    const summary = summarizePortfolio(
      "book",
      [child("book:a", 1_000, 0, 1), child("book:b", 1_000, null, 0), child("book:c", 1_000, null, 0)],
      new Map(),
      false,
    );

    expect(summary.childCount).toBe(3);
    expect(summary.tradedCount).toBe(1);
  });

  it("does not claim net PnL or equity while live open PnL is unavailable", () => {
    const summary = summarizePortfolio(
      "book",
      [child("book:a", 10_000, 120, 2)],
      new Map(),
      false,
    );

    expect(summary.realizedPnl).toBe(120);
    expect(summary.openPnl).toBeNull();
    expect(summary.netPnl).toBeNull();
  });
});

describe("strategyDisplayName", () => {
  it("prefixes the DSL name with the portfolio name", () => {
    const row = child("forward_bench_2:s0", 1000, null, 0);
    row.metadata = { portfolioName: "forward_bench", dslName: "gold_eur_rel2" };
    expect(strategyDisplayName(row)).toBe("forward_bench / gold_eur_rel2");
  });

  it("falls back to the grouped portfolio id when portfolioName is absent", () => {
    const row = child("forward_bench_2:s0", 1000, null, 0);
    row.metadata = { portfolioId: "forward_bench_2", dslName: "gold_eur_rel2" };
    expect(strategyDisplayName(row)).toBe("forward_bench / gold_eur_rel2");
  });

  it("shows the bare DSL name for a standalone strategy", () => {
    const row = child("solo", 1000, null, 0);
    row.metadata = { dslName: "gold_eur_rel2" };
    expect(strategyDisplayName(row)).toBe("gold_eur_rel2");
  });

  it("falls back to the strategyId when no DSL name is reported", () => {
    const row = child("forward_bench_2:s0", 1000, null, 0);
    row.metadata = { portfolioName: "forward_bench" };
    expect(strategyDisplayName(row)).toBe("forward_bench_2:s0");
  });
});
