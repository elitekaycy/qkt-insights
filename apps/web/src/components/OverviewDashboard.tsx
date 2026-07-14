import type { ReactNode } from "react";
import type { ClosedTradeRow, DayNet, ExecutionQuality, ExcursionStats, HealthRow, NormalizedPerformance, PerformanceReport } from "../api";
import { compact, duration, money, num } from "../format";
import { ChartCard } from "./ChartCard";
import { chartColors, EChart, qktChartAxis, qktChartGrid, qktChartTooltip, qktInsideZoom, type QktChartOption } from "./EChart";
import { ComparisonChart, type ComparisonSeries } from "./EquityChart";
import { Card, LiveDot } from "./ui";

export type DashboardWidgetId = "pnl" | "outcomes" | "risk" | "behavior" | "direction" | "equity" | "normalized" | "excursions" | "execution" | "review" | "system";
type WidgetSize = "medium" | "large";
interface Placement { id: DashboardWidgetId; size: WidgetSize }

const DEFAULT_LAYOUT: Placement[] = [
  { id: "pnl", size: "large" },
  { id: "outcomes", size: "medium" },
  { id: "risk", size: "medium" },
  { id: "behavior", size: "medium" },
  { id: "direction", size: "medium" },
  { id: "equity", size: "large" },
  { id: "normalized", size: "medium" },
  { id: "execution", size: "medium" },
  { id: "excursions", size: "large" },
  { id: "review", size: "medium" },
  { id: "system", size: "medium" },
];
const SIZE_CLASS: Record<WidgetSize, string> = {
  medium: "md:col-span-6 xl:col-span-6",
  large: "md:col-span-12 xl:col-span-12",
};

export interface OverviewDashboardData {
  instanceId: string;
  dailyNets: DayNet[];
  closes: ClosedTradeRow[];
  reports: PerformanceReport[];
  normalized: NormalizedPerformance[];
  excursions: ExcursionStats[];
  execution: ExecutionQuality[];
  series: ComparisonSeries[];
  accountEquity: number | null;
  accountBalance: number | null;
  accountOpenPnl: number | null;
  totalAllocated: number;
  dailyLossCap: number | null;
  drawdownCap: number | null;
  health: HealthRow | null;
  recentStateEvents: number;
  strategies: number;
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
  if (id === "behavior") return <BehaviorWidget closes={data.closes} reports={data.reports} />;
  if (id === "direction") return <DirectionWidget closes={data.closes} />;
  if (id === "equity") return <EquityWidget data={data} />;
  if (id === "normalized") return <NormalizedWidget rows={data.normalized} closes={data.closes} />;
  if (id === "excursions") return <ExcursionWidget rows={data.excursions} />;
  if (id === "execution") return <ExecutionWidget rows={data.execution} />;
  if (id === "review") return <ReviewWidget data={data} />;
  return <SystemWidget data={data} />;
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
    graphic: closes.length > 0 ? [{ type: "text", left: "center", top: "35%", style: { text: `${((wins / closes.length) * 100).toFixed(1)}%\nwin rate`, textAlign: "center", fill: "#f2f4f6", font: "600 16px Archivo", lineHeight: 22 } }] : [],
  };
  return (
    <ChartCard title="Trade outcomes" description="Wins, losses, and flat closes across every strategy." meta={`n=${closes.length}`}>
      {closes.length > 0 ? <div className="p-3"><EChart option={option} height={250} /></div> : <WidgetEmpty>No closed trades yet.</WidgetEmpty>}
    </ChartCard>
  );
}

function RiskWidget({ data }: { data: OverviewDashboardData }) {
  const today = new Date().toISOString().slice(0, 10);
  const todayNet = data.dailyNets.find((x) => x.day === today)?.net ?? 0;
  const drawdown = data.accountBalance != null && data.accountEquity != null ? Math.max(0, data.accountBalance - data.accountEquity) : null;
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Risk budget" description="Current consumption of configured loss and drawdown limits." />
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        <Budget label="Daily loss" used={Math.max(0, -todayNet)} cap={data.dailyLossCap} detail={`today ${money(todayNet)} UTC`} />
        <Budget label="Account drawdown" used={drawdown} cap={data.drawdownCap} detail={`equity ${money(data.accountEquity)}`} />
        <Metric label="Open P&L" value={money(data.accountOpenPnl)} tone={(data.accountOpenPnl ?? 0) < 0 ? "down" : "up"} />
        <Metric label="Allocated capital" value={money(data.totalAllocated)} />
      </div>
    </Card>
  );
}

