import { useMemo } from "react";
import { EChart, qktBarTooltip, qktChartAxis, qktChartGrid, type QktChartOption, qktXAxis, signedBar, tipHtml, zeroLine } from "../components/EChart";
import { count, DASH, duration, num, pnl, polarity, signedMoney, toneClass, winPct } from "../format";
import type { TripBucket } from "../trades/analytics";
import { rMultiple } from "../trades/format";
import { chipOf, MIN_SAMPLE, winRate } from "./journal";
import type { SectionProps } from "./StrategyPage";
import { ICON, SignedBars, StatRow, Widget } from "./widgets";

/*
 * Time & risk: when the strategy wins (UTC entry weekday and hour, with n and thin buckets
 * faded), how its trades end, how long it holds, which side pays, how much it risks (R) and how
 * it streaks. Every bucket narrows the query to its trades; a second click clears it.
 */

function bucketRows(buckets: TripBucket[], q: string, key: Parameters<typeof chipOf>[1], toggle: (t: string) => void, fadeThin = false) {
  const active = chipOf(q, key);
  return buckets.map((b) => ({
    key: b.key,
    label: b.label,
    value: b.pnl,
    n: b.n,
    faded: fadeThin && b.n < MIN_SAMPLE,
    pressed: active === b.filter,
    onClick: () => toggle(b.filter),
    title: `${b.label}: ${b.n} trades, ${b.wins} won, ${b.losses} lost, ${winPct(winRate(b))} win rate, average ${b.n ? signedMoney(b.pnl / b.n) : DASH}`,
  }));
}

