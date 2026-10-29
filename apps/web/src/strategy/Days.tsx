import { useMemo, useState } from "react";
import { withTokens } from "@qkt-insights/contract/query";
import { CalendarView } from "../components/Calendar";
import { chartColors, EChart, qktChartAxis, qktChartGrid, qktChartTooltip, qktXAxis, tipHtml, tok, zeroLine, type QktChartOption } from "../components/EChart";
import { compact, count, DASH, monthName, pnl, polarity, signedMoney, signedPct, toneClass, winPct } from "../format";
import type { TripDay, TripMonth } from "../trades/analytics";
import { RoundTripTable } from "../trades/RoundTripTable";
import { emptyHint, pickedSpan, profitFactorText, windowTotals, withCumulative, without } from "./journal";
import type { SectionProps } from "./StrategyPage";
import { ICON, Widget } from "./widgets";

/*
 * Calendar, Daily and Monthly: the strategy's P&L by UTC exit day and month. Each keeps its whole
 * period on screen (the query without its exit day or month) while a click picks a day or month,
 * which narrows the query; the trades behind the pick are listed under it.
 */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekday = (d: string) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
const winRate = (d: { wins: number; losses: number }) => (d.wins + d.losses > 0 ? (d.wins / (d.wins + d.losses)) * 100 : null);

function shade(net: number, maxAbs: number): string {
  const k = Math.min(1, Math.abs(net) / (maxAbs || 1));
  return `color-mix(in srgb, ${net >= 0 ? "var(--color-gain-fill)" : "var(--color-loss-fill)"} ${Math.round(9 + 46 * k)}%, var(--color-panel))`;
}

function Empty({ q, from }: { q: string; from: number | undefined }) {
  return (
    <div className="rounded-card border border-line bg-panel px-6 py-10 text-center text-sm text-muted">
      <b className="text-bright">No closed trades in this selection.</b> {emptyHint(q, from)}
    </div>
  );
}

/** The round trips behind a picked day or month, under the section that picked them. */
function PickedTrades({ scope, q, title, n }: { scope: SectionProps["scope"]; q: string; title: string; n: number }) {
  // as tall as its rows (a header plus 36px each), up to half the screen
  return (
    <Widget icon={ICON.streak} title={title} pad={false}>
      <RoundTripTable scope={scope} q={q} sort="exit" dir="asc" hide={["strategy"]} height={`min(50dvh, ${Math.max(2, n) * 36 + 44}px)`} />
    </Widget>
  );
}

export function CalendarSection({ scope, q, toggle, base, capital }: SectionProps) {
  const { day, month } = pickedSpan(q);
  if (!base) return null;
  if (base.daily.length === 0) return <Empty q={q} from={scope.from} />;
  return (
    <div className="grid grid-cols-1 gap-4">
      <CalendarView
        days={base.daily.map((d) => ({ day: d.day, net: d.pnl, trades: d.n }))}
        returnBase={() => capital.amount}
        baseLabel={capital.label.replace(/^on /, "")}
        onDay={(d) => toggle(`exit:${d}`)}
        selectedDay={day}
        month={month}
        monthlyTable={false}
      />
      {day && <PickedTrades scope={scope} q={q} title={`Trades exited on ${day}`} n={base.daily.find((d) => d.day === day)?.n ?? 0} />}
    </div>
  );
}

