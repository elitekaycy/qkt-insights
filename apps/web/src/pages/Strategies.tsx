import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, MIN_RATIO_DAYS, type EquityPoint, type LogRow, type PerformanceBundle, type StrategyRow, type StrategyStats, type TradeRow, type TradeView } from "../api";
import { CalendarView } from "../components/Calendar";
import { TradeDetail } from "../components/detail";
import { EquityChart } from "../components/EquityChart";
import { EdgeDetailPanels, PerformancePanels, TradeAnalysisPanels } from "../components/Performance";
import { Sparkline } from "../components/Sparkline";
import {
  Card, Cell, DataList, Empty, Field, IconButton, Loadable, LoadMore, Modal, PageHeader, Panel, Pill, Pnl, Popover, RangeSelect, rangeStart, ReturnPct, Row, SearchInput, Select, SideTag, Stat, Table, TimeCell,
  type RangeKey,
} from "../components/ui";
import { LogLine } from "../components/LogLine";
import { age, count, money, num, openPnl, pct, price, quantity, signedMoney, ts, tsShort } from "../format";
import { buildCloseMap } from "../useCloses";
import { useLiveState } from "../useLiveState";
import { physicalPortfolioId, portfolioGroupId, strategyCapital, strategyDisplayName as displayName, summarizePortfolio } from "../portfolio";
import { ShareControl } from "../components/ShareControl";
import { usePublicPageView, useView } from "../view";
import { haltClearing, haltSummary, resumeCommand } from "../halt";

/** The strategy page keeps only the latest log lines; the Logs page holds the history. */
const RECENT_LOGS = 7;

/**
 * Open P&L per strategy from the live broker positions of one instance, with a staleness flag.
 * Shared links receive it already summed per strategy, as marked at their delayed cutoff.
 */
