import type { ClosedTradeRow, ContributionRanking, CostDecomposition, DayNet, PerformanceReport } from "../api";
import { money, num, pct } from "../format";
import { CalendarView } from "./Calendar";
import { Card, Cell, Empty, Panel, Row, Stat, Table } from "./ui";

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

/** Account-level performance roll-up across every strategy on one account, plus the combined
 * P&L calendar. All figures are summed from the per-strategy analytics bundles the Overview
 * already fetches; cost split (gross/commission/swap) comes from broker deals and is null for
 * paper-only accounts, so those cards render "—" rather than a fabricated zero. */
export function AccountSummary({
  daily,
  closes,
  reports,
  costs,
  contribution,
  accountEquity,
  accountBalance,
  totalAllocated,
}: {
  daily: DayNet[];
  closes: ClosedTradeRow[];
  reports: PerformanceReport[];
  costs: CostDecomposition[];
  contribution: ContributionRanking[];
  accountEquity: number | null;
  accountBalance: number | null;
  totalAllocated: number;
}) {
  const netTotal = daily.reduce((a, d) => a + d.net, 0);
  const hasCosts = costs.length > 0;
  const gross = hasCosts ? costs.reduce((a, c) => a + (c.total?.grossProfit ?? 0), 0) : null;
  const commission = hasCosts ? costs.reduce((a, c) => a + (c.total?.commission ?? 0), 0) : null;
  const swap = hasCosts ? costs.reduce((a, c) => a + (c.total?.swap ?? 0), 0) : null;

  const wins = reports.reduce((a, r) => a + (r.wins ?? 0), 0);
  const losses = reports.reduce((a, r) => a + (r.losses ?? 0), 0);
  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : null;
  const tradeCount = closes.length || decided;
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

  const symMap = new Map<string, { net: number; trades: number }>();
  for (const c of contribution)
    for (const s of c.bySymbol ?? []) {
      const e = symMap.get(s.key) ?? { net: 0, trades: 0 };
      e.net += s.net;
      e.trades += s.trades;
      symMap.set(s.key, e);
    }
  const symbols = [...symMap.entries()].map(([sym, v]) => ({ sym, ...v })).sort((a, b) => b.trades - a.trades);

  const sign = (v: number): "up" | "down" | "neutral" => (v > 0 ? "up" : v < 0 ? "down" : "neutral");
  const dash = (v: number | null, fmt: (n: number) => string) => (v == null ? "—" : fmt(v));

  return (
    <section className="mt-8">
      <div className="rise flex items-baseline justify-between" style={{ "--stagger": 2 } as React.CSSProperties}>
        <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-body">Account performance</h3>
        <span className="text-xs text-faint">every strategy, combined · realized</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Net P&L" value={money(netTotal)} tone={sign(netTotal)} stagger={0} />
        <Stat label="Gross P&L" value={dash(gross, money)} sub="before costs" tone={gross == null ? "neutral" : sign(gross)} stagger={0} />
        <Stat label="Commission" value={dash(commission, (n) => money(-Math.abs(n)))} tone={commission ? "down" : "neutral"} stagger={0} />
        <Stat label="Swap" value={dash(swap, money)} tone={swap == null ? "neutral" : sign(swap)} stagger={0} />
        <Stat label="Win rate" value={pct(winRate)} sub={`${wins}W / ${losses}L`} stagger={1} />
        <Stat label="Expectancy" value={dash(expectancy, (n) => money(n))} sub="per trade" tone={expectancy == null ? "neutral" : sign(expectancy)} stagger={1} />
        <Stat label="Trades" value={num(tradeCount, 0)} sub={`${longs} long · ${shorts} short`} stagger={1} />
        <Stat label="Trading days" value={num(tradingDays, 0)} sub="days with fills" stagger={1} />
        <Stat label="Account DD" value={dash(accountDD, (n) => money(-n))} sub="equity vs balance" tone={accountDD ? "down" : "neutral"} stagger={2} />
        <Stat label="Worst day" value={money(worstDay)} tone={sign(worstDay)} stagger={2} />
        <Stat label="This week" value={money(weekPnl)} tone={sign(weekPnl)} stagger={2} />
        <Stat label="Worst week" value={money(worstWeek)} tone={sign(worstWeek)} stagger={2} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Panel stagger={3} title="Symbols traded" hint="ranked by trade count" scroll="max-h-[20rem]">
            <Table head={["Symbol", "Trades", "Net"]}>
              {symbols.map((s) => (
                <Row key={s.sym}>
                  <Cell className="font-semibold text-bright">{s.sym}</Cell>
                  <Cell className="font-mono text-body">{s.trades}</Cell>
                  <Cell className={`font-mono ${s.net > 0 ? "text-up" : s.net < 0 ? "text-down" : "text-muted"}`}>{money(s.net)}</Cell>
                </Row>
              ))}
              {symbols.length === 0 && <Empty colSpan={3}>No closed trades yet.</Empty>}
            </Table>
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <Panel stagger={3} title="P&L calendar" hint="realized net by UTC close day, all strategies">
            <div className="p-4">
              <CalendarView days={daily} startingBalance={totalAllocated} />
            </div>
          </Panel>
        </div>
      </div>
    </section>
  );
}
