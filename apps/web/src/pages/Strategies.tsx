import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type LogRow, type PerformanceBundle, type StrategyRow, type StrategyStats, type TradeRow } from "../api";
import { CalendarView } from "../components/Calendar";
import { TradeDetail } from "../components/detail";
import { EquityChart } from "../components/EquityChart";
import { BreakdownPanels, PerformancePanels } from "../components/Performance";
import { Sparkline } from "../components/Sparkline";
import {
  Card, Cell, Empty, LEVEL_TONE, Loadable, LoadMore, PageHeader, Panel, Pill, PnlLine, RangeSelect, rangeStart, Row, SearchInput, Select, SideTag, Stat, Table,
  type RangeKey,
} from "../components/ui";
import { age, money, num, pct, ts, tsDay } from "../format";
import { buildCloseMap, realizedLabel } from "../useCloses";
import { useLiveState } from "../useLiveState";

/** Open P&L per strategy from the live broker positions of one instance, with a staleness flag. */
function useOpenByStrategy(instanceId: string | null) {
  const liveState = useLiveState();
  const groups = (liveState.data?.positions ?? []).filter((g) => g.instanceId === instanceId);
  const open = new Map<string, number>();
  for (const g of groups)
    for (const p of g.list)
      if (p.strategyId) open.set(p.strategyId, (open.get(p.strategyId) ?? 0) + (p.profit ?? 0));
  return { open, hasState: groups.length > 0, stale: groups.length > 0 && groups.every((g) => g.stale) };
}

export default function Strategies({
  instanceId,
  focus = null,
  onClearFocus,
}: {
  instanceId: string | null;
  focus?: string | null;
  onClearFocus?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(focus);

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 10000,
  });
  const live = useOpenByStrategy(instanceId);

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;
  if (selected)
    return (
      <StrategyDetail
        instanceId={instanceId}
        strategyId={selected}
        onBack={() => {
          setSelected(null);
          onClearFocus?.();
        }}
      />
    );

  const rows = strategies.data ?? [];
  return (
    <div>
      <PageHeader title="Strategies" sub={`Every strategy ${instanceId} has reported. Click one to drill in.`} />
      <Loadable loading={strategies.isPending} error={strategies.isError} retry={() => strategies.refetch()} what="strategies">
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.length === 0 && <Card className="p-8 text-center text-faint md:col-span-2 xl:col-span-3">No strategies yet.</Card>}
        {rows.map((s, i) => {
          const realized = s.realizedNet;
          const open = live.open.get(s.strategyId) ?? (live.hasState ? 0 : null);
          const net = realized == null && open == null ? null : (realized ?? 0) + (open ?? 0);
          const allocation = net == null && s.startingBalance == null ? null : (s.startingBalance ?? 0) + (net ?? 0);
          return (
            <button key={s.strategyId} onClick={() => setSelected(s.strategyId)} className="group text-left">
              <Card className="p-5 transition group-hover:border-accent/50 group-hover:bg-raised" stagger={i}>
                <div className="flex items-baseline justify-between">
                  <span className="font-bold text-bright">{s.strategyId}</span>
                  <span className="text-xs text-faint">{age(s.lastSeen)}</span>
                </div>
                <div className="mt-2.5 flex items-baseline gap-3" title="allocation: starting balance + realized + open">
                  <span className={`font-mono text-2xl font-semibold ${live.stale ? "text-faint" : "text-bright"}`}>{money(allocation)}</span>
                  <PnlLine net={net} base={s.startingBalance} dim={live.stale} />
                </div>
                <div className={`mt-1 text-xs ${live.stale ? "text-faint" : "text-muted"}`}>
                  realized {money(realized)} · open {money(open)} · {s.dealCount} deal{s.dealCount === 1 ? "" : "s"}
                </div>
              </Card>
            </button>
          );
        })}
      </div>
      </Loadable>
    </div>
  );
}

