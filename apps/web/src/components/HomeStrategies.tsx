import { useState, type ReactNode } from "react";
import type { StrategyRow } from "../api";
import { age, count, DASH, money, pct, signedMoney, ts } from "../format";
import { haltSummary } from "../halt";
import { strategyTotal, type StrategyPeriods, type TodaySplit } from "../home";
import { strategyDisplayName } from "../portfolio";
import { asksForRetired, matchesStrategy } from "../strategyFilter";
import { notTradedYet } from "../strategyCards";
import { Link, useRoute, useSearchParam } from "../router";
import { Card, CurrencyMix, Pill, Pnl, Popover, RowChevron } from "./ui";

/*
 * The strategy table: one row per strategy with Today, 7D, MTD and all-time P&L, its deepest
 * realized drawdown, trades, win rate and last close. Sortable; a row opens the strategy. Closes
 * no strategy claimed are their own row so the column sums equal the account.
 */

type SortKey = "name" | "today" | "open" | "d7" | "mtd" | "all" | "maxDd" | "trades" | "winRate" | "lastTs";

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; hint?: string }> = [
  { key: "name", label: "Strategy" },
  { key: "today", label: "Today", hint: "realized since the account's trading day began" },
  { key: "open", label: "Open", hint: "floating on its open positions now, swap included" },
  { key: "d7", label: "7D", hint: "realized, today and the 6 UTC days before" },
  { key: "mtd", label: "MTD", hint: "realized since the UTC month began" },
  { key: "all", label: "All-time", hint: "realized, every stored close" },
  { key: "maxDd", label: "Max DD", hint: "deepest fall of cumulative realized P&L from its peak" },
  { key: "trades", label: "Trades" },
  { key: "winRate", label: "Win rate", hint: "wins over decided closes; breakeven excluded" },
  { key: "lastTs", label: "Last close" },
];

export interface StrategyLine {
  key: string | null;
  row: StrategyRow | null;
  periods: StrategyPeriods;
}

function sortValue(l: StrategyLine, key: SortKey): number | string {
  if (key === "name") return l.row ? strategyDisplayName(l.row).toLowerCase() : "~";
  if (key === "maxDd") return -l.periods.maxDd;
  if (key === "today") return l.periods.todayRealized;
  if (key === "open") return l.periods.floating;
  const v = l.periods[key];
  return v ?? -Infinity;
}

/**
 * Status beside the name: nothing while running; an amber "Halted" chip (the reason, when and how it ends on hover
 * or tap) for a strategy that needs a look, at full ink; a muted "Retired" for one that left the roster.
 */
function RowState({ row }: { row: StrategyRow | null }) {
  if (!row) return null;
  const halt = haltSummary(row);
  if (halt) {
    return (
      <Popover label="Why this strategy is halted" trigger={<Pill tone="warn">Halted</Pill>}>
        {halt}
      </Popover>
    );
  }
  return row.active ? null : <span className="text-xs text-faint">Retired</span>;
}

const retired = (row: StrategyRow | null) => row != null && !row.active;