export function TimeRiskSection({ q, toggle, a, busy, openTrade }: SectionProps) {
  const hourChip = chipOf(q, "hour");
  const hours = a?.hour ?? [];
  const hourOption = useMemo<QktChartOption>(() => ({
    grid: { ...qktChartGrid, top: 12 },
    tooltip: {
      ...qktBarTooltip(),
      formatter: (params: unknown) => {
        const b = hours[(params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0];
        if (!b) return "";
        return tipHtml(`Entered ${b.label}:00–${b.label}:59 UTC`, { text: pnl(b.pnl), tone: polarity(b.pnl) }, [
          ["Trades (n)", count(b.n)], ["Win rate", winPct(winRate(b))], ["Average", b.n ? signedMoney(b.pnl / b.n) : DASH],
          ...(b.n > 0 && b.n < MIN_SAMPLE ? [["Sample", `thin: under ${MIN_SAMPLE} trades`] as [string, string]] : []),
        ], "Click to filter to this hour");
      },
    },
    xAxis: { type: "category", data: hours.map((b) => b.label), ...qktXAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis },
    series: [{
      name: "P&L", type: "bar", barCategoryGap: "25%",
      data: hours.map((b) => ({
        value: b.n ? b.pnl : null,
        itemStyle: signedBar(b.pnl, hourChip ? (hourChip === b.filter ? 1 : 0.35) : b.n < MIN_SAMPLE ? 0.35 : 1),
      })),
      markLine: zeroLine(),
    }],
  }), [hours, hourChip]);

  if (!a) return null;
  if (a.closed === 0) {
    return (
      <div className="rounded-card border border-line bg-panel px-6 py-10 text-center text-sm text-muted">
        <b className="text-bright">No closed trades in this selection.</b> Loosen the search above or widen the range.
      </div>
    );
  }
  const long = a.side.find((b) => b.key === "long")!;
  const short = a.side.find((b) => b.key === "short")!;
  const thin = `faded: under ${MIN_SAMPLE} trades`;
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      <Widget icon={ICON.side} title="Long vs short" busy={busy}>
        <SignedBars rows={bucketRows(a.side, q, "side", toggle)} />
        <div className="mt-2">
          <StatRow label="Long win rate">{winPct(winRate(long))}</StatRow>
          <StatRow label="Short win rate">{winPct(winRate(short))}</StatRow>
        </div>
      </Widget>
      <Widget icon={ICON.flag} title="How trades ended" busy={busy}
        explain="From the venue's close comment and the engine's events: the stop or target filled, the strategy's own exit rule, the venue (a stop-out), or a close by hand.">
        {a.ended.length > 0 ? (
          <SignedBars labelWidth="5.5rem" rows={bucketRows(a.ended, q, "ended", toggle)} />
        ) : (
          <p className="py-4 text-sm text-muted">No close reason recorded for these trades: older engines and paper fills do not say.</p>
        )}
      </Widget>
      <Widget icon={ICON.hourglass} title="Held for" busy={busy}>
        <SignedBars rows={bucketRows(a.hold, q, "held", toggle)} />
      </Widget>
      <Widget icon={ICON.clock} title="By entry weekday (UTC)" hint={thin} busy={busy}>
        {/* with few trades, empty weekdays are noise: list the days that traded and say the rest had none */}
        <SignedBars rows={bucketRows(a.closed < MIN_SAMPLE ? a.weekday.filter((b) => b.n > 0) : a.weekday, q, "weekday", toggle, true)} />
        {a.closed < MIN_SAMPLE && a.weekday.some((b) => b.n === 0) && <p className="mt-2 text-xs text-muted">Other days: no trades.</p>}
      </Widget>
      <Widget icon={ICON.clock} title="By entry hour (UTC)" hint={thin} className="md:col-span-2" busy={busy}>
        <EChart option={hourOption} height={220} zoom={false} label="Realized P&L by UTC entry hour" onAxisClick={(x) => { const b = hours[Math.round(x)]; if (b && b.n > 0) toggle(b.filter); }} />
      </Widget>
      <Widget icon={ICON.shield} title="Risk" busy={busy}
        explain="R is a trade's P&L over the money it stood to lose at its initial stop. Only trades whose stop is known have an R: the stop is read from the entry's submit event, so a trade without one, or one older than the events kept, counts as no stop even if it had one at the venue. Average and total R cover only those trades. On a fast market a stop can fill worse than its level, so losses beyond −1R happen.">
        <StatRow label="Trades with a known stop">{count(a.r.n)} of {count(a.closed)}</StatRow>
        <StatRow label="Average R"><span className={toneClass(a.r.avg)}>{a.r.n ? rMultiple(a.r.avg) : "no stop"}</span>{a.r.n > 0 && a.r.n < a.closed && <span className="text-muted"> · {count(a.r.n)} of {count(a.closed)}</span>}</StatRow>
        <StatRow label="Total R"><span className={toneClass(a.r.total)}>{a.r.n ? rMultiple(a.r.total) : "no stop"}</span>{a.r.n > 0 && a.r.n < a.closed && <span className="text-muted"> · {count(a.r.n)} of {count(a.closed)}</span>}</StatRow>
        <StatRow label="Win/loss ratio">{num(a.payoff)}</StatRow>
        <StatRow label="Average hold">{a.avgHoldMs == null ? DASH : duration(a.avgHoldMs)}</StatRow>
      </Widget>
      <Widget icon={ICON.streak} title="Streaks and extremes" busy={busy}
        explain="Runs of consecutive wins or losses in exit order (breakeven trades break neither). The table reads how the next trade went after a run of losses, as seen in these trades.">
        <StatRow label="Current streak">
          <span className={toneClass(a.streaks.current)}>{a.streaks.current === 0 ? DASH : `${a.streaks.current > 0 ? `${a.streaks.current} won` : `${-a.streaks.current} lost`} in a row`}</span>
        </StatRow>
        <StatRow label="Longest winning streak">{count(a.streaks.maxWin)}</StatRow>
        <StatRow label="Longest losing streak">{count(a.streaks.maxLoss)}</StatRow>
        <StatRow label="Best trade" onClick={openTrade && a.best ? () => openTrade(a.best!.id) : undefined}><span className={toneClass(a.best?.pnl)}>{a.best ? signedMoney(a.best.pnl) : DASH}</span></StatRow>
        <StatRow label="Worst trade" onClick={openTrade && a.worst ? () => openTrade(a.worst!.id) : undefined}><span className={toneClass(a.worst?.pnl)}>{a.worst ? signedMoney(a.worst.pnl) : DASH}</span></StatRow>
        {a.postLoss.length > 0 && (
          <div className="mt-3">
            <div className="eyebrow pb-1">After N losses in a row, the next trade</div>
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-left">
                  {["Losses", "Seen", "Next win rate", "Next avg"].map((h, i) => <th key={h} className={`eyebrow py-1.5 ${i > 0 ? "text-right" : ""}`}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {a.postLoss.map((p) => (
                  <tr key={p.n} className="border-b border-line last:border-b-0">
                    <td className="py-1.5 text-bright">{p.n}</td>
                    <td className="text-right text-muted">{p.sample}×</td>
                    <td className="text-right text-body">{winPct(p.nextWinRate)}</td>
                    <td className={`text-right font-semibold ${toneClass(p.nextAvg)}`}>{signedMoney(p.nextAvg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Widget>
    </div>
  );
}