function Budget({ label, used, cap, detail }: { label: string; used: number | null; cap: number | null; detail: string }) {
  const pct = used != null && cap != null && cap > 0 ? Math.min(100, (used / cap) * 100) : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3"><span className="text-xs font-semibold text-body">{label}</span><span className="font-mono text-xs text-muted">{used == null ? "—" : money(used)} / {cap == null ? "no cap" : money(cap)}</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised"><div className={`h-full rounded-full ${pct != null && pct >= 80 ? "bg-down" : pct != null && pct >= 55 ? "bg-warn" : "bg-info"}`} style={{ width: `${pct ?? 0}%` }} /></div>
      <div className="mt-1.5 text-[11px] text-faint">{pct == null ? "Configure the strategy risk cap to activate this budget." : `${pct.toFixed(1)}% used · ${detail}`}</div>
    </div>
  );
}

function BehaviorWidget({ closes, reports }: { closes: ClosedTradeRow[]; reports: PerformanceReport[] }) {
  const chronological = [...closes].sort((a, b) => a.ts - b.ts);
  let streak = 0;
  for (let i = chronological.length - 1; i >= 0; i--) {
    const sign = chronological[i]!.realized > 0 ? 1 : chronological[i]!.realized < 0 ? -1 : 0;
    if (sign === 0) continue;
    if (streak === 0 || Math.sign(streak) === sign) streak += sign;
    else break;
  }
  const held = closes.filter((x) => x.entryTs != null).map((x) => x.ts - x.entryTs!);
  const grossProfit = reports.reduce((a, x) => a + x.grossProfit, 0);
  const grossLoss = reports.reduce((a, x) => a + x.grossLoss, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null;
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

function NormalizedWidget({ rows, closes }: { rows: NormalizedPerformance[]; closes: ClosedTradeRow[] }) {
  const trades = rows.reduce((a, x) => a + x.trades, 0);
  const qty = rows.reduce((a, x) => a + x.totalQty, 0);
  const comparableQuantity = new Set(closes.map((x) => x.symbol)).size <= 1;
  const netPerUnit = comparableQuantity && qty > 0 ? rows.reduce((a, x) => a + (x.netPerUnit ?? 0) * x.totalQty, 0) / qty : null;
  const rrN = rows.reduce((a, x) => a + x.plannedRiskRewardSample, 0);
  const rr = rrN > 0 ? rows.reduce((a, x) => a + (x.averagePlannedRiskReward ?? 0) * x.plannedRiskRewardSample, 0) / rrN : null;
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Size-normalized performance" description="Net per quantity is shown only when every close uses the same instrument unit." />
      <div className="grid grid-cols-2 gap-px bg-line/70">
        <Metric label="Net per unit" value={netPerUnit == null ? "—" : money(netPerUnit)} tone={netPerUnit == null ? undefined : netPerUnit >= 0 ? "up" : "down"} />
        <Metric label="Average quantity" value={trades > 0 && comparableQuantity ? num(qty / trades) : comparableQuantity ? "—" : "mixed units"} />
        <Metric label="Total quantity" value={trades > 0 && comparableQuantity ? num(qty) : comparableQuantity ? "—" : "mixed units"} />
        <Metric label="Planned reward/risk" value={rr == null ? "—" : `${rr.toFixed(2)}R`} />
      </div>
      <div className="border-t border-line/70 px-5 py-3 text-[11px] text-faint">Closed-trade sample n={trades} · planned-risk sample n={rrN}{!comparableQuantity ? " · quantity aggregation withheld across instruments" : ""}</div>
    </Card>
  );
}

function ExcursionWidget({ rows }: { rows: ExcursionStats[] }) {
  const samples = rows.flatMap((x) => x.rows);
  const closed = rows.reduce((a, x) => a + x.closedTrades, 0);
  const captureRows = samples.filter((x) => x.capturePct != null);
  const averageCapture = captureRows.length > 0 ? captureRows.reduce((a, x) => a + x.capturePct!, 0) / captureRows.length : null;
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
    <ChartCard title="Trade excursion" description="Maximum adverse versus favorable movement before exit; sampled from stored position valuations." meta={`coverage ${closed > 0 ? ((samples.length / closed) * 100).toFixed(1) : "0.0"}% · n=${samples.length}/${closed}`} value={averageCapture == null ? "—" : `${averageCapture.toFixed(1)}% captured`}>
      {samples.length > 0 ? <div className="p-3 sm:p-4"><EChart option={option} height={310} /></div> : <WidgetEmpty>Position valuation samples will reveal MAE, MFE, and exit capture.</WidgetEmpty>}
    </ChartCard>
  );
}

