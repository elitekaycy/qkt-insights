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
export function TripCount({ totals, loading, unit = "round trips" }: { totals: RoundTripTotals | null; loading?: boolean; unit?: string }) {
  if (!totals) return <span className="text-sm text-muted">{loading ? "Loading…" : ""}</span>;
  return (
    <span className={`text-sm text-muted ${loading ? "opacity-60" : ""}`} aria-live="polite">
      Showing <b className="font-semibold text-bright">{count(totals.matched)}</b> of {count(totals.total)} {unit}
      {totals.matched > 0 && (
        <>
          {" · net "}
          <b className={`font-semibold ${toneClass(totals.net)}`}>{pnl(totals.net)}</b>
          {" · win rate "}
          <b className="font-semibold text-bright" title="Winning over decided closed round trips; breakeven ones excluded">{winPct(totals.winRate)}</b>
        </>
      )}
    </span>
  );
}

