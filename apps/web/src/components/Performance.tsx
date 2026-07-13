import { useState, type ReactNode } from "react";
import type { ClosedTradeRow, DayNet, PerformanceBundle, PerformanceReport } from "../api";
import { duration, money, num, tsDay } from "../format";
import { EChart, type QktChartOption } from "./EChart";
import { BucketBoxplot, ContributionBars, CostStack } from "./EdgeCharts";
import { Cell, Empty, Panel, Pill, Row, Select, Stat, Table, type Tone } from "./ui";

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

      <Panel title="Risk" stagger={1} right={<Approx on={r.approximate} />}>
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


type TradeMetric = "net" | "trades" | "winRate" | "avg";
type TradeDimension = "side" | "symbol" | "hour" | "weekday" | "lot" | "hold";
type TradeOutcome = "all" | "wins" | "losses";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const DIMS: { key: TradeDimension; label: string }[] = [
  { key: "side", label: "Side" },
  { key: "symbol", label: "Symbol" },
  { key: "hour", label: "Hour" },
  { key: "weekday", label: "Weekday" },
  { key: "lot", label: "Lot" },
  { key: "hold", label: "Hold" },
];
const METRICS: { key: TradeMetric; label: string }[] = [
  { key: "net", label: "Net P&L" },
  { key: "trades", label: "Trades" },
  { key: "winRate", label: "Win rate" },
  { key: "avg", label: "Avg P&L" },
];