export function DailySection({ scope, q, toggle, base, busy }: SectionProps) {
  const { day: picked } = pickedSpan(q);
  const days = useMemo(() => withCumulative(base?.daily ?? []), [base]);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const option = useMemo<QktChartOption>(() => ({
    grid: { ...qktChartGrid, top: 12 },
    tooltip: {
      ...qktChartTooltip(),
      axisPointer: { type: "shadow", shadowStyle: { color: tok("hover") } },
      formatter: (params: unknown) => {
        const d = days[(params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0];
        if (!d) return "";
        return tipHtml(`${weekday(d.day)} ${d.day} · UTC exit day`, { text: pnl(d.pnl), tone: polarity(d.pnl) }, [
          ["Trades", count(d.n)], ["Win rate", winPct(winRate(d))], ["Running total", signedMoney(d.cum)],
        ], "Click to filter to this day");
      },
    },
    xAxis: { type: "category", data: days.map((d) => d.day.slice(5)), ...qktXAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis },
    series: [{
      name: "P&L", type: "bar", barMaxWidth: 22, barCategoryGap: "25%",
      data: days.map((d) => ({
        value: d.pnl,
        itemStyle: { color: d.pnl >= 0 ? chartColors.gain : chartColors.loss, opacity: picked && picked !== d.day ? 0.35 : 1, borderRadius: d.pnl >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] },
      })),
      markLine: zeroLine(),
    }],
  }), [days, picked]);
  if (!base) return null;
  if (days.length === 0) return <Empty q={q} from={scope.from} />;
  const shown = windowTotals(days, zoom);
  const rows = [...days].reverse();
  return (
    <div className="grid grid-cols-1 gap-4">
      <Widget icon={ICON.bars} title="Daily P&L" hint={`${count(days.length)} trading days`} busy={busy}>
        <EChart option={option} height={260} label="Realized P&L per UTC exit day" onAxisClick={(x) => { const d = days[Math.round(x)]; if (d) toggle(`exit:${d.day}`); }} onZoom={setZoom} />
        {shown && (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line pt-3 text-sm tabular-nums" aria-live="polite">
            <span className="text-muted">{zoom ? `${shown.from} → ${shown.to}` : "Whole period"}</span>
            <span className="text-body">{count(shown.days)} days</span>
            <span className="text-body">{count(shown.trades)} trades</span>
            <span className="text-body">{winPct(shown.winRate)} win</span>
            <b className={`font-semibold ${toneClass(shown.pnl)}`}>{pnl(shown.pnl)}</b>
          </div>
        )}
      </Widget>
      <Widget icon={ICON.calendar} title="Days" hint="newest first" pad={false} busy={busy}>
        <div className="max-h-[26rem] overflow-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line text-left">
                {["Day (UTC)", "Trades", "Win rate", "P&L", "Cumulative"].map((h, i) => <th key={h} className={`eyebrow whitespace-nowrap px-4 py-2 ${i > 0 ? "text-right" : ""}`}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.day} onClick={() => toggle(`exit:${d.day}`)} aria-selected={picked === d.day} className={`cursor-pointer border-b border-line last:border-b-0 hover:bg-hover ${picked === d.day ? "bg-accent-soft" : ""}`}>
                  <td className="whitespace-nowrap px-4 py-[7px] font-mono text-xs text-bright">{d.day} <span className="text-muted">{weekday(d.day)}</span></td>
                  <td className="px-4 text-right text-body">{count(d.n)}</td>
                  <td className="px-4 text-right text-body">{winPct(winRate(d))}</td>
                  <td className={`whitespace-nowrap px-4 text-right font-semibold ${toneClass(d.pnl)}`}>{pnl(d.pnl)}</td>
                  <td className={`whitespace-nowrap px-4 text-right ${toneClass(d.cum)}`}>{signedMoney(d.cum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
      {picked && <PickedTrades scope={scope} q={q} title={`Trades exited on ${picked}`} n={days.find((d) => d.day === picked)?.n ?? 0} />}
    </div>
  );
}

function monthPf(m: TripMonth): number | "inf" | null {
  if (m.wins + m.losses === 0) return null;
  return m.grossLoss === 0 ? (m.grossWin > 0 ? "inf" : null) : m.grossWin / -m.grossLoss;
}

export function MonthlySection({ scope, q, toggle, base, busy, capital, goTab }: SectionProps) {
  const { day, month: pickedMonth } = pickedSpan(q);
  const picked = day ? null : pickedMonth;
  const months = useMemo(() => base?.monthly ?? [], [base]);
  const option = useMemo<QktChartOption>(() => ({
    grid: { ...qktChartGrid, top: 12 },
    tooltip: {
      ...qktChartTooltip(),
      axisPointer: { type: "shadow", shadowStyle: { color: tok("hover") } },
      formatter: (params: unknown) => {
        const m = months[(params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0];
        if (!m) return "";
        return tipHtml(`${monthName(m.day)} · UTC exit month`, { text: pnl(m.pnl), tone: polarity(m.pnl) }, [
          ["Trades", count(m.n)], ["Win rate", winPct(winRate(m))], ["Profit factor", profitFactorText(monthPf(m))],
        ], "Click to filter to this month");
      },
    },
    xAxis: { type: "category", data: months.map((m) => m.day), ...qktXAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis },
    series: [{
      name: "P&L", type: "bar", barMaxWidth: 48, barCategoryGap: "30%",
      data: months.map((m) => ({
        value: m.pnl,
        itemStyle: { color: m.pnl >= 0 ? chartColors.gain : chartColors.loss, opacity: picked && picked !== m.day ? 0.35 : 1, borderRadius: m.pnl >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] },
      })),
      markLine: zeroLine(),
    }],
  }), [months, picked]);
  if (!base) return null;
  if (months.length === 0) return <Empty q={q} from={scope.from} />;
  return (
    <div className="grid grid-cols-1 gap-4">
      <Widget icon={ICON.bars} title="Monthly P&L" busy={busy}>
        <EChart option={option} height={240} label="Realized P&L per UTC exit month" zoom={months.length > 24} onAxisClick={(x) => { const m = months[Math.round(x)]; if (m) toggle(`exit:${m.day}`); }} />
      </Widget>
      <Widget icon={ICON.calendar} title="By month" pad={false} busy={busy}>
        <div className="max-h-[26rem] overflow-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line text-left">
                {["Month", "Trades", "Win rate", "PF", "P&L", capital.amount ? "Return" : null].filter(Boolean).map((h, i) => (
                  <th key={h} className={`eyebrow whitespace-nowrap px-4 py-2 ${i > 0 ? "text-right" : ""}`} title={h === "Return" ? `P&L ${capital.label}` : undefined}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => (
                <tr key={m.day} onClick={() => toggle(`exit:${m.day}`)} aria-selected={picked === m.day} className={`cursor-pointer border-b border-line last:border-b-0 hover:bg-hover ${picked === m.day ? "bg-accent-soft" : ""}`}>
                  <td className="whitespace-nowrap px-4 py-[7px] font-mono text-xs text-bright">{m.day}</td>
                  <td className="px-4 text-right text-body">{count(m.n)}</td>
                  <td className="px-4 text-right text-body">{winPct(winRate(m))}</td>
                  <td className="px-4 text-right text-body">{profitFactorText(monthPf(m))}</td>
                  <td className={`whitespace-nowrap px-4 text-right font-semibold ${toneClass(m.pnl)}`}>{pnl(m.pnl)}</td>
                  {capital.amount ? <td className="px-4 text-right text-body">{signedPct((m.pnl / capital.amount) * 100)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
      <YearHeat months={months} onMonth={(m) => goTab("calendar", withTokens(without(q, ["exit"]), `exit:${m}`))} />
      {picked && <PickedTrades scope={scope} q={q} title={`Trades exited in ${monthName(picked)}`} n={months.find((m) => m.day === picked)?.n ?? 0} />}
    </div>
  );
}

/** Year × month with every value printed; a cell opens that month in the calendar. */
function YearHeat({ months, onMonth }: { months: readonly TripDay[]; onMonth: (month: string) => void }) {
  const byMonth = new Map(months.map((m) => [m.day, m]));
  const years = [...new Set(months.map((m) => m.day.slice(0, 4)))].sort().reverse();
  const maxAbs = Math.max(0, ...months.map((m) => Math.abs(m.pnl)));
  return (
    <Widget icon={ICON.calendar} title="Year × month">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-1 text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className="w-12" />
              {MONTHS.map((m) => <th key={m} className="eyebrow text-center">{m}</th>)}
              <th className="eyebrow w-20 text-right">Year</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => {
              const total = months.filter((m) => m.day.startsWith(y)).reduce((a, m) => a + m.pnl, 0);
              return (
                <tr key={y}>
                  <td className="text-muted">{y}</td>
                  {MONTHS.map((_, i) => {
                    const key = `${y}-${String(i + 1).padStart(2, "0")}`;
                    const m = byMonth.get(key);
                    return (
                      <td key={key} className="p-0">
                        {m ? (
                          <button
                            type="button"
                            onClick={() => onMonth(key)}
                            title={`${monthName(key)}: ${signedMoney(m.pnl)} over ${m.n} trades`}
                            className="flex h-8 w-full items-center justify-center rounded-md font-semibold text-bright transition hover:-translate-y-px"
                            style={{ background: shade(m.pnl, maxAbs) }}
                          >
                            {m.pnl >= 0 ? "▲" : "▼"}{compact(Math.abs(m.pnl))}
                          </button>
                        ) : (
                          <div className="flex h-8 items-center justify-center rounded-md border border-dashed border-line text-faint">{DASH}</div>
                        )}
                      </td>
                    );
                  })}
                  <td className={`text-right font-semibold ${toneClass(total)}`}>{signedMoney(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Widget>
  );
}
