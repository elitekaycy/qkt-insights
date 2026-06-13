import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, type DealRow, type OrderRow, type StrategyRow, type TradeRow } from "../api";
import { OrderDetail, TradeDetail } from "../components/detail";
import {
  Cell, Empty, LiveDot, Loadable, LoadMore, PageHeader, Panel, Pill, Row, SearchInput, Select, SideTag, STATE_TONE, Table,
} from "../components/ui";
import { ts, tsDay } from "../format";
import { realizedLabel, useCloseMap } from "../useCloses";
import { useLiveStream } from "../useLiveStream";

const ORDERFLOW_TYPES = [
  "trade", "order.submit", "order.accepted", "order.filled", "order.partially_filled", "order.cancelled",
  "order.rejected", "order.modified", "signal", "risk.rejected", "risk.halted", "risk.resumed", "broker.deal",
];

export default function Orderflow({ instanceId }: { instanceId: string | null }) {
  const [strategy, setStrategy] = useState("");
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [orderCap, setOrderCap] = useState(20);
  const [tradeCap, setTradeCap] = useState(20);
  const [openOrder, setOpenOrder] = useState<OrderRow | null>(null);
  const [openTrade, setOpenTrade] = useState<TradeRow | null>(null);
  const closeMap = useCloseMap(instanceId);

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  const ordersUrl = useMemo(() => {
    if (!instanceId) return null;
    const p = new URLSearchParams({ instance: instanceId, limit: "1000" });
    if (strategy) p.set("strategy", strategy);
    if (state) p.set("state", state);
    return `/orders?${p}`;
  }, [instanceId, strategy, state]);

  const orders = useQuery({
    queryKey: ["orders", ordersUrl],
    queryFn: () => get<OrderRow[]>(ordersUrl!),
    enabled: !!ordersUrl,
    refetchInterval: 5000,
  });

  const trades = useQuery({
    queryKey: ["trades", instanceId, strategy],
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId!, limit: "1000" });
      if (strategy) p.set("strategy", strategy);
      return get<TradeRow[]>(`/trades?${p}`);
    },
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  // Broker deal history is the real executed order flow; when present it wins over
  // engine fills. A pushed broker.deal means it grew — refetch instead of waiting the poll.
  const deals = useQuery({
    queryKey: ["deals-page", instanceId],
    queryFn: () => get<DealRow[]>(`/deals?instance=${encodeURIComponent(instanceId!)}&limit=1000`),
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  const live = useLiveStream(instanceId, 500, ORDERFLOW_TYPES);
  const qc = useQueryClient();
  const newestDealId = live.find((e) => e.type === "broker.deal")?.id;
  useEffect(() => {
    if (newestDealId) qc.invalidateQueries({ queryKey: ["deals-page", instanceId] });
  }, [newestDealId, qc, instanceId]);

  const needle = q.trim().toUpperCase();
  const matchText = (...parts: (string | null | undefined)[]) =>
    !needle || parts.some((x) => (x ?? "").toUpperCase().includes(needle));

  const usingDeals = (deals.data?.length ?? 0) > 0;
  const dealNet = (d: DealRow) => (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0);
  const dealRows = (deals.data ?? []).filter((d) => (!strategy || d.strategyId === strategy) && matchText(d.symbol, d.dealTicket, d.strategyId));
  const orderRows = (orders.data ?? []).filter((o) => matchText(o.symbol, o.orderId, o.strategyId));
  const tradeRows = (trades.data ?? []).filter((t) => matchText(t.payload.symbol, t.payload.orderId, t.strategyId));
  const liveFiltered = live.filter(
    (e) =>
      (!strategy || e.strategyId === strategy) &&
      matchText(String(e.payload.symbol ?? ""), String(e.payload.orderId ?? ""), e.strategyId),
  );

  const filterBar = (
    <>
      <SearchInput
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOrderCap(20);
          setTradeCap(20);
        }}
        placeholder="search symbol, order id…"
        className="w-64"
      />
      <Select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
        <option value="">all strategies</option>
        {(strategies.data ?? []).map((s) => (
          <option key={s.strategyId} value={s.strategyId}>
            {s.strategyId}
          </option>
        ))}
      </Select>
    </>
  );

  return (
    <div>
      <PageHeader title="Orderflow" sub={`Orders and fills for ${instanceId ?? "—"}, live tail alongside. Click a row to inspect.`} />

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="grid content-start gap-5">
          <Panel
            stagger={0}
            title="Orders"
            scroll="max-h-[24rem]"
            toolbar={
              <>
                {filterBar}
                <Select value={state} onChange={(e) => setState(e.target.value)}>
                  <option value="">any state</option>
                  {Object.keys(STATE_TONE).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </>
            }
          >
            <Loadable loading={!!instanceId && orders.isPending} error={orders.isError} retry={() => orders.refetch()} what="orders">
            <Table head={["Time", "Strategy", "Symbol", "Side", "Qty", "Avg px", "State"]}>
              {orderRows.slice(0, orderCap).map((o) => (
                <Row key={o.orderId} onClick={() => setOpenOrder(o)}>
                  <Cell className="whitespace-nowrap text-muted">{tsDay(o.updatedTs)}</Cell>
                  <Cell>{o.strategyId ?? "—"}</Cell>
                  <Cell className="font-semibold text-bright">{o.symbol ?? "—"}</Cell>
                  <Cell>
                    <SideTag side={o.side} />
                  </Cell>
                  <Cell className="font-mono">{o.qty ?? o.cumQty}</Cell>
                  <Cell className="font-mono">{o.avgPrice ?? "—"}</Cell>
                  <Cell>
                    <Pill tone={STATE_TONE[o.state] ?? "neutral"}>{o.state}</Pill>
                  </Cell>
                </Row>
              ))}
              {orderRows.length === 0 && (
                <Empty colSpan={7}>
                  {usingDeals
                    ? "No order-lifecycle events — this instance reports executed deals (see below), not the submit → fill lifecycle."
                    : "No orders yet"}
                </Empty>
              )}
            </Table>
            <LoadMore shown={Math.min(orderCap, orderRows.length)} total={orderRows.length} onMore={() => setOrderCap((c) => c + 20)} />
            </Loadable>
          </Panel>

          <Panel stagger={1} title={usingDeals ? "Executed deals" : "Recent trades"} hint={usingDeals ? "broker in/out legs, as the venue recorded them" : undefined} toolbar={filterBar} scroll="max-h-[24rem]">
            <Loadable loading={!!instanceId && trades.isPending && deals.isPending} error={trades.isError && deals.isError} retry={() => { void trades.refetch(); void deals.refetch(); }} what="trade flow">
            {usingDeals ? (
              <>
                <Table head={["Time", "Strategy", "Symbol", "Side", "Entry", "Qty", "Price", "Net"]}>
                  {dealRows.slice(0, tradeCap).map((d) => {
                    const n = dealNet(d);
                    return (
                      <Row key={d.id}>
                        <Cell className="whitespace-nowrap text-muted">{tsDay(d.ts)}</Cell>
                        <Cell>{d.strategyId ?? <Pill>unattributed</Pill>}</Cell>
                        <Cell className="font-semibold text-bright">{d.symbol ?? "—"}</Cell>
                        <Cell>
                          <SideTag side={d.side} />
                        </Cell>
                        <Cell className="font-mono text-muted">{d.entry ?? "—"}</Cell>
                        <Cell className="font-mono">{d.qty ?? "—"}</Cell>
                        <Cell className="font-mono">{d.price ?? "—"}</Cell>
                        <Cell className={`font-mono font-semibold ${n > 0 ? "text-up" : n < 0 ? "text-down" : "text-muted"}`}>{n > 0 ? "+" : ""}{n.toFixed(2)}</Cell>
                      </Row>
                    );
                  })}
                  {dealRows.length === 0 && <Empty colSpan={8}>No deals match</Empty>}
                </Table>
                <LoadMore shown={Math.min(tradeCap, dealRows.length)} total={dealRows.length} onMore={() => setTradeCap((c) => c + 20)} />
              </>
            ) : (
              <>
                <Table>
                  {tradeRows.slice(0, tradeCap).map((t) => (
                    <Row key={t.id} onClick={() => setOpenTrade(t)}>
                      <Cell className="whitespace-nowrap text-muted">{tsDay(t.ts)}</Cell>
                      <Cell>{t.strategyId ?? "—"}</Cell>
                      <Cell className="font-semibold text-bright">{t.payload.symbol}</Cell>
                      <Cell>
                        <SideTag side={t.payload.side} />
                      </Cell>
                      <Cell className="font-mono">{t.payload.qty}</Cell>
                      <Cell className="font-mono text-muted">@ {t.payload.price}</Cell>
                      {(() => {
                        const r = realizedLabel(closeMap.get(t.payload.orderId));
                        return <Cell className={`font-mono ${r.className}`}>{r.text}</Cell>;
                      })()}
                    </Row>
                  ))}
                  {tradeRows.length === 0 && <Empty colSpan={7}>No trades yet</Empty>}
                </Table>
                <LoadMore shown={Math.min(tradeCap, tradeRows.length)} total={tradeRows.length} onMore={() => setTradeCap((c) => c + 20)} />
              </>
            )}
            </Loadable>
          </Panel>
        </div>

        <Panel stagger={2} title="Live tail" right={<LiveDot on={liveFiltered.length > 0} />} scroll="max-h-[34rem]">
          <div className="p-2 font-mono text-xs">
            {liveFiltered.length === 0 && <div className="p-3 text-faint">Waiting for events…</div>}
            {liveFiltered.map((e) => (
              <div key={`${e.instanceId}-${e.id}`} className="border-b border-line/50 px-2 py-1.5 last:border-b-0">
                <span className="text-faint">{ts(e.ts)}</span> <span className="text-info">{e.type}</span>{" "}
                {e.strategyId && <span className="text-muted">[{e.strategyId}]</span>}{" "}
                <span className="break-all text-body/80">{JSON.stringify(e.payload)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {instanceId && <OrderDetail order={openOrder} instanceId={instanceId} onClose={() => setOpenOrder(null)} close={openOrder ? closeMap.get(openOrder.orderId) : null} />}
      {instanceId && <TradeDetail trade={openTrade} instanceId={instanceId} onClose={() => setOpenTrade(null)} close={openTrade ? closeMap.get(openTrade.payload.orderId) : null} />}
    </div>
  );
}
