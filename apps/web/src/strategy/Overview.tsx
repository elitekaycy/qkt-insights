import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, MIN_RATIO_DAYS, type PerformanceBundle } from "../api";
import { CostTerm } from "../components/InstrumentType";
import { areaFade, chartColors, EChart, qktBarTooltip, qktChartAxis, qktChartGrid, type QktChartOption, qktChartTooltip, qktXAxis, signedBar, tipHtml, zeroLine } from "../components/EChart";
import { withTokens } from "@qkt-insights/contract/query";
import { rangeStart, type RangeKey } from "../components/ui";
import { count, day as utcDay, days, num, pctValue, pnl, polarity, signedMoney, toneClass, tsShort } from "../format";
import { rMultiple } from "../trades/format";
import { useTripAnalytics } from "../trades/analytics";
import { chipOf, emptyHint, exitSpan, nearestByTime, profitFactorText, todayParts, without } from "./journal";
import type { SectionProps } from "./StrategyPage";
import { BigPnl, ICON, PayoffBars, Ring, SignedBars, Spark, StatRow, Widget } from "./widgets";

/*
 * The strategy's Overview: today's story first, then realized P&L, win rate, profit factor, win/loss ratio, expectancy and
 * the deepest fall as cards; the running total and every trade's P&L as charts. Cards and bars narrow the query (or
 * open the trade) when clicked.
 */

const SPARK_POINTS = 160;

function thin<T>(rows: readonly T[], max: number): T[] {
  if (rows.length <= max) return [...rows];
  const step = rows.length / max;
  return Array.from({ length: max }, (_, i) => rows[Math.min(rows.length - 1, Math.round(i * step))]!).concat(rows[rows.length - 1]!);
}

