import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type PerformanceBundle, type StrategyRow } from "../api";
import { ComparisonChart, UnderwaterChart, type ComparisonSeries } from "../components/EquityChart";
import { Card, Cell, Empty, PageHeader, Panel, Pill, Row, Select, Table } from "../components/ui";
import { money, tsDay } from "../format";

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

  const [ddStrategy, setDdStrategy] = useState("");
  const focusId = ddStrategy || ids[0] || "";
  const focusIdx = ids.indexOf(focusId);
  const focusCurve = focusIdx >= 0 ? (curves[focusIdx]?.data ?? []) : [];

  const performance = useQuery({
    queryKey: ["performance", instanceId, focusId, "all"],
    queryFn: () =>
      get<PerformanceBundle>(`/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(focusId)}`),
    enabled: !!instanceId && !!focusId,
    refetchInterval: 15000,
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

  const periods = performance.data?.drawdownPeriods ?? [];
  const ddSelect = (
    <Select value={focusId} onChange={(e) => setDdStrategy(e.target.value)}>
      {ids.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </Select>
  );

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
          <ComparisonChart series={series} height={360} />
        </div>
      </Panel>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel stagger={2} title="Underwater" hint="distance below the running equity peak" toolbar={ddSelect}>
          <div className="p-4">
            <UnderwaterChart points={focusCurve} />
          </div>
        </Panel>

        <Panel stagger={3} title="Drawdown periods" hint={focusId} scroll="max-h-[20rem]">
          <Table head={["Peak", "Trough", "Depth", "Length", "Recovery"]}>
            {periods.map((p) => (
              <Row key={p.peakTs}>
                <Cell className="whitespace-nowrap text-muted">{tsDay(p.peakTs).slice(0, 14)}</Cell>
                <Cell className="whitespace-nowrap text-muted">{tsDay(p.troughTs).slice(0, 14)}</Cell>
                <Cell className="font-mono text-down">
                  {money(-p.depth)} <span className="text-faint">({p.depthPct.toFixed(2)}%)</span>
                </Cell>
                <Cell className="font-mono text-muted">{p.lengthDays.toFixed(1)}d</Cell>
                <Cell>
                  {p.recoveryTs != null ? (
                    <Pill tone="up">recovered {p.recoveryDays!.toFixed(1)}d</Pill>
                  ) : (
                    <Pill tone="warn">ongoing</Pill>
                  )}
                </Cell>
              </Row>
            ))}
            {periods.length === 0 && <Empty colSpan={5}>No drawdowns recorded — flat or rising equity.</Empty>}
          </Table>
        </Panel>
      </div>
    </div>
  );
}
