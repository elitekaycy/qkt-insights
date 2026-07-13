import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type PerformanceBundle, type PerformanceReport, type StrategyRow } from "../api";
import { DowHourHeatmap, HonestBucketBars, MIN_N, RollingChart, StrategyRadar } from "../components/EdgeCharts";
import {
  Empty, Loadable, PageHeader, Panel, RangeSelect, rangeStart, Select,
  type RangeKey,
} from "../components/ui";

/*
 * The Edge page: WHEN is this account good — day-of-week × hour heatmap,
 * statistically honest weekday/hour bars, rolling edge stability, and a
 * strategy-comparison radar. All time bucketing is UTC and says so; buckets
 * under MIN_N trades render greyed because thin slices lie.
 */

const WINDOWS = [30, 60, 90] as const;

export function Edge({ instanceId }: { instanceId: string | null }) {
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 30000,
  });
  const list = strategies.data ?? [];
  const [chosen, setChosen] = useState<string>("");
  const strategyId = chosen || list[0]?.strategyId || "";
  const [range, setRange] = useState<RangeKey>("all");
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>(30);

  const qs = instanceId && strategyId
    ? `instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`
    : null;
  const from = rangeStart(range);
  const perf = useQuery({
    queryKey: ["edge-perf", instanceId, strategyId, range, window],
    queryFn: () => get<PerformanceBundle>(
      `/performance?${qs}&include=dowHour,rolling,breakdowns&window=${window}${from > 0 ? `&from=${from}` : ""}`,
    ),
    enabled: !!qs,
    refetchInterval: 30000,
  });

  // Radar: reports for up to the four most active strategies on this instance.
  const radarIds = useMemo(
    () => [...list].sort((a, b) => b.dealCount - a.dealCount).slice(0, 4).map((s) => s.strategyId),
    [list],
  );
  const radarReports = useQueries({
    queries: radarIds.map((id) => ({
      queryKey: ["edge-report", instanceId, id, range],
      queryFn: () => get<{ report: PerformanceReport }>(
        `/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}&include=report${from > 0 ? `&from=${from}` : ""}`,
      ),
      enabled: !!instanceId,
      refetchInterval: 60000,
    })),
  });
  const radarEntries = radarIds
    .map((id, i) => ({ strategyId: id, report: radarReports[i]?.data?.report }))
    .filter((e): e is { strategyId: string; report: PerformanceReport } => e.report != null && e.report.wins + e.report.losses > 0);

  if (!instanceId) return <div className="p-6"><Empty>Pick an instance to analyze.</Empty></div>;

  const b = perf.data;
  const cells = b?.dowHour ?? null;
  const byDow = b?.breakdowns?.byDow ?? [];
  const byHour = b?.breakdowns?.byHour ?? [];
  const totalTrades = byDow.reduce((a, r) => a + r.trades, 0);

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={strategyId} onChange={(e) => setChosen(e.target.value)}>
        {list.map((s) => <option key={s.strategyId} value={s.strategyId}>{s.strategyId}</option>)}
      </Select>
      <RangeSelect value={range} onChange={setRange} />
    </div>
  );

  return (
    <div className="grid gap-5 p-4 sm:p-6">
      <PageHeader
        title="Edge"
        sub="when this strategy makes money — all buckets UTC, grey means not enough data"
        right={toolbar}
      />

      <Panel
        title="Day × hour P&L"
        hint={`close-time buckets, UTC · ${totalTrades} closed trades · cells under n=${MIN_N} desaturated`}
        stagger={0}
        className="min-w-0"
      >
        <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="the day × hour matrix" lines={6}>
          {cells && cells.length > 0
            ? (
              <div className="overflow-x-auto p-3">
                <div className="min-w-[860px]"><DowHourHeatmap cells={cells} /></div>
              </div>
            )
            : <Empty>No closed trades in this range — the heatmap needs exact per-trade data (broker deals or trade.closed).</Empty>}
        </Loadable>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Weekday P&L" hint="net bar · n label · whisker = per-trade mean ± SE" stagger={1}>
          <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="weekday buckets" lines={4}>
            {byDow.length > 0 ? <div className="p-3"><HonestBucketBars rows={byDow} /></div> : <Empty>No per-trade rows yet.</Empty>}
          </Loadable>
        </Panel>
        <Panel title="Hour-of-day P&L" hint="close hour, UTC — mind the n labels before believing a spike" stagger={2}>
          <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="hour buckets" lines={4}>
            {byHour.length > 0 ? <div className="p-3"><HonestBucketBars rows={byHour} /></div> : <Empty>No per-trade rows yet.</Empty>}
          </Loadable>
        </Panel>
      </div>

      <Panel
        title="Edge stability"
        hint={`rolling over the last ${window} daily observations — gaps are warmup, not zero`}
        stagger={3}
        toolbar={
          <Select value={String(window)} onChange={(e) => setWindow(Number(e.target.value) as (typeof WINDOWS)[number])}>
            {WINDOWS.map((w) => <option key={w} value={w}>{w}d window</option>)}
          </Select>
        }
      >
        <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="rolling stats" lines={4}>
          {b?.rolling && b.rolling.length > 1
            ? <div className="p-3"><RollingChart points={b.rolling} /></div>
            : <Empty>Not enough daily history for a rolling view yet.</Empty>}
        </Loadable>
      </Panel>

      <Panel
        title="Strategy comparison"
        hint="outline radar over the instance's most active strategies · axes min-max normalized across those shown"
        stagger={4}
      >
        {radarEntries.length >= 2
          ? <div className="p-3"><StrategyRadar entries={radarEntries} /></div>
          : <Empty>Needs at least two strategies with closed trades to compare.</Empty>}
      </Panel>
    </div>
  );
}
