import type { StrategyRow } from "./api";

export interface PortfolioSummary {
  portfolioId: string;
  childCount: number;
  /** Children that have at least one broker deal — i.e. sleeves that actually traded, not just
   * registered. A book can register 40 sleeves yet have only 1 that ever fired. */
  tradedCount: number;
  allocatedCapital: number | null;
  realizedPnl: number;
  openPnl: number | null;
  netPnl: number | null;
  dealCount: number;
  lastSeen: number;
}

function allocatedCapital(row: StrategyRow): number | null {
  const value = row.metadata?.allocatedCapital;
  return typeof value === "number" ? value : row.startingBalance;
}

function metaString(row: StrategyRow, key: string): string | null {
  const value = row.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** qkt-forge can shard one logical forward book as book, book_2, book_3. */
export function logicalPortfolioId(portfolioId: string): string {
  return portfolioId.replace(/_\d+$/u, "");
}

export function physicalPortfolioId(row: StrategyRow): string | null {
  return metaString(row, "portfolioId");
}

export function portfolioGroupId(row: StrategyRow): string | null {
  const id = physicalPortfolioId(row);
  return id == null ? null : logicalPortfolioId(id);
}

/**
 * Human label for a strategy: its own DSL name, prefixed with the portfolio it
 * runs in. The raw strategyId is a deploy slot (`forward_bench_2:s0`) that says
 * nothing about what the strategy is.
 * e.g. portfolio `forward_bench` + dslName `gold_eur_rel2` -> `forward_bench / gold_eur_rel2`.
 */
export function strategyDisplayName(row: StrategyRow): string {
  const dsl = metaString(row, "dslName");
  const portfolio = metaString(row, "portfolioName") ?? portfolioGroupId(row);
  if (dsl && portfolio) return `${portfolio} / ${dsl}`;
  return dsl ?? row.strategyId;
}

/** Aggregates only child-attributed values; broker account equity is intentionally excluded. */
export function summarizePortfolio(
  portfolioId: string,
  children: StrategyRow[],
  openByStrategy: ReadonlyMap<string, number>,
  hasLiveState: boolean,
): PortfolioSummary {
  const allocations = children.map(allocatedCapital);
  const capital = allocations.every((value) => value != null)
    ? allocations.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const realized = children.reduce(
    (sum, child) => sum + (child.realizedNet ?? 0),
    0,
  );
  const open = hasLiveState
    ? children.reduce(
        (sum, child) => sum + (openByStrategy.get(child.strategyId) ?? 0),
        0,
      )
    : null;
  const net = open == null ? null : realized + open;

  return {
    portfolioId,
    childCount: children.length,
    tradedCount: children.filter((child) => child.dealCount > 0).length,
    allocatedCapital: capital,
    realizedPnl: realized,
    openPnl: open,
    netPnl: net,
    dealCount: children.reduce((sum, child) => sum + child.dealCount, 0),
    lastSeen: children.reduce(
      (latest, child) => Math.max(latest, child.lastSeen),
      0,
    ),
  };
}