function useOpenByStrategy(instanceId: string | null) {
  const view = useView();
  const liveState = useLiveState();
  if (view.public) {
    const delayed = liveState.data?.openByStrategy;
    return { open: new Map(Object.entries(delayed ?? {})), hasState: delayed != null, stale: false };
  }
  const groups = (liveState.data?.positions ?? []).filter((g) => g.instanceId === instanceId);
  const open = new Map<string, number>();
  for (const g of groups)
    for (const p of g.list)
      if (p.strategyId) open.set(p.strategyId, (open.get(p.strategyId) ?? 0) + openPnl(p));
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
  const view = useView();
  const [selected, setSelected] = useState<string | null>(focus);
  const [selectedPortfolio, setSelectedPortfolio] = useState<string | null>(null);
  usePublicPageView(selected || selectedPortfolio ? null : "strategies");
  const [showRetired, setShowRetired] = useState(false);

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
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
          retiredCount > 0 && !view.public ? (
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
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">
              Portfolios
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {portfolioEntries.map(([id, children]) => {
                const physicalIds = new Set(children.map(physicalPortfolioId).filter((value): value is string => value != null));
                const haltedCount = children.filter((child) => child.halted).length;
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
                     
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 truncate font-semibold text-bright">
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
                        {haltedCount > 0 && (
                          <span title="sleeves the engine has halted; open the portfolio for each reason">
                            <Pill tone="warn">{haltedCount} halted</Pill>
                          </span>
                        )}
                      </div>
                      <div
                        className="mt-4 flex items-baseline gap-3"
                        title="realized + open P&L attributed to this portfolio's sleeves — not the shared broker account equity"
                      >
                        <Pnl value={summary.netPnl} dim={live.stale} className="text-xl font-headline" />
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
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">
              Standalone strategies
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {standalone.map((s) => {
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
                   
                    onClick={() => setSelected(s.strategyId)}
                  />
                );
              })}
            </div>
          </section>
        )}
        {childRows.length > 0 && (
          <section className="mt-7">
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">
              Portfolio child strategies
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {childRows.map((s) => {
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
  onClick,
}: {
  row: StrategyRow;
  net: number | null;
  open: number | null;
  liveStale: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="group text-left">
      <Card className="flex h-full flex-col justify-between p-4 transition group-hover:border-line-strong">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 truncate font-semibold text-bright" title={s.strategyId}>
            {displayName(s)}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <HaltBadge row={s} />
            <span className="text-xs text-faint">{age(s.lastSeen)}</span>
          </span>
        </div>
        <div
          className="mt-4 flex items-baseline gap-3"
          title="net P&L = realized + open (this strategy, on a shared account)"
        >
          <Pnl value={net} dim={liveStale} className="text-xl font-headline" />
          <ReturnPct net={net} base={strategyCapital(s).amount} dim={liveStale} />
        </div>
      </Card>
    </button>
  );
}

/** Engine risk halt on a strategy row: tap or click for the reason, how it ends and the resume command. */
function HaltBadge({ row }: { row: StrategyRow }) {
  const summary = haltSummary(row);
  if (!summary) return null;
  return (
    <Popover label="Why this strategy is halted" align="right" trigger={<Pill tone="warn">halted</Pill>}>
      {summary}
    </Popover>
  );
}

/** The halt spelled out on the strategy page, where a tooltip alone would not reach touch screens. */
function HaltDetail({ row }: { row: StrategyRow }) {
  const command = resumeCommand(row);
  return (
    <div className="mt-2 flex max-w-xl flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="font-semibold text-warn">Halted: {row.haltReason ?? "no reason given"}</span>
      {row.haltedAt != null && <span className="text-muted">since {ts(row.haltedAt)} UTC · {age(row.haltedAt)}</span>}
      <span className="text-muted">{haltClearing(row)}</span>
      {command && <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-body">{command}</span>}
    </div>
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
  /** Absent on a shared portfolio link, which has nowhere to go back to. */
  onBack?: () => void;
  onSelectChild: (strategyId: string) => void;
}) {
  const view = useView();
  usePublicPageView("portfolio");
  const live = useOpenByStrategy(instanceId);
  const state = useLiveState();
  const summary = summarizePortfolio(id, children, live.open, live.hasState);
  const accounts = (state.data?.accounts ?? []).filter(
    (account) => account.instanceId === instanceId,
  );
  const account = accounts.length === 1 ? accounts[0] : null;
  return (
    <div>
      {onBack && (
        <button
          onClick={onBack}
          className="text-sm text-muted transition hover:text-body"
        >
          ← strategies
        </button>
      )}
      <PageHeader
        title={id}
        sub={`${summary.childCount} child strategies · ${summary.dealCount} attributed deals`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <ShareControl instanceId={instanceId} kind="portfolio" subject={id} />
            <Pill tone="accent">portfolio</Pill>
          </div>
        }
      />
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Allocated capital"
          value={money(summary.allocatedCapital)}
          sub={`sum of child allocations · ${summary.tradedCount}/${summary.childCount} sleeves traded`}
        />
        <Stat
          label="Net P&L"
          signed={summary.netPnl}
          sub="realized + open"
        />
        <Stat
          label="Realized"
          signed={summary.realizedPnl}
          sub="closed child deals"
        />
        <Stat
          label="Open"
          signed={summary.openPnl}
          sub={live.stale ? "broker state stale" : "attributed positions"}
        />
        {!view.public && (
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
        )}
      </div>
      <div className={`mt-6 grid gap-6 ${view.public ? "" : "xl:grid-cols-[2fr_1fr]"}`}>
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
                const allocation = strategyCapital(child).amount;
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
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-bright" title={child.strategyId}>
                          {displayName(child)}
                        </span>
                        <HaltBadge row={child} />
                      </div>
                      {portfolioAlias(child) && (
                        <div className="text-xs text-faint">
                          {portfolioAlias(child)}
                        </div>
                      )}
                    </Cell>
                    <Cell>{money(allocation)}</Cell>
                    <Cell>{pct(weight)}</Cell>
                    <Cell>
                      <Pnl value={child.realizedNet ?? 0} glyphs={false} />
                    </Cell>
                    <Cell>
                      <Pnl value={open} glyphs={false} />
                    </Cell>
                    <Cell className="font-semibold">
                      <Pnl value={net} dim={live.stale} />
                    </Cell>
                    <Cell>{count(child.dealCount)}</Cell>
                    <Cell className="whitespace-nowrap text-faint">
                      {age(child.lastSeen)}
                    </Cell>
                  </Row>
                );
              })}
            </Table>
          </div>
        </Panel>
        {!view.public && (
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
                <Cell>{a.currency}</Cell>
                <Cell>{money(a.balance)}</Cell>
                <Cell>{money(a.equity)}</Cell>
              </Row>
            ))}
          </Table>
        </Panel>
        )}
      </div>
    </div>
  );
}

