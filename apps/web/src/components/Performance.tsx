import { Bar, BarChart, CartesianGrid, Cell as RechartsCell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BreakdownRow, PerformanceBundle, PerformanceReport, TradeBreakdowns } from "../api";
import { money, num } from "../format";
import { Cell, Empty, Panel, Pill, Row, Stat, Table, type Tone } from "./ui";

/*
 * The performance tab of a strategy: profitability, risk, and streak panels fed
 * by one /performance bundle. Phase-1 values derive from realized deltas between
 * equity snapshots — close enough to act on, marked "≈" until trade.closed lands.
 */

function pf(v: PerformanceReport["profitFactor"]): string {
  if (v == null) return "—";
  if (v === "inf") return "∞";
  return v.toFixed(2);
}

/** Percent values that arrive already scaled to 0–100. */
function pcts(v: number | null | undefined, digits = 1): string {
  if (v == null) return "—";
  return `${v.toFixed(digits)}%`;
}

function toneOf(v: number | null | undefined): Tone {
  if (v == null) return "neutral";
  return v >= 0 ? "up" : "down";
}

export function Approx({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      className="ml-auto cursor-help text-xs text-faint"
      title="Approximate: derived from realized-P&L changes between equity snapshots. Becomes exact once this instance runs a qkt version that publishes trade.closed events."
    >
      ≈ approximate
    </span>
  );
}

