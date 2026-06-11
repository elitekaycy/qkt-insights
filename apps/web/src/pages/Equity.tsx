import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type StrategyRow } from "../api";
import { ComparisonChart, type ComparisonSeries } from "../components/EquityChart";

const PALETTE = ["#34d399", "#60a5fa", "#f59e0b", "#f87171", "#a78bfa", "#22d3ee", "#f472b6", "#a3e635"];

export default function Equity({ instanceId }: { instanceId: string | null }) {
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  const ids = (strategies.data ?? []).map((s) => s.strategyId);
  const curves = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["equity", instanceId, id],
      queryFn: () =>
        get<EquityPoint[]>(`/equity?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 10000,
    })),
  });

  if (!instanceId) return <p className="text-zinc-500">No instance selected.</p>;

  const series: ComparisonSeries[] = ids
    .map((id, i) => {
      const pts = curves[i]?.data ?? [];
      const base = pts[0]?.equity;
      return {
        strategyId: id,
        color: PALETTE[i % PALETTE.length]!,
        points: base ? pts.map((p) => ({ ts: p.ts, pct: (p.equity / base - 1) * 100 })) : [],
      };
    })
    .filter((s) => s.points.length > 0);

  return (
    <div>
      <h2 className="text-xl font-semibold">Equity</h2>
      <p className="mt-1 text-sm text-zinc-500">
        All strategies on {instanceId}, normalized to % change from their first snapshot so different capital sizes compare fairly.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        {series.map((s) => (
          <span key={s.strategyId} className="flex items-center gap-1.5 text-sm text-zinc-300">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
            {s.strategyId}
          </span>
        ))}
      </div>

      <section className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <ComparisonChart series={series} />
      </section>
    </div>
  );
}
