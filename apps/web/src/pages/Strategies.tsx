import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type LogRow, type PerformanceBundle, type StrategyRow, type StrategyStats, type TradeRow, type TradeView } from "../api";
import { CalendarView } from "../components/Calendar";
import { TradeDetail } from "../components/detail";
import { EquityChart } from "../components/EquityChart";
import { EdgeDetailPanels, PerformancePanels, TradeAnalysisPanels } from "../components/Performance";
import { Sparkline } from "../components/Sparkline";
import {
  Card, Cell, Empty, LEVEL_TONE, Loadable, LoadMore, PageHeader, Panel, Pill, RangeSelect, rangeStart, ReturnPct, Row, SearchInput, Select, SideTag, Stat, Table,
  type RangeKey,
} from "../components/ui";
import { age, money, num, pct, ts, tsDay } from "../format";
import { buildCloseMap } from "../useCloses";
import { useLiveState } from "../useLiveState";
import { physicalPortfolioId, portfolioGroupId, strategyDisplayName as displayName, summarizePortfolio } from "../portfolio";

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

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function metaNumber(meta: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

function metaStringList(meta: Record<string, unknown> | null | undefined, key: string): string[] {
  const v = meta?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function sourceName(path: string | null): string | null {
  if (!path) return null;
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function portfolioId(row: StrategyRow): string | null {
  return portfolioGroupId(row);
}

function portfolioAlias(row: StrategyRow): string | null {
  return metaString(row.metadata, "portfolioAlias");
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
  const [selectedPortfolio, setSelectedPortfolio] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);

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

  const allRows = strategies.data ?? [];
  const retiredCount = allRows.filter((row) => !row.active).length;
  // Default to the live deployed roster; ids left over from a prior bench topology
  // (active=false) are hidden unless the operator opts to see them.
  const rows = showRetired ? allRows : allRows.filter((row) => row.active);
  const portfolioGroups = rows.reduce((acc, row) => {
    const id = portfolioId(row);
    if (!id) return acc;
    const group = acc.get(id) ?? [];
    group.push(row);
    acc.set(id, group);
    return acc;
  }, new Map<string, StrategyRow[]>());
  const standalone = rows.filter((row) => !portfolioId(row));
  const portfolio =
    selectedPortfolio == null
      ? null
      : (portfolioGroups.get(selectedPortfolio) ?? null);
  if (selectedPortfolio && portfolio) {
    return (
      <PortfolioDetail
        instanceId={instanceId}
        portfolioId={selectedPortfolio}
        children={portfolio}
        onBack={() => setSelectedPortfolio(null)}
        onSelectChild={(strategyId) => {
          setSelectedPortfolio(null);
          setSelected(strategyId);
        }}
      />
    );
  }

  const portfolioEntries = [...portfolioGroups.entries()];
  const childRows = portfolioEntries.flatMap(([, children]) => children);
  return (
    <div>
      <PageHeader
        title="Strategies"
        sub={`${rows.length} deployed · ${standalone.length} standalone · ${portfolioGroups.size} portfolio${portfolioGroups.size === 1 ? "" : "s"}${retiredCount > 0 ? ` · ${retiredCount} retired` : ""}`}
        right={
          retiredCount > 0 ? (
            <button
              onClick={() => setShowRetired((v) => !v)}
              className="h-8 rounded-lg border border-line bg-raised px-3 text-xs font-semibold text-muted transition hover:border-line-strong hover:text-body"
            >
              {showRetired ? "Hide retired" : `Show ${retiredCount} retired`}
            </button>
          ) : undefined
        }
      />
      <Loadable
        loading={strategies.isPending}
        error={strategies.isError}
        retry={() => strategies.refetch()}
        what="strategies"
      >
        {rows.length === 0 && (
          <Card className="mt-6 p-8 text-center text-faint">
            No strategies yet.
          </Card>
        )}
        {portfolioEntries.length > 0 && (
          <section className="mt-6">
            <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-muted">
              Portfolios
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {portfolioEntries.map(([id, children], i) => {
                const physicalIds = new Set(children.map(physicalPortfolioId).filter((value): value is string => value != null));
                const summary = summarizePortfolio(
                  id,
                  children,
                  live.open,
                  live.hasState,
                );
                return (
                  <button
                    key={id}
                    onClick={() => setSelectedPortfolio(id)}
                    className="group text-left"
                  >
                    <Card
                      className="flex h-full flex-col justify-between p-5 transition group-hover:border-accent/50 group-hover:bg-raised"
                      stagger={i}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 truncate font-bold text-bright">
                          {id}
                        </span>
                        <span className="shrink-0 text-xs text-faint">
                          {age(summary.lastSeen)}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Pill tone="accent">portfolio</Pill>
                        <Pill tone={summary.tradedCount > 0 ? "accent" : undefined}>
                          {summary.tradedCount}/{summary.childCount} traded
                        </Pill>
                        {physicalIds.size > 1 && <Pill>{physicalIds.size} shards</Pill>}
                      </div>
                      <div
                        className="mt-4 flex items-baseline gap-3"
                        title="realized + open P&L attributed to this portfolio's sleeves — not the shared broker account equity"
                      >
                        <span
                          className={`font-mono text-2xl font-semibold ${
                            summary.netPnl == null || live.stale
                              ? "text-faint"
                              : summary.netPnl > 0
                                ? "text-up"
                                : summary.netPnl < 0
                                  ? "text-down"
                                  : "text-bright"
                          }`}
                        >
                          {money(summary.netPnl)}
                        </span>
                        <ReturnPct
                          net={summary.netPnl}
                          base={summary.allocatedCapital}
                          dim={live.stale}
                        />
                      </div>
                    </Card>
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {standalone.length > 0 && (
          <section className="mt-7">
            <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-muted">
              Standalone strategies
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {standalone.map((s, i) => {
                const realized = s.realizedNet;
                const open =
                  live.open.get(s.strategyId) ?? (live.hasState ? 0 : null);
                const net =
                  realized == null && open == null
                    ? null
                    : (realized ?? 0) + (open ?? 0);
                return (
                  <StrategyCard
                    key={s.strategyId}
                    row={s}
                    net={net}
                    open={open}
                    liveStale={live.stale}
                    stagger={i}
                    onClick={() => setSelected(s.strategyId)}
                  />
                );
              })}
            </div>
          </section>
        )}
        {childRows.length > 0 && (
          <section className="mt-7">
            <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-muted">
              Portfolio child strategies
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {childRows.map((s, i) => {
                const realized = s.realizedNet;
                const open =
                  live.open.get(s.strategyId) ?? (live.hasState ? 0 : null);
                const net =
                  realized == null && open == null
                    ? null
                    : (realized ?? 0) + (open ?? 0);
                return (
                  <StrategyCard
                    key={s.strategyId}
                    row={s}
                    net={net}
                    open={open}
                    liveStale={live.stale}
                    stagger={i}
                    onClick={() => setSelected(s.strategyId)}
                  />
                );
              })}
            </div>
          </section>
        )}
      </Loadable>
    </div>
  );
}

function StrategyCard({
  row: s,
  net,
  liveStale,
  stagger,
  onClick,
}: {
  row: StrategyRow;
  net: number | null;
  open: number | null;
  liveStale: boolean;
  stagger: number;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="group text-left">
      <Card
        className="flex h-full flex-col justify-between p-5 transition group-hover:border-accent/50 group-hover:bg-raised"
        stagger={stagger}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 truncate font-bold text-bright" title={s.strategyId}>
            {displayName(s)}
          </span>
          <span className="shrink-0 text-xs text-faint">{age(s.lastSeen)}</span>
        </div>
        <div
          className="mt-4 flex items-baseline gap-3"
          title="net P&L = realized + open (this strategy, on a shared account)"
        >
          <span
            className={`font-mono text-2xl font-semibold ${net == null || liveStale ? "text-faint" : net >= 0 ? "text-up" : "text-down"}`}
          >
            {net == null
              ? "—"
              : `${net >= 0 ? "+" : "−"}${money(Math.abs(net))}`}
          </span>
          <ReturnPct net={net} base={s.startingBalance} dim={liveStale} />
        </div>
      </Card>
    </button>
  );
}

function PortfolioDetail({
  instanceId,
  portfolioId: id,
  children,
  onBack,
  onSelectChild,
}: {
  instanceId: string;
  portfolioId: string;
  children: StrategyRow[];
  onBack: () => void;
  onSelectChild: (strategyId: string) => void;
}) {
  const live = useOpenByStrategy(instanceId);
  const state = useLiveState();
  const summary = summarizePortfolio(id, children, live.open, live.hasState);
  const accounts = (state.data?.accounts ?? []).filter(
    (account) => account.instanceId === instanceId,
  );
  const account = accounts.length === 1 ? accounts[0] : null;
  return (
    <div>
      <button
        onClick={onBack}
        className="rise text-sm text-muted transition hover:text-body"
      >
        ← strategies
      </button>
      <PageHeader
        title={id}
        sub={`${summary.childCount} child strategies · ${summary.dealCount} attributed deals`}
        right={<Pill tone="accent">portfolio</Pill>}
      />
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Allocated capital"
          value={money(summary.allocatedCapital)}
          sub={`${summary.tradedCount}/${summary.childCount} sleeves traded`}
        />
        <Stat
          label="Net P&L"
          value={money(summary.netPnl)}
          tone={
            summary.netPnl == null
              ? "neutral"
              : summary.netPnl >= 0
                ? "up"
                : "down"
          }
          sub="realized + open"
        />
        <Stat
          label="Realized"
          value={money(summary.realizedPnl)}
          tone={summary.realizedPnl >= 0 ? "up" : "down"}
          sub="closed child deals"
        />
        <Stat
          label="Open"
          value={money(summary.openPnl)}
          tone={
            summary.openPnl == null
              ? "neutral"
              : summary.openPnl >= 0
                ? "up"
                : "down"
          }
          sub={live.stale ? "broker state stale" : "attributed positions"}
        />
        <Stat
          label="Allocated capital"
          value={money(summary.allocatedCapital)}
          sub="sum of child allocations"
        />
        <Stat
          label="Broker account equity"
          value={money(account?.equity)}
          sub={
            account
              ? `${account.broker} · shared account`
              : accounts.length > 1
                ? "multiple broker accounts"
                : "account state unavailable"
          }
        />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Panel
          title="Child contribution"
          hint="click a strategy for full analytics"
        >
          <div className="overflow-x-auto">
            <Table
              head={[
                "Strategy",
                "Allocation",
                "Weight",
                "Realized",
                "Open",
                "Net",
                "Deals",
                "Last seen",
              ]}
            >
              {children.map((child) => {
                const allocation =
                  metaNumber(child.metadata, "allocatedCapital") ??
                  child.startingBalance;
                const weight = metaNumber(child.metadata, "portfolioWeight");
                const open =
                  live.open.get(child.strategyId) ?? (live.hasState ? 0 : null);
                const net =
                  open == null ? null : (child.realizedNet ?? 0) + open;
                return (
                  <Row
                    key={child.strategyId}
                    onClick={() => onSelectChild(child.strategyId)}
                  >
                    <Cell>
                      <div className="font-semibold text-bright" title={child.strategyId}>
                        {displayName(child)}
                      </div>
                      {portfolioAlias(child) && (
                        <div className="text-xs text-faint">
                          {portfolioAlias(child)}
                        </div>
                      )}
                    </Cell>
                    <Cell className="font-mono">{money(allocation)}</Cell>
                    <Cell className="font-mono">{pct(weight)}</Cell>
                    <Cell className="font-mono">
                      {money(child.realizedNet ?? 0)}
                    </Cell>
                    <Cell className="font-mono">{money(open)}</Cell>
                    <Cell
                      className={`font-mono font-semibold ${net == null || live.stale ? "text-faint" : net >= 0 ? "text-up" : "text-down"}`}
                    >
                      {money(net)}
                    </Cell>
                    <Cell className="font-mono">{child.dealCount}</Cell>
                    <Cell className="whitespace-nowrap text-faint">
                      {age(child.lastSeen)}
                    </Cell>
                  </Row>
                );
              })}
            </Table>
          </div>
        </Panel>
        <Panel title="Broker accounts" hint="shared venue truth">
          <Table head={["Broker", "Currency", "Balance", "Equity"]}>
            {accounts.length === 0 && (
              <Empty colSpan={4}>Account state unavailable.</Empty>
            )}
            {accounts.map((a) => (
              <Row key={`${a.broker}:${a.login ?? ""}:${a.server ?? ""}`}>
                <Cell>
                  <span className="font-semibold text-bright">{a.broker}</span>
                  {a.stale && <div className="text-xs text-warn">stale</div>}
                </Cell>
                <Cell className="font-mono">{a.currency}</Cell>
                <Cell className="font-mono">{money(a.balance)}</Cell>
                <Cell className="font-mono">{money(a.equity)}</Cell>
              </Row>
            ))}
          </Table>
        </Panel>
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
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId)}`),
    refetchInterval: 10000,
  });

  const live = useOpenByStrategy(instanceId);
  const row = (strategies.data ?? []).find((r) => r.strategyId === strategyId);
  const metadata = row?.metadata ?? null;
  const sourcePath = metaString(metadata, "sourcePath");
  const sourceHash = metaString(metadata, "sourceSha256");
  const parentPortfolio = metaString(metadata, "portfolioId");
  const parentAlias = metaString(metadata, "portfolioAlias");
  const allocatedCapital = metaNumber(metadata, "allocatedCapital");
  const portfolioWeight = metaNumber(metadata, "portfolioWeight");
  const streams = Array.isArray(metadata?.streams) ? metadata.streams as Array<Record<string, unknown>> : [];

  const s = stats.data;
  const openPnl = live.open.get(strategyId) ?? (live.hasState ? 0 : null);
  const heroNet = s?.realizedPnl == null && openPnl == null ? null : (s?.realizedPnl ?? 0) + (openPnl ?? 0);
  // Closed trades rebuilt from broker deals (realized P&L built in) are the row
  // source whenever the strategy has any; engine fills are the paper/backtest fallback.
  const closes = performance.data?.closes ?? [];
  const closeByOrder = buildCloseMap(closes);
  const usingDealTrades = closes.length > 0;
  const tradeNeedle = tradeQ.trim().toUpperCase();
  const tradeRows: TradeView[] = (usingDealTrades
    ? closes.map((c) => ({ key: `${c.orderId ?? "?"}-${c.ts}`, ts: c.ts, symbol: c.symbol, side: c.side, qty: c.qty, price: c.price, realized: c.realized, searchKey: c.orderId ?? "", raw: null }))
    : (trades.data ?? []).map((t) => ({ key: t.id, ts: t.ts, symbol: t.payload.symbol, side: t.payload.side, qty: t.payload.qty, price: t.payload.price, realized: closeByOrder.get(t.payload.orderId)?.realized ?? null, searchKey: t.payload.orderId, raw: t })))
    .filter((t) => (!tradeSide || t.side === tradeSide) && (!tradeNeedle || t.symbol.toUpperCase().includes(tradeNeedle) || t.searchKey.toUpperCase().includes(tradeNeedle)))
    .sort((a, b) => {
      switch (tradeSort) {
        case "oldest": return a.ts - b.ts;
        case "qty": return b.qty - a.qty;
        case "price": return b.price - a.price;
        case "pnl": return (b.realized ?? -Infinity) - (a.realized ?? -Infinity);
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
          <h2 className="text-2xl font-extrabold tracking-tight text-bright" title={strategyId}>{row ? displayName(row) : strategyId}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {parentPortfolio ? (
              <>
                <Pill tone="info">portfolio child</Pill>
                <Pill>{parentPortfolio}</Pill>
                {parentAlias && <Pill>{parentAlias}</Pill>}
              </>
            ) : (
              <Pill>standalone</Pill>
            )}
          </div>
          <div className="mt-2 flex items-baseline gap-3" title="net P&L = realized + open (this strategy, on a shared account)">
            <span className={`font-mono text-4xl font-bold ${heroNet == null || live.stale ? "text-faint" : heroNet >= 0 ? "text-up" : "text-down"}`}>
              {heroNet == null ? "—" : `${heroNet >= 0 ? "+" : "−"}${money(Math.abs(heroNet))}`}
            </span>
            <ReturnPct net={heroNet} base={s?.startingBalance} dim={live.stale} />
          </div>
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">net P&L · this strategy</div>
          <div className={`mt-1 text-xs ${live.stale ? "text-faint" : "text-muted"}`}>
            realized {money(s?.realizedPnl)} · open {money(openPnl)} · notional {money(s?.startingBalance)}
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
            {performance.data && <TradeAnalysisPanels bundle={performance.data} />}
            {performance.data && <EdgeDetailPanels bundle={performance.data} />}
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

      {metadata && (
        <Panel className="mt-6" stagger={1} title="Runtime" hint="from latest strategy.started event">
          <Table head={["Field", "Value"]}>
            <Row>
              <Cell className="text-muted">Mode</Cell>
              <Cell className="font-mono">{metaString(metadata, "runtimeMode") ?? "—"}</Cell>
            </Row>
            <Row>
              <Cell className="text-muted">Role</Cell>
              <Cell className="font-mono">{parentPortfolio ? "portfolio child" : "standalone"}</Cell>
            </Row>
            {parentPortfolio && (
              <Row>
                <Cell className="text-muted">Portfolio</Cell>
                <Cell className="font-mono">
                  {parentPortfolio}{parentAlias ? ` / ${parentAlias}` : ""}
                </Cell>
              </Row>
            )}
            {parentPortfolio && (
              <Row>
                <Cell className="text-muted">Allocation</Cell>
                <Cell className="font-mono">
                  {allocatedCapital == null ? "—" : money(allocatedCapital)}{portfolioWeight == null ? "" : ` · ${(portfolioWeight * 100).toFixed(2)}%`}
                </Cell>
              </Row>
            )}
            <Row>
              <Cell className="text-muted">DSL version</Cell>
              <Cell className="font-mono">{metaNumber(metadata, "dslVersion") ?? "—"}</Cell>
            </Row>
            <Row>
              <Cell className="text-muted">Source</Cell>
              <Cell className="font-mono">
                <span title={sourcePath ?? undefined}>{sourceName(sourcePath) ?? "—"}</span>
              </Cell>
            </Row>
            <Row>
              <Cell className="text-muted">Source hash</Cell>
              <Cell className="font-mono">
                <span title={sourceHash ?? undefined}>{sourceHash ? sourceHash.slice(0, 12) : "—"}</span>
              </Cell>
            </Row>
            <Row>
              <Cell className="text-muted">Brokers</Cell>
              <Cell className="font-mono">{metaStringList(metadata, "brokers").join(", ") || "paper"}</Cell>
            </Row>
            <Row>
              <Cell className="text-muted">Symbols</Cell>
              <Cell className="font-mono">{metaStringList(metadata, "symbols").join(", ") || "—"}</Cell>
            </Row>
            <Row>
              <Cell className="text-muted">Streams</Cell>
              <Cell className="font-mono">
                {streams.length === 0
                  ? "—"
                  : streams.map((s) => `${String(s.alias ?? "?")}:${String(s.qktSymbol ?? s.symbol ?? "?")}@${String(s.timeframe ?? "?")}`).join(", ")}
              </Cell>
            </Row>
          </Table>
        </Panel>
      )}

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
          hint={usingDealTrades ? "broker deal closes" : "click a row to inspect"}
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
          <Loadable loading={!performance.data && trades.isPending} error={trades.isError} retry={() => { void trades.refetch(); void performance.refetch(); }} what="trades">
          <Table>
            {tradeRows.slice(0, tradeCap).map((t) => {
              const raw = t.raw;
              const r = t.realized;
              const rcls = r == null ? "text-faint" : r > 0 ? "text-up" : r < 0 ? "text-down" : "text-muted";
              return (
                <Row key={t.key} onClick={raw ? () => setOpenTrade(raw) : undefined}>
                  <Cell className="whitespace-nowrap text-muted">{tsDay(t.ts)}</Cell>
                  <Cell className="font-semibold text-bright">{t.symbol}</Cell>
                  <Cell>
                    <SideTag side={t.side} />
                  </Cell>
                  <Cell className="font-mono">{t.qty}</Cell>
                  <Cell className="font-mono text-muted">@ {t.price}</Cell>
                  <Cell className={`font-mono font-semibold ${rcls}`}>{r == null ? "—" : `${r > 0 ? "+" : ""}${r.toFixed(2)}`}</Cell>
                </Row>
              );
            })}
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