export function PerformancePanels({ bundle }: { bundle: PerformanceBundle }) {
  const r = bundle.report;
  const noTrades = r.wins + r.losses === 0;
  if (noTrades) {
    return (
      <Panel title="Performance" stagger={0}>
        <Empty>No closed trades in this range yet.</Empty>
      </Panel>
    );
  }

  const streakTone: Tone = r.currentStreak <= -3 ? "warn" : toneOf(r.currentStreak);
  return (
    <div className="grid gap-5">
      <Panel title="Profitability" stagger={0} right={<Approx on={r.approximate} />}>
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Stat label="Profit factor" value={pf(r.profitFactor)} tone={r.profitFactor === "inf" || (typeof r.profitFactor === "number" && r.profitFactor >= 1) ? "up" : "down"} />
          <Stat label="Expectancy" value={money(r.expectancy)} tone={toneOf(r.expectancy)} sub="avg P&L per trade" />
          <Stat label="Win rate" value={pcts(r.winRate)} sub={`${r.wins}W · ${r.losses}L`} />
          <Stat label="Kelly" value={r.kelly == null ? "—" : pcts(r.kelly * 100)} sub="suggested risk fraction" />
          <Stat label="Avg win" value={money(r.avgWin)} tone="up" />
          <Stat label="Avg loss" value={r.avgLoss == null ? "—" : money(-r.avgLoss)} tone={r.avgLoss == null ? "neutral" : "down"} />
          <Stat label="Payoff ratio" value={num(r.payoffRatio)} />
          <Stat label="Total net" value={money(r.totalNet)} tone={toneOf(r.totalNet)} />
          <Stat label="Gross profit" value={money(r.grossProfit)} tone="up" />
          <Stat label="Gross loss" value={money(-r.grossLoss)} tone={r.grossLoss > 0 ? "down" : "neutral"} />
          <Stat label="Largest win" value={money(r.largestWin)} tone="up" />
          <Stat label="Largest loss" value={r.largestLoss == null ? "—" : money(-r.largestLoss)} tone={r.largestLoss == null ? "neutral" : "down"} />
        </div>
      </Panel>

      <Panel title="Risk" stagger={1}>
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Stat label="Max drawdown" value={pcts(r.maxDrawdownPct)} tone={r.maxDrawdownPct ? "down" : "neutral"} sub={r.maxDrawdownAbs != null ? money(-r.maxDrawdownAbs) : undefined} />
          <Stat label="DD duration" value={r.drawdownDurationDays == null ? "—" : `${r.drawdownDurationDays.toFixed(1)}d`} sub="longest underwater" />
          <Stat label="Recovery factor" value={num(r.recoveryFactor)} sub="net / max DD" />
          <Stat label="Sharpe" value={num(r.sharpe)} sub="annualized, 252d" />
          <Stat label="Sortino" value={num(r.sortino)} sub="downside-only vol" />
          <Stat label="Calmar" value={num(r.calmar)} sub="return / max DD" />
          <Stat label="Best day" value={money(r.bestDay)} tone="up" />
          <Stat label="Worst day" value={money(r.worstDay)} tone={r.worstDay != null && r.worstDay < 0 ? "down" : "neutral"} />
        </div>
      </Panel>

      <Panel title="Streaks" stagger={2} right={<Approx on={r.approximate} />}>
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Stat
            label="Current streak"
            value={r.currentStreak === 0 ? "—" : `${r.currentStreak > 0 ? "+" : ""}${r.currentStreak}`}
            tone={streakTone}
            sub={r.currentStreak <= -3 ? "tilt risk — slow down" : r.currentStreak > 0 ? "winning run" : r.currentStreak < 0 ? "losing run" : undefined}
          />
          <Stat label="Max win streak" value={String(r.maxWinStreak)} tone="up" />
          <Stat label="Max loss streak" value={String(r.maxLossStreak)} tone={r.maxLossStreak > 0 ? "down" : "neutral"} />
          <Stat label="Profitable days" value={`${r.profitableDays}/${r.daysTraded}`} sub={`avg day ${money(r.avgDayPnl)}`} />
        </div>
        {bundle.postLoss.length > 0 && (
          <div className="border-t border-line">
            <div className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              After N consecutive losses, the next trade…
            </div>
            <Table head={["Losses in a row", "Times seen", "Next-trade win rate", "Next-trade avg P&L"]}>
              {bundle.postLoss.map((p) => (
                <Row key={p.n}>
                  <Cell className="font-mono">{p.n}</Cell>
                  <Cell className="font-mono text-muted">{p.sample}</Cell>
                  <Cell>
                    <Pill tone={p.nextWinRate >= 50 ? "up" : "down"}>{p.nextWinRate.toFixed(0)}%</Pill>
                  </Cell>
                  <Cell className={`font-mono ${p.nextAvg >= 0 ? "text-up" : "text-down"}`}>{money(p.nextAvg)}</Cell>
                </Row>
              ))}
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}

const BAR_TOOLTIP = {
  background: "var(--color-raised)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: 10,
  fontSize: 12,
  fontFamily: "var(--font-mono)",
} as const;

function BreakdownBars({ rows, title, hint, stagger }: { rows: BreakdownRow[]; title: string; hint?: string; stagger?: number }) {
  return (
    <Panel title={title} hint={hint} stagger={stagger}>
      <div className="p-4">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="key" tick={{ stroke: "var(--color-faint)", fontSize: 11, fontFamily: "var(--font-mono)" }} tickLine={false} axisLine={false} />
            <YAxis tick={{ stroke: "var(--color-faint)", fontSize: 11, fontFamily: "var(--font-mono)" }} tickLine={false} axisLine={false} width={56} />
            <Tooltip
              contentStyle={BAR_TOOLTIP}
              cursor={{ fill: "var(--color-raised)" }}
              formatter={(value: unknown, name) => [name === "net" ? money(Number(value)) : String(value), String(name)]}
            />
            <Bar dataKey="net" radius={[4, 4, 0, 0]}>
              {rows.map((r) => (
                <RechartsCell key={r.key} fill={r.net >= 0 ? "var(--color-up)" : "var(--color-down)"} fillOpacity={0.75} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

/** Exact, per-close charts — only rendered once trade.closed data exists for the range. */
export function BreakdownPanels({ b }: { b: TradeBreakdowns }) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <BreakdownBars rows={b.bySymbol} title="By symbol" hint="net P&L" stagger={3} />
      <BreakdownBars rows={b.byDow} title="By day of week" hint="net P&L, UTC" stagger={3} />
      <BreakdownBars rows={b.byHour} title="By hour" hint="net P&L, UTC entry hour" stagger={4} />
      <BreakdownBars
        rows={b.distribution.map((d) => ({ key: money((d.from + d.to) / 2), net: d.count, trades: d.count, wins: 0 }))}
        title="P&L distribution"
        hint="trade count per bucket"
        stagger={4}
      />
      <BreakdownBars rows={b.byVolume} title="By lot size" hint="net P&L" stagger={5} />
      {b.holdTime && <BreakdownBars rows={b.holdTime} title="By hold time" hint="net P&L" stagger={5} />}
    </div>
  );
}