function timeFmt(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function sideKey(side: string): "long" | "short" {
  return side === "BUY" ? "long" : "short";
}

function holdBucket(c: ClosedTradeRow): string {
  if (c.entryTs == null) return "unknown";
  const held = c.ts - c.entryTs;
  if (held < 15 * 60_000) return "<15m";
  if (held < 60 * 60_000) return "15-60m";
  if (held < 4 * 3_600_000) return "1-4h";
  if (held < 24 * 3_600_000) return "4-24h";
  return ">1d";
}

function dimKey(c: ClosedTradeRow, dim: TradeDimension): string {
  const d = new Date(c.ts);
  if (dim === "side") return sideKey(c.side);
  if (dim === "symbol") return c.symbol;
  if (dim === "hour") return String(d.getUTCHours()).padStart(2, "0");
  if (dim === "weekday") return WEEKDAYS[(d.getUTCDay() + 6) % 7]!;
  if (dim === "lot") return c.qty.toFixed(2);
  return holdBucket(c);
}

interface GroupRow { key: string; net: number; trades: number; wins: number; avg: number; winRate: number }

function groupTrades(rows: ClosedTradeRow[], dim: TradeDimension): GroupRow[] {
  const out = new Map<string, GroupRow>();
  for (const c of rows) {
    const key = dimKey(c, dim);
    const cur = out.get(key) ?? { key, net: 0, trades: 0, wins: 0, avg: 0, winRate: 0 };
    cur.net += c.realized;
    cur.trades++;
    if (c.realized > 0) cur.wins++;
    out.set(key, cur);
  }
  const rowsOut = [...out.values()].map((r) => ({ ...r, avg: r.trades > 0 ? r.net / r.trades : 0, winRate: r.trades > 0 ? (r.wins / r.trades) * 100 : 0 }));
  if (dim === "weekday") return rowsOut.sort((a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key));
  if (dim === "side") return rowsOut.sort((a, b) => a.key.localeCompare(b.key));
  return rowsOut.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

function distributionRows(rows: ClosedTradeRow[]): { key: string; count: number; midpoint: number }[] {
  if (rows.length === 0) return [];
  const pnls = rows.map((r) => r.realized);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const bins = 13;
  const width = max > min ? (max - min) / bins : 1;
  const out = Array.from({ length: bins }, (_, i) => {
    const from = min + i * width;
    const to = min + (i + 1) * width;
    return { key: `${money(from)}..${money(to)}`, count: 0, midpoint: (from + to) / 2 };
  });
  for (const p of pnls) out[Math.min(bins - 1, Math.floor((p - min) / width))]!.count++;
  return out;
}

function sideCurveRows(rows: ClosedTradeRow[]) {
  let total = 0;
  let long = 0;
  let short = 0;
  return [...rows].reverse().map((c) => {
    total += c.realized;
    if (sideKey(c.side) === "long") long += c.realized;
    else short += c.realized;
    return { ts: c.ts, total, long, short };
  });
}

function metricValue(r: GroupRow, metric: TradeMetric): number {
  if (metric === "trades") return r.trades;
  if (metric === "winRate") return r.winRate;
  if (metric === "avg") return r.avg;
  return r.net;
}

function metricLabel(metric: TradeMetric): string {
  return METRICS.find((m) => m.key === metric)?.label ?? metric;
}

function metricText(value: number, metric: TradeMetric): string {
  if (metric === "trades") return String(value);
  if (metric === "winRate") return `${value.toFixed(1)}%`;
  return money(value);
}

function TradeAnalysis({ bundle }: { bundle: PerformanceBundle }) {
  const [side, setSide] = useState("");
  const [symbol, setSymbol] = useState("");
  const [outcome, setOutcome] = useState<TradeOutcome>("all");
  const [dimension, setDimension] = useState<TradeDimension>("side");
  const [metric, setMetric] = useState<TradeMetric>("net");
  const closes = bundle.closes;
  const symbols = [...new Set(closes.map((c) => c.symbol))].sort();
  const filtered = closes.filter((c) => {
    if (side && sideKey(c.side) !== side) return false;
    if (symbol && c.symbol !== symbol) return false;
    if (outcome === "wins" && c.realized <= 0) return false;
    if (outcome === "losses" && c.realized >= 0) return false;
    return true;
  });
  const groups = groupTrades(filtered, dimension);
  const curve = sideCurveRows(filtered);
  const dist = distributionRows(filtered);
  const scatter = filtered.map((c, i) => ({
    i: i + 1,
    pnl: c.realized,
    holdMin: c.entryTs == null ? null : Math.max(0, (c.ts - c.entryTs) / 60_000),
    qty: c.qty,
    side: sideKey(c.side),
    symbol: c.symbol,
    ts: c.ts,
  })).filter((r) => r.holdMin != null);
  const total = filtered.reduce((a, c) => a + c.realized, 0);
  const wins = filtered.filter((c) => c.realized > 0).length;
  const losses = filtered.filter((c) => c.realized < 0).length;
  const best = [...filtered].sort((a, b) => b.realized - a.realized).slice(0, 5);
  const worst = [...filtered].sort((a, b) => a.realized - b.realized).slice(0, 5);
  const curveOption: QktChartOption = {
    backgroundColor: "transparent",
    color: ["#f2f4f6", "#3fe08c", "#5cb8ff"],
    grid: ECHART_GRID,
    tooltip: { ...tooltipBox(), trigger: "axis" },
    legend: { top: 0, right: 0, textStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace" } },
    dataZoom: [
      { type: "inside" },
      {
        type: "slider",
        height: 16,
        bottom: 4,
        borderColor: "#22272d",
        fillerColor: "rgba(200,247,74,0.18)",
        textStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace" },
        handleStyle: { color: "#f2f4f6" },
        moveHandleStyle: { color: "#f2f4f6" },
      },
    ],
    xAxis: { type: "time", ...ECHART_AXIS },
    yAxis: { type: "value", ...ECHART_AXIS },
    series: [
      { name: "total", type: "line", showSymbol: false, smooth: true, data: curve.map((r) => [r.ts, r.total]) },
      { name: "long", type: "line", showSymbol: false, smooth: true, data: curve.map((r) => [r.ts, r.long]) },
      { name: "short", type: "line", showSymbol: false, smooth: true, data: curve.map((r) => [r.ts, r.short]) },
    ],
  };
  const groupedOption: QktChartOption = {
    backgroundColor: "transparent",
    grid: ECHART_GRID,
    tooltip: { ...tooltipBox(), trigger: "axis" },
    dataZoom: groups.length > 12 ? [
      { type: "inside" },
      {
        type: "slider",
        height: 16,
        bottom: 4,
        borderColor: "#22272d",
        fillerColor: "rgba(92,184,255,0.18)",
        textStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace" },
        handleStyle: { color: "#f2f4f6" },
        moveHandleStyle: { color: "#f2f4f6" },
      },
    ] : undefined,
    xAxis: { type: "category", data: groups.map((g) => g.key), ...ECHART_AXIS },
    yAxis: { type: "value", ...ECHART_AXIS },
    series: [
      {
        name: metricLabel(metric),
        type: "bar",
        data: groups.map((g) => {
          const value = metricValue(g, metric);
          return {
            value,
            itemStyle: { color: metric === "trades" ? "#5cb8ff" : value >= 0 ? "#3fe08c" : "#ff6b6b" },
          };
        }),
      },
    ],
  };
  const distributionOption: QktChartOption = {
    backgroundColor: "transparent",
    grid: ECHART_GRID,
    tooltip: { ...tooltipBox(), trigger: "axis" },
    xAxis: { type: "category", data: dist.map((d) => money(d.midpoint)), ...ECHART_AXIS },
    yAxis: { type: "value", ...ECHART_AXIS },
    series: [{ name: "trades", type: "bar", data: dist.map((d) => d.count), itemStyle: { color: "#c8f74a", opacity: 0.8 } }],
  };
  const scatterOption: QktChartOption = {
    backgroundColor: "transparent",
    grid: ECHART_GRID,
    tooltip: {
      ...tooltipBox(),
      trigger: "item",
      formatter: (params: unknown) => {
        const p = params as { data?: [number, number, string, string, number, number] };
        const d = p.data;
        if (!d) return "";
        return `${d[2]}<br/>${d[3]} · ${d[4]} lots<br/>held ${d[0].toFixed(1)}m<br/>P&L ${money(d[1])}`;
      },
    },
    xAxis: { type: "value", name: "hold min", ...ECHART_AXIS },
    yAxis: { type: "value", name: "P&L", ...ECHART_AXIS },
    series: [
      {
        name: "trade",
        type: "scatter",
        symbolSize: (value: unknown) => {
          const row = value as [number, number, string, string, number, number];
          return Math.max(7, Math.min(18, row[4] * 450));
        },
        data: scatter.map((r) => ({
          value: [r.holdMin ?? 0, r.pnl, r.symbol, r.side, r.qty, r.ts],
          itemStyle: { color: r.pnl >= 0 ? "#3fe08c" : "#ff6b6b" },
        })),
      },
    ],
  };

  return (
    <Panel
      title="Trade analysis"
      hint="closed trades"
      stagger={3}
      toolbar={
        <div className="flex flex-wrap items-end gap-2">
          <FilterField label="Side">
            <Select value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="">all sides</option>
              <option value="long">longs</option>
              <option value="short">shorts</option>
            </Select>
          </FilterField>
          <FilterField label="Symbol">
            <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              <option value="">all symbols</option>
              {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </FilterField>
          <FilterField label="Outcome">
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value as TradeOutcome)}>
              <option value="all">all outcomes</option>
              <option value="wins">wins</option>
              <option value="losses">losses</option>
            </Select>
          </FilterField>
          <FilterField label="Group by">
            <Select value={dimension} onChange={(e) => setDimension(e.target.value as TradeDimension)}>
              {DIMS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </Select>
          </FilterField>
          <FilterField label="Measure">
            <Select value={metric} onChange={(e) => setMetric(e.target.value as TradeMetric)}>
              {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </Select>
          </FilterField>
        </div>
      }
    >
      {filtered.length === 0 ? <Empty>No closed trades match these filters.</Empty> : (
        <div className="grid gap-5 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Net" value={money(total)} tone={total >= 0 ? "up" : "down"} />
            <Stat label="Trades" value={String(filtered.length)} />
            <Stat label="Wins" value={String(wins)} tone="up" />
            <Stat label="Losses" value={String(losses)} tone={losses > 0 ? "down" : "neutral"} />
            <Stat label="Avg" value={money(total / filtered.length)} tone={total / filtered.length >= 0 ? "up" : "down"} />
          </div>

          <div className="rounded-lg border border-line bg-ink/35 px-4 py-3 text-sm text-muted">
            Use the controls above to ask: which side, symbol, hour, lot, or holding-time bucket is actually carrying the edge?
            Drag the bottom range slider or mouse-wheel over a chart to zoom.
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <ChartShell title="Realized curve" hint="total vs long vs short">
              <EChart option={curveOption} height={260} />
            </ChartShell>

            <ChartShell title={`${metricLabel(metric)} by ${DIMS.find((d) => d.key === dimension)?.label}`} hint="change group and measure">
              <EChart option={groupedOption} height={260} />
            </ChartShell>

            <ChartShell title="P&L distribution" hint="trade count per outcome bucket">
              <EChart option={distributionOption} height={240} />
            </ChartShell>

            <ChartShell title="Hold time vs P&L" hint="dot size follows lot size">
              {scatter.length === 0 ? <div className="flex h-60 items-center justify-center text-sm text-faint">No entry timestamps for this filter.</div> : (
                <EChart option={scatterOption} height={240} />
              )}
            </ChartShell>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <div className="rounded-lg border border-line bg-ink/25">
              <div className="px-4 pt-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Best trades</div>
              <Table head={["Closed", "Symbol", "Side", "Qty", "P&L"]}>
                {best.map((c, i) => <Row key={`${c.ts}-best-${i}`}><Cell className="whitespace-nowrap text-muted">{tsDay(c.ts)}</Cell><Cell className="font-semibold text-bright">{c.symbol}</Cell><Cell><Pill tone={sideKey(c.side) === "long" ? "up" : "info"}>{sideKey(c.side)}</Pill></Cell><Cell className="font-mono">{c.qty}</Cell><Cell className="font-mono text-up">+{money(c.realized)}</Cell></Row>)}
              </Table>
            </div>
            <div className="rounded-lg border border-line bg-ink/25">
              <div className="px-4 pt-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Worst trades</div>
              <Table head={["Closed", "Symbol", "Side", "Qty", "P&L"]}>
                {worst.map((c, i) => <Row key={`${c.ts}-worst-${i}`}><Cell className="whitespace-nowrap text-muted">{tsDay(c.ts)}</Cell><Cell className="font-semibold text-bright">{c.symbol}</Cell><Cell><Pill tone={sideKey(c.side) === "long" ? "up" : "info"}>{sideKey(c.side)}</Pill></Cell><Cell className="font-mono">{c.qty}</Cell><Cell className="font-mono text-down">{money(c.realized)}</Cell></Row>)}
              </Table>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

const ECHART_GRID = { left: 58, right: 22, top: 34, bottom: 44 };
const ECHART_AXIS = {
  axisLine: { lineStyle: { color: "var(--color-line)" } },
  axisTick: { show: false },
  axisLabel: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11 },
  nameTextStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11 },
  splitLine: { lineStyle: { color: "var(--color-line)", type: "dashed" as const } },
};

function tooltipBox(): QktChartOption["tooltip"] {
  return {
    backgroundColor: "#191d21",
    borderColor: "#2f363e",
    borderWidth: 1,
    textStyle: { color: "#f2f4f6", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 12 },
  };
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-faint">{label}</span>
      {children}
    </label>
  );
}

function ChartShell({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-raised/45 p-3 shadow-inner shadow-black/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-body">{title}</div>
        <div className="text-xs text-faint">{hint}</div>
      </div>
      {children}
    </div>
  );
}

/** Exact, per-close charts — only rendered once trade.closed data exists for the range. */
export function TradeAnalysisPanels({ bundle }: { bundle: PerformanceBundle }) {
  return <TradeAnalysis bundle={bundle} />;
}

/** Weekday P&L samples for the box plots, oldest-first for stable ordering. */
function weekdaySamples(closes: ClosedTradeRow[]): { key: string; values: number[] }[] {
  const by = new Map<string, number[]>();
  for (const c of closes) {
    const key = WEEKDAYS[(new Date(c.ts).getUTCDay() + 6) % 7]!;
    const arr = by.get(key) ?? [];
    arr.push(c.realized);
    by.set(key, arr);
  }
  return WEEKDAYS.filter((d) => by.has(d)).map((d) => ({ key: d, values: by.get(d)! }));
}

/**
 * Cost, attribution, and dispersion panels fed by the edge-analytics bundle
 * keys. Costs render only on deals-backed strategies (the split needs broker
 * commission/swap columns); the absence itself is stated, not hidden.
 */
export function EdgeDetailPanels({ bundle }: { bundle: PerformanceBundle }) {
  const costs = bundle.costs;
  const contribution = bundle.contribution;
  const boxGroups = weekdaySamples(bundle.closes);
  if (!costs && !contribution && boxGroups.length === 0) return null;
  return (
    <div className="grid gap-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Cost of trading" hint="gross profit vs commission vs swap, per UTC month" stagger={4}>
          {costs && costs.byMonth.length > 0 ? (
            <div className="grid gap-3 p-3">
              <CostStack costs={costs} />
              <div className="rounded-lg border border-line bg-ink/25">
                <Table head={["", "Gross", "Commission", "Swap", "Fee", "Net"]}>
                  <Row>
                    <Cell className="text-muted">total</Cell>
                    <Cell className="font-mono text-up">{money(costs.total.grossProfit)}</Cell>
                    <Cell className="font-mono text-down">{money(costs.total.commission)}</Cell>
                    <Cell className={`font-mono ${costs.total.swap < 0 ? "text-down" : "text-muted"}`}>{money(costs.total.swap)}</Cell>
                    <Cell className={`font-mono ${costs.total.fee < 0 ? "text-down" : "text-muted"}`}>{money(costs.total.fee)}</Cell>
                    <Cell className={`font-mono font-semibold ${costs.total.net >= 0 ? "text-up" : "text-down"}`}>{money(costs.total.net)}</Cell>
                  </Row>
                </Table>
              </div>
            </div>
          ) : (
            <Empty>Cost split needs broker deals — paper instances carry realized P&L without a commission/swap breakdown.</Empty>
          )}
        </Panel>
        <Panel title="Where the money comes from" hint="net contribution by symbol · n labels · expectancy in tooltip" stagger={5}>
          {contribution && contribution.bySymbol.length > 0 ? (
            <div className="grid gap-3 p-3">
              <ContributionBars ranking={contribution} />
              <div className="rounded-lg border border-line bg-ink/25">
                <Table head={["Symbol", "Net", "n", "Win", "Expectancy"]}>
                  {contribution.bySymbol.map((r) => (
                    <Row key={r.key}>
                      <Cell className="font-semibold text-bright">{r.key}</Cell>
                      <Cell className={`font-mono ${r.net >= 0 ? "text-up" : "text-down"}`}>{money(r.net)}</Cell>
                      <Cell className="font-mono text-muted">{r.trades}</Cell>
                      <Cell className="font-mono text-muted">{r.winRate.toFixed(0)}%</Cell>
                      <Cell className={`font-mono ${r.expectancy >= 0 ? "text-up" : "text-down"}`}>{money(r.expectancy)}</Cell>
                    </Row>
                  ))}
                </Table>
              </div>
            </div>
          ) : (
            <Empty>No closed trades to attribute yet.</Empty>
          )}
        </Panel>
      </div>
      {boxGroups.length > 0 && (
        <Panel title="P&L dispersion by weekday" hint="box = quartiles, whiskers = min/max · UTC close day · grey under n=30" stagger={6}>
          <div className="p-3"><BucketBoxplot groups={boxGroups} /></div>
        </Panel>
      )}
    </div>
  );
}
