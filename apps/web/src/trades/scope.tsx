import { useSearchParam } from "../router";
import { count, toneClass, winPct, signedMoney } from "../format";
import { currencyName, splitNets } from "../currencies";
import type { RoundTripTotals, SortKey } from "./data";
import { Spinner } from "../components/ui";

const SORTS: ReadonlySet<string> = new Set<SortKey>(["entry", "exit", "pnl", "r", "held", "size", "strategy", "symbol", "side", "entryPrice", "exitPrice", "ended", "ticket"]);

/** The sort in the URL (`sort`, `dir`), so a sorted view is a link too. */
export function useSortParams(): [SortKey, "asc" | "desc", (s: SortKey, d: "asc" | "desc") => void] {
  const [rawSort, setSort] = useSearchParam("sort", "entry");
  const [rawDir, setDir] = useSearchParam("dir", "desc");
  const sort = (SORTS.has(rawSort) ? rawSort : "entry") as SortKey;
  const dir = rawDir === "asc" ? "asc" : "desc";
  return [sort, dir, (s, d) => { setSort(s); setDir(d); }];
}

/** "12 of 1,304 trades · −550.00 · win rate 43%": always the numbers of what is listed. "of" only when a search narrows it. */
export function TripCount({ totals, loading, compactOnPhone = false }: {
  totals: RoundTripTotals | null;
  loading?: boolean;
  /** Phones keep the count and the net on one short line beside the range chips. */
  compactOnPhone?: boolean;
}) {
  if (!totals) return loading ? <Spinner label="Loading the count" /> : null;
  const split = splitNets(totals.currencies);
  const wide = compactOnPhone ? "max-sm:hidden" : "";
  return (
    <span className={`whitespace-nowrap text-sm text-muted ${compactOnPhone ? "max-sm:w-full max-sm:text-xs" : ""} ${loading ? "opacity-60" : ""}`} aria-live="polite">
      <b className="font-medium text-bright">{count(totals.matched)}</b>
      {totals.matched !== totals.total && ` of ${count(totals.total)}`} trades
      {totals.matched > 0 && (
        <>
          {" · "}
          {split ? (
            <span title="The accounts book in different currencies: each currency's net, never added together">
              {split.map((c, i) => (
                <span key={c.currency ?? ""}>
                  {i > 0 && " · "}
                  <b className={`font-medium ${toneClass(c.net)}`}>{signedMoney(c.net)}</b> {currencyName(c.currency)}
                </span>
              ))}
            </span>
          ) : (
            <b className={`font-medium ${toneClass(totals.net)}`} title={totals.netInExit ? "Realized by the closing legs inside the exit: range, as the calendar books it" : undefined}>{signedMoney(totals.net)}</b>
          )}
          <span className={wide}>
            {" · win rate "}
            <b className="font-medium text-bright" title="Winning over decided closed trades; breakeven ones excluded">{winPct(totals.winRate)}</b>
          </span>
        </>
      )}
    </span>
  );
}
