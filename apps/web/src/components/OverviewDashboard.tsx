import type { ReactNode } from "react";
import type { AccountRiskRow, ClosedTradeRow, DayNet, ExcursionStats } from "../api";
import { compact, count, DASH, duration, money, pct, pctValue, pnl, polarity, quantity, ratio, signedMoney } from "../format";
import { ChartCard } from "./ChartCard";
import { chartColors, EChart, qktChartAxis, qktChartGrid, qktChartTooltip, qktXAxis, tipHtml, tok, zeroLine, type QktChartOption } from "./EChart";
import { Card, Pnl } from "./ui";

export type DashboardWidgetId = "pnl" | "risk" | "behavior" | "direction" | "excursions";
type WidgetSize = "medium" | "large";
interface Placement { id: DashboardWidgetId; size: WidgetSize }

// Full-width charts anchor the view; the metric tiles then run as one uniform
// band so like sits next to like. Order: headline P&L chart, the excursion
// scatter, then every metric tile. The win rate is a tile in Account
// performance, and strategy equity lives on Equity & risk.
const DEFAULT_LAYOUT: Placement[] = [
  { id: "pnl", size: "large" },
  { id: "excursions", size: "large" },
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
  accountOpenPnl: number | null;
  /** Each venue account's drawdown and daily loss against its own limits. */
  risk: AccountRiskRow[];
}

export function OverviewDashboard({ data }: { data: OverviewDashboardData }) {
  return (
    <section className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-12">
      {DEFAULT_LAYOUT.map((item) => (
        <div key={item.id} className={`${SIZE_CLASS[item.size]} min-w-0`}>
          <Widget id={item.id} data={data} />
        </div>
      ))}
    </section>
  );
}

function Widget({ id, data }: { id: DashboardWidgetId; data: OverviewDashboardData }) {
  if (id === "pnl") return <PnlWidget data={data} />;
  if (id === "risk") return <RiskWidget data={data} />;
  if (id === "behavior") return <BehaviorWidget closes={data.closes} sumWins={data.sumWins} sumLosses={data.sumLosses} />;
  if (id === "direction") return <DirectionWidget closes={data.closes} />;
  return <ExcursionWidget rows={data.excursions} />;
}