/** A shared portfolio link: the portfolio page, with its public children one click away. */
export function SharedPortfolio({ instanceId, portfolioId: id }: { instanceId: string; portfolioId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId)}`),
    refetchInterval: 30_000,
  });
  if (selected) return <StrategyDetail instanceId={instanceId} strategyId={selected} onBack={() => setSelected(null)} />;
  return (
    <Loadable loading={strategies.isPending} error={strategies.isError} retry={() => strategies.refetch()} what="the portfolio">
      <PortfolioDetail instanceId={instanceId} portfolioId={id} children={strategies.data ?? []} onSelectChild={setSelected} />
    </Loadable>
  );
}

export function StrategyDetail({ instanceId, strategyId, onBack }: { instanceId: string; strategyId: string; onBack?: () => void }) {
  const view = useView();
  usePublicPageView("strategy", strategyId);
  const qs = `instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`;
  const stats = useQuery({
    queryKey: ["stats", instanceId, strategyId],
    queryFn: () => get<StrategyStats>(`/stats?${qs}`),
    refetchInterval: 30_000,
  });
  const equity = useQuery({
    queryKey: ["equity", instanceId, strategyId],
    queryFn: () => get<EquityPoint[]>(`/equity?${qs}`),
    refetchInterval: 30_000,
  });
  const trades = useQuery({
    queryKey: ["trades", instanceId, strategyId],
    queryFn: () => get<TradeRow[]>(`/trades?${qs}&limit=500`),
    refetchInterval: 30_000,
  });
  const logs = useQuery({
    queryKey: ["logs", instanceId, strategyId],
    queryFn: () => get<LogRow[]>(`/logs?${qs}&limit=${RECENT_LOGS}`),
    enabled: !view.public,
    refetchInterval: 30_000,
  });
  const [tradeCap, setTradeCap] = useState(20);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
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
    refetchInterval: 30_000,
  });
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId)}`),
    refetchInterval: 30_000,
  });

  const live = useOpenByStrategy(instanceId);
  const row = (strategies.data ?? []).find((r) => r.strategyId === strategyId);
  const metadata = row?.metadata ?? null;
  const sourcePath = metaString(metadata, "sourcePath");
  const sourceHash = metaString(metadata, "sourceSha256");
  const parentPortfolio = metaString(metadata, "portfolioId");
  const parentAlias = metaString(metadata, "portfolioAlias");
  const streams = Array.isArray(metadata?.streams) ? metadata.streams as Array<Record<string, unknown>> : [];

  const s = stats.data;
  const capital = row ? strategyCapital(row) : { amount: s?.startingBalance ?? null, source: null };
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
      {onBack && (
        <button onClick={onBack} className="text-sm text-muted transition hover:text-body">
          ← strategies
        </button>
      )}
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div className="">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate text-2xl font-headline tracking-tight text-bright" title={strategyId}>{row ? displayName(row) : strategyId}</h2>
            {metadata && !view.public && (
              <IconButton label="runtime details" onClick={() => setRuntimeOpen(true)} d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            )}
          </div>
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
            {row && <HaltBadge row={row} />}
          </div>
          {row?.halted && <HaltDetail row={row} />}
          <div className="mt-2 flex items-baseline gap-3" title="net P&L = realized + open (this strategy, on a shared account)">
            <Pnl value={heroNet} dim={live.stale} className="text-3xl font-headline" />
            <ReturnPct net={heroNet} base={capital.amount} dim={live.stale} />
          </div>
          <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">net P&L · this strategy</div>
          <div className={`mt-1 text-xs ${live.stale ? "text-faint" : "text-muted"}`}>
            realized {signedMoney(s?.realizedPnl)} · open {signedMoney(openPnl)}
          </div>
        </div>
        <div className="-mb-1 w-64">
          <Sparkline points={equity.data ?? []} height={56} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {(["overview", "performance", "calendar"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`h-9 rounded-lg px-4 text-sm font-semibold capitalize transition ${
              tab === t ? "bg-accent text-on-accent" : "border border-line bg-raised text-muted hover:border-line-strong hover:text-body"
            }`}
          >
            {t}
          </button>
        ))}
        <ShareControl instanceId={instanceId} kind="strategy" subject={strategyId} />
        {tab !== "overview" && (
          <div className="w-full sm:ml-auto sm:w-auto">
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
                returnBase={() => capital.amount}
                baseLabel={capital.source ? `the strategy's ${capital.source}` : "the strategy's capital"}
                trades={tradeRows}
                onTrade={view.public ? undefined : setOpenTrade}
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
        <Stat label="Capital" value={money(capital.amount)} sub={capital.source ?? undefined} />
        <Stat
          label="Realized PnL"
          signed={s?.realizedPnl}
        />
        <Stat
          label="Sharpe"
          value={num(s?.sharpe)}
          sub={s == null ? undefined : s.sharpe == null && s.ratioDays < MIN_RATIO_DAYS ? `needs ${MIN_RATIO_DAYS} days with closes, has ${s.ratioDays}` : `n=${s.ratioDays} days`}
        />
        <Stat label="Win rate" value={pct(s?.winRate)} sub="round trips, breakeven excluded" />
        <Stat label="Max drawdown" value={pct(s?.maxDrawdownPct)} tone={s?.maxDrawdownPct ? "down" : "neutral"} />
        <Stat
          label="Trades"
          value={count(s?.tradeCount)}
          sub={s ? `${s.buyCount} buys · ${s.sellCount} sells · vol ${num(s.volume)}` : undefined}
        />
      </div>
        </Loadable>
      </div>

      <Panel
        className="mt-6"
       
        title="Equity"
        hint="this strategy's capital plus its own P&L — not the shared account equity"
      >
        <Loadable loading={equity.isPending} error={equity.isError} retry={() => equity.refetch()} what="the equity curve" lines={4}>
          <div className="p-4">
            <EquityChart points={equity.data ?? []} />
          </div>
        </Loadable>
      </Panel>

      {/* items-start: each list sizes to its own rows instead of stretching to its neighbour */}
      <div className="mt-6 grid grid-cols-1 items-start gap-6 2xl:grid-cols-2">
        <Panel
         
          title="Trades"
          hint={usingDealTrades ? "broker deal closes" : "click a row to inspect"}
          toolbar={
            <>
              <SearchInput
                value={tradeQ}
                onChange={(e) => {
                  setTradeQ(e.target.value);
                  setTradeCap(20);
                }}
                placeholder="search symbol, order id…"
                className="w-full sm:w-56"
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
          <DataList
            head={["Time (UTC)", "Symbol", "Side", "Qty", "Price", "P&L"]}
            rows={tradeRows.slice(0, tradeCap)}
            keyOf={(t) => t.key}
            onRow={usingDealTrades || view.public ? undefined : (t) => t.raw && setOpenTrade(t.raw)}
            empty="No trades yet"
            cells={(t) => {
              const r = t.realized;
              return (
                <>
                  <TimeCell ts={t.ts} />
                  <Cell className="font-semibold text-bright">{t.symbol}</Cell>
                  <Cell>
                    <SideTag side={t.side} />
                  </Cell>
                  <Cell>{quantity(t.qty)}</Cell>
                  <Cell className="whitespace-nowrap text-muted">@ {price(t.price)}</Cell>
                  <Cell className="font-semibold">
                    <Pnl value={r} glyphs={false} />
                  </Cell>
                </>
              );
            }}
            card={(t) => {
              const r = t.realized;
              return (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate font-semibold text-bright">{t.symbol}</span>
                    <SideTag side={t.side} />
                    <Pnl value={r} glyphs={false} className="ml-auto shrink-0 text-sm font-semibold" />
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-faint">
                    <span className="whitespace-nowrap">
                      {quantity(t.qty)} @ {price(t.price)}
                    </span>
                    <span className="ml-auto whitespace-nowrap">{tsShort(t.ts)} UTC</span>
                  </div>
                </>
              );
            }}
          />
          <LoadMore shown={Math.min(tradeCap, tradeRows.length)} total={tradeRows.length} onMore={() => setTradeCap((c) => c + 20)} />
          </Loadable>
        </Panel>

        {!view.public && (
        <Panel title="Recent logs" hint={`latest ${RECENT_LOGS} · full history on Logs`}>
          <Loadable loading={logs.isPending} error={logs.isError} retry={() => logs.refetch()} what="logs">
          <div className="p-2">
            {logRows.map((l) => (
              <LogLine key={l.id} log={l} showStrategy={false} />
            ))}
            {logRows.length === 0 && <Empty>No logs yet</Empty>}
          </div>
          </Loadable>
        </Panel>
        )}
      </div>
        </>
      )}

      {!view.public && (
        <TradeDetail trade={openTrade} instanceId={instanceId} onClose={() => setOpenTrade(null)} close={openTrade ? closeByOrder.get(openTrade.payload.orderId) : null} />
      )}

      {metadata && !view.public && (
        <Modal open={runtimeOpen} onClose={() => setRuntimeOpen(false)} title="Runtime" hint="from latest strategy.started event" width="min(94vw, 760px)">
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
            <Field label="Mode">{metaString(metadata, "runtimeMode") ?? "—"}</Field>
            <Field label="DSL version">{metaNumber(metadata, "dslVersion") ?? "—"}</Field>
            <Field label="Source" wide>{sourcePath ?? "—"}</Field>
            <Field label="Source hash" wide>{sourceHash ?? "—"}</Field>
            <Field label="Symbols" wide>{metaStringList(metadata, "symbols").join(", ") || "—"}</Field>
            <Field label="Streams" wide>
              {streams.length === 0
                ? "—"
                : streams.map((st) => `${String(st.alias ?? "?")}:${String(st.qktSymbol ?? st.symbol ?? "?")}@${String(st.timeframe ?? "?")}`).join(", ")}
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
