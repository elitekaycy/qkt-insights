import type { ReactNode } from "react";
import type { AccountRiskRow, ClosedTradeRow, DayNet, ExcursionStats } from "../api";
import { compact, duration, fixed, money } from "../format";
import { ChartCard } from "./ChartCard";
import { chartColors, EChart, qktChartAxis, qktChartGrid, qktChartTooltip, qktInsideZoom, type QktChartOption } from "./EChart";
import { ComparisonChart, type ComparisonSeries } from "./EquityChart";
import { Card } from "./ui";

export type DashboardWidgetId = "pnl" | "outcomes" | "risk" | "behavior" | "direction" | "equity" | "excursions";
type WidgetSize = "medium" | "large";
interface Placement { id: DashboardWidgetId; size: WidgetSize }

// Full-width charts anchor the view; the metric tiles then run as one uniform
// band so like sits next to like instead of a pie beside progress bars beside
// number cells. Order: headline P&L and equity charts, the excursion scatter,
// then every metric tile.
const DEFAULT_LAYOUT: Placement[] = [
  { id: "pnl", size: "large" },
  { id: "equity", size: "large" },
  { id: "excursions", size: "large" },
  { id: "outcomes", size: "medium" },
  { id: "direction", size: "medium" },
  { id: "risk", size: "medium" },
  { id: "behavior", size: "medium" },
];
const SIZE_CLASS: Record<WidgetSize, string> = {
  medium: "md:col-span-6 xl:col-span-6",
  large: "md:col-span-12 xl:col-span-12",
};

export interface OverviewDashboardData {
  instanceId: string;
  dailyNets: DayNet[];
  closes: ClosedTradeRow[];
  /** Sums of winning and (positive) losing closes' net, the profit-factor terms. */
  sumWins: number;
  sumLosses: number;
  excursions: ExcursionStats[];
  series: ComparisonSeries[];
  accountEquity: number | null;
  accountOpenPnl: number | null;
  /** Each venue account's drawdown and daily loss against its own limits. */
  risk: AccountRiskRow[];
}

