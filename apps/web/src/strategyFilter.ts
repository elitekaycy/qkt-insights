import type { StrategyRow } from "./api";
import { strategyDisplayName } from "./portfolio";

/*
 * The strategies table's search: free words match the name or id, `status:` the state
 * (running, halted, retired) and `symbol:` an instrument the strategy trades. Every word must
 * match. The text lives in the URL (`find`), so a filtered table is a link too.
 */

export type StrategyStatus = "running" | "halted" | "retired";

export function strategyStatus(row: StrategyRow): StrategyStatus {
  return row.halted ? "halted" : row.active ? "running" : "retired";
}

function symbols(row: StrategyRow): string[] {
  const v = row.metadata?.symbols;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** True when the row matches every word of the query; the unattributed row (null) matches only free text "unattributed". */
export function matchesStrategy(row: StrategyRow | null, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return words.every((w) => {
    const [key, value] = w.includes(":") ? [w.slice(0, w.indexOf(":")), w.slice(w.indexOf(":") + 1)] : [null, w];
    if (row == null) return key == null && "unattributed".includes(value);
    if (key === "status") return strategyStatus(row).startsWith(value);
    if (key === "symbol") return symbols(row).some((s) => s.toLowerCase().includes(value));
    const text = key == null ? value : w;
    return strategyDisplayName(row).toLowerCase().includes(text) || row.strategyId.toLowerCase().includes(text);
  });
}

/** True when the query asks for retired strategies, which the table otherwise folds away. */
export function asksForRetired(query: string): boolean {
  return /(^|\s)status:ret/iu.test(query);
}
