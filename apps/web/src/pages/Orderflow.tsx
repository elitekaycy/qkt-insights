import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type OrderRow, type StrategyRow, type TradeRow } from "../api";
import { useLiveStream } from "../useLiveStream";

const STATE_COLOR: Record<string, string> = {
  FILLED: "bg-emerald-900/60 text-emerald-300",
  WORKING: "bg-sky-900/60 text-sky-300",
  SUBMITTED: "bg-sky-900/60 text-sky-300",
  PARTIALLY_FILLED: "bg-amber-900/60 text-amber-300",
  CANCELLED: "bg-zinc-800 text-zinc-400",
  REJECTED: "bg-red-900/60 text-red-300",
};

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export default function Orderflow({ instanceId }: { instanceId: string | null }) {
  const [strategy, setStrategy] = useState("");
  const [symbol, setSymbol] = useState("");
  const [state, setState] = useState("");

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  const ordersUrl = useMemo(() => {
    if (!instanceId) return null;
    const p = new URLSearchParams({ instance: instanceId });
    if (strategy) p.set("strategy", strategy);
    if (symbol) p.set("symbol", symbol.toUpperCase());
    if (state) p.set("state", state);
    return `/orders?${p}`;
  }, [instanceId, strategy, symbol, state]);

  const orders = useQuery({
    queryKey: ["orders", ordersUrl],
    queryFn: () => get<OrderRow[]>(ordersUrl!),
    enabled: !!ordersUrl,
    refetchInterval: 5000,
  });

  const trades = useQuery({
    queryKey: ["trades", instanceId, strategy, symbol],
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId!, limit: "50" });
      if (strategy) p.set("strategy", strategy);
      if (symbol) p.set("symbol", symbol.toUpperCase());
      return get<TradeRow[]>(`/trades?${p}`);
    },
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  const live = useLiveStream(instanceId);
  const liveFiltered = live.filter(
    (e) =>
      (!strategy || e.strategyId === strategy) &&
      (!symbol || String(e.payload.symbol ?? "").toUpperCase().includes(symbol.toUpperCase())),
  );

  return (
    <div>
      <h2 className="text-xl font-semibold">Orderflow</h2>
      <p className="mt-1 text-sm text-zinc-500">Orders and fills for {instanceId ?? "—"}, live tail below.</p>

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
        <select value={state} onChange={(e) => setState(e.target.value)} className="rounded bg-zinc-800 p-1.5 text-sm">
          <option value="">any state</option>
          {Object.keys(STATE_COLOR).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section>
          <h3 className="text-sm font-semibold text-zinc-400">Orders</h3>
          <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-left text-zinc-400">
                <tr>
                  <th className="p-2">Time</th>
                  <th className="p-2">Strategy</th>
                  <th className="p-2">Symbol</th>
                  <th className="p-2">Side</th>
                  <th className="p-2">Qty</th>
                  <th className="p-2">Avg px</th>
                  <th className="p-2">State</th>
                </tr>
              </thead>
              <tbody>
                {(orders.data ?? []).map((o) => (
                  <tr key={o.orderId} className="border-t border-zinc-800">
                    <td className="p-2 text-zinc-500">{ts(o.updatedTs)}</td>
                    <td className="p-2">{o.strategyId ?? "—"}</td>
                    <td className="p-2">{o.symbol ?? "—"}</td>
                    <td className={`p-2 ${o.side === "BUY" ? "text-emerald-400" : "text-red-400"}`}>{o.side}</td>
                    <td className="p-2">{o.qty ?? o.cumQty}</td>
                    <td className="p-2">{o.avgPrice ?? "—"}</td>
                    <td className="p-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_COLOR[o.state] ?? "bg-zinc-800"}`}>
                        {o.state}
                      </span>
                    </td>
                  </tr>
                ))}
                {(orders.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-4 text-center text-zinc-600">
                      No orders yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h3 className="mt-6 text-sm font-semibold text-zinc-400">Recent trades</h3>
          <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <tbody>
                {(trades.data ?? []).map((t) => (
                  <tr key={t.id} className="border-t border-zinc-800 first:border-t-0">
                    <td className="p-2 text-zinc-500">{ts(t.ts)}</td>
                    <td className="p-2">{t.strategyId ?? "—"}</td>
                    <td className="p-2">{t.payload.symbol}</td>
                    <td className={`p-2 ${t.payload.side === "BUY" ? "text-emerald-400" : "text-red-400"}`}>
                      {t.payload.side}
                    </td>
                    <td className="p-2">{t.payload.qty}</td>
                    <td className="p-2">@ {t.payload.price}</td>
                  </tr>
                ))}
                {(trades.data ?? []).length === 0 && (
                  <tr>
                    <td className="p-4 text-center text-zinc-600">No trades yet</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-zinc-400">Live tail</h3>
          <div className="mt-2 h-[32rem] overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 font-mono text-xs">
            {liveFiltered.length === 0 && <div className="p-2 text-zinc-600">Waiting for events…</div>}
            {liveFiltered.map((e) => (
              <div key={`${e.instanceId}-${e.id}`} className="border-b border-zinc-800/60 py-1">
                <span className="text-zinc-500">{ts(e.ts)}</span>{" "}
                <span className="text-sky-400">{e.type}</span>{" "}
                {e.strategyId && <span className="text-zinc-400">[{e.strategyId}]</span>}{" "}
                <span className="text-zinc-300">{JSON.stringify(e.payload)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