export function OverviewDashboard({ data }: { data: OverviewDashboardData }) {
  return (
    <section className="mt-7">
      <div className="rise">
        <h3 className="text-lg font-semibold text-bright">Dashboard</h3>
        <p className="mt-0.5 text-xs text-muted">Performance, risk, behavior, and runtime truth in one complete view.</p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12">
        {DEFAULT_LAYOUT.map((item) => (
          <div key={item.id} className={`${SIZE_CLASS[item.size]} min-w-0`}>
            <Widget id={item.id} data={data} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Widget({ id, data }: { id: DashboardWidgetId; data: OverviewDashboardData }) {
  if (id === "pnl") return <PnlWidget data={data} />;
  if (id === "outcomes") return <OutcomeWidget closes={data.closes} />;
  if (id === "risk") return <RiskWidget data={data} />;
  if (id === "behavior") return <BehaviorWidget closes={data.closes} sumWins={data.sumWins} sumLosses={data.sumLosses} />;
  if (id === "direction") return <DirectionWidget closes={data.closes} />;
  if (id === "equity") return <EquityWidget data={data} />;
  return <ExcursionWidget rows={data.excursions} />;
}

function PnlWidget({ data }: { data: OverviewDashboardData }) {
  const rows = data.dailyNets;
  let cumulative = 0;
  const cumulativeRows = rows.map((x) => [x.day, cumulative += x.net]);
  const total = rows.reduce((a, x) => a + x.net, 0);
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: { ...qktChartGrid, top: 24 },
    tooltip: {
      ...qktChartTooltip(), trigger: "axis",
      formatter: (params: unknown) => {
        const list = params as Array<{ dataIndex: number }>;
        const row = rows[list[0]?.dataIndex ?? 0];
        return row ? `${row.day} UTC<br/>daily <b>${money(row.net)}</b> · ${row.trades} closes<br/>cumulative ${money(cumulativeRows[list[0]?.dataIndex ?? 0]?.[1] as number)}` : "";
      },
    },
    dataZoom: qktInsideZoom(),
    xAxis: { type: "category", data: rows.map((x) => x.day), boundaryGap: true, ...qktChartAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => compact(v) } },
    series: [
      { name: "daily", type: "bar", barMaxWidth: 18, data: rows.map((x) => ({ value: x.net, itemStyle: { color: x.net >= 0 ? chartColors.up : chartColors.down, borderRadius: x.net >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })) },
      { name: "cumulative", type: "line", showSymbol: false, smooth: false, data: cumulativeRows.map((x) => x[1]), lineStyle: { color: chartColors.primary, width: 2 } },
    ],
  };
  return (
    <ChartCard title="Daily and cumulative P&L" description="Realized results by UTC close day; bars are daily, line is cumulative." meta={`${rows.reduce((a, x) => a + x.trades, 0)} closed trades`} value={<span className={total >= 0 ? "text-up" : "text-down"}>{money(total)}</span>}>
      {rows.length > 0 ? <div className="p-3 sm:p-4"><EChart option={option} height={300} /></div> : <WidgetEmpty>Closed trades will build the daily P&L history.</WidgetEmpty>}
    </ChartCard>
  );
}

function OutcomeWidget({ closes }: { closes: ClosedTradeRow[] }) {
  const wins = closes.filter((x) => x.realized > 0).length;
  const losses = closes.filter((x) => x.realized < 0).length;
  const flat = closes.length - wins - losses;
  const option: QktChartOption = {
    backgroundColor: "transparent",
    tooltip: { ...qktChartTooltip(), trigger: "item", formatter: "{b}<br/><b>{c}</b> trades · {d}%" },
    legend: { bottom: 0, textStyle: { color: chartColors.muted, fontFamily: "Archivo, system-ui, sans-serif" } },
    series: [{ type: "pie", radius: ["58%", "78%"], center: ["50%", "43%"], avoidLabelOverlap: true, label: { show: false }, itemStyle: { borderColor: "#121518", borderWidth: 2, borderRadius: 3 }, data: [
      { name: "Wins", value: wins, itemStyle: { color: chartColors.up } },
      { name: "Breakeven", value: flat, itemStyle: { color: chartColors.muted } },
      { name: "Losses", value: losses, itemStyle: { color: chartColors.down } },
    ] }],
    graphic: wins + losses > 0 ? [{ type: "text", left: "center", top: "35%", style: { text: `${((wins / (wins + losses)) * 100).toFixed(1)}%\nwin rate`, textAlign: "center", fill: "#f2f4f6", font: "600 16px Archivo", lineHeight: 22 } }] : [],
  };
  return (
    <ChartCard title="Trade outcomes" description="Wins, losses, and breakeven closes on the account; the win rate excludes breakeven." meta={`n=${closes.length}`}>
      {closes.length > 0 ? <div className="p-3"><EChart option={option} height={250} /></div> : <WidgetEmpty>No closed trades yet.</WidgetEmpty>}
    </ChartCard>
  );
}

function RiskWidget({ data }: { data: OverviewDashboardData }) {
  const capital = data.risk.reduce<number | null>((a, r) => (r.startBalance == null ? a : (a ?? 0) + r.startBalance), null);
  const one = data.risk.length === 1 ? data.risk[0]! : null;
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Risk budget" description="Consumption of each account's loss and drawdown limits; limits belong to the account, never summed per strategy." />
      {data.risk.length === 0 && <WidgetEmpty>Account limits appear with the first broker account rollup.</WidgetEmpty>}
      {data.risk.map((r) => (
        <div key={r.account} className="grid gap-5 border-b border-line/70 p-5 sm:grid-cols-2">
          {data.risk.length > 1 && <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted sm:col-span-2">{r.label}</div>}
          <Budget
            label={`Daily loss · ${r.dailyLoss.includesFloating ? "incl. floating" : "realized"}`}
            used={r.dailyLoss.used}
            cap={r.dailyLoss.cap}
            detail={`day from ${String(r.dailyLoss.resetHour).padStart(2, "0")}:00 ${r.dailyLoss.timezone} · realized ${money(r.dailyLoss.realizedToday)}`}
          />
          <Budget
            label={`Account drawdown · ${r.basis === "static" ? "static" : "from peak"}`}
            used={r.drawdown.used}
            cap={r.drawdown.cap}
            detail={`${r.basis === "static" ? "below start balance" : "below peak equity"} ${money(r.drawdown.reference)} · equity ${money(r.equity)}`}
          />
          <div className="text-[11px] text-faint sm:col-span-2">
            {r.source == null ? "No limits configured: set INSIGHTS_ACCOUNT_LIMITS or the strategies' qkt risk caps." : `Limits from ${r.source}.`}
          </div>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-px bg-line/70">
        <Metric label="Open P&L" value={money(data.accountOpenPnl)} tone={(data.accountOpenPnl ?? 0) < 0 ? "down" : "up"} />
        <Metric label={one?.startBalanceSource === "first recorded balance" ? "Account capital · first balance" : "Account capital · start balance"} value={money(capital)} />
      </div>
    </Card>
  );
}

function Budget({ label, used, cap, detail }: { label: string; used: number | null; cap: number | null; detail: string }) {
  const pct = used != null && cap != null && cap > 0 ? (used / cap) * 100 : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3"><span className="text-xs font-semibold text-body">{label}</span><span className="font-mono text-xs text-muted">{used == null ? "—" : money(used)} / {cap == null ? "no cap" : money(cap)}</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised"><div className={`h-full rounded-full ${pct != null && pct >= 80 ? "bg-down" : pct != null && pct >= 55 ? "bg-warn" : "bg-info"}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} /></div>
      <div className="mt-1.5 text-[11px] text-faint">{pct == null ? detail : `${pct.toFixed(1)}% used · ${detail}`}</div>
    </div>
  );
}

function BehaviorWidget({ closes, sumWins, sumLosses }: { closes: ClosedTradeRow[]; sumWins: number; sumLosses: number }) {
  const chronological = [...closes].sort((a, b) => a.ts - b.ts);
  let streak = 0;
  for (let i = chronological.length - 1; i >= 0; i--) {
    const sign = chronological[i]!.realized > 0 ? 1 : chronological[i]!.realized < 0 ? -1 : 0;
    if (sign === 0) continue;
    if (streak === 0 || Math.sign(streak) === sign) streak += sign;
    else break;
  }
  const held = closes.filter((x) => x.entryTs != null).map((x) => x.ts - x.entryTs!);
  const pf = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? Infinity : null;
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Trading behavior" description="Compact context for pace, streaks, and payoff." />
      <div className="grid grid-cols-2 gap-px bg-line/70">
        <Metric label="Current streak" value={streak === 0 ? "—" : `${Math.abs(streak)} ${streak > 0 ? "wins" : "losses"}`} tone={streak > 0 ? "up" : streak < 0 ? "down" : undefined} />
        <Metric label="Average hold" value={held.length > 0 ? duration(held.reduce((a, x) => a + x, 0) / held.length) : "—"} />
        <Metric label="Profit factor" value={pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2)} tone={pf != null && pf >= 1 ? "up" : "down"} />
        <Metric label="Expectancy" value={closes.length > 0 ? money(closes.reduce((a, x) => a + x.realized, 0) / closes.length) : "—"} />
      </div>
    </Card>
  );
}

function DirectionWidget({ closes }: { closes: ClosedTradeRow[] }) {
  const rows = ["LONG", "SHORT"].map((side) => {
    const matches = closes.filter((x) => normalizedSide(x.side) === side);
    return { side, n: matches.length, net: matches.reduce((a, x) => a + x.realized, 0), qty: matches.reduce((a, x) => a + x.qty, 0) };
  });
  const extent = Math.max(...rows.map((x) => Math.abs(x.net)), 1);
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Long and short performance" description="Direction contribution with trade count and average size." />
      <div className="grid gap-5 p-5">
        {rows.map((row) => (
          <div key={row.side}>
            <div className="flex items-baseline gap-3"><span className="w-12 text-xs font-semibold text-body">{row.side}</span><span className={`font-mono text-lg font-semibold ${row.net >= 0 ? "text-up" : "text-down"}`}>{money(row.net)}</span><span className="ml-auto text-xs text-faint">n={row.n} · avg qty {row.n > 0 ? (row.qty / row.n).toFixed(2) : "—"}</span></div>
            <div className="mt-2 h-2 rounded-full bg-raised"><div className={`h-full rounded-full ${row.net >= 0 ? "bg-up" : "bg-down"}`} style={{ width: `${Math.max(2, (Math.abs(row.net) / extent) * 100)}%` }} /></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function EquityWidget({ data }: { data: OverviewDashboardData }) {
  return (
    <ChartCard title="Strategy equity" description="Normalized percentage change keeps different capital allocations comparable." meta={`${data.series.length} active series`} value={money(data.accountEquity)}>
      {data.series.length > 0 ? <div className="p-3 sm:p-4"><ComparisonChart series={data.series} height={300} /></div> : <WidgetEmpty>Strategy equity appears after the first stored close or snapshot.</WidgetEmpty>}
    </ChartCard>
  );
}

function ExcursionWidget({ rows }: { rows: ExcursionStats[] }) {
  const samples = rows.flatMap((x) => x.rows);
  const closed = rows.reduce((a, x) => a + x.closedTrades, 0);
  // Median capture of winners: exit P&L over the best open P&L seen, on trades that closed in profit.
  const captures = samples.filter((x) => x.exitPnl > 0 && x.capturePct != null).map((x) => x.capturePct!).sort((a, b) => a - b);
  const mid = Math.floor(captures.length / 2);
  const medianCapture = captures.length === 0 ? null : captures.length % 2 ? captures[mid]! : (captures[mid - 1]! + captures[mid]!) / 2;
  const option: QktChartOption = {
    backgroundColor: "transparent",
    grid: { ...qktChartGrid, top: 24, left: 56, right: 24, bottom: 48 },
    tooltip: {
      ...qktChartTooltip(), trigger: "item",
      formatter: (param: unknown) => {
        const p = param as { data: [number, number, number, string, number] };
        return `${p.data[3]}<br/>MAE <b>${money(p.data[0])}</b> · MFE <b>${money(p.data[1])}</b><br/>exit ${money(p.data[2])} · ${p.data[4]} marks`;
      },
    },
    xAxis: { type: "value", name: "MAE", nameLocation: "middle", nameGap: 30, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => compact(v) } },
    yAxis: { type: "value", name: "MFE", ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => compact(v) } },
    series: [{
      type: "scatter", symbolSize: 10,
      data: samples.map((x) => ({ value: [x.mae, x.mfe, x.exitPnl, x.symbol, x.observations], itemStyle: { color: x.exitPnl >= 0 ? chartColors.up : chartColors.down, opacity: 0.82 } })),
    }],
  };
  return (
    <ChartCard title="Trade excursion" description="Maximum adverse versus favorable movement before exit; sampled from stored position valuations." meta={`coverage ${closed > 0 ? ((samples.length / closed) * 100).toFixed(1) : "0.0"}% · n=${samples.length}/${closed}`} value={medianCapture == null ? "—" : <span title={`median over ${captures.length} winning trades`}>{`${fixed(medianCapture, 1)}% median capture of winners`}</span>}>
      {samples.length > 0 ? <div className="p-3 sm:p-4"><EChart option={option} height={310} /></div> : <WidgetEmpty>Position valuation samples will reveal MAE, MFE, and exit capture.</WidgetEmpty>}
    </ChartCard>
  );
}

function WidgetHeader({ title, description }: { title: string; description: string }) {
  return <div className="border-b border-line/70 px-5 py-3.5"><h3 className="text-[15px] font-semibold text-bright">{title}</h3><p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p></div>;
}

function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: "up" | "down" }) {
  return <div className="bg-panel p-4"><div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</div><div className={`mt-1.5 font-mono text-lg font-semibold ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-bright"}`}>{value}</div></div>;
}

function WidgetEmpty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-52 items-center justify-center px-5 text-center text-sm text-faint">{children}</div>;
}

function normalizedSide(side: string): "LONG" | "SHORT" {
  return side.toUpperCase() === "BUY" || side.toUpperCase() === "LONG" ? "LONG" : "SHORT";
}
