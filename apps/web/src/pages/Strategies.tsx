import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type LogRow, type PerformanceBundle, type StrategyRow, type StrategyStats, type TradeRow } from "../api";
import { CalendarView } from "../components/Calendar";
import { TradeDetail } from "../components/detail";
import { EquityChart } from "../components/EquityChart";
import { PerformancePanels } from "../components/Performance";
import { Sparkline } from "../components/Sparkline";
import {
  Card, Cell, Delta, Empty, LEVEL_TONE, LoadMore, PageHeader, Panel, Pill, RangeSelect, rangeStart, Row, SideTag, Stat, Table,
  type RangeKey,
} from "../components/ui";
import { age, money, num, pct, ts, tsDay } from "../format";

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
      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.length === 0 && <Card className="p-8 text-center text-faint md:col-span-2 xl:col-span-3">No strategies yet.</Card>}
        {rows.map((s, i) => {
          const ret =
            s.equity != null && s.startingBalance ? (s.equity - s.startingBalance) / s.startingBalance : null;
          return (
            <button key={s.strategyId} onClick={() => setSelected(s.strategyId)} className="group text-left">
              <Card className="p-5 transition group-hover:border-accent/50 group-hover:bg-raised" stagger={i}>
                <div className="flex items-baseline justify-between">
                  <span className="font-bold text-bright">{s.strategyId}</span>
                  <span className="text-xs text-faint">{age(s.lastSeen)}</span>
                </div>
                <div className="mt-2.5 flex items-baseline gap-3">
                  <span className="font-mono text-2xl font-semibold text-bright">{money(s.equity)}</span>
                  <Delta value={ret} />
                </div>
                <div className="mt-1 text-xs text-faint">from {money(s.startingBalance)} starting</div>
              </Card>
            </button>
          );
        })}
      </div>
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
  const [openTrade, setOpenTrade] = useState<TradeRow | null>(null);
  const [tab, setTab] = useState<"overview" | "performance" | "calendar">("overview");
  const [range, setRange] = useState<RangeKey>("all");

  const performance = useQuery({
    queryKey: ["performance", instanceId, strategyId, range],
    queryFn: () => {
      const from = rangeStart(range);
      return get<PerformanceBundle>(`/performance?${qs}${from > 0 ? `&from=${from}` : ""}`);
    },
    enabled: tab !== "overview",
    refetchInterval: 15000,
  });

  const s = stats.data;
  const tradeRows = trades.data ?? [];
  const logRows = logs.data ?? [];
  return (
    <div>
      <button onClick={onBack} className="rise text-sm text-muted transition hover:text-body">
        ← strategies
      </button>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div className="rise">
          <h2 className="text-2xl font-extrabold tracking-tight text-bright">{strategyId}</h2>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="font-mono text-4xl font-bold text-bright">{money(s?.equity)}</span>
            <Delta value={s?.returnPct} />
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
        <div className="mt-5">
          {performance.data ? <PerformancePanels bundle={performance.data} /> : <Card className="p-8 text-center text-faint">Loading…</Card>}
        </div>
      )}

      {tab === "calendar" && (
        <div className="mt-5">
          {performance.data ? (
            <CalendarView days={performance.data.dailyNets} startingBalance={s?.startingBalance ?? null} />
          ) : (
            <Card className="p-8 text-center text-faint">Loading…</Card>
          )}
        </div>
      )}

      {tab === "overview" && (
        <>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Realized PnL"
          value={money(s?.realizedPnl)}
          tone={s?.realizedPnl == null ? "neutral" : s.realizedPnl >= 0 ? "up" : "down"}
          stagger={0}
        />
        <Stat label="Sharpe" value={num(s?.sharpe)} stagger={1} />
        <Stat label="Win rate" value={pct(s?.winRate)} stagger={2} />
        <Stat label="Max drawdown" value={pct(s?.maxDrawdownPct)} tone={s?.maxDrawdownPct ? "down" : "neutral"} stagger={3} />
        <Stat label="Trades" value={String(s?.tradeCount ?? "—")} sub={`${s?.buyCount ?? 0} buys · ${s?.sellCount ?? 0} sells`} stagger={4} />
        <Stat label="Volume" value={num(s?.volume)} stagger={5} />
      </div>

      <Panel className="mt-6" stagger={2} title="Equity" hint={`from ${money(s?.startingBalance)} starting`}>
        <div className="p-4">
          <EquityChart points={equity.data ?? []} />
        </div>
      </Panel>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel stagger={3} title="Trades" hint="click a row to inspect" scroll="max-h-[26rem]">
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
              </Row>
            ))}
            {tradeRows.length === 0 && <Empty colSpan={5}>No trades yet</Empty>}
          </Table>
          <LoadMore shown={Math.min(tradeCap, tradeRows.length)} total={tradeRows.length} onMore={() => setTradeCap((c) => c + 20)} />
        </Panel>

        <Panel stagger={4} title="Recent logs" scroll="max-h-[26rem]">
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
        </Panel>
      </div>
        </>
      )}

      <TradeDetail trade={openTrade} instanceId={instanceId} onClose={() => setOpenTrade(null)} />
    </div>
  );
}
