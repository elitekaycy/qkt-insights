import type { StrategyRow } from "./api";

export interface PortfolioSummary {
  portfolioId: string;
  childCount: number;
  allocatedCapital: number | null;
  realizedPnl: number;
  openPnl: number | null;
  netPnl: number | null;
  portfolioEquity: number | null;
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
    allocatedCapital: capital,
    realizedPnl: realized,
    openPnl: open,
    netPnl: net,
    portfolioEquity: capital == null || net == null ? null : capital + net,
    dealCount: children.reduce((sum, child) => sum + child.dealCount, 0),
    lastSeen: children.reduce(
      (latest, child) => Math.max(latest, child.lastSeen),
      0,
    ),
  };
}
