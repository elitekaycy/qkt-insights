import { useMemo, useState } from "react";
import type { DayNet } from "../api";
import { money } from "../format";
import { Cell, Empty, IconButton, Panel, Row, Table } from "./ui";

/*
 * Calendar views over daily nets: a month grid with cells tinted by P&L
 * magnitude, and a monthly-returns table with a YTD row. All math happens on
 * the server's DayNet list; this file only buckets and paints.
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

export function CalendarView({ days, startingBalance }: { days: DayNet[]; startingBalance: number | null }) {
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const months = useMemo(() => [...new Set(days.map((d) => monthKey(d.day)))].sort(), [days]);
  const [month, setMonth] = useState<string>(months[months.length - 1] ?? new Date().toISOString().slice(0, 7));

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

  if (days.length === 0) {
    return (
      <Panel title="Calendar" stagger={0}>
        <Empty>No trading days in this range yet.</Empty>
      </Panel>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <Panel
        title={first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}
        hint={`month net ${money(monthNet)}`}
        stagger={0}
        right={
          <div className="flex gap-1.5">
            <IconButton label="previous month" onClick={() => idx > 0 && setMonth(months[idx - 1]!)} d="M15 18l-6-6 6-6" />
            <IconButton label="next month" onClick={() => idx < months.length - 1 && setMonth(months[idx + 1]!)} d="M9 6l6 6-6 6" />
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
                <div
                  key={dayStr}
                  className="flex aspect-square flex-col rounded-lg border border-line/60 p-1.5"
                  style={{ background: d ? tint(d.net, maxAbs) : "transparent" }}
                  title={d ? `${dayStr}: ${money(d.net)} · ${d.trades} fill${d.trades === 1 ? "" : "s"}` : dayStr}
                >
                  <span className="text-[10px] text-faint">{i + 1}</span>
                  {d && (
                    <span className={`mt-auto truncate font-mono text-[11px] font-semibold ${d.net > 0 ? "text-up" : d.net < 0 ? "text-down" : "text-muted"}`}>
                      {d.net > 0 ? "+" : ""}
                      {Math.abs(d.net) >= 1000 ? `${(d.net / 1000).toFixed(1)}k` : d.net.toFixed(0)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel title="Monthly returns" hint={`YTD ${money(ytd)}`} stagger={1} scroll="max-h-[30rem]">
        <Table head={["Month", "Net", startingBalance ? "Return" : "", "Fills"].filter(Boolean) as string[]}>
          {monthly.map(([k, v]) => (
            <Row key={k}>
              <Cell className="font-mono">{k}</Cell>
              <Cell className={`font-mono ${v.net > 0 ? "text-up" : v.net < 0 ? "text-down" : "text-muted"}`}>{money(v.net)}</Cell>
              {startingBalance ? (
                <Cell className="font-mono text-muted">{((v.net / startingBalance) * 100).toFixed(2)}%</Cell>
              ) : null}
              <Cell className="font-mono text-muted">{v.trades}</Cell>
            </Row>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
