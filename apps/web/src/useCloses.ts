import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type ClosedTradeRow, type PerformanceBundle, type StrategyRow } from "./api";

/**
 * orderId → closed-trade row across every strategy on the instance, so fill
 * tables can show the dollar P&L and win/loss of the position each fill closed.
 * e.g. closeMap.get(trade.payload.orderId)?.realized → +42.10
 */
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
  for (const q of perf) for (const c of q.data?.closes ?? []) if (c.orderId) map.set(c.orderId, c);
  return map;
}

/** Table cell content for a fill's realized result: colored dollars or a muted dash. */
export function realizedLabel(close: ClosedTradeRow | undefined): { text: string; className: string } {
  if (!close) return { text: "—", className: "text-faint" };
  const sign = close.realized > 0 ? "+" : "";
  const color = close.realized > 0 ? "text-up" : close.realized < 0 ? "text-down" : "text-muted";
  return { text: `${sign}${close.realized.toFixed(2)}`, className: `font-semibold ${color}` };
}
