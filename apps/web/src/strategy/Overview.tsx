import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, MIN_RATIO_DAYS, type PerformanceBundle } from "../api";
import { chartColors, EChart, areaFade, qktChartAxis, qktChartGrid, qktChartTooltip, qktXAxis, tipHtml, tok, zeroLine, type QktChartOption } from "../components/EChart";
import { rangeStart, type RangeKey } from "../components/ui";
import { count, DASH, day as utcDay, days, duration, num, pct, pctValue, pnl, polarity, signedMoney, signedPct, toneClass, tsShort } from "../format";
import { rMultiple } from "../trades/format";
import { chipOf, emptyHint, exitSpan, nearestByTime, profitFactorText } from "./journal";
import type { SectionProps } from "./StrategyPage";
import { BigPnl, Gauge, ICON, PayoffBars, Ring, SignedBars, Spark, StatRow, Widget } from "./widgets";

/*
 * The strategy's Overview, the journal's: realised P&L, win rate, profit factor, payoff,
 * expectancy, the deepest fall and the risk-adjusted ratios as cards; the running total and every
 * trade's P&L as charts. Cards and bars narrow the query (or open the trade) when clicked.
 */

const SPARK_POINTS = 160;

function thin<T>(rows: readonly T[], max: number): T[] {
  if (rows.length <= max) return [...rows];
  const step = rows.length / max;
  return Array.from({ length: max }, (_, i) => rows[Math.min(rows.length - 1, Math.round(i * step))]!).concat(rows[rows.length - 1]!);
}