function PnlWidget({ data }: { data: OverviewDashboardData }) {
  const rows = data.dailyNets;
  let cumulative = 0;
  const cum = rows.map((x) => (cumulative += x.net));
  const total = rows.reduce((a, x) => a + x.net, 0);
  const option: QktChartOption = {
    grid: { ...qktChartGrid, top: 16 },
    tooltip: {
      ...qktChartTooltip(),
      axisPointer: { type: "shadow", shadowStyle: { color: tok("hover") } },
      formatter: (params: unknown) => {
        const i = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
        const row = rows[i];
        if (!row) return "";
        return tipHtml(`${weekday(row.day)} ${row.day} · UTC day`, { text: pnl(row.net), tone: polarity(row.net) }, [
          ["Closed trades", count(row.trades)],
          ["Cumulative", signedMoney(cum[i])],
        ]);
      },
    },
    xAxis: { type: "category", data: rows.map((x) => x.day), boundaryGap: true, ...qktXAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => compact(v) } },
    series: [
      {
        name: "daily",
        type: "bar",
        barMaxWidth: 18,
        barCategoryGap: "25%",
        data: rows.map((x) => ({ value: x.net, itemStyle: { color: x.net >= 0 ? chartColors.gain : chartColors.loss, borderRadius: x.net >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })),
        markLine: zeroLine(),
      },
      { name: "cumulative", type: "line", showSymbol: false, smooth: false, data: cum, lineStyle: { color: chartColors.primary, width: 2 }, itemStyle: { color: chartColors.primary } },
    ],
  };
  return (
    <ChartCard
      title="Daily and cumulative P&L"
      description="Realized results by UTC close day; bars are daily, line is cumulative."
      meta={`${count(rows.reduce((a, x) => a + x.trades, 0))} closed trades`}
      value={<Pnl value={total} />}
    >
      {rows.length > 0 ? (
        <div className="p-3 sm:p-4">
          <EChart option={option} height={300} label="Daily realized P&L bars with the cumulative line" />
        </div>
      ) : (
        <WidgetEmpty>Closed trades will build the daily P&L history.</WidgetEmpty>
      )}
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
        <div key={r.account} className="grid gap-5 border-b border-line p-4 sm:grid-cols-2">
          {data.risk.length > 1 && <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted sm:col-span-2">{r.label}</div>}
          <Budget
            label={`Daily loss · ${r.dailyLoss.includesFloating ? "incl. floating" : "realized"}`}
            used={r.dailyLoss.used}
            cap={r.dailyLoss.cap}
            detail={`day from ${String(r.dailyLoss.resetHour).padStart(2, "0")}:00 ${r.dailyLoss.timezone} · realized ${signedMoney(r.dailyLoss.realizedToday)}`}
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
      <div className="grid grid-cols-2 gap-px bg-line">
        <Metric label="Open P&L" value={<Pnl value={data.accountOpenPnl} />} />
        <Metric label={one?.startBalanceSource === "first recorded balance" ? "Account capital · first balance" : "Account capital · start balance"} value={money(capital)} />
      </div>
    </Card>
  );
}

function Budget({ label, used, cap, detail }: { label: string; used: number | null; cap: number | null; detail: string }) {
  const pct = used != null && cap != null && cap > 0 ? (used / cap) * 100 : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3"><span className="text-xs font-semibold text-body">{label}</span><span className="text-xs text-muted">{money(used)} / {cap == null ? "no cap" : money(cap)}</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised"><div className={`h-full rounded-full ${pct != null && pct >= 80 ? "bg-loss-fill" : pct != null && pct >= 55 ? "bg-warn" : "bg-info"}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} /></div>
      <div className="mt-1.5 text-[11px] text-faint">{pct == null ? detail : `${pctValue(pct, 1)} used · ${detail}`}</div>
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
      <div className="grid grid-cols-2 gap-px bg-line">
        <Metric label="Current streak" value={streak === 0 ? DASH : `${Math.abs(streak)} ${streak > 0 ? "wins" : "losses"}`} tone={streak > 0 ? "up" : streak < 0 ? "down" : undefined} />
        <Metric label="Average hold" value={held.length > 0 ? duration(held.reduce((a, x) => a + x, 0) / held.length) : DASH} />
        <Metric label="Profit factor" value={ratio(pf)} tone={pf == null ? undefined : pf >= 1 ? "up" : "down"} />
        <Metric label="Expectancy" value={<Pnl value={closes.length > 0 ? closes.reduce((a, x) => a + x.realized, 0) / closes.length : null} />} />
      </div>
    </Card>
  );
}

function DirectionWidget({ closes }: { closes: ClosedTradeRow[] }) {
  const rows = ["LONG", "SHORT"].map((side) => {
    const matches = closes.filter((x) => normalizedSide(x.side) === side);
    return { side, n: matches.length, net: matches.reduce((a, x) => a + x.realized, 0), qty: matches.reduce((a, x) => a + x.qty, 0) };
  });
  const extent = Math.max(...rows.map((x) => Math.abs(x.net)), 1e-9);
  return (
    <Card className="h-full overflow-hidden">
      <WidgetHeader title="Long and short performance" description="Net by direction, with trade count and average size; gains grow right, losses left." />
      <div className="grid gap-3 p-4">
        {rows.map((row) => {
          const w = (Math.abs(row.net) / extent) * 50;
          return (
            <div key={row.side} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 text-sm">
              <span className="text-body">{row.side === "LONG" ? "Long" : "Short"}</span>
              <span className="relative h-2 overflow-hidden rounded bg-raised">
                <span className="absolute inset-y-[-2px] left-1/2 w-px bg-axis" />
                <span
                  className={`absolute inset-y-0 rounded ${row.net >= 0 ? "bg-gain-fill" : "bg-loss-fill"}`}
                  style={{ left: row.net >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }}
                />
              </span>
              <span className="whitespace-nowrap text-right">
                <span className="text-muted">{count(row.n)} · </span>
                <Pnl value={row.net} className="font-semibold" />
              </span>
              <span />
              <span className="col-span-2 -mt-2 text-xs text-muted">avg size {row.n > 0 ? quantity(row.qty / row.n) : DASH}</span>
            </div>
          );
        })}
      </div>
    </Card>
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
    grid: { ...qktChartGrid, top: 24, left: 56, right: 24, bottom: 48 },
    tooltip: {
      ...qktChartTooltip(), trigger: "item",
      formatter: (param: unknown) => {
        const p = param as { data: [number, number, number, string, number] };
        return tipHtml(p.data[3], { text: pnl(p.data[2]), tone: polarity(p.data[2]) }, [
          ["MAE", signedMoney(p.data[0])],
          ["MFE", signedMoney(p.data[1])],
          ["Marks sampled", count(p.data[4])],
        ]);
      },
    },
    xAxis: { type: "value", name: "MAE", nameLocation: "middle", nameGap: 30, ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => compact(v) } },
    yAxis: { type: "value", name: "MFE", ...qktChartAxis, axisLabel: { ...qktChartAxis.axisLabel, formatter: (v: number) => compact(v) } },
    series: [{
      type: "scatter", symbolSize: 10,
      data: samples.map((x) => ({ value: [x.mae, x.mfe, x.exitPnl, x.symbol, x.observations], itemStyle: { color: x.exitPnl >= 0 ? chartColors.gain : chartColors.loss, opacity: 0.82 } })),
    }],
  };
  return (
    <ChartCard title="Trade excursion" description="Maximum adverse versus favorable movement before exit; sampled from stored position valuations." meta={`coverage ${pct(closed > 0 ? samples.length / closed : 0)} · n=${samples.length}/${closed}`} value={medianCapture == null ? DASH : `${pctValue(medianCapture, 1)} median capture of ${captures.length} winners`}>
      {samples.length > 0 ? <div className="p-3 sm:p-4"><EChart option={option} height={310} /></div> : <WidgetEmpty>Position valuation samples will reveal MAE, MFE, and exit capture.</WidgetEmpty>}
    </ChartCard>
  );
}

function WidgetHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-line px-4 py-3">
      <h3 className="text-sm font-medium text-body">{title}</h3>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="bg-panel p-4">
      <div className="text-sm font-medium text-muted">{label}</div>
      <div className={`mt-1.5 text-lg font-headline ${tone === "up" ? "text-gain" : tone === "down" ? "text-loss" : "text-bright"}`}>{value}</div>
    </div>
  );
}

function WidgetEmpty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-52 items-center justify-center px-5 text-center text-sm text-muted">{children}</div>;
}

function weekday(day: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T00:00:00Z`).getUTCDay()]!;
}

function normalizedSide(side: string): "LONG" | "SHORT" {
  return side.toUpperCase() === "BUY" || side.toUpperCase() === "LONG" ? "LONG" : "SHORT";
}