export function StrategyTable({
  lines,
  hint,
  account = null,
  mix = null,
  search = false,
  origin,
}: {
  lines: StrategyLine[];
  hint?: string;
  /** The shown account's Today split; the total row then sets the rows against the account's own figure. Null on All accounts. */
  account?: TodaySplit | null;
  /** Set when the rows add accounts in different currencies: the total carries "USD+USDC". */
  mix?: { label: string; title: string } | null;
  /** Draws the search box in the header; the search (`find` in the URL) applies either way. */
  search?: boolean;
  /** The page the table is on, for the strategy page's way back. */
  origin: string;
}) {
  const { navigate } = useRoute();
  const [sortParam, setSort] = useSearchParam("sort", "today");
  const [showAll, setShowAll] = useState(false);
  const [find] = useSearchParam("find");
  const desc = !sortParam.startsWith("+");
  const key = (COLUMNS.find((c) => c.key === sortParam.replace(/^\+/, ""))?.key ?? "today") as SortKey;

  // Only retired strategies fold away; a deployed one shows before its first trade.
  const hidden = (l: StrategyLine) => l.row != null && !l.row.active;
  const all = showAll || asksForRetired(find);
  const matched = lines.filter((l) => matchesStrategy(l.row, find));
  // strategies yet to trade are one line under the table, not rows of zeros
  const visible = matched.filter((l) => all || !hidden(l));
  const idle = visible.filter(notTradedYet);
  const shown = visible.filter((l) => !notTradedYet(l)).sort((a, b) => {
    const x = sortValue(a, key), y = sortValue(b, key);
    const c = x < y ? -1 : x > y ? 1 : 0;
    // names read A to Z by default, figures largest first
    return key === "name" ? (desc ? c : -c) : desc ? -c : c;
  });
  const hiddenCount = matched.filter(hidden).length;
  const open = (l: StrategyLine) => (l.key ? navigate(`/s/${encodeURIComponent(l.key)}`, { from: origin }) : undefined);
  const toggleSort = (k: SortKey) => setSort(k === key ? (desc ? `+${k}` : k) : k);

  const cell = (l: StrategyLine, k: SortKey) => {
    const p = l.periods;
    switch (k) {
      case "today": return <Pnl value={p.todayRealized} glyphs={false} />;
      case "open": return <Pnl value={p.floating} glyphs={false} />;
      case "d7": return <Pnl value={p.d7} glyphs={false} />;
      case "mtd": return <Pnl value={p.mtd} glyphs={false} />;
      case "all": return <Pnl value={p.all} glyphs={false} className="font-semibold" />;
      case "maxDd": return p.maxDd > 0 ? <span className="text-loss">{money(-p.maxDd)}</span> : <span className="text-faint">{money(0)}</span>;
      case "trades": return count(p.trades);
      case "winRate": return pct(p.winRate);
      case "lastTs": return p.lastTs == null ? DASH : <span title={`${ts(p.lastTs)} UTC`}>{age(p.lastTs)}</span>;
      default: return null;
    }
  };
  const name = (l: StrategyLine) => (l.row ? strategyDisplayName(l.row) : "Unattributed");

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-body">Strategies</h2>
        {hint && <span className="text-xs text-muted">{hint}</span>}
        {search && <StrategySearch className="ml-auto" />}
        {hiddenCount > 0 && !asksForRetired(find) && (
          <button type="button" onClick={() => setShowAll((s) => !s)} className={`${search ? "" : "ml-auto"} text-xs font-medium text-accent-ink hover:underline`}>
            {showAll ? "Hide retired" : `Show ${hiddenCount} retired`}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">
          {find ? `No strategy matches “${find}”.` : "No trades yet. Strategies show up here as they trade."}
        </div>
      ) : (
        <div className="@container">
          <div className="hidden @3xl:block">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-line text-left">
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={`whitespace-nowrap px-3 py-2 ${c.key === "name" ? "" : "text-right"}`} aria-sort={c.key === key ? (desc ? "descending" : "ascending") : "none"}>
                      <button type="button" onClick={() => toggleSort(c.key)} title={c.hint} className={`eyebrow inline-flex items-center gap-1 hover:text-bright ${c.key === key ? "text-bright" : ""}`}>
                        {c.label}
                        <span aria-hidden className="w-2">{c.key === key ? (desc ? "↓" : "↑") : ""}</span>
                      </button>
                    </th>
                  ))}
                  <th className="w-8" aria-label="Open the strategy" />
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <tr
                    key={l.key ?? "(unattributed)"}
                    onClick={l.key ? () => open(l) : undefined}
                    onKeyDown={l.key ? (e) => { if (e.key === "Enter") open(l); } : undefined}
                    tabIndex={l.key ? 0 : undefined}
                    aria-label={l.key ? `Open ${name(l)}` : undefined}
                    className={`group border-b border-line last:border-b-0 ${l.key ? "cursor-pointer transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-hi" : ""}`}
                  >
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <span className={`break-words font-medium ${l.key == null ? "italic text-muted" : retired(l.row) ? "text-muted" : "text-bright"}`} title={l.key ?? "closes and positions no strategy claimed"}>
                          {name(l)}
                        </span>
                        <RowState row={l.row} />
                      </span>
                    </td>
                    {COLUMNS.slice(1).map((c) => (
                      <td key={c.key} className={`whitespace-nowrap px-3 py-2.5 text-right font-mono ${c.key === "trades" || c.key === "winRate" || c.key === "lastTs" ? "text-body" : ""}`}>
                        {cell(l, c.key)}
                      </td>
                    ))}
                    <td className="w-8 pr-2">{l.key && <RowChevron />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-line @3xl:hidden">
            {shown.map((l) => {
              const body = (
                <>
                  <div className="flex items-center gap-2">
                    <span className={`min-w-0 break-words font-medium ${l.key == null ? "italic text-muted" : retired(l.row) ? "text-muted" : "text-bright"}`}>{name(l)}</span>
                    <RowState row={l.row} />
                    <span className="ml-auto shrink-0 text-xs text-muted">Today</span>
                    <span className="shrink-0 font-semibold">{cell(l, "today")}</span>
                    {l.key && <RowChevron className="-mr-1" />}
                  </div>
                  <div className="mt-1.5 grid grid-cols-5 gap-x-2 text-xs tabular-nums">
                    <Mini k="Open">{cell(l, "open")}</Mini>
                    <Mini k="7D">{cell(l, "d7")}</Mini>
                    <Mini k="MTD">{cell(l, "mtd")}</Mini>
                    <Mini k="All-time">{cell(l, "all")}</Mini>
                    <Mini k="Max DD">{cell(l, "maxDd")}</Mini>
                  </div>
                  <div className="mt-1 text-[11px] text-faint">
                    {count(l.periods.trades)} trades · win {pct(l.periods.winRate)} · last {l.periods.lastTs == null ? DASH : age(l.periods.lastTs)}
                  </div>
                </>
              );
              return (
                <li key={l.key ?? "(unattributed)"}>
                  {l.key ? (
                    <Link to={`/s/${encodeURIComponent(l.key)}`} from={origin} className="group block px-4 py-3 transition hover:bg-hover active:bg-press">{body}</Link>
                  ) : (
                    <div className="px-4 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {idle.length > 0 && (
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          Not traded yet ({idle.length}): {idle.map((l, i) => <span key={l.key}>{i > 0 && ", "}<Link to={`/s/${encodeURIComponent(l.key!)}`} from={origin} className="text-body hover:underline">{name(l)}</Link></span>)}
        </p>
      )}
      <TotalLine lines={shown} account={account} mix={mix} hidden={lines.length - shown.length - idle.length} />
    </Card>
  );
}

/** The strategies search: free words match the name, `status:` and `symbol:` narrow it. */
export function StrategySearch({ className = "" }: { className?: string }) {
  const [find, setFind] = useSearchParam("find");
  return (
    <label className={`relative flex h-8 w-full min-w-0 items-center sm:w-64 ${className}`}>
      <span className="sr-only">Filter strategies</span>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
        <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35" />
      </svg>
      <input
        type="search"
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Filter strategies"
        title="Words match the name; status:running, status:halted, status:retired and symbol:xau narrow it"
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-full rounded-lg border border-ctl bg-panel pl-8 pr-2 text-sm text-bright placeholder:text-muted focus:border-accent-hi focus:outline-none focus:ring-3 focus:ring-accent-soft"
      />
    </label>
  );
}

function Mini({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-faint">{k}</div>
      <div className="truncate">{children}</div>
    </div>
  );
}

/**
 * The table's total from the rows shown, today's closes plus what is open: "Total incl. open +18.35"; on one account,
 * set against the account's own Today ("· other system −767.77 · account −749.42"), with whatever else it holds named
 * so the parts add up. On All accounts it is marked when it adds currencies.
 */
function TotalLine({ lines, account, mix, hidden }: { lines: StrategyLine[]; account: TodaySplit | null; mix: { label: string; title: string } | null; hidden: number }) {
  const total = strategyTotal(lines.map((l) => l.periods.today), account);
  const figure = (v: number) => <span className="font-mono tabular-nums text-body">{signedMoney(v)}</span>;
  const parts: ReactNode[] = [<>Total incl. open {figure(total.rows)}{total.account == null && <CurrencyMix mix={mix} />}</>];
  if (total.other != null) parts.push(<>other system {figure(total.other)}</>);
  if (total.account != null && total.rest !== 0) parts.push(<>{hidden > 0 ? "rows not shown" : "not in a row"} {figure(total.rest)}</>);
  if (total.account != null) parts.push(<>account {figure(total.account)}</>);
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-line px-4 py-2 text-xs text-muted">
      {parts.map((p, i) => <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap">{i > 0 && <span className="text-faint">·</span>}<span>{p}</span></span>)}
    </div>
  );
}