export function OverviewSection({ instanceId, strategyId, scope, q, toggle, a, busy, capital, open, openTrade, goTab, range }: SectionProps & { range: RangeKey }) {
  const todayDay = utcDay(Date.now());
  const todayQ = withTokens(without(q, ["exit"]), `exit:${todayDay}`);
  const today = useTripAnalytics(scope, todayQ);
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
      ...qktBarTooltip(),
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
      data: trades.map((t) => ({ value: t.pnl, itemStyle: signedBar(t.pnl) })),
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
  const ratioNote = r && r.sharpe == null && r.ratioDays < MIN_RATIO_DAYS ? `Risk-adjusted ratios need ${MIN_RATIO_DAYS} trading days (has ${r.ratioDays}).` : null;
  const base = capital.amount;
  const rangeNote = " Follows the date range; the search does not apply.";
  const story = todayParts(today.data ? { closed: today.data.closed, wins: today.data.wins, ended: today.data.ended } : null, open, a.streaks.current);
  const decided = a.wins + a.losses;

  return (
    <div className="grid grid-cols-1 gap-4">
      {story.length > 0 && (
        <button type="button" onClick={() => goTab("trades", todayQ)} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-card border border-line bg-panel px-4 py-3 text-left transition hover:border-line-strong">
          <span className="text-sm font-medium text-bright">Today</span>
          <span className="text-sm text-body">{story.join(" · ")}</span>
          <span className="ml-auto text-xs font-medium text-accent-ink">See the trades</span>
        </button>
      )}
      <div className="grid gap-4 @container md:grid-cols-3">
        <Widget
          icon={ICON.pnl}
          title="Realized P&L"
          className={`relative overflow-hidden ${decided === 0 ? "md:col-span-3" : "md:col-span-2"}`}
          busy={busy}
          explain={`Closed trades in the range that match the search, after commission, swap and fees.${base ? ` ${signedMoney(a.pnl)} is ${pctValue((a.pnl / base) * 100, 2)} ${capital.label}.` : ""}`}
        >
          <button type="button" onClick={() => goTab("trades")} className="block w-full text-left">
            <BigPnl value={a.pnl} />
            <div className="mt-1 text-sm text-muted">
              {count(a.closed)} closed{a.open > 0 ? ` · ${count(a.open)} open` : ""}
            </div>
          </button>
          <Spark values={thin(trades, SPARK_POINTS).map((t) => t.cum)} className="absolute bottom-0 right-0 hidden h-14 w-[55%] @xl:block" />
        </Widget>
        {decided > 0 && (
          <Widget
            icon={ICON.percent}
            title="Win rate"
            busy={busy}
            explain={`Winning closed trades over winning plus losing ones; breakeven trades (${a.breakeven}) count for neither. Read it with the win/loss ratio: a low win rate pays when wins are bigger than losses.`}
          >
            <div className="flex items-center gap-4">
              <Ring wins={a.wins} losses={a.losses} picked={picked} onWins={() => toggle("win")} onLosses={() => toggle("loss")} />
              <div className="grid gap-1 text-sm tabular-nums">
                <button type="button" onClick={() => toggle("win")} className="text-left text-gain hover:underline">▲ {count(a.wins)} won</button>
                <button type="button" onClick={() => toggle("loss")} className="text-left text-loss hover:underline">▼ {count(a.losses)} lost</button>
              </div>
            </div>
          </Widget>
        )}
      </div>

      {a.closed > 0 && <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
        {a.profitFactor != null && <Widget
          icon={ICON.gauge}
          title="Profit factor"
          busy={busy}
          explain="Money won over money lost, both after costs. Above 1.0 it makes money; ∞ means no losing trade yet."
        >
          <div className={`text-2xl font-headline tabular-nums ${a.profitFactor === "inf" || (typeof a.profitFactor === "number" && a.profitFactor >= 1) ? "text-bright" : "text-loss"}`}>
            {profitFactorText(a.profitFactor)}
          </div>
          <div className="mt-1 text-sm tabular-nums text-muted">
            <span className="font-mono text-gain">{signedMoney(a.grossWin)}</span> won / <span className="font-mono text-loss">{signedMoney(a.grossLoss)}</span> lost
          </div>
        </Widget>}
        {(a.avgWin != null || a.avgLoss != null) && <Widget
          icon={ICON.scale}
          title="Avg win / loss"
          busy={busy}
          explain="The mean winning and losing trade, and their ratio: above 1 winners are bigger than losers."
        >
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-headline tabular-nums text-bright">{num(a.payoff)}</span>
            <span className="text-sm text-muted">win/loss ratio</span>
          </div>
          <div className="mt-2">
            <PayoffBars avgWin={a.avgWin} avgLoss={a.avgLoss} onWin={() => toggle("win")} onLoss={() => toggle("loss")} />
          </div>
        </Widget>}
        {a.expectancy != null && <Widget
          icon={ICON.target}
          title="Expectancy"
          busy={busy}
          explain="What one closed trade makes on average. R is the same over the money at risk to the first stop, for trades that had one."
        >
          <div className={`text-2xl font-headline tabular-nums ${toneClass(a.expectancy)}`}>{signedMoney(a.expectancy)}</div>
          <div className="mt-1 text-sm text-muted">
            {a.r.n > 0 ? <><span className={`font-semibold ${toneClass(a.r.avg)}`}>{rMultiple(a.r.avg)}</span> · {count(a.r.n)} with a stop</> : "per trade"}
          </div>
        </Widget>}
        <Widget
          icon={ICON.drawdown}
          title="Max drawdown"
          busy={busy}
          explain={`The deepest fall of the running realized total from its high: the worst losing stretch on the trades shown. On equity it counts open positions too.${rangeNote}`}
        >
          <button type="button" disabled={!a.maxDdWindow} onClick={() => a.maxDdWindow && toggle(exitSpan(a.maxDdWindow.from, a.maxDdWindow.to))} className="block w-full text-left">
            <div className={`text-2xl font-headline tabular-nums ${a.maxDd > 0 ? "text-loss" : "text-bright"}`}>{a.maxDd > 0 ? signedMoney(-a.maxDd) : signedMoney(0)}</div>
            <div className="mt-1 text-sm text-muted">
              {r?.maxDrawdownPct != null ? `on equity ${pctValue(-r.maxDrawdownPct, 2)}` : a.maxDdWindow ? `${utcDay(a.maxDdWindow.from)} → ${utcDay(a.maxDdWindow.to)}` : "no fall yet"}
            </div>
          </button>
        </Widget>
      </div>}

      {a.closed === 0 ? (
        <p className="rounded-card border border-line bg-panel px-4 py-6 text-center text-sm text-muted">No closed trades yet. The charts fill in as trades close.</p>
      ) : (
        <>
          <Widget icon={ICON.line} title="Cumulative P&L" hint={trades.length > 0 && utcDay(trades[0]!.exitTs) === utcDay(trades[trades.length - 1]!.exitTs) ? `${utcDay(trades[0]!.exitTs)}, UTC` : "UTC"} busy={busy}>
            <EChart option={cumOption} height={260} label="Running total of realized P&L, trade by trade" onAxisClick={openTrade ? (x) => { const t = nearestByTime(trades, x); if (t) openTrade(t.id); } : undefined} />
            {a.tradesTruncated && <div className="mt-1 text-[11px] text-muted">The newest {count(trades.length)} trades are drawn.</div>}
          </Widget>

          <Widget icon={ICON.bars} title="P&L per trade" busy={busy}>
            <EChart option={barOption} height={220} label="Each closed trade's P&L in exit order" onAxisClick={openTrade ? (x) => { const t = trades[Math.round(x)]; if (t) openTrade(t.id); } : undefined} />
          </Widget>
        </>
      )}

      <div className={`grid items-start gap-4 ${a.instrument.length > 1 ? "md:grid-cols-2" : ""}`}>
        {a.instrument.length > 1 && (
          <Widget icon={ICON.coins} title="Where the money comes from" busy={busy}>
            <SignedBars
              labelWidth={a.instrument.some((b) => b.label.includes(":")) ? "8rem" : "5.5rem"}
              rows={a.instrument.map((b) => ({ key: b.key, label: b.label, value: b.pnl, n: b.n, pressed: chipOf(q, "symbol") === b.filter, onClick: () => toggle(b.filter), title: `${b.label}: ${b.wins} won, ${b.losses} lost` }))}
            />
          </Widget>
        )}
        {a.closed > 0 && <Widget icon={ICON.shield} title="Costs and recovery" explain={`From the strategy's equity on its base and the venue's cost columns.${rangeNote}`}>
          {perf.isPending ? (
            <div className="h-24 rounded bg-raised" />
          ) : (
            <div className={`grid gap-x-8 ${a.instrument.length > 1 ? "" : "@3xl:grid-cols-2"}`}>
              {r?.drawdownDurationDays != null && <StatRow label="Longest under water">{days(r.drawdownDurationDays)}</StatRow>}
              {r?.recoveryFactor != null && <StatRow label="Recovery factor" title="Total net over the deepest drawdown">{num(r.recoveryFactor)}</StatRow>}
              {costs ? (
                <>
                  <StatRow label="Gross, before costs"><span className={toneClass(costs.total.grossProfit)}>{signedMoney(costs.total.grossProfit)}</span></StatRow>
                  <StatRow label={<><CostTerm kind="commission" /> · <CostTerm kind="swap">swap</CostTerm> · <CostTerm kind="fee">fees</CostTerm></>}>
                    <span className="text-body">{signedMoney(costs.total.commission)} · {signedMoney(costs.total.swap)} · {signedMoney(costs.total.fee)}</span>
                  </StatRow>
                  {costs.total.funding ? (
                    <StatRow label={<>Perpetual <CostTerm kind="funding">funding</CostTerm></>} title="What the venue charged (negative) or paid for funding the perpetual positions; not in swap">
                      <span className="text-body">{signedMoney(costs.total.funding)}</span>
                    </StatRow>
                  ) : null}
                </>
              ) : null}
              {r && !ratioNote && (
                <StatRow label="Sharpe · Sortino · Calmar" title={`From end-of-day equity on the base, annualised over 252 days; n = ${r.ratioDays} days with closes`}>
                  {num(r.sharpe)} · {num(r.sortino)} · {num(r.calmar)}
                </StatRow>
              )}
            </div>
          )}
          {ratioNote && <p className="mt-2 text-xs text-muted">{ratioNote}</p>}
        </Widget>}
      </div>
    </div>
  );
}
