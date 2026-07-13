import { useMemo, useState } from "react";
import type { DayNet, TradeRow, TradeView } from "../api";
import { human, money, ts } from "../format";
import { Cell, Empty, Field, IconButton, Modal, Panel, Pill, Row, SideTag, Table } from "./ui";

/*
 * Calendar views over daily nets: a month grid with cells tinted by P&L
 * magnitude, and a monthly-returns table with a YTD row. All math happens on
 * the server's DayNet list; this file only buckets and paints. Days and months
 * are clickable and open breakdown modals (fills of the day, days of the month).
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** Cell tint via the up/down tokens, opacity scaled to |net| within the month. */
function tint(net: number, maxAbs: number): string {
  if (net === 0 || maxAbs === 0) return "transparent";
  const k = Math.max(0.15, Math.min(1, Math.abs(net) / maxAbs));
  const color = net > 0 ? "var(--color-up)" : "var(--color-down)";
  return `color-mix(in srgb, ${color} ${Math.round(k * 30)}%, transparent)`;
}

function netClass(net: number): string {
  return net > 0 ? "text-up" : net < 0 ? "text-down" : "text-muted";
}

export function CalendarView({
  days,
  startingBalance,
  trades = [],
  onTrade,
}: {
  days: DayNet[];
  startingBalance: number | null;
  /** Closed trades / fills for the day-detail modal; pass what the page already fetched. */
  trades?: TradeView[];
  onTrade?: (raw: TradeRow) => void;
}) {
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const months = useMemo(() => [...new Set(days.map((d) => monthKey(d.day)))].sort(), [days]);
  const [month, setMonth] = useState<string>(months[months.length - 1] ?? new Date().toISOString().slice(0, 7));
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  const idx = months.indexOf(month);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first
  const monthDays = [...byDay.values()].filter((d) => monthKey(d.day) === month);
  const maxAbs = Math.max(0, ...monthDays.map((d) => Math.abs(d.net)));
  const monthNet = monthDays.reduce((a, d) => a + d.net, 0);

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

  const year = month.slice(0, 4);
  const ytd = monthly.filter(([k]) => k.startsWith(year)).reduce((a, [, v]) => a + v.net, 0);
  const monthlyMaxAbs = Math.max(0, ...monthly.map(([, v]) => Math.abs(v.net)));

  if (days.length === 0) {
    return (
      <Panel title="Calendar" stagger={0}>
        <Empty>No trading days in this range yet.</Empty>
      </Panel>
    );
  }

  const dayInfo = openDay ? byDay.get(openDay) : null;
  const dayFills = openDay ? trades.filter((t) => new Date(t.ts).toISOString().slice(0, 10) === openDay) : [];
  const openMonthDays = openMonth ? days.filter((d) => monthKey(d.day) === openMonth).sort((a, b) => (a.day < b.day ? -1 : 1)) : [];
  const openMonthNet = openMonthDays.reduce((a, d) => a + d.net, 0);
  const bestDay = openMonthDays.reduce<DayNet | null>((a, d) => (a == null || d.net > a.net ? d : a), null);
  const worstDay = openMonthDays.reduce<DayNet | null>((a, d) => (a == null || d.net < a.net ? d : a), null);

  return (
    <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <Panel
        title={first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}
        hint={`month net ${money(monthNet)} · click a day`}
        stagger={0}
        right={
          <div className="flex gap-1.5">
            <IconButton label="previous month" disabled={idx <= 0} onClick={() => idx > 0 && setMonth(months[idx - 1]!)} d="M15 18l-6-6 6-6" />
            <IconButton
              label="next month"
              disabled={idx >= months.length - 1}
              onClick={() => idx < months.length - 1 && setMonth(months[idx + 1]!)}
              d="M9 6l6 6-6 6"
            />
          </div>
        }
      >
        <div className="p-4">
          <div className="grid grid-cols-7 gap-1.5 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
            {WEEKDAYS.map((w) => (
              <div key={w} className="pb-1">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: lead }).map((_, i) => (
              <div key={`pad${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const dayStr = `${month}-${String(i + 1).padStart(2, "0")}`;
              const d = byDay.get(dayStr);
              return (
                <button
                  type="button"
                  key={dayStr}
                  onClick={() => d && setOpenDay(dayStr)}
                  className={`flex aspect-square flex-col rounded-lg border border-line/60 p-1.5 text-left transition ${
                    d ? "cursor-pointer hover:border-accent/60 hover:brightness-125" : "cursor-default"
                  }`}
                  style={{ background: d ? tint(d.net, maxAbs) : "transparent" }}
                  title={d ? `${dayStr}: ${money(d.net)} · ${d.trades} fill${d.trades === 1 ? "" : "s"}` : dayStr}
                >
                  <span className="text-[10px] text-faint">{i + 1}</span>
                  {d && (
                    <span className={`mt-auto truncate font-mono text-[11px] font-semibold ${netClass(d.net)}`}>
                      {d.net > 0 ? "+" : ""}
                      {Math.abs(d.net) >= 1000 ? `${(d.net / 1000).toFixed(1)}k` : d.net.toFixed(0)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel title="Monthly returns" hint={`YTD ${money(ytd)} · click a month`} stagger={1} scroll="max-h-[30rem]">
        <Table head={["Month", "Net", startingBalance ? "Return" : "", "Fills"].filter(Boolean) as string[]}>
          {monthly.map(([k, v]) => (
            <Row
              key={k}
              onClick={() => {
                setMonth(k);
                setOpenMonth(k);
              }}
            >
              <Cell className="font-mono">{k}</Cell>
              <Cell className={`font-mono ${netClass(v.net)}`}>
                <span className="rounded px-2 py-0.5" style={{ background: tint(v.net, monthlyMaxAbs) }}>{money(v.net)}</span>
              </Cell>
              {startingBalance ? (
                <Cell className="font-mono text-muted">{((v.net / startingBalance) * 100).toFixed(2)}%</Cell>
              ) : null}
              <Cell className="font-mono text-muted">{v.trades}</Cell>
            </Row>
          ))}
        </Table>
      </Panel>

      {openDay && dayInfo && (
        <Modal
          open
          onClose={() => setOpenDay(null)}
          title={human(Date.parse(`${openDay}T12:00:00Z`)).split("·")[0]!.trim()}
          hint={`${dayInfo.trades} fill${dayInfo.trades === 1 ? "" : "s"}`}
          width="min(94vw, 760px)"
        >
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="Day net P&L">
              <span className={netClass(dayInfo.net)}>{money(dayInfo.net)}</span>
            </Field>
            <Field label="Return on starting capital">
              {startingBalance ? `${((dayInfo.net / startingBalance) * 100).toFixed(2)}%` : "—"}
            </Field>
          </div>
          <div className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Trades that day {onTrade && dayFills.some((t) => t.raw) ? "· click one to inspect" : ""}
          </div>
          <Table>
            {dayFills.map((t) => {
              const raw = t.raw;
              return (
                <Row key={t.key} onClick={onTrade && raw ? () => onTrade(raw) : undefined}>
                  <Cell className="whitespace-nowrap text-muted">{ts(t.ts).slice(11)}</Cell>
                  <Cell className="font-semibold text-bright">{t.symbol}</Cell>
                  <Cell>
                    <SideTag side={t.side} />
                  </Cell>
                  <Cell className="font-mono">{t.qty}</Cell>
                  <Cell className="font-mono text-muted">@ {t.price}</Cell>
                </Row>
              );
            })}
            {dayFills.length === 0 && <Empty colSpan={5}>No trades loaded for this day</Empty>}
          </Table>
        </Modal>
      )}

      {openMonth && (
        <Modal
          open
          onClose={() => setOpenMonth(null)}
          title={new Date(`${openMonth}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}
          hint={`net ${money(openMonthNet)}`}
          width="min(94vw, 760px)"
        >
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <Field label="Month net P&L">
              <span className={netClass(openMonthNet)}>{money(openMonthNet)}</span>
            </Field>
            <Field label="Return on starting capital">
              {startingBalance ? `${((openMonthNet / startingBalance) * 100).toFixed(2)}%` : "—"}
            </Field>
            <Field label="Best day">
              {bestDay ? (
                <>
                  {bestDay.day} <span className="ml-2 text-up">{money(bestDay.net)}</span>
                </>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Worst day">
              {worstDay ? (
                <>
                  {worstDay.day} <span className={`ml-2 ${netClass(worstDay.net)}`}>{money(worstDay.net)}</span>
                </>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Days traded">{openMonthDays.length}</Field>
            <Field label="Profitable days">
              {openMonthDays.filter((d) => d.net > 0).length}/{openMonthDays.length}{" "}
              <Pill tone={openMonthDays.filter((d) => d.net > 0).length * 2 >= openMonthDays.length ? "up" : "down"}>
                {openMonthDays.length ? `${Math.round((openMonthDays.filter((d) => d.net > 0).length / openMonthDays.length) * 100)}%` : "—"}
              </Pill>
            </Field>
          </div>
          <div className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Day by day · click to open</div>
          <Table head={["Day", "Net", "Fills"]}>
            {openMonthDays.map((d) => (
              <Row
                key={d.day}
                onClick={() => {
                  setOpenMonth(null);
                  setOpenDay(d.day);
                }}
              >
                <Cell className="font-mono text-muted">{d.day}</Cell>
                <Cell className={`font-mono ${netClass(d.net)}`}>{money(d.net)}</Cell>
                <Cell className="font-mono text-muted">{d.trades}</Cell>
              </Row>
            ))}
          </Table>
        </Modal>
      )}
    </div>
  );
}
