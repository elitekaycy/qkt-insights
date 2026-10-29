import { strategyDisplayName } from "../portfolio";
import { useState } from "react";
import { usePublicPageView } from "../view";
import { useQuery } from "@tanstack/react-query";
import { get, type PerformanceBundle, type StrategyRow } from "../api";
import { DowHourHeatmap, HonestBucketBars, MIN_N, RollingChart } from "../components/EdgeCharts";
import {
  Card, Empty, Loadable, PageHeader, Panel, Pnl, RangeSelect, rangeStart, Select, useRangeParam,
} from "../components/ui";
import { useSearchParam } from "../router";
import { edgeDefault } from "../strategyFilter";

/*
 * The Edge page: WHEN is this account good — day-of-week × hour heatmap,
 * statistically honest weekday/hour bars, and rolling edge stability. All time
 * bucketing is UTC and says so; buckets under MIN_N trades render greyed because
 * thin slices lie.
 */

const WINDOWS = [30, 60, 90] as const;

export function Edge({ instanceId }: { instanceId: string | null }) {
  usePublicPageView("edge");
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 30000,
  });
  const list = strategies.data ?? [];
  const [chosen, setChosen] = useSearchParam("strategy");
  const strategyId = chosen || edgeDefault(list) || "";
  const chosenRow = list.find((s) => s.strategyId === strategyId);
  const [range, setRange] = useRangeParam();
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>(30);
  // under MIN_N closed trades the page shows the counts first; the charts are one click away
  const [anyway, setAnyway] = useState(false);

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

  if (!instanceId) return <div className="p-6"><Empty>Pick an instance to analyze.</Empty></div>;

  const b = perf.data;
  const cells = b?.dowHour ?? null;
  const byDow = b?.breakdowns?.byDow ?? [];
  const byHour = b?.breakdowns?.byHour ?? [];
  const totalTrades = byDow.reduce((a, r) => a + r.trades, 0);

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={strategyId} onChange={(e) => setChosen(e.target.value)}>
        {list.map((s) => <option key={s.strategyId} value={s.strategyId}>{s.dealCount > 0 ? strategyDisplayName(s) : `${strategyDisplayName(s)} · no closed trades`}</option>)}
      </Select>
      <RangeSelect value={range} onChange={setRange} />
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Edge" sub="By hour and weekday, UTC" right={toolbar} />

      {perf.isSuccess && totalTrades > 0 && totalTrades < MIN_N && !anyway && (
        <Card className="p-5">
          <p className="text-sm text-bright">Edge needs {MIN_N} closed trades; {chosenRow ? strategyDisplayName(chosenRow) : strategyId} has {totalTrades}.</p>
          <table className="mt-3 w-full max-w-md text-sm tabular-nums">
            <thead><tr><th className="eyebrow pb-1.5 text-left">Weekday</th><th className="eyebrow pb-1.5 text-right">Trades</th><th className="eyebrow pb-1.5 text-right">Net</th></tr></thead>
            <tbody>
              {byDow.filter((r) => r.trades > 0).map((r) => (
                <tr key={r.key} className="border-t border-line"><td className="py-1.5">{r.key}</td><td className="py-1.5 text-right">{r.trades}</td><td className="py-1.5 text-right"><Pnl value={r.net} glyphs={false} /></td></tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setAnyway(true)} className="mt-3 text-sm font-medium text-accent-ink hover:underline">Show the charts anyway</button>
        </Card>
      )}

      {(!perf.isSuccess || totalTrades === 0 || totalTrades >= MIN_N || anyway) && <>
      <Panel
        title="Day × hour P&L"
        hint={`${perf.isSuccess ? `${totalTrades} trades · ` : ""}faded under ${MIN_N}`}
        className="min-w-0"
      >
        <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="the day × hour matrix" shape="chart">
          {cells && cells.length > 0
            ? (
              <div className="overflow-x-auto p-3">
                {/* wide screens keep 24 labelled columns readable; the chart's own phone layout fits the width */}
                <div className="min-w-0 sm:min-w-[860px]"><DowHourHeatmap cells={cells} /></div>
              </div>
            )
            : <Empty>{chosenRow && chosenRow.dealCount === 0
              ? `No closed trades yet${list.some((s) => s.dealCount > 0) ? ". Pick a strategy that has some above." : ". The charts fill in as trades close."}`
              : "No closed trades in this range."}</Empty>}
        </Loadable>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Weekday P&L" hint={`faded under ${MIN_N} trades`} hintTitle="Bar: net. Whisker: per-trade mean ± standard error. n under each day.">
          <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="weekday buckets" shape="chart">
            {byDow.length > 0 ? <div className="p-3"><HonestBucketBars rows={byDow} /></div> : <Empty>No closed trades yet.</Empty>}
          </Loadable>
        </Panel>
        <Panel title="Hour-of-day P&L" hint={`close hour, UTC · faded under ${MIN_N} trades`}>
          <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="hour buckets" shape="chart">
            {byHour.length > 0 ? <div className="p-3"><HonestBucketBars rows={byHour} /></div> : <Empty>No closed trades yet.</Empty>}
          </Loadable>
        </Panel>
      </div>

      <Panel
        title="Edge stability"
        hint={`rolling ${window} days`}
        hintTitle="Gaps are the warm-up of the window, not zero."
        toolbar={
          <Select value={String(window)} onChange={(e) => setWindow(Number(e.target.value) as (typeof WINDOWS)[number])}>
            {WINDOWS.map((w) => <option key={w} value={w}>{w}d window</option>)}
          </Select>
        }
      >
        <Loadable loading={perf.isPending} error={perf.isError} retry={() => perf.refetch()} what="rolling stats" shape="chart">
          {b?.rolling && b.rolling.length >= window
            ? <div className="p-3"><RollingChart points={b.rolling} window={window} /></div>
            : <Empty>Needs {window} trading days of history{b?.rolling ? ` (has ${b.rolling.length})` : ""}.</Empty>}
        </Loadable>
      </Panel>
      </>}

    </div>
  );
}