function ExecutionWidget({ rows }: { rows: ExecutionQuality[] }) {
  const submitted = rows.reduce((a, x) => a + x.submitted, 0);
  const accepted = rows.reduce((a, x) => a + x.accepted, 0);
  const rejected = rows.reduce((a, x) => a + x.rejected, 0);
  const acceptMs = accepted > 0 ? rows.reduce((a, x) => a + (x.averageAcceptMs ?? 0) * x.accepted, 0) / accepted : null;
  const p95s = rows.map((x) => x.p95FillMs).filter((x): x is number => x != null);
  const slipN = rows.reduce((a, x) => a + x.slippageSample, 0);
  const slippage = slipN > 0 ? rows.reduce((a, x) => a + (x.averageAdverseSlippage ?? 0) * x.slippageSample, 0) / slipN : null;
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Execution quality" description="Order acceptance, fill latency, rejection, and adverse price slippage." />
      <div className="grid grid-cols-2 gap-px bg-line/70">
        <Metric label="Rejection rate" value={submitted > 0 ? `${((rejected / submitted) * 100).toFixed(1)}%` : "—"} tone={rejected > 0 ? "down" : undefined} />
        <Metric label="Average accept" value={acceptMs == null ? "—" : duration(acceptMs)} />
        <Metric label="Worst strategy p95 fill" value={p95s.length > 0 ? duration(Math.max(...p95s)) : "—"} />
        <Metric label="Adverse slippage" value={slippage == null ? "—" : num(slippage)} tone={slippage != null && slippage > 0 ? "down" : undefined} />
      </div>
      <div className="border-t border-line/70 px-5 py-3 text-[11px] text-faint">Submitted n={submitted} · slippage sample n={slipN}</div>
    </Card>
  );
}

function ReviewWidget({ data }: { data: OverviewDashboardData }) {
  const closed = data.closes.length;
  const total = data.closes.reduce((a, x) => a + x.realized, 0);
  const excursionRows = data.excursions.flatMap((x) => x.rows);
  const capture = excursionRows.filter((x) => x.capturePct != null);
  const averageCapture = capture.length > 0 ? capture.reduce((a, x) => a + x.capturePct!, 0) / capture.length : null;
  const submitted = data.execution.reduce((a, x) => a + x.submitted, 0);
  const rejected = data.execution.reduce((a, x) => a + x.rejected, 0);
  const notes: string[] = [];
  if (closed < 20) notes.push(`Treat performance as early evidence: only ${closed} closed trades are available.`);
  if (averageCapture != null && averageCapture < 40) notes.push(`Exit capture averages ${averageCapture.toFixed(1)}%; review profit-taking and giveback.`);
  if (submitted > 0 && rejected / submitted >= 0.05) notes.push(`${((rejected / submitted) * 100).toFixed(1)}% of submitted orders were rejected; inspect sizing and venue constraints.`);
  if (total < 0) notes.push(`Realized P&L is ${money(total)}; compare the weakest symbols, directions, and holding periods.`);
  if (notes.length === 0) notes.push("No immediate exception stands out. Continue monitoring sample size, execution, and risk consumption.");
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Review focus" description="Deterministic prompts from the current evidence; not an AI verdict or trading advice." />
      <ol className="grid gap-3 p-5">
        {notes.slice(0, 4).map((note, index) => <li key={note} className="flex gap-3 text-sm leading-relaxed text-body"><span className="font-mono text-xs text-accent">0{index + 1}</span><span>{note}</span></li>)}
      </ol>
    </Card>
  );
}

function SystemWidget({ data }: { data: OverviewDashboardData }) {
  const fresh = data.health != null && Date.now() - data.health.lastSeen < 30_000;
  const rows: Array<[string, ReactNode]> = [
    ["Instance", <span className="flex items-center gap-2"><LiveDot on={fresh} />{fresh ? "live" : "idle"}</span>],
    ["Broker state", data.recentStateEvents > 0 ? `${data.recentStateEvents} recent` : "waiting"],
    ["Collector queue", data.health?.insightsQueued ?? "—"],
    ["Delivery backlog", data.health?.insightsJournalPending ?? "—"],
    ["Strategies", data.strategies],
  ];
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="System health" description="Transport and collector state; operational, not performance data." />
      <div className="grid gap-3 p-5 text-sm">
        {rows.map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4"><span className="text-muted">{label}</span><span className="font-mono text-bright">{value}</span></div>)}
      </div>
    </Card>
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
