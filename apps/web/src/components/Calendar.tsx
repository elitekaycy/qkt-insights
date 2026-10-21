import { useMemo, useState } from "react";
import type { DayNet } from "../api";
import { compact, compactPnl, count, DASH, day as utcDay, human, monthName, pct, pnl, signedMoney, signedPct } from "../format";
import { Card, Cell, Empty, Field, IconButton, Modal, Pnl, Row, Table } from "./ui";
import { Link, PAGE_PATHS, routePath, useSearchParam } from "../router";
import { RoundTripTable } from "../trades/RoundTripTable";

/*
 * The journal calendar over daily nets: a Monday-first month grid with a week column, cells
 * shaded by the size of the day, and a monthly-returns table. All math happens on the server's
 * DayNet list; this file only buckets and paints. Days and months open breakdown modals.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86_400_000;

function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** Cell shade: the gain or loss fill mixed into the card, 9% to 55% by the size of the day. */
function shade(net: number, maxAbs: number): string {
  const k = Math.min(1, Math.abs(net) / (maxAbs || 1));
  const color = net >= 0 ? "var(--color-gain-fill)" : "var(--color-loss-fill)";
  return `color-mix(in srgb, ${color} ${Math.round(9 + 46 * k)}%, var(--color-panel))`;
}

/** Phone-width cell figure: sign and compact size only, the shade carries the rest. */
function compactSigned(net: number): string {
  const c = compact(net);
  return net > 0 && c !== "0" ? `+${c}` : c;
}

