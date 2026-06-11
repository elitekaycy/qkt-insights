import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell as RechartsCell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BreakdownRow, ClosedTradeRow, DayNet, PerformanceBundle, PerformanceReport, TradeBreakdowns } from "../api";
import { duration, money, num, tsDay } from "../format";
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

function outcomeTone(realized: number): Tone {
  return realized > 0 ? "up" : realized < 0 ? "down" : "neutral";
}

/** The trades behind a metric: closed trades with their dollar P&L and outcome. */
function CloseList({ rows, hint }: { rows: ClosedTradeRow[]; hint?: string }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-faint">
        No per-trade rows for this range — exact trade lists need trade.closed events (qkt ≥ 0.41); until then the
        number is approximated from equity snapshots.
      </p>
    );
  }
  return (
    <div>
      {hint && <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{hint}</div>}
      <div className="max-h-72 overflow-auto rounded-lg border border-line">
        <Table head={["Closed", "Symbol", "Outcome", "Qty", "Exit px", "P&L", "Held"]}>
          {rows.map((c, i) => (
            <Row key={`${c.ts}-${c.orderId ?? i}`}>
              <Cell className="whitespace-nowrap text-muted">{tsDay(c.ts)}</Cell>
              <Cell className="font-semibold text-bright">{c.symbol}</Cell>
              <Cell>
                <Pill tone={outcomeTone(c.realized)}>{c.realized > 0 ? "WIN" : c.realized < 0 ? "LOSS" : "FLAT"}</Pill>
              </Cell>
              <Cell className="font-mono">{c.qty}</Cell>
              <Cell className="font-mono text-muted">@ {c.price}</Cell>
              <Cell className={`font-mono font-semibold ${c.realized > 0 ? "text-up" : c.realized < 0 ? "text-down" : "text-muted"}`}>
                {c.realized > 0 ? "+" : ""}
                {money(c.realized)}
              </Cell>
              <Cell className="font-mono text-muted">{c.entryTs != null ? duration(c.ts - c.entryTs) : "—"}</Cell>
            </Row>
          ))}
        </Table>
      </div>
    </div>
  );
}

/** The days behind a day-based metric. */
function DayList({ rows, hint }: { rows: DayNet[]; hint?: string }) {
  if (rows.length === 0) return <p className="text-sm text-faint">No trading days in this range yet.</p>;
  return (
    <div>
      {hint && <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{hint}</div>}
      <div className="max-h-72 overflow-auto rounded-lg border border-line">
        <Table head={["Day", "Net", "Fills"]}>
          {rows.map((d) => (
            <Row key={d.day}>
              <Cell className="font-mono text-muted">{d.day}</Cell>
              <Cell className={`font-mono font-semibold ${d.net > 0 ? "text-up" : d.net < 0 ? "text-down" : "text-muted"}`}>
                {d.net > 0 ? "+" : ""}
                {money(d.net)}
              </Cell>
              <Cell className="font-mono text-muted">{d.trades}</Cell>
            </Row>
          ))}
        </Table>
      </div>
    </div>
  );
}

/** Longest run of closes matching pred, scanning chronologically. */
function longestRun(chron: ClosedTradeRow[], pred: (c: ClosedTradeRow) => boolean): ClosedTradeRow[] {
  let best: ClosedTradeRow[] = [];
  let cur: ClosedTradeRow[] = [];
  for (const c of chron) {
    if (c.realized === 0) continue;
    if (pred(c)) {
      cur.push(c);
      if (cur.length > best.length) best = cur.slice();
    } else {
      cur = [];
    }
  }
  return best;
}

/** The run of closes ending at the latest trade (the current streak). */
function currentRun(chron: ClosedTradeRow[]): ClosedTradeRow[] {
  const out: ClosedTradeRow[] = [];
  for (let i = chron.length - 1; i >= 0; i--) {
    const c = chron[i]!;
    if (c.realized === 0) continue;
    if (out.length === 0 || out[0]!.realized > 0 === c.realized > 0) out.unshift(c);
    else break;
  }
  return out;
}

