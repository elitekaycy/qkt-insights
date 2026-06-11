import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type StrategyRow, type TradeRow } from "../api";
import { TradeDetail } from "../components/detail";
import {
  Card, Cell, Empty, LoadMore, PageHeader, Panel, QueryError, RangeSelect, rangeStart, Row, SearchInput, Select, SideTag, Table,
  type RangeKey,
} from "../components/ui";
import { tsDay } from "../format";
import { realizedLabel, useCloseMap } from "../useCloses";

export default function Trades({ instanceId }: { instanceId: string | null }) {
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
      if (strategy) p.set("strategy", strategy);
      return get<TradeRow[]>(`/trades?${p}`);
    },
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const needle = q.trim().toUpperCase();
  const start = rangeStart(range);
  const filtered = (trades.data ?? []).filter(
    (t) =>
      t.ts >= start &&
      (!needle ||
        t.payload.symbol.toUpperCase().includes(needle) ||
        t.payload.orderId.toUpperCase().includes(needle) ||
        (t.strategyId ?? "").toUpperCase().includes(needle)),
  );
  const shown = filtered.slice(0, cap);

  return (
    <div>
      <PageHeader title="Trades" sub={`Every fill recorded for ${instanceId}. Click a row for the full story.`} />
      <QueryError on={strategies.isError || trades.isError} what="trades" />

      <Panel
        className="mt-5"
        stagger={1}
        title="Fills"
        scroll="max-h-[calc(100vh-15rem)]"
        toolbar={
          <>
            <SearchInput
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setCap(30);
              }}
              placeholder="search symbol, order id, strategy…"
              className="w-72"
            />
            <Select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value);
                setCap(30);
              }}
            >
              <option value="">all strategies</option>
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
        <Table head={["Time", "Strategy", "Symbol", "Side", "Qty", "Price", "P&L", "Order"]}>
          {shown.map((t) => (
            <Row key={t.id} onClick={() => setOpen(t)}>
              <Cell className="whitespace-nowrap text-muted">{tsDay(t.ts)}</Cell>
              <Cell>{t.strategyId ?? "—"}</Cell>
              <Cell className="font-semibold text-bright">{t.payload.symbol}</Cell>
              <Cell>
                <SideTag side={t.payload.side} />
              </Cell>
              <Cell className="font-mono">{t.payload.qty}</Cell>
              <Cell className="font-mono">{t.payload.price}</Cell>
              {(() => {
                const r = realizedLabel(closeMap.get(t.payload.orderId));
                return <Cell className={`font-mono ${r.className}`}>{r.text}</Cell>;
              })()}
              <Cell className="font-mono text-xs text-faint">{t.payload.orderId}</Cell>
            </Row>
          ))}
          {shown.length === 0 && <Empty colSpan={8}>No trades match</Empty>}
        </Table>
        <LoadMore shown={shown.length} total={filtered.length} onMore={() => setCap((c) => c + 30)} />
      </Panel>

      <TradeDetail trade={open} instanceId={instanceId} onClose={() => setOpen(null)} close={open ? closeMap.get(open.payload.orderId) : null} />
    </div>
  );
}