function shiftMonth(month: string, n: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

export function CalendarView({
  days,
  returnBase,
  baseLabel = "starting capital",
  drill,
}: {
  days: DayNet[];
  /** Capital a month's (and its days') return is measured against; null hides the return. */
  returnBase: (month: string) => number | null;
  /** What the base is, e.g. "account equity at month start". */
  baseLabel?: string;
  /** Where a day's round trips come from: the instance, and the strategy on a strategy page. */
  drill?: { instanceId: string; strategy?: string };
}) {
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const months = useMemo(() => [...new Set(days.map((d) => monthKey(d.day)))].sort(), [days]);
  const today = utcDay(Date.now());
  const [picked, setMonth] = useState<string | null>(null);
  const month = picked && months.includes(picked) ? picked : (months[months.length - 1] ?? monthKey(today));
  const [openDay, setDay] = useState<string | null>(null);
  const [trade, setTrade] = useSearchParam("trade");
  // closing the day closes a trade opened from it
  const setOpenDay = (d: string | null) => {
    if (d == null && trade) setTrade("");
    setDay(d);
  };
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  const monthly = useMemo(() => {
    const out = new Map<string, { net: number; trades: number }>();
    for (const d of days) {
      const k = monthKey(d.day);
      const cur = out.get(k) ?? { net: 0, trades: 0 };
      cur.net += d.net;
      cur.trades += d.trades;
      out.set(k, cur);
    }
    return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [days]);

  if (days.length === 0) {
    return (
      <Card>
        <Empty>No closed trades in this range yet. Days appear here as positions close.</Empty>
      </Card>
    );
  }

  const idx = months.indexOf(month);
  const first = Date.parse(`${month}-01T00:00:00Z`);
  const lead = (new Date(first).getUTCDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const cells: { day: string; inMonth: boolean }[] = [];
  for (let i = -lead; i < Math.ceil((lead + daysInMonth) / 7) * 7 - lead; i++) {
    cells.push({ day: utcDay(first + i * DAY_MS), inMonth: i >= 0 && i < daysInMonth });
  }
  const weeks: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const monthDays = days.filter((d) => monthKey(d.day) === month);
  const maxAbs = Math.max(0, ...monthDays.map((d) => Math.abs(d.net)));
  const monthNet = monthDays.reduce((a, d) => a + d.net, 0);
  const monthTrades = monthDays.reduce((a, d) => a + d.trades, 0);
  const greenDays = monthDays.filter((d) => d.net > 0).length;
  const best = monthDays.reduce<DayNet | null>((a, d) => (a == null || d.net > a.net ? d : a), null);
  const worst = monthDays.reduce<DayNet | null>((a, d) => (a == null || d.net < a.net ? d : a), null);

  const year = month.slice(0, 4);
  const pctOf = (net: number, m: string) => {
    const base = returnBase(m);
    return base ? signedPct((net / base) * 100) : DASH;
  };
  const hasBase = monthly.some(([k]) => returnBase(k) != null);
  const ytd = monthly.filter(([k]) => k.startsWith(year)).reduce((a, [, v]) => a + v.net, 0);
  const monthlyMaxAbs = Math.max(0, ...monthly.map(([, v]) => Math.abs(v.net)));

  const dayInfo = openDay ? byDay.get(openDay) : null;
  const openMonthDays = openMonth ? days.filter((d) => monthKey(d.day) === openMonth).sort((a, b) => (a.day < b.day ? -1 : 1)) : [];
  const openMonthNet = openMonthDays.reduce((a, d) => a + d.net, 0);
  const bestDay = openMonthDays.reduce<DayNet | null>((a, d) => (a == null || d.net > a.net ? d : a), null);
  const worstDay = openMonthDays.reduce<DayNet | null>((a, d) => (a == null || d.net < a.net ? d : a), null);

  return (
    <div className="@container grid gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-body">P&L calendar</span>
          <span className="ml-auto text-xs text-muted">by close day (UTC){drill ? " · click a day for its trades" : ""}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <IconButton label="Previous month" disabled={idx <= 0} onClick={() => idx > 0 && setMonth(months[idx - 1]!)} d="M15 18l-6-6 6-6" />
          <span className="min-w-[9.5rem] text-center text-[15px] font-headline text-bright">{monthName(month)}</span>
          <IconButton
            label="Next month"
            disabled={idx >= months.length - 1}
            onClick={() => idx < months.length - 1 && setMonth(months[idx + 1] ?? shiftMonth(month, 1))}
            d="M9 6l6 6-6 6"
          />
          <span className="flex-1" />
          <Pnl value={monthNet} className="font-headline" />
          <span className="text-muted">
            {count(monthTrades)} trades · {monthDays.length ? pct(greenDays / monthDays.length, 0) : DASH} green days
          </span>
          {best && best.net > 0 && (
            <span className="hidden text-muted @2xl:inline">
              best <b className="font-semibold text-gain">{signedMoney(best.net, 0)}</b>
            </span>
          )}
          {worst && worst.net < 0 && (
            <span className="hidden text-muted @2xl:inline">
              worst <b className="font-semibold text-loss">{signedMoney(worst.net, 0)}</b>
            </span>
          )}
        </div>

        <div role="grid" aria-label={`P&L calendar for ${monthName(month)}`} className="mt-3 grid grid-cols-7 gap-1 @xl:grid-cols-[repeat(7,minmax(0,1fr))_96px] @xl:gap-1.5">
          <div role="row" className="contents">
            {WEEKDAYS.map((w) => (
              <div key={w} role="columnheader" className="eyebrow pb-1 text-center">
                {w}
              </div>
            ))}
            <div role="columnheader" className="eyebrow hidden pb-1 text-center @xl:block">
              Week
            </div>
          </div>
          {weeks.map((w, wi) => {
            const wd = w.filter((c) => c.inMonth).map((c) => byDay.get(c.day)).filter((d): d is DayNet => d != null);
            const wNet = wd.reduce((a, d) => a + d.net, 0);
            const wTrades = wd.reduce((a, d) => a + d.trades, 0);
            return (
              <div key={`w${wi}`} role="row" className="contents">
                {w.map((c) => {
                  const d = c.inMonth ? byDay.get(c.day) : undefined;
                  const n = Number(c.day.slice(8));
                  const isToday = c.day === today;
                  if (!d) {
                    return (
                      <div
                        key={c.day}
                        role="gridcell"
                        className={`flex min-h-12 flex-col justify-between rounded-lg border px-1.5 py-1 @xl:min-h-[78px] @xl:px-2 @xl:py-1.5 ${
                          c.inMonth ? "border-line bg-panel" : "border-dashed border-line-strong"
                        } ${isToday ? "border-accent-hi" : ""}`}
                      >
                        <span className={`text-[11px] ${c.inMonth ? "text-muted" : "text-faint"}`}>{n}</span>
                        {isToday && <span className="hidden text-[11px] text-accent-ink @xl:block">today</span>}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={c.day}
                      type="button"
                      role="gridcell"
                      onClick={() => setOpenDay(c.day)}
                      style={{ background: shade(d.net, maxAbs) }}
                      aria-label={`${c.day}: ${signedMoney(d.net)}, ${d.trades} trades`}
                      className={`flex min-h-12 min-w-0 flex-col justify-between rounded-lg border px-1.5 py-1 text-left transition hover:-translate-y-px hover:border-faint @xl:min-h-[78px] @xl:px-2 @xl:py-1.5 ${
                        isToday ? "border-accent-hi" : "border-line"
                      }`}
                    >
                      <span className="flex items-center justify-between text-[11px] text-bright">
                        {n}
                        {isToday && <span className="hidden text-accent-ink @xl:inline">in progress</span>}
                      </span>
                      <span className="truncate text-[10px] font-headline text-bright @xl:hidden">{compactSigned(d.net)}</span>
                      <span className="hidden truncate text-sm font-headline text-bright @xl:block">{compactPnl(d.net)}</span>
                      <span className="hidden text-[11px] text-bright @xl:block">
                        {d.trades} trade{d.trades === 1 ? "" : "s"}
                      </span>
                    </button>
                  );
                })}
                <div role="gridcell" className="hidden flex-col justify-center gap-0.5 rounded-lg border border-dashed border-line-strong px-2 py-1.5 text-[11px] text-muted @xl:flex">
                  <span>Week {wi + 1}</span>
                  <b className={`text-sm font-semibold ${wTrades ? (wNet >= 0 ? "text-gain" : "text-loss") : "text-muted"}`}>{wTrades ? signedMoney(wNet, 0) : DASH}</b>
                  <span>{wTrades} trades</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-body">
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: shade(1, 1) }} />
            profit day
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: shade(-1, 1) }} />
            loss day
          </span>
          <span className="text-muted">Intensity follows the size of the day.</span>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
          <h3 className="text-sm font-medium text-body">Monthly returns</h3>
          <span className="text-xs text-muted">
            YTD {pnl(ytd)}
            {hasBase ? ` · return on ${baseLabel}` : ""} · click a month
          </span>
        </div>
        <div className="max-h-[30rem] overflow-auto">
          <Table head={["Month", "Net", ...(hasBase ? ["Return"] : []), "Trades"]}>
            {[...monthly].reverse().map(([k, v]) => (
              <Row
                key={k}
                onClick={() => {
                  setMonth(k);
                  setOpenMonth(k);
                }}
              >
                <Cell className="whitespace-nowrap">{k}</Cell>
                <Cell>
                  <span className="rounded px-1.5 py-0.5 font-semibold" style={{ background: shade(v.net, monthlyMaxAbs) }}>
                    {pnl(v.net)}
                  </span>
                </Cell>
                {hasBase && <Cell className="text-body">{pctOf(v.net, k)}</Cell>}
                <Cell className="text-body">{count(v.trades)}</Cell>
              </Row>
            ))}
          </Table>
        </div>
      </Card>

      {openDay && dayInfo && (
        <Modal
          open
          onClose={() => setOpenDay(null)}
          title={human(Date.parse(`${openDay}T12:00:00Z`)).split("·")[0]!.trim()}
          hint={`UTC day · ${dayInfo.trades} closed trade${dayInfo.trades === 1 ? "" : "s"}`}
          width={drill ? "min(96vw, 1040px)" : "min(94vw, 760px)"}
        >
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="Day net P&L">
              <Pnl value={dayInfo.net} />
            </Field>
            <Field label={`Return on ${baseLabel}`}>{pctOf(dayInfo.net, monthKey(openDay))}</Field>
          </div>
          {drill && <DayTrades day={openDay} drill={drill} />}
        </Modal>
      )}

      {openMonth && (
        <Modal open onClose={() => setOpenMonth(null)} title={monthName(openMonth)} hint={`net ${signedMoney(openMonthNet)}`} width="min(94vw, 760px)">
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="Month net P&L">
              <Pnl value={openMonthNet} />
            </Field>
            <Field label={`Return on ${baseLabel}`}>{pctOf(openMonthNet, openMonth)}</Field>
            <Field label="Best day">
              {bestDay ? (
                <>
                  {bestDay.day} <Pnl value={bestDay.net} className="ml-2" />
                </>
              ) : (
                DASH
              )}
            </Field>
            <Field label="Worst day">
              {worstDay ? (
                <>
                  {worstDay.day} <Pnl value={worstDay.net} className="ml-2" />
                </>
              ) : (
                DASH
              )}
            </Field>
            <Field label="Days traded">{count(openMonthDays.length)}</Field>
            <Field label="Profitable days">
              {openMonthDays.filter((d) => d.net > 0).length}/{openMonthDays.length} ·{" "}
              {openMonthDays.length ? pct(openMonthDays.filter((d) => d.net > 0).length / openMonthDays.length, 0) : DASH}
            </Field>
          </div>
          <div className="eyebrow px-4 pb-1">Day by day · click to open</div>
          <Table head={["Day (UTC)", "Net", "Trades"]}>
            {openMonthDays.map((d) => (
              <Row
                key={d.day}
                onClick={() => {
                  setOpenMonth(null);
                  setOpenDay(d.day);
                }}
              >
                <Cell className="text-muted">{d.day}</Cell>
                <Cell>
                  <Pnl value={d.net} />
                </Cell>
                <Cell className="text-muted">{count(d.trades)}</Cell>
              </Row>
            ))}
          </Table>
        </Modal>
      )}
    </div>
  );
}

/**
 * The round trips that closed on one UTC day, from the same endpoint and query language as the
 * Trades page (`exit:<day>`): a row opens the trade drawer over this dialog, and the link opens
 * Trades (or the strategy's trades) filtered to the day.
 */
function DayTrades({ day, drill }: { day: string; drill: { instanceId: string; strategy?: string } }) {
  const [, setTrade] = useSearchParam("trade");
  const q = `exit:${day}`;
  const to = drill.strategy ? routePath({ page: "strategies", strategy: drill.strategy, tab: "trades" }) : PAGE_PATHS.trades;
  const hide = drill.strategy ? ["id", "size", "r", "strategy"] : ["id", "size", "r"];
  return (
    <div className="border-t border-line">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="eyebrow">Round trips closed that day</span>
        <span className="hidden text-xs text-faint sm:inline">· click one for its timeline</span>
        <Link
          to={`${to}?q=${encodeURIComponent(q)}`}
          onClick={() => setTrade("")}
          className="ml-auto text-xs font-medium text-accent-ink hover:underline"
        >
          Open in Trades →
        </Link>
      </div>
      <RoundTripTable scope={{ instanceId: drill.instanceId, strategy: drill.strategy }} q={q} sort="exit" dir="asc" hide={hide} height="min(46dvh, 24rem)" />
    </div>
  );
}
