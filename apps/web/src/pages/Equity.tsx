import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type StrategyRow } from "../api";
import { ComparisonChart, type ComparisonSeries } from "../components/EquityChart";
import { Card, PageHeader, Panel, Pill } from "../components/ui";

const PALETTE = ["#c8f74a", "#5cb8ff", "#a78bfa", "#3fe08c", "#fbbf24", "#ff6b6b", "#f472b6", "#22d3ee"];

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

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

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
      <PageHeader
        title="Equity"
        sub={`All strategies on ${instanceId}, normalized to % change from their first snapshot so different capital sizes compare fairly.`}
        right={
          <div className="flex flex-wrap gap-2">
            {series.map((s) => (
              <Pill key={s.strategyId}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.strategyId}
              </Pill>
            ))}
          </div>
        }
      />

      <Panel className="mt-5" stagger={1} title="All strategies" hint="% change from first snapshot">
        <div className="p-4">
          <ComparisonChart series={series} height={420} />
        </div>
      </Panel>
    </div>
  );
}