/** A metric Stat whose hover-expand explains what the number means and how to read it. */
function MStat({
  label,
  value,
  tone,
  sub,
  explain,
  reading,
  detail,
}: {
  label: string;
  value: string;
  tone?: Tone;
  sub?: string;
  /** What the metric is, in plain language. */
  explain: string;
  /** How to read the current value. */
  reading?: string;
  detail?: ReactNode;
}) {
  return (
    <Stat
      label={label}
      value={value}
      tone={tone}
      sub={sub}
      expand={{
        hint: "what this means",
        content: (
          <div className="grid gap-3 p-4 sm:p-5">
            <div className="rounded-lg border border-line bg-raised px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Current value</div>
              <div className={`mt-1 font-mono text-2xl font-semibold ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-bright"}`}>
                {value}
              </div>
              {sub && <div className="mt-0.5 text-xs text-faint">{sub}</div>}
            </div>
            <p className="text-sm leading-relaxed text-body">{explain}</p>
            {reading && <p className="text-sm leading-relaxed text-muted">{reading}</p>}
            {detail}
          </div>
        ),
      }}
    />
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

  // The rows behind the numbers. closes arrive newest-first; chron is oldest-first.
  const closes = bundle.closes;
  const chron = [...closes].reverse();
  const winRows = closes.filter((c) => c.realized > 0);
  const lossRows = closes.filter((c) => c.realized < 0);
  const topWins = [...winRows].sort((a, b) => b.realized - a.realized).slice(0, 10);
  const topLosses = [...lossRows].sort((a, b) => a.realized - b.realized).slice(0, 10);
  const onDay = (net: number | null) => {
    const day = bundle.dailyNets.find((d) => d.net === net)?.day;
    return day ? closes.filter((c) => new Date(c.ts).toISOString().slice(0, 10) === day) : [];
  };
  const bestDayRows = onDay(r.bestDay);
  const worstDayRows = onDay(r.worstDay);
  const worstPeriod = bundle.drawdownPeriods.reduce<(typeof bundle.drawdownPeriods)[number] | null>(
    (a, p) => (a == null || p.depth > a.depth ? p : a),
    null,
  );
  const inWorstPeriod = worstPeriod
    ? closes.filter((c) => c.ts >= worstPeriod.peakTs && c.ts <= (worstPeriod.recoveryTs ?? Infinity))
    : [];

  return (
    <div className="grid gap-5">
      <Panel title="Profitability" stagger={0} right={<Approx on={r.approximate} />}>
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <MStat
            label="Profit factor"
            value={pf(r.profitFactor)}
            tone={r.profitFactor === "inf" || (typeof r.profitFactor === "number" && r.profitFactor >= 1) ? "up" : "down"}
            explain={`Gross profit divided by gross loss — here ${money(r.grossProfit)} / ${money(r.grossLoss)}. It answers: for every unit lost, how much was won?`}
            reading="Above 1 the strategy makes money; 1.5+ is solid; below 1 it loses overall. ∞ means no losing trades yet."
            detail={<CloseList rows={closes} hint="every closed trade in this range" />}
          />
          <MStat
            label="Expectancy"
            value={money(r.expectancy)}
            tone={toneOf(r.expectancy)}
            sub="avg P&L per trade"
            explain={`The average result of one trade: total net (${money(r.totalNet)}) spread over ${r.wins + r.losses} closed trades.`}
            reading="Positive means each trade is worth taking on average. Multiply by your expected trade count to project P&L."
            detail={<CloseList rows={closes} hint="the trades averaged into this number" />}
          />
          <MStat
            label="Win rate"
            value={pcts(r.winRate)}
            sub={`${r.wins}W · ${r.losses}L`}
            explain={`The share of closed trades that ended positive: ${r.wins} winners out of ${r.wins + r.losses}.`}
            reading="A low win rate can still be profitable if wins are much bigger than losses — read it together with the payoff ratio."
            detail={<CloseList rows={closes} hint={`${r.wins} wins and ${r.losses} losses`} />}
          />
          <MStat
            label="Kelly"
            value={r.kelly == null ? "—" : pcts(r.kelly * 100)}
            sub="suggested risk fraction"
            explain="The Kelly criterion: the bankroll fraction that maximizes long-run growth, from win rate and payoff ratio."
            reading="Most traders bet a half or quarter of Kelly — the full value assumes the stats are stable, which they rarely are. Negative or zero means no statistical edge right now."
            detail={<CloseList rows={closes} hint="computed from these trades" />}
          />
          <MStat
            label="Avg win"
            value={money(r.avgWin)}
            tone="up"
            explain="The mean P&L of winning trades only."
            reading={`Compare with the avg loss (${r.avgLoss == null ? "—" : money(-r.avgLoss)}): you want wins at least as large as losses unless the win rate is high.`}
            detail={<CloseList rows={winRows} hint={`all ${winRows.length} winning trades`} />}
          />
          <MStat
            label="Avg loss"
            value={r.avgLoss == null ? "—" : money(-r.avgLoss)}
            tone={r.avgLoss == null ? "neutral" : "down"}
            explain="The mean P&L of losing trades only."
            reading={`If a single recent loss is much bigger than this average (largest: ${r.largestLoss == null ? "—" : money(-r.largestLoss)}), risk control slipped on that trade.`}
            detail={<CloseList rows={lossRows} hint={`all ${lossRows.length} losing trades`} />}
          />
          <MStat
            label="Payoff ratio"
            value={num(r.payoffRatio)}
            explain="Average win divided by average loss — how much a typical winner pays relative to a typical loser."
            reading="Above 1 means winners are bigger than losers. Below 1 needs a win rate over 50% to stay profitable."
            detail={<CloseList rows={closes} hint="winners and losers behind the ratio" />}
          />
          <MStat
            label="Total net"
            value={money(r.totalNet)}
            tone={toneOf(r.totalNet)}
            explain={`All closed-trade P&L in this range summed: ${money(r.grossProfit)} of profit minus ${money(r.grossLoss)} of loss.`}
            reading="This is realized result only — open positions aren't counted until they close."
            detail={<CloseList rows={closes} hint="every closed trade summed into this" />}
          />
          <MStat
            label="Gross profit"
            value={money(r.grossProfit)}
            tone="up"
            explain="The sum of winning trades only, before subtracting any losses."
            detail={<CloseList rows={winRows} hint={`the ${winRows.length} winning trades`} />}
          />
          <MStat
            label="Gross loss"
            value={money(-r.grossLoss)}
            tone={r.grossLoss > 0 ? "down" : "neutral"}
            explain="The sum of losing trades only."
            reading="Gross profit minus gross loss gives the total net; their ratio is the profit factor."
            detail={<CloseList rows={lossRows} hint={`the ${lossRows.length} losing trades`} />}
          />
          <MStat
            label="Largest win"
            value={money(r.largestWin)}
            tone="up"
            explain="The single best closed trade in this range."
            reading={`If this dwarfs the average win (${money(r.avgWin)}), the headline numbers may lean on one lucky trade.`}
            detail={<CloseList rows={topWins} hint="biggest wins, largest first" />}
          />
          <MStat
            label="Largest loss"
            value={r.largestLoss == null ? "—" : money(-r.largestLoss)}
            tone={r.largestLoss == null ? "neutral" : "down"}
            explain="The single worst closed trade in this range."
            reading={`Compare with the average loss (${r.avgLoss == null ? "—" : money(-r.avgLoss)}) — a big gap points to a stop that didn't hold or sizing that spiked.`}
            detail={<CloseList rows={topLosses} hint="biggest losses, worst first" />}
          />
        </div>
      </Panel>

      <Panel title="Risk" stagger={1}>
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <MStat
            label="Max drawdown"
            value={pcts(r.maxDrawdownPct)}
            tone={r.maxDrawdownPct ? "down" : "neutral"}
            sub={r.maxDrawdownAbs != null ? money(-r.maxDrawdownAbs) : undefined}
            explain="The deepest peak-to-trough fall in equity — the worst losing stretch an investor would have sat through."
            reading="The Equity page lists every drawdown period with peak, trough, and recovery dates."
            detail={<CloseList rows={inWorstPeriod} hint={worstPeriod ? `trades during the deepest drawdown (${money(-worstPeriod.depth)})` : undefined} />}
          />
          <MStat
            label="DD duration"
            value={r.drawdownDurationDays == null ? "—" : `${r.drawdownDurationDays.toFixed(1)}d`}
            sub="longest underwater"
            explain="The longest time equity stayed below a previous high before making a new one."
            reading="Long durations hurt even when shallow — capital is locked in recovery instead of compounding."
            detail={<CloseList rows={inWorstPeriod} hint="trades while underwater in the deepest drawdown" />}
          />
          <MStat
            label="Recovery factor"
            value={num(r.recoveryFactor)}
            sub="net / max DD"
            explain={`Total net (${money(r.totalNet)}) divided by the deepest drawdown — profit earned per unit of worst-case pain.`}
            reading="Higher is better; above 2–3 means the strategy makes meaningfully more than its worst stumble."
            detail={<DayList rows={bundle.dailyNets} hint="the daily nets behind net and drawdown" />}
          />
          <MStat
            label="Sharpe"
            value={num(r.sharpe)}
            sub="annualized, 252d"
            explain="Average daily return divided by the volatility of daily returns, scaled to a year. The classic risk-adjusted-return score."
            reading="Rule of thumb: under 1 weak, 1–2 decent, above 2 strong. Penalizes upside swings as much as downside — see Sortino."
            detail={<DayList rows={bundle.dailyNets} hint="the daily return series this is computed from" />}
          />
          <MStat
            label="Sortino"
            value={num(r.sortino)}
            sub="downside-only vol"
            explain="Like Sharpe, but only downside volatility counts as risk — big up days don't lower the score."
            reading="Usually higher than Sharpe. If it's much higher, most of the volatility is the good kind."
            detail={<DayList rows={bundle.dailyNets} hint="the daily return series this is computed from" />}
          />
          <MStat
            label="Calmar"
            value={num(r.calmar)}
            sub="return / max DD"
            explain="Annualized return divided by max drawdown percent — return earned per unit of worst drawdown."
            reading="Above 1 means a year's return outweighs the worst historical fall."
            detail={<DayList rows={bundle.dailyNets} hint="the daily return series this is computed from" />}
          />
          <MStat
            label="Best day"
            value={money(r.bestDay)}
            tone="up"
            explain="The most profitable single UTC trading day in this range."
            reading={`The average day makes ${money(r.avgDayPnl)} — if the best day towers over that, results are concentrated.`}
            detail={<CloseList rows={bestDayRows} hint="the trades that made the best day" />}
          />
          <MStat
            label="Worst day"
            value={money(r.worstDay)}
            tone={r.worstDay != null && r.worstDay < 0 ? "down" : "neutral"}
            explain="The most damaging single UTC trading day in this range."
            reading="A worst day far beyond the average suggests a session where risk limits failed — find it in the calendar."
            detail={<CloseList rows={worstDayRows} hint="the trades that made the worst day" />}
          />
        </div>
      </Panel>

      <Panel title="Streaks" stagger={2} right={<Approx on={r.approximate} />}>
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <MStat
            label="Current streak"
            value={r.currentStreak === 0 ? "—" : `${r.currentStreak > 0 ? "+" : ""}${r.currentStreak}`}
            tone={streakTone}
            sub={r.currentStreak <= -3 ? "tilt risk — slow down" : r.currentStreak > 0 ? "winning run" : r.currentStreak < 0 ? "losing run" : undefined}
            explain="Consecutive wins (positive) or losses (negative) ending at the latest closed trade."
            reading="Three or more losses in a row is the classic tilt zone — the table below shows how the next trade historically went after a streak like this."
            detail={<CloseList rows={currentRun(chron)} hint="the trades in the current streak" />}
          />
          <MStat
            label="Max win streak"
            value={String(r.maxWinStreak)}
            tone="up"
            explain="The longest run of consecutive winning trades in this range."
            detail={<CloseList rows={longestRun(chron, (c) => c.realized > 0)} hint="the trades in that run" />}
          />
          <MStat
            label="Max loss streak"
            value={String(r.maxLossStreak)}
            tone={r.maxLossStreak > 0 ? "down" : "neutral"}
            explain="The longest run of consecutive losing trades in this range."
            reading="Size positions so that a streak this long is survivable — it already happened once."
            detail={<CloseList rows={longestRun(chron, (c) => c.realized < 0)} hint="the trades in that run" />}
          />
          <MStat
            label="Profitable days"
            value={`${r.profitableDays}/${r.daysTraded}`}
            sub={`avg day ${money(r.avgDayPnl)}`}
            explain={`Out of ${r.daysTraded} UTC days with at least one fill, ${r.profitableDays} ended positive.`}
            reading="Day-level consistency matters for compounding — the calendar tab paints every one of these days."
            detail={<DayList rows={bundle.dailyNets} hint="every traded day, profitable ones in green" />}
          />
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
