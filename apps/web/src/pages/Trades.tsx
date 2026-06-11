import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type StrategyRow, type TradeRow } from "../api";
import { SidePill } from "../components/StatCard";
import { ts } from "../format";

export default function Trades({ instanceId }: { instanceId: string | null }) {
  const [strategy, setStrategy] = useState("");
  const [symbol, setSymbol] = useState("");

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  const trades = useQuery({
    queryKey: ["trades-page", instanceId, strategy, symbol],
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId!, limit: "200" });
      if (strategy) p.set("strategy", strategy);
      if (symbol) p.set("symbol", symbol.toUpperCase());
      return get<TradeRow[]>(`/trades?${p}`);
    },
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  if (!instanceId) return <p className="text-zinc-500">No instance selected.</p>;

  const rows = trades.data ?? [];
  return (
    <div>
      <h2 className="text-xl font-semibold">Trades</h2>
      <p className="mt-1 text-sm text-zinc-500">Every fill recorded for {instanceId}.</p>

      <div className="mt-4 flex gap-2">
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="rounded bg-zinc-800 p-1.5 text-sm">
          <option value="">all strategies</option>
          {(strategies.data ?? []).map((s) => (
            <option key={s.strategyId} value={s.strategyId}>
              {s.strategyId}
            </option>
          ))}
        </select>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="symbol filter"
          className="rounded bg-zinc-800 p-1.5 text-sm outline-none"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-zinc-400">
            <tr>
              <th className="p-3">Time</th>
              <th className="p-3">Strategy</th>
              <th className="p-3">Symbol</th>
              <th className="p-3">Side</th>
              <th className="p-3">Qty</th>
              <th className="p-3">Price</th>
              <th className="p-3">Order</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-zinc-800">
                <td className="p-3 text-zinc-500">{ts(t.ts)}</td>
                <td className="p-3">{t.strategyId ?? "—"}</td>
                <td className="p-3">{t.payload.symbol}</td>
                <td className="p-3">
                  <SidePill side={t.payload.side} />
                </td>
                <td className="p-3 tabular-nums">{t.payload.qty}</td>
                <td className="p-3 tabular-nums">{t.payload.price}</td>
                <td className="p-3 font-mono text-xs text-zinc-500">{t.payload.orderId}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-zinc-600">
                  No trades match
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