export function OverviewSection({ instanceId, strategyId, scope, q, toggle, a, busy, capital, openTrade, goTab, range }: SectionProps & { range: RangeKey }) {
  const from = rangeStart(range);
  // the ratios walk the strategy's daily equity on its base: they follow the range, not the search
  const perf = useQuery({
    queryKey: ["performance", instanceId, strategyId, range, "report,costs"],
    queryFn: () => get<Pick<PerformanceBundle, "report" | "costs">>(
      `/performance?instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}&include=report,costs${from > 0 ? `&from=${Math.floor(from / 60_000) * 60_000}` : ""}`,
    ),
    refetchInterval: 60_000,
  });
  const trades = a?.trades ?? [];
  const cumOption = useMemo<QktChartOption>(() => ({
    grid: { ...qktChartGrid, top: 12 },
    tooltip: {
      ...qktChartTooltip(),
      formatter: (params: unknown) => {
        const i = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
        const t = trades[i];
        if (!t) return "";
        return tipHtml(`${tsShort(t.exitTs)} UTC · trade ${count(i + 1)}`, { text: pnl(t.cum), tone: polarity(t.cum) }, [["This trade", signedMoney(t.pnl)]], openTrade ? "Click to open the trade" : undefined);
      },
    },
    xAxis: { type: "time", ...qktXAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis },
    series: [{
      name: "running total", type: "line", showSymbol: false, smooth: false, data: trades.map((t) => [t.exitTs, t.cum]),
      lineStyle: { color: chartColors.primary, width: 2 }, itemStyle: { color: chartColors.primary }, areaStyle: areaFade(chartColors.primary), markLine: zeroLine(),
    }],
  }), [trades, openTrade]);
  const barOption = useMemo<QktChartOption>(() => ({
    grid: { ...qktChartGrid, top: 12 },
    tooltip: {
      ...qktChartTooltip(),
      axisPointer: { type: "shadow", shadowStyle: { color: tok("hover") } },
      formatter: (params: unknown) => {
        const i = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
        const t = trades[i];
        if (!t) return "";
        return tipHtml(`Trade ${count(i + 1)} · exited ${tsShort(t.exitTs)} UTC`, { text: pnl(t.pnl), tone: polarity(t.pnl) }, [["Running total", signedMoney(t.cum)]], openTrade ? "Click to open the trade" : undefined);
      },
    },
    xAxis: { type: "category", data: trades.map((_, i) => String(i + 1)), ...qktXAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis },
    series: [{
      name: "P&L", type: "bar", barMaxWidth: 14, barCategoryGap: "20%",
      data: trades.map((t) => ({ value: t.pnl, itemStyle: { color: t.pnl >= 0 ? chartColors.gain : chartColors.loss, borderRadius: t.pnl >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })),
      markLine: zeroLine(),
    }],
  }), [trades, openTrade]);

  if (!a) return null;
  if (a.matched === 0) {
    return (
      <div className="rounded-card border border-line bg-panel px-6 py-10 text-center text-sm text-muted">
        <b className="text-bright">No round trips match.</b> {emptyHint(q, scope.from)}
      </div>
    );
  }

  const outcome = chipOf(q, "outcome");
  const picked = outcome === "win" ? "win" : outcome === "loss" ? "loss" : null;
  const r = perf.data?.report;
  const costs = perf.data?.costs;
  const ratioNote = r && r.sharpe == null && r.ratioDays < MIN_RATIO_DAYS ? `needs ${MIN_RATIO_DAYS} days with closes, has ${r.ratioDays}` : null;
  const base = capital.amount;
  const scopeHint = "range · ignores the search";

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid gap-4 @container md:grid-cols-3">
        <Widget
          icon={ICON.pnl}
          title="Realised P&L"
          className="relative overflow-hidden md:col-span-2"
          busy={busy}
          explain="Closed round trips in the range that match the search, after commission, swap and fees. A position still open counts what it has closed so far."
        >
          <button type="button" onClick={() => goTab("trades")} className="block w-full text-left">
            <BigPnl value={a.pnl} />
            <div className="mt-1 text-sm text-muted">
              {base ? `${signedPct((a.pnl / base) * 100, 1)} ${capital.label}` : capital.label}
            </div>
            <div className="mt-1 text-sm text-muted">
              {count(a.closed)} closed{a.open > 0 ? ` · ${count(a.open)} still open` : ""}
              {a.avgHoldMs != null && ` · held ${duration(a.avgHoldMs)} on average`}
            </div>
          </button>
          <Spark values={thin(trades, SPARK_POINTS).map((t) => t.cum)} className="absolute bottom-0 right-0 hidden h-14 w-[55%] @xl:block" />
        </Widget>
        <Widget
          icon={ICON.percent}
          title="Win rate"
          busy={busy}
          explain={`Winning closed round trips over winning plus losing ones; breakeven trades (${a.breakeven}) count for neither. A low win rate still pays when wins are much bigger than losses: read it with the payoff.`}
        >
          <div className="flex items-center gap-4">
            <Ring wins={a.wins} losses={a.losses} picked={picked} onWins={() => toggle("win")} onLosses={() => toggle("loss")} />
            <div className="grid gap-1 text-sm tabular-nums">
              <button type="button" onClick={() => toggle("win")} className="text-left text-gain hover:underline">▲ {count(a.wins)} won</button>
              <button type="button" onClick={() => toggle("loss")} className="text-left text-loss hover:underline">▼ {count(a.losses)} lost</button>
              {a.breakeven > 0 && <span className="text-muted">{count(a.breakeven)} breakeven</span>}
            </div>
          </div>
        </Widget>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        <Widget
          icon={ICON.gauge}
          title="Profit factor"
          hint="1.0 is break-even"
          busy={busy}
          explain={`Sum of winning trades over the sum of losing trades, both after costs: ${signedMoney(a.grossWin)} / ${signedMoney(a.grossLoss)}. Above 1 it makes money, 1.5 and up is solid, ∞ means no losing trade yet.`}
        >
          <div className="relative flex w-fit flex-col items-center">
            <Gauge value={a.profitFactor} />
            <span className={`absolute bottom-0 text-xl font-headline tabular-nums ${a.profitFactor === "inf" || (typeof a.profitFactor === "number" && a.profitFactor >= 1) ? "text-bright" : "text-loss"}`}>
              {profitFactorText(a.profitFactor)}
            </span>
          </div>
          <div className="mt-1 text-sm tabular-nums text-muted">
            <span className="text-gain">{signedMoney(a.grossWin, 0)}</span> / <span className="text-loss">{signedMoney(a.grossLoss, 0)}</span>
          </div>
        </Widget>
        <Widget
          icon={ICON.scale}
          title="Avg win / loss"
          busy={busy}
          explain="The mean winning trade and the mean losing trade. Payoff is their ratio: above 1 winners are bigger than losers; below 1 the strategy needs a win rate over 50% to make money."
        >
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-headline tabular-nums text-bright">{num(a.payoff)}</span>
            <span className="text-sm text-muted">payoff</span>
          </div>
          <div className="mt-2">
            <PayoffBars avgWin={a.avgWin} avgLoss={a.avgLoss} onWin={() => toggle("win")} onLoss={() => toggle("loss")} />
          </div>
        </Widget>
        <Widget
          icon={ICON.target}
          title="Expectancy"
          hint="per closed trade"
          busy={busy}
          explain={`The average result of one closed trade: ${signedMoney(a.grossWin + a.grossLoss)} over ${count(a.closed)} trades. In R it is the average P&L over the money at risk to the initial stop, for the trades that had one.`}
        >
          <div className={`text-2xl font-headline tabular-nums ${toneClass(a.expectancy)}`}>{a.expectancy == null ? DASH : signedMoney(a.expectancy)}</div>
          <div className="mt-1 text-sm text-muted">
            {a.r.n > 0 ? (
              <>
                <span className={`font-semibold ${toneClass(a.r.avg)}`}>{rMultiple(a.r.avg)}</span> average over {count(a.r.n)} of {count(a.closed)} trade{a.closed === 1 ? "" : "s"} (those with a known stop)
              </>
            ) : (
              "no stop on the entries, so no R"
            )}
          </div>
        </Widget>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Widget
          icon={ICON.drawdown}
          title="Max drawdown"
          busy={busy}
          explain="The deepest fall of the running realized total from its high, over the trades on screen: the worst losing stretch you would have sat through. The equity-based figure, with open positions, is under Risk-adjusted."
        >
          <button type="button" disabled={!a.maxDdWindow} onClick={() => a.maxDdWindow && toggle(exitSpan(a.maxDdWindow.from, a.maxDdWindow.to))} className="block w-full text-left">
            <div className={`text-2xl font-headline tabular-nums ${a.maxDd > 0 ? "text-loss" : "text-bright"}`}>{a.maxDd > 0 ? signedMoney(-a.maxDd) : signedMoney(0)}</div>
            <div className="mt-1 text-sm text-muted">
              {base && a.maxDd > 0 ? `${pct(a.maxDd / base)} of the base · ` : ""}
              {a.maxDdWindow ? `${utcDay(a.maxDdWindow.from)} → ${utcDay(a.maxDdWindow.to)}` : "no fall yet"}
            </div>
          </button>
        </Widget>
        <Widget
          icon={ICON.ratio}
          title="Sharpe · Sortino · Calmar"
          hint={scopeHint}
          className="md:col-span-2"
          explain={`From the strategy's end-of-day equity on its base, annualised over 252 days, for the range (the search does not apply). Sharpe divides the mean daily return by its volatility; Sortino counts only downside volatility; Calmar divides the annual return by the max drawdown. Shown only from ${MIN_RATIO_DAYS} days with closes: fewer is noise.`}
        >
          {perf.isPending ? (
            <div className="h-12 animate-pulse rounded bg-raised" />
          ) : ratioNote ? (
            <div className="text-sm text-muted">Not enough history: {ratioNote}.</div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {[["Sharpe", r?.sharpe], ["Sortino", r?.sortino], ["Calmar", r?.calmar]].map(([k, v]) => (
                <div key={k as string}>
                  <div className="text-xs text-muted">{k}</div>
                  <div className={`text-2xl font-headline tabular-nums ${typeof v === "number" && v < 0 ? "text-loss" : "text-bright"}`}>{num(v as number | null | undefined)}</div>
                </div>
              ))}
            </div>
          )}
          {r && !ratioNote && <div className="mt-1 text-xs text-muted">n = {r.ratioDays} days with closes</div>}
        </Widget>
      </div>

      <Widget icon={ICON.line} title="Cumulative P&L" busy={busy}>
        <EChart option={cumOption} height={260} label="Running total of realized P&L, trade by trade" onAxisClick={openTrade ? (x) => { const t = nearestByTime(trades, x); if (t) openTrade(t.id); } : undefined} />
        {a.tradesTruncated && <div className="mt-1 text-[11px] text-muted">The newest {count(trades.length)} trades are drawn.</div>}
      </Widget>

      <Widget icon={ICON.bars} title="P&L per trade" hint="in exit order" busy={busy}>
        <EChart option={barOption} height={220} label="Each closed trade's P&L in exit order" onAxisClick={openTrade ? (x) => { const t = trades[Math.round(x)]; if (t) openTrade(t.id); } : undefined} />
      </Widget>

      <div className={`grid items-start gap-4 ${a.instrument.length > 1 ? "md:grid-cols-2" : ""}`}>
        {a.instrument.length > 1 && (
          <Widget icon={ICON.coins} title="Where the money comes from" busy={busy}>
            <SignedBars
              labelWidth={a.instrument.some((b) => b.label.includes(":")) ? "8rem" : "5.5rem"}
              rows={a.instrument.map((b) => ({ key: b.key, label: b.label, value: b.pnl, n: b.n, pressed: chipOf(q, "symbol") === b.filter, onClick: () => toggle(b.filter), title: `${b.label}: ${b.wins} won, ${b.losses} lost` }))}
            />
          </Widget>
        )}
        <Widget icon={ICON.shield} title="Drawdown and costs" hint={scopeHint} explain="From the strategy's equity on its base (open positions marked) and the venue's cost columns, for the range. The search does not apply to these.">
          {perf.isPending ? (
            <div className="h-24 animate-pulse rounded bg-raised" />
          ) : (
            <div className={`grid gap-x-8 ${a.instrument.length > 1 ? "" : "@3xl:grid-cols-2"}`}>
              <StatRow label="Max drawdown on equity">
                <span className={r?.maxDrawdownPct ? "text-loss" : ""}>{r?.maxDrawdownPct == null ? DASH : pctValue(-r.maxDrawdownPct, 1)}</span>
                {r?.maxDrawdownAbs ? <span className="ml-2 font-normal text-muted">{signedMoney(-r.maxDrawdownAbs, 0)}</span> : null}
              </StatRow>
              <StatRow label="Longest under water">{days(r?.drawdownDurationDays)}</StatRow>
              <StatRow label="Recovery factor" title="Total net over the deepest drawdown">{num(r?.recoveryFactor)}</StatRow>
              {costs ? (
                <>
                  <StatRow label="Gross, before costs"><span className={toneClass(costs.total.grossProfit)}>{signedMoney(costs.total.grossProfit)}</span></StatRow>
                  <StatRow label="Commission · swap · fees">
                    <span className="text-body">{signedMoney(costs.total.commission, 0)} · {signedMoney(costs.total.swap, 0)} · {signedMoney(costs.total.fee, 0)}</span>
                  </StatRow>
                </>
              ) : (
                <div className="pt-2 text-xs text-muted">The cost split needs broker deals; this strategy has none in the range.</div>
              )}
            </div>
          )}
        </Widget>
      </div>
    </div>
  );
}
