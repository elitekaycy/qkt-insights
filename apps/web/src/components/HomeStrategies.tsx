import { useState, type ReactNode } from "react";
import type { StrategyRow } from "../api";
import { age, count, DASH, money, pct, ts } from "../format";
import { haltSummary } from "../halt";
import type { StrategyPeriods } from "../home";
import { strategyDisplayName } from "../portfolio";
import { Link, useRoute, useSearchParam } from "../router";
import { Card, LiveDot, Pill, Pnl, Popover } from "./ui";

/*
 * The strategy table: one row per strategy with Today, 7D, MTD and all-time P&L, its deepest
 * realized drawdown, trades, win rate and last close. Sortable; a row opens the strategy. Closes
 * no strategy claimed are their own row so the column sums equal the account.
 */

type SortKey = "name" | "today" | "d7" | "mtd" | "all" | "maxDd" | "trades" | "winRate" | "lastTs";

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; hint?: string }> = [
  { key: "name", label: "Strategy" },
  { key: "today", label: "Today", hint: "realized on the account's day + floating" },
  { key: "d7", label: "7D", hint: "realized, last 7 x 24 h" },
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
  const v = l.periods[key];
  return v ?? -Infinity;
}

function Status({ row, isPublic }: { row: StrategyRow | null; isPublic: boolean }) {
  if (!row) return <Pill>unattributed</Pill>;
  const halt = haltSummary(row);
  if (halt) {
    return (
      <Popover label="Why this strategy is halted" trigger={<Pill tone="warn">halted</Pill>}>
        {halt}
      </Popover>
    );
  }
  if (!row.active) return <Pill>retired</Pill>;
  // shared links carry no live risk state, so they claim nothing about it
  return isPublic ? null : <span className="inline-flex items-center gap-1.5 text-[11px] text-muted"><LiveDot on /> running</span>;
}

/** The halt's reason and age under the name, so it reads without a click; the badge holds the rest. */
function HaltLine({ row }: { row: StrategyRow | null }) {
  if (!row?.halted) return null;
  return (
    <div className="truncate text-[11px] text-warn" title={haltSummary(row) ?? undefined}>
      {row.haltReason ?? "no reason given"}
      {row.haltedAt != null && <span className="text-muted"> · {row.haltedBefore ? "at least " : ""}{age(row.haltedAt)}</span>}
    </div>
  );
}

export function StrategyTable({
  lines,
  now,
  isPublic,
  title = "Strategies",
  hint = "click a row to open the strategy · times UTC",
  right,
  footer = "the rows add up to the account; unattributed = deals no strategy claimed",
}: {
  lines: StrategyLine[];
  now: number;
  isPublic: boolean;
  title?: string;
  hint?: string;
  /** Extra header content at the right edge, e.g. a group's total. */
  right?: ReactNode;
  footer?: string;
}) {
  const { navigate } = useRoute();
  const [sortParam, setSort] = useSearchParam("sort", "today");
  const [showAll, setShowAll] = useState(false);
  const desc = !sortParam.startsWith("+");
  const key = (COLUMNS.find((c) => c.key === sortParam.replace(/^\+/, ""))?.key ?? "today") as SortKey;

  const hidden = (l: StrategyLine) => l.row != null && (!l.row.active || (l.periods.trades === 0 && l.periods.floating === 0));
  const shown = lines.filter((l) => showAll || !hidden(l)).sort((a, b) => {
    const x = sortValue(a, key), y = sortValue(b, key);
    const c = x < y ? -1 : x > y ? 1 : 0;
    // names read A to Z by default, figures largest first
    return key === "name" ? (desc ? c : -c) : desc ? -c : c;
  });
  const hiddenCount = lines.filter(hidden).length;
  const open = (l: StrategyLine) => (l.key ? navigate(`/s/${encodeURIComponent(l.key)}`) : undefined);
  const toggleSort = (k: SortKey) => setSort(k === key ? (desc ? `+${k}` : k) : k);

  const cell = (l: StrategyLine, k: SortKey) => {
    const p = l.periods;
    switch (k) {
      case "today": return <Pnl value={p.today} glyphs={false} />;
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
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-body">{title}</h2>
        <span className="text-xs text-muted">{hint}</span>
        {right && <span className="ml-auto flex items-center gap-2">{right}</span>}
        {hiddenCount > 0 && (
          <button type="button" onClick={() => setShowAll((s) => !s)} className={`${right ? "" : "ml-auto"} text-xs font-medium text-accent-ink hover:underline`}>
            {showAll ? "Hide retired and empty" : `Show ${hiddenCount} retired or empty`}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted">No strategy has traded yet. Rows appear with the first close or open position.</div>
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
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <tr
                    key={l.key ?? "(unattributed)"}
                    onClick={l.key ? () => open(l) : undefined}
                    className={`border-b border-line text-bright last:border-b-0 hover:bg-hover ${l.key ? "cursor-pointer" : ""} ${l.row && !l.row.active ? "text-muted" : ""}`}
                  >
                    <td className="max-w-[22rem] px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {l.key ? (
                          <Link to={`/s/${encodeURIComponent(l.key)}`} onClick={(e) => e.stopPropagation()} className="truncate font-semibold hover:underline" title={l.key}>
                            {name(l)}
                          </Link>
                        ) : (
                          <span className="font-semibold text-muted" title="closes and positions no strategy claimed">Unattributed</span>
                        )}
                        {l.key && <Status row={l.row} isPublic={isPublic} />}
                      </div>
                      <HaltLine row={l.row} />
                    </td>
                    {COLUMNS.slice(1).map((c) => (
                      <td key={c.key} className={`whitespace-nowrap px-3 py-2 text-right ${c.key === "trades" || c.key === "winRate" || c.key === "lastTs" ? "text-body" : ""}`}>
                        {cell(l, c.key)}
                      </td>
                    ))}
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
                    <span className="min-w-0 truncate font-semibold text-bright">{name(l)}</span>
                    {l.key && <Status row={l.row} isPublic={isPublic} />}
                    <span className="ml-auto shrink-0 text-xs text-muted">Today</span>
                    <span className="shrink-0 font-semibold">{cell(l, "today")}</span>
                  </div>
                  <HaltLine row={l.row} />
                  <div className="mt-1.5 grid grid-cols-4 gap-x-2 text-xs tabular-nums">
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
                    <Link to={`/s/${encodeURIComponent(l.key)}`} className="block px-4 py-3 transition hover:bg-hover active:bg-press">{body}</Link>
                  ) : (
                    <div className="px-4 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="border-t border-line px-4 py-2 text-[11px] text-faint">
        as of {ts(now).slice(11, 16)} UTC · {footer}
      </div>
    </Card>
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
