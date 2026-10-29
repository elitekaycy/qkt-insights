import { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { TRADE_KEYS } from "@qkt-insights/contract/query";
import { Card, PageHeader, RangeChips, rangeStart, useRangeParam } from "../components/ui";
import { useSearchParam } from "../router";
import { QueryBar, TRADE_PRESETS } from "../query/QueryBar";
import { tripParams, useTripFacets, type RoundTripTotals, type TripScope } from "../trades/data";
import { RoundTripTable } from "../trades/RoundTripTable";
import { TripCount, useSortParams } from "../trades/scope";
import { usePublicPageView, useView } from "../view";

/** The ticket is in each trade's drawer; the list gives its width to the symbol. */
const TRADES_HIDDEN = ["id"];

export default function Trades({ instanceId }: { instanceId: string | null }) {
  usePublicPageView("trades");
  const view = useView();
  const [q, setQ] = useSearchParam("q");
  const [range, setRange] = useRangeParam();
  const [sort, dir, setSort] = useSortParams();
  const facets = useTripFacets(instanceId);
  const [totals, setTotals] = useState<{ t: RoundTripTotals | null; errors: string[]; loading: boolean }>({ t: null, errors: [], loading: true });
  const onTotals = useCallback((t: RoundTripTotals | null, query: { errors: string[] } | null, loading: boolean) => {
    setTotals((cur) => ({ t: t ?? cur.t, errors: query?.errors ?? cur.errors, loading }));
  }, []);
  // phones: one row of a search button, the range and the count; the search box opens on tap
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBox = useRef<HTMLDivElement>(null);
  const openSearch = () => {
    if (searchOpen) return setSearchOpen(false);
    flushSync(() => setSearchOpen(true));
    searchBox.current?.querySelector("input")?.focus();
  };
  const from = rangeStart(range);
  const scope: TripScope | null = useMemo(() => (instanceId ? { instanceId, from: from > 0 ? Math.floor(from / 60_000) * 60_000 : undefined } : null), [instanceId, from]);
  const data = useMemo(
    () => ({
      strategies: (facets.data?.strategies ?? []).flatMap((s) => (s.id ? [s.id] : [])),
      instruments: (facets.data?.instruments ?? []).map((i) => i.name),
      days: facets.data?.days ?? [],
      sizes: facets.data?.sizes ?? [],
    }),
    [facets.data],
  );

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const exportHref = scope ? `/round-trips/export?${tripParams(scope, q, sort, dir)}` : "#";

  return (
    <div>
      <PageHeader
        title="Trades"
        sub={view.public ? `${view.meta.delayMinutes} minutes behind` : undefined}
        right={
          !view.public && (
            <span className="flex items-center gap-2">
            <span className="hidden h-8 w-8 cursor-help items-center justify-center rounded-lg border border-line text-sm text-muted [@media(pointer:fine)]:inline-flex" title="Keys: / search · j and k move · Enter opens a trade" aria-label="Keyboard shortcuts: / search, j and k move, Enter opens a trade">?</span>
            <a
              href={exportHref}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ctl bg-raised px-3 text-sm font-medium text-bright transition hover:bg-well"
              title="Every round trip the query matches, as CSV"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
              </svg>
              Export CSV
            </a>
            </span>
          )
        }
        scope={
          <div className="grid w-full gap-2">
            <div className="flex flex-wrap items-center gap-1.5 sm:hidden">
              <button
                type="button"
                aria-label="Search trades"
                aria-expanded={searchOpen}
                onClick={openSearch}
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition ${searchOpen || q ? "border-accent-hi bg-accent-soft text-bright" : "border-ctl bg-raised text-body"}`}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden><path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35" /></svg>
              </button>
              <RangeChips value={range} onChange={setRange} dense />
              <TripCount totals={totals.t} loading={totals.loading} compactOnPhone />
            </div>
            <div ref={searchBox} className={searchOpen ? "" : "hidden sm:block"}>
            <QueryBar
              value={q}
              onChange={(v) => setQ(v)}
              keys={TRADE_KEYS}
              data={data}
              page="Trades"
              presets={TRADE_PRESETS}
              errors={totals.errors}
              placeholder="Search trades"
              trailing={
                <span className="hidden sm:contents">
                  <RangeChips value={range} onChange={setRange} />
                  <TripCount totals={totals.t} loading={totals.loading} />
                </span>
              }
            />
            </div>
          </div>
        }
      />
      <Card className="mt-5 overflow-hidden">
        <RoundTripTable scope={scope} q={q} sort={sort} dir={dir} onSort={setSort} onTotals={onTotals} hide={TRADES_HIDDEN} height="calc(100dvh - 19rem)" />
      </Card>
    </div>
  );
}

