import { useCallback, useMemo, useState } from "react";
import { TRADE_KEYS } from "@qkt-insights/contract/query";
import { Card, PageHeader, RangeSelect, rangeStart, useRangeParam } from "../components/ui";
import { useSearchParam } from "../router";
import { QueryBar, TRADE_PRESETS } from "../query/QueryBar";
import { tripParams, useTripFacets, type RoundTripTotals, type TripScope } from "../trades/data";
import { RoundTripTable } from "../trades/RoundTripTable";
import { TripCount, useSortParams } from "../trades/scope";
import { usePublicPageView, useView } from "../view";

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
        sub={`Every round trip on ${instanceId}, entry to exit: one row per position, P&L after costs, times UTC${view.public ? `, ${view.meta.delayMinutes} minutes behind` : ""}.`}
        right={
          !view.public && (
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
          )
        }
        scope={
          <>
            <QueryBar
              value={q}
              onChange={(v) => setQ(v)}
              keys={TRADE_KEYS}
              data={data}
              page="Trades"
              presets={TRADE_PRESETS}
              errors={totals.errors}
              placeholder="Search or filter: gold, win, side:short, pnl:<0, held:<1h, ended:stop, exit:2026-10, #ticket…"
            />
            <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
              <RangeSelect value={range} onChange={setRange} />
              <TripCount totals={totals.t} loading={totals.loading} />
              <span className="ml-auto hidden text-xs text-faint lg:inline">
                <kbd className="font-mono">/</kbd> search · <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> move · <kbd className="font-mono">Enter</kbd> open
              </span>
            </div>
          </>
        }
      />
      <Card className="mt-5 overflow-hidden">
        <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
          <h3 className="text-sm font-medium text-body">Round trips</h3>
          <span className="hidden text-xs text-muted sm:inline">one row per entry-to-exit · {view.public ? "closed positions only" : "click a row for its timeline"}</span>
        </div>
        <RoundTripTable scope={scope} q={q} sort={sort} dir={dir} onSort={setSort} onTotals={onTotals} height="calc(100dvh - 19rem)" />
      </Card>
    </div>
  );
}

