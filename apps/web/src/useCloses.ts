import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type ClosedTradeRow, type PerformanceBundle, type StrategyRow } from "./api";

/**
 * Index closed trades by every id a table row might hold: the close row's own
 * orderId (position ticket for deals-backed closes, engine order id for ledger
 * closes), the engine order that executed the close, and the engine order that
 * opened the position. An opening order whose position closed in parts maps to
 * one aggregate row (realized summed, qty summed, ts of the last partial), so a
 * fill row always shows the position's full outcome.
 * e.g. closeMap.get(trade.payload.orderId)?.realized → +42.10
 */
export function buildCloseMap(closes: ClosedTradeRow[]): Map<string, ClosedTradeRow> {
  const map = new Map<string, ClosedTradeRow>();
  for (const c of closes) {
    if (c.orderId) map.set(c.orderId, c);
    if (c.exitOrderId) map.set(c.exitOrderId, c);
  }
  const byEntry = new Map<string, ClosedTradeRow>();
  for (const c of closes) {
    if (!c.entryOrderId) continue;
    const cur = byEntry.get(c.entryOrderId);
    byEntry.set(
      c.entryOrderId,
      cur ? { ...c, realized: cur.realized + c.realized, qty: cur.qty + c.qty, ts: Math.max(cur.ts, c.ts) } : c,
    );
  }
  for (const [k, v] of byEntry) if (!map.has(k)) map.set(k, v);
  return map;
}

/** buildCloseMap over every strategy's closes on the instance. */
export function useCloseMap(instanceId: string | null): Map<string, ClosedTradeRow> {
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });
  const ids = (strategies.data ?? []).map((s) => s.strategyId);
  const perf = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["performance", instanceId, id, "all"],
      queryFn: () =>
        get<PerformanceBundle>(`/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 15000,
    })),
  });
  const map = new Map<string, ClosedTradeRow>();
  for (const q of perf) for (const [k, v] of buildCloseMap(q.data?.closes ?? [])) map.set(k, v);
  return map;
}

/** Table cell content for a fill's realized result: colored dollars or a muted dash. */
export function realizedLabel(close: ClosedTradeRow | undefined): { text: string; className: string } {
  if (!close) return { text: "—", className: "text-faint" };
  const sign = close.realized > 0 ? "+" : "";
  const color = close.realized > 0 ? "text-up" : close.realized < 0 ? "text-down" : "text-muted";
  return { text: `${sign}${close.realized.toFixed(2)}`, className: `font-semibold ${color}` };
}
