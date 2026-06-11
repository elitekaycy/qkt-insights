import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type LogRow, type StrategyRow, type StrategyStats, type TradeRow } from "../api";
import { EquityChart } from "../components/EquityChart";
import { LEVEL_COLOR, SidePill, StatCard } from "../components/StatCard";
import { age, money, num, pct, ts } from "../format";

export default function Strategies({ instanceId }: { instanceId: string | null }) {
  const [selected, setSelected] = useState<string | null>(null);

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 10000,
  });

  if (!instanceId) return <p className="text-zinc-500">No instance selected.</p>;
  if (selected) return <StrategyDetail instanceId={instanceId} strategyId={selected} onBack={() => setSelected(null)} />;

  const rows = strategies.data ?? [];
  return (
    <div>
      <h2 className="text-xl font-semibold">Strategies</h2>
      <p className="mt-1 text-sm text-zinc-500">Every strategy {instanceId} has reported. Click one to drill in.</p>
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.length === 0 && <p className="text-zinc-600">No strategies yet.</p>}
        {rows.map((s) => {
          const ret =
            s.equity != null && s.startingBalance ? (s.equity - s.startingBalance) / s.startingBalance : null;
          return (
            <button
              key={s.strategyId}
              onClick={() => setSelected(s.strategyId)}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 text-left transition hover:border-zinc-600"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{s.strategyId}</span>
                <span className="text-xs text-zinc-500">{age(s.lastSeen)}</span>
              </div>
              <div className="mt-3 flex items-baseline gap-3">
                <span className="text-2xl font-semibold tabular-nums">{money(s.equity)}</span>
                {ret != null && (
                  <span className={`text-sm tabular-nums ${ret >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {ret >= 0 ? "+" : ""}
                    {pct(ret)}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-zinc-500">from {money(s.startingBalance)} starting</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StrategyDetail({ instanceId, strategyId, onBack }: { instanceId: string; strategyId: string; onBack: () => void }) {
  const qs = `instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`;
  const stats = useQuery({
    queryKey: ["stats", instanceId, strategyId],
    queryFn: () => get<StrategyStats>(`/stats?${qs}`),
    refetchInterval: 10000,
  });
  const equity = useQuery({
    queryKey: ["equity", instanceId, strategyId],
    queryFn: () => get<EquityPoint[]>(`/equity?${qs}`),
    refetchInterval: 10000,
  });
  const trades = useQuery({
    queryKey: ["trades", instanceId, strategyId],
    queryFn: () => get<TradeRow[]>(`/trades?${qs}&limit=30`),
    refetchInterval: 10000,
  });
  const logs = useQuery({
    queryKey: ["logs", instanceId, strategyId],
    queryFn: () => get<LogRow[]>(`/logs?${qs}&limit=30`),
    refetchInterval: 10000,
  });

  const s = stats.data;
  return (
    <div>
      <button onClick={onBack} className="text-sm text-zinc-500 hover:text-zinc-300">
        ← strategies
      </button>
      <h2 className="mt-1 text-xl font-semibold">{strategyId}</h2>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <StatCard label="Equity" value={money(s?.equity)} />
        <StatCard
          label="Return"
          value={pct(s?.returnPct)}
          tone={s?.returnPct == null ? "neutral" : s.returnPct >= 0 ? "good" : "bad"}
        />
        <StatCard
          label="Realized PnL"
          value={money(s?.realizedPnl)}
          tone={s?.realizedPnl == null ? "neutral" : s.realizedPnl >= 0 ? "good" : "bad"}
        />
        <StatCard label="Sharpe" value={num(s?.sharpe)} />
        <StatCard label="Win rate" value={pct(s?.winRate)} />
        <StatCard label="Max DD" value={pct(s?.maxDrawdownPct)} tone={s?.maxDrawdownPct ? "bad" : "neutral"} />
        <StatCard label="Trades" value={String(s?.tradeCount ?? "—")} />
        <StatCard label="Volume" value={num(s?.volume)} />
      </div>

      <section className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h3 className="text-sm font-semibold text-zinc-400">Equity</h3>
        <EquityChart points={equity.data ?? []} />
      </section>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section>
          <h3 className="text-sm font-semibold text-zinc-400">Trades</h3>
          <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <tbody>
                {(trades.data ?? []).map((t) => (
                  <tr key={t.id} className="border-t border-zinc-800 first:border-t-0">
                    <td className="p-2 text-zinc-500">{ts(t.ts)}</td>
                    <td className="p-2">{t.payload.symbol}</td>
                    <td className="p-2">
                      <SidePill side={t.payload.side} />
                    </td>
                    <td className="p-2 tabular-nums">{t.payload.qty}</td>
                    <td className="p-2 tabular-nums">@ {t.payload.price}</td>
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
          <h3 className="text-sm font-semibold text-zinc-400">Recent logs</h3>
          <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
            {(logs.data ?? []).map((l) => (
              <div key={l.id} className="flex items-start gap-2 border-t border-zinc-800 p-2 text-xs first:border-t-0">
                <span className="whitespace-nowrap text-zinc-500">{ts(l.ts)}</span>
                <span className={`rounded-full px-1.5 ${LEVEL_COLOR[l.level] ?? ""}`}>{l.level}</span>
                <span className="text-zinc-300">{l.message}</span>
              </div>
            ))}
            {(logs.data ?? []).length === 0 && <div className="p-4 text-center text-sm text-zinc-600">No logs yet</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