function StrategyDetail({ instanceId, strategyId, onBack }: { instanceId: string; strategyId: string; onBack: () => void }) {
  const qs = `instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`;
  const stats = useQuery({
    queryKey: ["stats", instanceId, strategyId],
    queryFn: () => get<StrategyStats>(`/stats?${qs}`),
    refetchInterval: 10000,
  });
  const equity = useQuery({
    queryKey: ["equity", instanceId, strategyId],
    queryFn: () => get<EquityPoint[]>(`/equity?${qs}`),
    refetchInterval: 10000,
  });
  const trades = useQuery({
    queryKey: ["trades", instanceId, strategyId],
    queryFn: () => get<TradeRow[]>(`/trades?${qs}&limit=500`),
    refetchInterval: 10000,
  });
  const logs = useQuery({
    queryKey: ["logs", instanceId, strategyId],
    queryFn: () => get<LogRow[]>(`/logs?${qs}&limit=500`),
    refetchInterval: 10000,
  });
  const [tradeCap, setTradeCap] = useState(20);
  const [logCap, setLogCap] = useState(20);
  const [tradeQ, setTradeQ] = useState("");
  const [tradeSide, setTradeSide] = useState("");
  const [tradeSort, setTradeSort] = useState<"newest" | "oldest" | "qty" | "price" | "pnl">("newest");
  const [openTrade, setOpenTrade] = useState<TradeRow | null>(null);
  const [tab, setTab] = useState<"overview" | "performance" | "calendar">("overview");
  const [range, setRange] = useState<RangeKey>("all");

  const performance = useQuery({
    queryKey: ["performance", instanceId, strategyId, range],
    queryFn: () => {
      const from = rangeStart(range);
      return get<PerformanceBundle>(`/performance?${qs}${from > 0 ? `&from=${from}` : ""}`);
    },
    refetchInterval: 15000,
  });

  const live = useOpenByStrategy(instanceId);

  const s = stats.data;
  const openPnl = live.open.get(strategyId) ?? (live.hasState ? 0 : null);
  const heroNet = s?.realizedPnl == null && openPnl == null ? null : (s?.realizedPnl ?? 0) + (openPnl ?? 0);
  const allocation = heroNet == null && s?.startingBalance == null ? null : (s?.startingBalance ?? 0) + (heroNet ?? 0);
  const closeByOrder = buildCloseMap(performance.data?.closes ?? []);
  const tradeNeedle = tradeQ.trim().toUpperCase();
  const tradeRows = (trades.data ?? [])
    .filter(
      (t) =>
        (!tradeSide || t.payload.side === tradeSide) &&
        (!tradeNeedle ||
          t.payload.symbol.toUpperCase().includes(tradeNeedle) ||
          t.payload.orderId.toUpperCase().includes(tradeNeedle)),
    )
    .sort((a, b) => {
      switch (tradeSort) {
        case "oldest": return a.ts - b.ts;
        case "qty": return b.payload.qty - a.payload.qty;
        case "price": return b.payload.price - a.payload.price;
        case "pnl": {
          const ra = closeByOrder.get(a.payload.orderId)?.realized ?? -Infinity;
          const rb = closeByOrder.get(b.payload.orderId)?.realized ?? -Infinity;
          return rb - ra;
        }
        default: return b.ts - a.ts;
      }
    });
  const logRows = logs.data ?? [];
  return (
    <div>
      <button onClick={onBack} className="rise text-sm text-muted transition hover:text-body">
        ← strategies
      </button>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div className="rise">
          <h2 className="text-2xl font-extrabold tracking-tight text-bright">{strategyId}</h2>
          <div className="mt-2 flex items-baseline gap-3" title="allocation: starting balance + realized + open">
            <span className={`font-mono text-4xl font-bold ${allocation == null || live.stale ? "text-faint" : "text-bright"}`}>
              {money(allocation)}
            </span>
            <PnlLine net={heroNet} base={s?.startingBalance} dim={live.stale} />
          </div>
          <div className={`mt-1 text-xs ${live.stale ? "text-faint" : "text-muted"}`}>
            {money(s?.startingBalance)} allocated · realized {money(s?.realizedPnl)} · open {money(openPnl)}
          </div>
        </div>
        <div className="rise -mb-1 w-64">
          <Sparkline points={equity.data ?? []} height={56} />
        </div>
      </div>

      <div className="rise mt-5 flex flex-wrap items-center gap-2">
        {(["overview", "performance", "calendar"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-9 rounded-lg px-4 text-sm font-semibold capitalize transition ${
              tab === t ? "bg-accent text-ink" : "border border-line bg-raised text-muted hover:border-line-strong hover:text-body"
            }`}
          >
            {t}
          </button>
        ))}
        {tab !== "overview" && (
          <div className="ml-auto">
            <RangeSelect value={range} onChange={setRange} />
          </div>
        )}
      </div>

      {tab === "performance" && (
        <div className="mt-5 grid gap-5">
          <Loadable loading={!performance.data} error={performance.isError} retry={() => performance.refetch()} what="performance" lines={6}>
            {performance.data && <PerformancePanels bundle={performance.data} />}
            {performance.data?.breakdowns && <BreakdownPanels b={performance.data.breakdowns} />}
          </Loadable>
        </div>
      )}

      {tab === "calendar" && (
        <div className="mt-5">
          <Loadable loading={!performance.data} error={performance.isError} retry={() => performance.refetch()} what="the calendar" lines={6}>
            {performance.data && (
              <CalendarView
                days={performance.data.dailyNets}
                startingBalance={s?.startingBalance ?? null}
                trades={tradeRows}
                onTrade={setOpenTrade}
              />
            )}
          </Loadable>
        </div>
      )}

      {tab === "overview" && (
        <>
      <div className="mt-5">
        <Loadable loading={stats.isPending} error={stats.isError} retry={() => stats.refetch()} what="strategy stats" lines={2}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Realized PnL"
          value={money(s?.realizedPnl)}
          tone={s?.realizedPnl == null ? "neutral" : s.realizedPnl >= 0 ? "up" : "down"}
          stagger={0}
        />
        <Stat label="Sharpe" value={num(s?.sharpe)} stagger={1} />
        <Stat label="Win rate" value={pct(s?.winRate)} stagger={2} />
        <Stat label="Max drawdown" value={pct(s?.maxDrawdownPct)} tone={s?.maxDrawdownPct ? "down" : "neutral"} stagger={3} />
        <Stat
          label="Trades"
          value={String(s?.tradeCount ?? "—")}
          sub={s ? `${s.buyCount} buys · ${s.sellCount} sells` : undefined}
          stagger={4}
        />
        <Stat label="Volume" value={num(s?.volume)} stagger={5} />
      </div>
        </Loadable>
      </div>

      <Panel className="mt-6" stagger={2} title="Equity" hint="broker deals when available, ledger snapshots otherwise">
        <Loadable loading={equity.isPending} error={equity.isError} retry={() => equity.refetch()} what="the equity curve" lines={4}>
          <div className="p-4">
            <EquityChart points={equity.data ?? []} />
          </div>
        </Loadable>
      </Panel>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel
          stagger={3}
          title="Trades"
          hint="click a row to inspect"
          scroll="max-h-[26rem]"
          toolbar={
            <>
              <SearchInput
                value={tradeQ}
                onChange={(e) => {
                  setTradeQ(e.target.value);
                  setTradeCap(20);
                }}
                placeholder="search symbol, order id…"
                className="w-56"
              />
              <Select
                value={tradeSide}
                onChange={(e) => {
                  setTradeSide(e.target.value);
                  setTradeCap(20);
                }}
              >
                <option value="">any side</option>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </Select>
              <Select value={tradeSort} onChange={(e) => setTradeSort(e.target.value as typeof tradeSort)}>
                <option value="newest">newest first</option>
                <option value="oldest">oldest first</option>
                <option value="qty">biggest qty</option>
                <option value="price">highest price</option>
                <option value="pnl">best P&L</option>
              </Select>
            </>
          }
        >
          <Loadable loading={trades.isPending} error={trades.isError} retry={() => trades.refetch()} what="trades">
          <Table>
            {tradeRows.slice(0, tradeCap).map((t) => (
              <Row key={t.id} onClick={() => setOpenTrade(t)}>
                <Cell className="whitespace-nowrap text-muted">{tsDay(t.ts)}</Cell>
                <Cell className="font-semibold text-bright">{t.payload.symbol}</Cell>
                <Cell>
                  <SideTag side={t.payload.side} />
                </Cell>
                <Cell className="font-mono">{t.payload.qty}</Cell>
                <Cell className="font-mono text-muted">@ {t.payload.price}</Cell>
                {(() => {
                  const r = realizedLabel(closeByOrder.get(t.payload.orderId));
                  return <Cell className={`font-mono ${r.className}`}>{r.text}</Cell>;
                })()}
              </Row>
            ))}
            {tradeRows.length === 0 && <Empty colSpan={6}>No trades yet</Empty>}
          </Table>
          <LoadMore shown={Math.min(tradeCap, tradeRows.length)} total={tradeRows.length} onMore={() => setTradeCap((c) => c + 20)} />
          </Loadable>
        </Panel>

        <Panel stagger={4} title="Recent logs" scroll="max-h-[26rem]">
          <Loadable loading={logs.isPending} error={logs.isError} retry={() => logs.refetch()} what="logs">
          <div className="p-2">
            {logRows.slice(0, logCap).map((l) => (
              <div key={l.id} className="flex items-start gap-2 border-b border-line/50 px-2 py-1.5 font-mono text-xs last:border-b-0">
                <span className="whitespace-nowrap text-faint">{ts(l.ts)}</span>
                <Pill tone={LEVEL_TONE[l.level] ?? "neutral"}>{l.level}</Pill>
                <span className="break-all text-body">{l.message}</span>
              </div>
            ))}
            {logRows.length === 0 && <Empty>No logs yet</Empty>}
          </div>
          <LoadMore shown={Math.min(logCap, logRows.length)} total={logRows.length} onMore={() => setLogCap((c) => c + 20)} />
          </Loadable>
        </Panel>
      </div>
        </>
      )}

      <TradeDetail trade={openTrade} instanceId={instanceId} onClose={() => setOpenTrade(null)} close={openTrade ? closeByOrder.get(openTrade.payload.orderId) : null} />
    </div>
  );
}
