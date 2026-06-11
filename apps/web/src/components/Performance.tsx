import type { PerformanceBundle, PerformanceReport } from "../api";
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
