import { useState } from "react";
import type { AccountRiskRow, AccountSummary as AccountSummaryData } from "../api";
import { count, money, pct, pctValue } from "../format";
import { CalendarView } from "./Calendar";
import { Cell, Empty, Panel, Pnl, Row, Select, Stat, Table } from "./ui";

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
  risk,
}: {
  summary: AccountSummaryData;
  strategyName: (strategyId: string) => string;
  /** The accounts' risk rows: the drawdown tile reads them. */
  risk: AccountRiskRow[];
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

  // Real drawdown on each account's configured basis; balance minus equity is only the open P&L.
  const ddRows = risk.filter((r) => r.drawdown.used != null);
  const accountDD = ddRows.length > 0 ? ddRows.reduce((a, r) => a + r.drawdown.used!, 0) : null;
  const ddSub = ddRows.length === 1
    ? `${ddRows[0]!.basis === "static" ? "below start" : "from peak"} ${money(ddRows[0]!.drawdown.reference)} · ${pctValue(ddRows[0]!.drawdown.usedPct ?? 0)}`
    : ddRows.length > 1 ? `${ddRows.length} accounts, each on its basis` : "no account history yet";
  const bases = new Map(summary.monthBases.map((b) => [b.period, b]));
  const baseLabel = summary.monthBases.some((b) => b.source === "account equity") ? "account equity at month start" : "account start balance";

  const buckets = split === "instrument" ? summary.byInstrument : summary.byStrategy;
  const label = (key: string | null) => split === "instrument" ? key ?? "—" : key == null ? "Unattributed" : strategyName(key);


  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-body">Account performance</h3>
        <span className="text-xs text-faint">every close on the account, retired strategies and unattributed deals included · realized</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Net P&L" signed={netTotal} />
        <Stat label="Gross P&L" signed={gross} sub="before commission and swap" />
        <Stat label="Commission" signed={commission == null ? null : -Math.abs(commission)} />
        <Stat label="Swap" signed={swap} />
        <Stat label="Win rate" value={pct(winRate)} sub={`${wins}W / ${losses}L · breakeven excluded`} />
        <Stat label="Expectancy" signed={expectancy} sub="per trade" />
        <Stat label="Trades" value={count(tradeCount)} sub={`${longs} long · ${shorts} short`} />
        <Stat label="Trading days" value={count(tradingDays)} sub="days with closes (UTC)" />
        <Stat label={ddRows.length === 1 && ddRows[0]!.basis === "static" ? "Account DD · static" : "Account DD · from peak"} signed={accountDD == null ? null : -accountDD} sub={ddSub} />
        <Stat label="Worst day" signed={worstDay} sub="UTC day" />
        <Stat label="This week" signed={weekPnl} sub="ISO week, UTC" />
        <Stat label="Worst week" signed={worstWeek} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Panel
           
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
                  <Cell className="text-body">{count(s.trades)}</Cell>
                  <Cell>
                    <Pnl value={s.net} glyphs={false} />
                  </Cell>
                </Row>
              ))}
              {buckets.length === 0 && <Empty colSpan={3}>No closed trades yet.</Empty>}
            </Table>
          </Panel>
        </div>
        <div className="lg:col-span-2">
          <CalendarView days={daily} returnBase={(month) => bases.get(month)?.base ?? null} baseLabel={baseLabel} />
        </div>
      </div>
    </section>
  );
}
