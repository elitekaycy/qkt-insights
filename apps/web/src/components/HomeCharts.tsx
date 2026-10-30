import { useState } from "react";
import type { DayNet } from "../api";
import { count, day as utcDay, monthName, polarity, shortDay, signedMoney, weekday } from "../format";
import { HOME_RANGES, rangeFirstDay, type HomeRange } from "../home";
import { Link, useRoute } from "../router";
import { ChartCard } from "./ChartCard";
import { EChart, qktBarTooltip, qktChartAxis, qktChartGrid, type QktChartOption, qktXAxis, signedBar, tipHtml, tok, zeroLine } from "./EChart";
import { compactSigned, monthCells, shade, shiftMonth, WEEKDAYS } from "../calendar";
import { Card, CurrencyMix, IconButton, Pnl, Segmented } from "./ui";

/*
 * Home's history: realized P&L by UTC close day over the chosen range (bars) with its running total
 * (line), and the month's calendar whose days open their trades.
 */

export function PnlChart({ days, range, onRange, now, mix = null }: { days: DayNet[]; range: HomeRange; onRange: (r: HomeRange) => void; now: number; /** Set when the days add accounts in different currencies. */ mix?: { label: string; title: string } | null }) {
  const first = rangeFirstDay(range, now);
  const rows = first == null ? days : days.filter((d) => d.day >= first);
  let running = 0;
  const cum = rows.map((x) => (running += x.net));
  const total = running;
  const trades = rows.reduce((a, x) => a + x.trades, 0);
  const option: QktChartOption = {
    grid: { ...qktChartGrid, top: 12 },
    tooltip: {
      ...qktBarTooltip(),
      formatter: (params: unknown) => {
        const i = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
        const row = rows[i];
        if (!row) return "";
        return tipHtml(`${weekday(row.day)} ${row.day} · UTC day`, { text: signedMoney(row.net), tone: polarity(row.net) }, [
          ["Closed trades", count(row.trades)],
          ["Running total", signedMoney(cum[i])],
        ]);
      },
    },
    xAxis: { type: "category", data: rows.map((x) => x.day), boundaryGap: true, ...qktXAxis },
    yAxis: { type: "value", splitNumber: 4, ...qktChartAxis },
    series: [
      {
        name: "daily",
        type: "bar",
        barMaxWidth: 18,
        barCategoryGap: "25%",
        data: rows.map((x) => ({ value: x.net, itemStyle: signedBar(x.net) })),
        markLine: zeroLine(),
      },
      // a neutral line, so the running total never reads as one more gain bar
      { name: "running total", type: "line", showSymbol: false, smooth: false, data: cum, lineStyle: { color: tok("muted"), width: 2 }, itemStyle: { color: tok("muted") } },
    ],
  };
  return (
    <ChartCard
      title="Realized P&L"
      meta={`${count(trades)} closes · ${count(rows.length)} days · UTC`}
      value={<><Pnl value={total} /><CurrencyMix mix={mix} /></>}
      controls={<Segmented label="Range" value={range} options={HOME_RANGES} onChange={onRange} />}
    >
            {rows.length > 0 ? (
        <div className="p-3 sm:p-4">
          <EChart option={option} height={230} label="Realized P&L per UTC day with the running total" />
        </div>
      ) : (
        <div className="flex min-h-40 items-center justify-center px-5 text-center text-sm text-muted">
          No closed trades in this range: widen it to All.
        </div>
      )}
    </ChartCard>
  );
}

/** One Monday-first month of daily realized P&L; a day opens its closed trades on the Trades page. */
export function MonthCalendar({ days, now, mix = null }: { days: DayNet[]; now: number; mix?: { label: string; title: string } | null }) {
  const { navigate } = useRoute();
  const today = utcDay(now);
  const [month, setMonth] = useState(today.slice(0, 7));
  const byDay = new Map(days.map((d) => [d.day, d]));
  const firstMonth = days[0]?.day.slice(0, 7) ?? month;
  const cells = monthCells(month);
  const monthDays = days.filter((d) => d.day.startsWith(month));
  const maxAbs = Math.max(0, ...monthDays.map((d) => Math.abs(d.net)));
  const net = monthDays.reduce((a, d) => a + d.net, 0);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <IconButton label="previous month" d="M15 18l-6-6 6-6" onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= firstMonth} />
        <div className="min-w-0 flex-1 text-center">
          <div className="text-sm font-semibold text-bright">{monthName(month)}</div>
          <div className="text-xs"><Pnl value={net} /><CurrencyMix mix={mix} /> <span className="text-muted">· {count(monthDays.reduce((a, d) => a + d.trades, 0))} trades</span></div>
        </div>
        <IconButton label="next month" d="M9 18l6-6-6-6" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= today.slice(0, 7)} />
      </div>
      <div className="grid grid-cols-7 gap-1 p-3">
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-center text-xs font-medium text-muted">{w}</div>
        ))}
        {cells.map((c) => {
          const d = byDay.get(c.day);
          const isToday = c.day === today;
          if (!c.inMonth) return <div key={c.day} />;
          const label = `${c.day}${d ? `: ${signedMoney(d.net)} over ${d.trades} closed trades` : ": no closes"}${isToday ? " (in progress)" : ""}`;
          return (
            <button
              key={c.day}
              type="button"
              disabled={!d}
              aria-label={label}
              title={d ? `${label} · open these trades` : label}
              onClick={() => navigate(`/t?q=${encodeURIComponent(`exit:${c.day}`)}`, { from: `Home · ${shortDay(c.day)}` })}
              className={`flex h-11 min-w-0 flex-col justify-between rounded-md border px-0.5 py-0.5 text-left transition ${isToday ? "border-dashed border-accent-hi" : "border-transparent"} ${d ? "hover:border-line-strong" : "cursor-default"}`}
              style={{ background: d ? shade(d.net, maxAbs, 10) : "var(--color-raised)" }}
            >
              <span className="text-xs leading-none text-muted">{Number(c.day.slice(8))}</span>
              {d && <span className="text-xs font-medium leading-none tracking-tighter text-bright">{compactSigned(d.net)}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted">
        <span>UTC days</span>
        <Link to="/calendar" className="font-medium text-accent-ink hover:underline">Full calendar</Link>
      </div>
    </Card>
  );
}
