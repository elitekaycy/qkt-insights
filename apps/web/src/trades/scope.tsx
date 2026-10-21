import { useSearchParam } from "../router";
import { count, pnl, toneClass, winPct } from "../format";
import type { RoundTripTotals, SortKey } from "./data";

const SORTS: ReadonlySet<string> = new Set<SortKey>(["entry", "exit", "pnl", "r", "held", "size", "strategy", "symbol", "side", "entryPrice", "exitPrice", "ended", "ticket"]);

/** The sort in the URL (`sort`, `dir`), so a sorted view is a link too. */
export function useSortParams(): [SortKey, "asc" | "desc", (s: SortKey, d: "asc" | "desc") => void] {
  const [rawSort, setSort] = useSearchParam("sort", "entry");
  const [rawDir, setDir] = useSearchParam("dir", "desc");
  const sort = (SORTS.has(rawSort) ? rawSort : "entry") as SortKey;
  const dir = rawDir === "asc" ? "asc" : "desc";
  return [sort, dir, (s, d) => { setSort(s); setDir(d); }];
}

/** "Showing 12 of 1,304 round trips · net ▼ −550.00 · win rate 43%": always the numbers of what is listed. */
export function TripCount({ totals, loading, unit = "round trips", compactOnPhone = false }: {
  totals: RoundTripTotals | null;
  loading?: boolean;
  unit?: string;
  /** Phones keep the counts and the net, stacked on two short lines beside the range chips. */
  compactOnPhone?: boolean;
}) {
  if (!totals) return <span className="text-sm text-muted">{loading ? "Loading…" : ""}</span>;
  const wide = compactOnPhone ? "max-sm:hidden" : "";
  const phone = compactOnPhone ? "sm:hidden" : "hidden";
  return (
    <span
      className={`text-sm text-muted ${compactOnPhone ? "max-sm:ml-auto max-sm:flex max-sm:flex-col max-sm:items-end max-sm:text-[11px] max-sm:leading-tight" : ""} ${loading ? "opacity-60" : ""}`}
      aria-live="polite"
    >
      <span>
        <span className={wide}>Showing </span><b className="font-semibold text-bright">{count(totals.matched)}</b>
        <span className={wide}> of {count(totals.total)} {unit}</span><span className={phone}> of {count(totals.total)}</span>
      </span>
      {totals.matched > 0 && (
        <span>
          <span className={wide}>{" · net "}</span>
          <b className={`font-semibold ${toneClass(totals.net)}`}>{pnl(totals.net)}</b>
          <span className={wide}>
            {" · win rate "}
            <b className="font-semibold text-bright" title="Winning over decided closed round trips; breakeven ones excluded">{winPct(totals.winRate)}</b>
          </span>
        </span>
      )}
    </span>
  );
}

