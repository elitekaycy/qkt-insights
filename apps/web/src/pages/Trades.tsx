import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, type DealRow, type StrategyRow, type TradeRow } from "../api";
import { TradeDetail } from "../components/detail";
import {
  Card, Cell, DataList, Loadable, LoadMore, PageHeader, Panel, Pill, Pnl, RangeSelect, rangeStart, SearchInput, Select, SideTag, TimeCell,
  type RangeKey,
} from "../components/ui";
import { dealNet, price, quantity, tsShort } from "../format";
import { realizedLabel, useCloseMap } from "../useCloses";
import { useLiveStream } from "../useLiveStream";
import { usePublicPageView, useView } from "../view";

// a pushed deal or fill means the history just grew — refetch instead of waiting out the poll
const HISTORY_TYPES = ["broker.deal", "trade"];
/** Strategy filter value for deals and fills no strategy claimed. */
const UNATTRIBUTED = "(unattributed)";

export default function Trades({ instanceId }: { instanceId: string | null }) {
  usePublicPageView("trades");
  const view = useView();
  const [strategy, setStrategy] = useState("");
  const [q, setQ] = useState("");
  const [range, setRange] = useState<RangeKey>("all");
  const [cap, setCap] = useState(30);
  const [open, setOpen] = useState<TradeRow | null>(null);
  const closeMap = useCloseMap(instanceId);

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  const trades = useQuery({
    queryKey: ["trades-page", instanceId, strategy],
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId!, limit: "1000" });
      if (strategy && strategy !== UNATTRIBUTED) p.set("strategy", strategy);
      return get<TradeRow[]>(`/trades?${p}`);
    },
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });
  // Broker deal history; when the instance has any, it wins over engine fills.
  // Strategy filtering happens client-side so an empty filter result doesn't
  // flip the page back to the fills view.
  const deals = useQuery({
    queryKey: ["deals-page", instanceId],
    queryFn: () => get<DealRow[]>(`/deals?instance=${encodeURIComponent(instanceId!)}&limit=1000`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });

  const qc = useQueryClient();
  const historyLive = useLiveStream(instanceId, 5, HISTORY_TYPES);
  const newest = historyLive[0];
  useEffect(() => {
    if (!newest) return;
    void qc.invalidateQueries({ queryKey: [newest.type === "trade" ? "trades-page" : "deals-page", instanceId] });
  }, [newest, qc, instanceId]);

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const usingDeals = (deals.data?.length ?? 0) > 0;
  const needle = q.trim().toUpperCase();
  const start = rangeStart(range);
  const filtered = (trades.data ?? []).filter(
    (t) =>
      t.ts >= start &&
      (strategy !== UNATTRIBUTED || t.strategyId == null) &&
      (!needle ||
        t.payload.symbol.toUpperCase().includes(needle) ||
        t.payload.orderId.toUpperCase().includes(needle) ||
        (t.strategyId ?? "").toUpperCase().includes(needle)),
  );
  const shown = filtered.slice(0, cap);
  const filteredDeals = (deals.data ?? []).filter(
    (d) =>
      d.ts >= start &&
      (!strategy || (strategy === UNATTRIBUTED ? d.strategyId == null : d.strategyId === strategy)) &&
      (!needle ||
        (d.symbol ?? "").toUpperCase().includes(needle) ||
        d.dealTicket.toUpperCase().includes(needle) ||
        (d.strategyId ?? "").toUpperCase().includes(needle)),
  );
  const shownDeals = filteredDeals.slice(0, cap);

  return (
    <div>
      <PageHeader
        title="Trades"
        sub={
          usingDeals
            ? `Broker deal history for ${instanceId} — every executed in/out leg as the venue recorded it.`
            : `Every fill recorded for ${instanceId}. Click a row for the full story.`
        }
      />
      <Panel
        className="mt-5"
       
        title={usingDeals ? "Deals" : "Fills"}
        hint={usingDeals ? "source: broker deals" : "source: engine fills"}
        scroll="max-h-[calc(100vh-15rem)]"
        toolbar={
          <>
            <SearchInput
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setCap(30);
              }}
              placeholder={usingDeals ? "search symbol, deal ticket, strategy…" : "search symbol, order id, strategy…"}
              className="w-full sm:w-72"
            />
            <Select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value);
                setCap(30);
              }}
            >
              <option value="">all strategies</option>
              <option value={UNATTRIBUTED}>unattributed</option>
              {(strategies.data ?? []).map((s) => (
                <option key={s.strategyId} value={s.strategyId}>
                  {s.strategyId}
                </option>
              ))}
            </Select>
            <RangeSelect
              value={range}
              onChange={(v) => {
                setRange(v);
                setCap(30);
              }}
            />
          </>
        }
      >
        <Loadable
          loading={trades.isPending || deals.isPending}
          error={trades.isError || deals.isError}
          retry={() => {
            void trades.refetch();
            void deals.refetch();
          }}
          what="trade history"
        >
        {usingDeals ? (
          <>
            <DataList
              head={["Time (UTC)", "Strategy", "Symbol", "Side", "Entry", "Qty", "Price", "Net", "Deal"]}
              rows={shownDeals}
              keyOf={(d) => d.id}
              empty="No deals match"
              cells={(d) => {
                const n = dealNet(d);
                return (
                  <>
                    <TimeCell ts={d.ts} />
                    <Cell>{d.strategyId ?? <Pill>unattributed</Pill>}</Cell>
                    <Cell className="font-semibold text-bright">{d.symbol ?? "—"}</Cell>
                    <Cell>
                      <SideTag side={d.side} />
                    </Cell>
                    <Cell className="text-muted">{d.entry ?? "—"}</Cell>
                    <Cell>{quantity(d.qty)}</Cell>
                    <Cell>{price(d.price)}</Cell>
                    <Cell className="font-semibold">
                      <Pnl value={n} glyphs={false} />
                    </Cell>
                    <Cell className="font-mono text-xs text-faint">{d.dealTicket}</Cell>
                  </>
                );
              }}
              card={(d) => {
                const n = dealNet(d);
                return (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate font-semibold text-bright">{d.symbol ?? "—"}</span>
                      <SideTag side={d.side} />
                      <Pnl value={n} glyphs={false} className="ml-auto shrink-0 text-sm font-semibold" />
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-faint">
                      <span className="min-w-0 truncate">{d.strategyId ?? "unattributed"}</span>
                      <span className="ml-auto shrink-0 whitespace-nowrap ">
                        {quantity(d.qty)} @ {price(d.price)} · {tsShort(d.ts)} UTC
                      </span>
                    </div>
                  </>
                );
              }}
            />
            <LoadMore shown={shownDeals.length} total={filteredDeals.length} onMore={() => setCap((c) => c + 30)} />
          </>
        ) : (
          <>
            <DataList
              head={["Time (UTC)", "Strategy", "Symbol", "Side", "Qty", "Price", "P&L", "Order"]}
              rows={shown}
              keyOf={(t) => t.id}
              onRow={view.public ? undefined : (t) => setOpen(t)}
              empty="No trades match"
              cells={(t) => {
                const r = realizedLabel(closeMap.get(t.payload.orderId));
                return (
                  <>
                    <TimeCell ts={t.ts} />
                    <Cell>{t.strategyId ?? "—"}</Cell>
                    <Cell className="font-semibold text-bright">{t.payload.symbol}</Cell>
                    <Cell>
                      <SideTag side={t.payload.side} />
                    </Cell>
                    <Cell>{quantity(t.payload.qty)}</Cell>
                    <Cell>{price(t.payload.price)}</Cell>
                    <Cell className={r.className}>{r.text}</Cell>
                    <Cell className="font-mono text-xs text-faint">{t.payload.orderId}</Cell>
                  </>
                );
              }}
              card={(t) => {
                const r = realizedLabel(closeMap.get(t.payload.orderId));
                return (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate font-semibold text-bright">{t.payload.symbol}</span>
                      <SideTag side={t.payload.side} />
                      <span className={`ml-auto shrink-0 text-sm font-semibold ${r.className}`}>{r.text}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-faint">
                      <span className="min-w-0 truncate">{t.strategyId ?? "unattributed"}</span>
                      <span className="ml-auto shrink-0 whitespace-nowrap ">
                        {quantity(t.payload.qty)} @ {price(t.payload.price)} · {tsShort(t.ts)} UTC
                      </span>
                    </div>
                  </>
                );
              }}
            />
            <LoadMore shown={shown.length} total={filtered.length} onMore={() => setCap((c) => c + 30)} />
          </>
        )}
        </Loadable>
      </Panel>

      {!view.public && (
        <TradeDetail trade={open} instanceId={instanceId} onClose={() => setOpen(null)} close={open ? closeMap.get(open.payload.orderId) : null} />
      )}
    </div>
  );
}
