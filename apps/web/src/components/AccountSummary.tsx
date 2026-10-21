import { useState } from "react";
import type { AccountSummary as AccountSummaryData } from "../api";
import { money, num, pct } from "../format";
import { CalendarView } from "./Calendar";
import { Cell, Empty, Panel, Row, Select, Stat, Table } from "./ui";

/** A closed position's direction, folding broker BUY/SELL and long/short labels to one axis. */
function normalizedSide(side: string): "LONG" | "SHORT" {
  const s = side.toUpperCase();
  return s.includes("SELL") || s.includes("SHORT") ? "SHORT" : "LONG";
}

/** ISO-week key (YYYY-Www) for a UTC YYYY-MM-DD day, so weekly rollups are calendar-stable. */
function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const target = new Date(d);
  target.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Thursday of this week
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Account-level performance roll-up over every close on the account (retired strategies and
 * unattributed deals included), plus the combined P&L calendar. Cost split (gross/commission/swap)
 * comes from broker deals and is null for paper-only accounts, so those cards render "—" rather
 * than a fabricated zero. */
export function AccountSummary({
  summary,
  strategyName,
  accountEquity,
  accountBalance,
  totalAllocated,
}: {
  summary: AccountSummaryData;
  strategyName: (strategyId: string) => string;
  accountEquity: number | null;
  accountBalance: number | null;
  totalAllocated: number;
}) {
  const [split, setSplit] = useState<"instrument" | "strategy">("instrument");
  const daily = summary.dailyNets;
  const closes = summary.closes;
  const netTotal = summary.totalNet;
  const costs = summary.costs;
  const gross = costs?.grossProfit ?? null;
  const commission = costs?.commission ?? null;
  const swap = costs?.swap ?? null;

  const { wins, losses } = summary;
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : null;
  const tradeCount = summary.trades;
  const expectancy = tradeCount > 0 ? netTotal / tradeCount : null;

  const longs = closes.filter((c) => normalizedSide(c.side) === "LONG").length;
  const shorts = closes.filter((c) => normalizedSide(c.side) === "SHORT").length;

  const activeDays = daily.filter((d) => d.trades > 0);
  const tradingDays = activeDays.length;
  const worstDay = daily.length ? Math.min(...daily.map((d) => d.net)) : 0;

  const weekTotals = new Map<string, number>();
  for (const d of daily) weekTotals.set(isoWeek(d.day), (weekTotals.get(isoWeek(d.day)) ?? 0) + d.net);
  const thisWeek = isoWeek(new Date().toISOString().slice(0, 10));
  const weekPnl = weekTotals.get(thisWeek) ?? 0;
  const worstWeek = weekTotals.size ? Math.min(...weekTotals.values()) : 0;

  const accountDD = accountBalance != null && accountEquity != null ? Math.max(0, accountBalance - accountEquity) : null;

  const buckets = split === "instrument" ? summary.byInstrument : summary.byStrategy;
  const label = (key: string | null) => split === "instrument" ? key ?? "—" : key == null ? "Unattributed" : strategyName(key);

  const sign = (v: number): "up" | "down" | "neutral" => (v > 0 ? "up" : v < 0 ? "down" : "neutral");
  const dash = (v: number | null, fmt: (n: number) => string) => (v == null ? "—" : fmt(v));

  return (
    <section className="mt-8">
      <div className="rise flex items-baseline justify-between" style={{ "--stagger": 2 } as React.CSSProperties}>
        <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-body">Account performance</h3>
        <span className="text-xs text-faint">every close on the account, retired strategies and unattributed deals included · realized</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Net P&L" value={money(netTotal)} tone={sign(netTotal)} stagger={0} />
        <Stat label="Gross P&L" value={dash(gross, money)} sub="before commission and swap" tone={gross == null ? "neutral" : sign(gross)} stagger={0} />
        <Stat label="Commission" value={dash(commission, (n) => money(-Math.abs(n)))} tone={commission ? "down" : "neutral"} stagger={0} />
        <Stat label="Swap" value={dash(swap, money)} tone={swap == null ? "neutral" : sign(swap)} stagger={0} />
        <Stat label="Win rate" value={pct(winRate)} sub={`${wins}W / ${losses}L · breakeven excluded`} stagger={1} />
        <Stat label="Expectancy" value={dash(expectancy, (n) => money(n))} sub="per trade" tone={expectancy == null ? "neutral" : sign(expectancy)} stagger={1} />
        <Stat label="Trades" value={num(tradeCount, 0)} sub={`${longs} long · ${shorts} short`} stagger={1} />
        <Stat label="Trading days" value={num(tradingDays, 0)} sub="days with closes (UTC)" stagger={1} />
        <Stat label="Account DD" value={dash(accountDD, (n) => money(-n))} sub="equity vs balance" tone={accountDD ? "down" : "neutral"} stagger={2} />
        <Stat label="Worst day" value={money(worstDay)} tone={sign(worstDay)} stagger={2} />
        <Stat label="This week" value={money(weekPnl)} tone={sign(weekPnl)} stagger={2} />
        <Stat label="Worst week" value={money(worstWeek)} tone={sign(worstWeek)} stagger={2} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Panel
            stagger={3}
            title={split === "instrument" ? "Symbols traded" : "Strategies"}
            hint={split === "instrument" ? "by instrument, broker profiles folded · by trade count" : "by net · unattributed = deals no strategy claimed"}
            scroll="max-h-[20rem]"
            toolbar={
              <Select value={split} onChange={(e) => setSplit(e.target.value as "instrument" | "strategy")} aria-label="split by">
                <option value="instrument">by instrument</option>
                <option value="strategy">by strategy</option>
              </Select>
            }
          >
            <Table head={[split === "instrument" ? "Symbol" : "Strategy", "Trades", "Net"]}>
              {buckets.map((s) => (
                <Row key={s.key ?? "(unattributed)"}>
                  <Cell className="font-semibold text-bright">
                    <span title={s.venues?.join(", ")}>{label(s.key)}</span>
                  </Cell>
                  <Cell className="font-mono text-body">{s.trades}</Cell>
                  <Cell className={`font-mono ${s.net > 0 ? "text-up" : s.net < 0 ? "text-down" : "text-muted"}`}>{money(s.net)}</Cell>
                </Row>
              ))}
              {buckets.length === 0 && <Empty colSpan={3}>No closed trades yet.</Empty>}
            </Table>
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <CalendarView days={daily} startingBalance={totalAllocated} />
        </div>
      </div>
    </section>
  );
}
