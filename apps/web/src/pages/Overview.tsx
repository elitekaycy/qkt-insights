import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type DayNet, type EquityPoint, type HealthRow, type PerformanceBundle, type StrategyRow, type StrategyStats } from "../api";
import type { ComparisonSeries } from "../components/EquityChart";
import { OverviewDashboard } from "../components/OverviewDashboard";
import { Sparkline } from "../components/Sparkline";
import { Card, Cell, Empty, FlashValue, LiveDot, Loadable, PageHeader, Panel, Pill, ReturnPct, Row, SideTag, Stat, Table } from "../components/ui";
import { age, money, num, pct } from "../format";
import { useLiveState } from "../useLiveState";
import { useLiveStream } from "../useLiveStream";

const PALETTE = ["#c8f74a", "#5cb8ff", "#a78bfa", "#3fe08c", "#fbbf24", "#ff6b6b", "#f472b6", "#22d3ee"];

// Overview only needs broker state pushes for live account/position truth; raw
// event inspection belongs on Logs/Search so payloads cannot stretch the layout.
const FEED_TYPES = ["state.account", "state.positions"];

function aggregateDaily(rows: DayNet[]): DayNet[] {
  const byDay = new Map<string, DayNet>();
  for (const row of rows) {
    const current = byDay.get(row.day) ?? { day: row.day, net: 0, trades: 0 };
    current.net += row.net;
    current.trades += row.trades;
    byDay.set(row.day, current);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function aggregateRiskCap(rows: StrategyRow[], keys: string[]): number | null {
  let cap = 0;
  let found = false;
  for (const row of rows) {
    if (row.startingBalance == null || row.startingBalance <= 0 || row.metadata == null) continue;
    const risk = row.metadata.risk;
    const sources = [row.metadata, risk && typeof risk === "object" ? risk as Record<string, unknown> : null];
    let raw: number | null = null;
    for (const source of sources) {
      if (!source) continue;
      for (const key of keys) {
        const value = source[key];
        const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) { raw = parsed; break; }
      }
      if (raw != null) break;
    }
    if (raw == null) continue;
    const fraction = raw <= 1 ? raw : raw / 100;
    cap += row.startingBalance * fraction;
    found = true;
  }
  return found ? cap : null;
}

export default function Overview({
  instanceId,
  onOpenStrategy,
}: {
  instanceId: string | null;
  onOpenStrategy: (strategyId: string) => void;
}) {
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 10000,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => get<HealthRow[]>("/health/instances"),
    refetchInterval: 5000,
  });

  const rows = strategies.data ?? [];
  const ids = rows.map((s) => s.strategyId);

  const curves = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["equity", instanceId, id],
      queryFn: () =>
        get<EquityPoint[]>(`/equity?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 10000,
    })),
  });
  const stats = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["stats", instanceId, id],
      queryFn: () =>
        get<StrategyStats>(`/stats?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 10000,
    })),
  });

  const live = useLiveStream(instanceId, 40, FEED_TYPES);
  const liveState = useLiveState(live);
  // One bounded bundle per strategy feeds every account-level review widget.
  const perf = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["perf-daily", instanceId, id],
      queryFn: () =>
        get<Partial<PerformanceBundle>>(`/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}&include=dailyNets,report,closes,normalized,excursions,execution`),
      refetchInterval: 60000,
    })),
  });

  if (!instanceId) {
    return (
      <Card className="p-10 text-center text-muted">
        No instances reporting yet — enable the insights block on a qkt instance and it will appear here.
      </Card>
    );
  }

  const accounts = (liveState.data?.accounts ?? []).filter((a) => a.instanceId === instanceId);
  const brokerPositions = (liveState.data?.positions ?? []).filter((p) => p.instanceId === instanceId);

  // Live truth: account figures summed across brokers, open P&L attributed per strategy.
  const accountEquity = accounts.length > 0 ? accounts.reduce((a, x) => a + x.equity, 0) : null;
  const accountBalance = accounts.length > 0 ? accounts.reduce((a, x) => a + x.balance, 0) : null;
  const accountOpenPnl = accounts.length > 0 ? accounts.reduce((a, x) => a + (x.openProfit ?? 0), 0) : null;
  const positionsStale = brokerPositions.length > 0 && brokerPositions.every((g) => g.stale);
  const openByStrategy = new Map<string, number>();
  for (const g of brokerPositions)
    for (const p of g.list)
      if (p.strategyId) openByStrategy.set(p.strategyId, (openByStrategy.get(p.strategyId) ?? 0) + (p.profit ?? 0));

  // Per-strategy slice of everything the stat cards aggregate, for their breakdown modals.
  const perStrategy = ids.map((id, i) => {
    const row = rows[i]!;
    const realized = row.realizedNet ?? stats[i]?.data?.realizedPnl ?? null;
    const open = openByStrategy.get(id) ?? (brokerPositions.length > 0 ? 0 : null);
    const net = realized == null && open == null ? null : (realized ?? 0) + (open ?? 0);
    return {
      id,
      row,
      stats: stats[i]?.data,
      realized,
      open,
      net,
    };
  });
  const totalAllocated = rows.reduce((a, s) => a + (s.startingBalance ?? 0), 0);
  const combinedDaily = aggregateDaily(perf.flatMap((q) => q.data?.dailyNets ?? []));
  const combinedCloses = perf.flatMap((q) => q.data?.closes ?? []);
  const reports = perf.flatMap((q) => q.data?.report ? [q.data.report] : []);
  const normalized = perf.flatMap((q) => q.data?.normalized ? [q.data.normalized] : []);
  const excursions = perf.flatMap((q) => q.data?.excursions ? [q.data.excursions] : []);
  const execution = perf.flatMap((q) => q.data?.execution ? [q.data.execution] : []);
  const dailyLossCap = aggregateRiskCap(rows, ["maxDailyDrawdownPct", "maxDailyLossPct", "max_daily_drawdown_pct"]);
  const drawdownCap = aggregateRiskCap(rows, ["maxDrawdownPct", "max_drawdown_pct"]);

  const series: ComparisonSeries[] = ids
    .map((id, i) => {
      const pts = curves[i]?.data ?? [];
      const base = pts[0]?.equity;
      return {
        strategyId: id,
        color: PALETTE[i % PALETTE.length]!,
        points: base ? pts.map((p) => ({ ts: p.ts, pct: (p.equity / base - 1) * 100 })) : [],
      };
    })
    .filter((s) => s.points.length > 0);

  return (
    <div>
      <PageHeader title="Overview" sub={`Everything ${instanceId} is doing, right now.`} />

      <div className="mt-6">
        <div className="rise flex items-baseline justify-between" style={{ "--stagger": 0 } as React.CSSProperties}>
          <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-body">Account</h3>
          <span className="text-xs text-faint">broker-reported, whole account</span>
        </div>
        <Loadable
          loading={liveState.isPending}
          error={liveState.isError}
          retry={() => liveState.refetch()}
          what="broker account state"
          lines={2}
        >
        {accounts.length === 0 && (
          <Card className="mt-3 p-8 text-center text-faint" stagger={0}>
            No broker account state yet — waiting for the state poller.
          </Card>
        )}
        {accounts.map((a) => (
          <div key={`${a.instanceId}:${a.broker}`} className={`mt-3 ${a.stale ? "opacity-50" : ""}`}>
            <div className="flex flex-wrap items-center gap-2.5">
              <LiveDot on={!a.stale} />
              <span className="font-semibold text-bright">{a.broker}</span>
              <Pill>{a.currency}</Pill>
              {a.login && <span className="font-mono text-xs text-faint">#{a.login}</span>}
              {a.server && <span className="text-xs text-faint">{a.server}</span>}
              {a.name && <span className="text-xs text-muted">{a.name}</span>}
              {a.stale && <Pill>stale {Math.max(0, Math.floor((Date.now() - a.lastSeen) / 1000))}s</Pill>}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Balance" value={money(a.balance)} sub={a.currency} stagger={0} />
              <Stat label="Equity" value={<FlashValue value={a.equity}>{money(a.equity)}</FlashValue>} stagger={0} />
              <Stat
                label="Open P&L"
                value={<FlashValue value={a.openProfit}>{money(a.openProfit)}</FlashValue>}
                tone={a.openProfit == null ? "neutral" : a.openProfit > 0 ? "up" : a.openProfit < 0 ? "down" : "neutral"}
                stagger={1}
              />
              <Stat
                label="Margin level"
                value={a.marginLevel == null ? "—" : `${num(a.marginLevel)}%`}
                sub={a.margin != null ? `margin ${money(a.margin)}` : undefined}
                stagger={1}
              />
            </div>
          </div>
        ))}
        </Loadable>
        <div className="mt-4">
          <Panel stagger={1} title="Open positions" hint="live broker tickets, broker-valued" scroll="max-h-[22rem]">
            <Loadable
              loading={liveState.isPending}
              error={liveState.isError}
              retry={() => liveState.refetch()}
              what="open positions"
            >
            <Table head={["Ticket", "Symbol", "Side", "Qty", "Entry", "Current", "Profit", "Swap", "Strategy"]}>
              {brokerPositions.flatMap((g) =>
                g.list.map((p) => (
                  <Row key={`${g.broker}-${p.ticket}`}>
                    <Cell className="font-mono text-xs text-faint">{p.ticket}</Cell>
                    <Cell className="font-semibold text-bright">{p.symbol}</Cell>
                    <Cell>
                      <SideTag side={p.side} />
                    </Cell>
                    <Cell className="font-mono">{p.qty}</Cell>
                    <Cell className="font-mono text-muted">@ {p.entryPrice}</Cell>
                    <Cell className="font-mono">{p.currentPrice ?? "—"}</Cell>
                    <Cell
                      className={`font-mono font-semibold ${p.profit == null ? "text-faint" : p.profit > 0 ? "text-up" : p.profit < 0 ? "text-down" : "text-muted"}`}
                    >
                      <FlashValue value={p.profit}>
                        {p.profit == null ? "—" : `${p.profit > 0 ? "+" : ""}${p.profit.toFixed(2)}`}
                      </FlashValue>
                    </Cell>
                    <Cell className="font-mono text-muted">{p.swap ?? "—"}</Cell>
                    <Cell>{p.strategyId ? p.strategyId : <Pill>unattributed</Pill>}</Cell>
                  </Row>
                )),
              )}
              {brokerPositions.every((g) => g.list.length === 0) && (
                <Empty colSpan={9}>
                  {brokerPositions.length === 0 ? "No broker state yet." : "Flat — no open broker positions."}
                </Empty>
              )}
            </Table>
            </Loadable>
          </Panel>
        </div>
      </div>

      <Loadable
        loading={rows.length > 0 && (perf.some((query) => query.isPending) || curves.some((query) => query.isPending))}
        error={perf.some((query) => query.isError) || curves.some((query) => query.isError)}
        retry={() => { void Promise.all([...perf, ...curves].map((query) => query.refetch())); }}
        what="overview analysis"
        lines={8}
      >
        <OverviewDashboard
          data={{
            instanceId,
            dailyNets: combinedDaily,
            closes: combinedCloses,
            reports,
            normalized,
            excursions,
            execution,
            series,
            accountEquity,
            accountBalance,
            accountOpenPnl,
            totalAllocated,
            dailyLossCap,
            drawdownCap,
            health: health.data?.find((h) => h.instanceId === instanceId) ?? null,
            recentStateEvents: live.length,
            strategies: rows.length,
          }}
        />
      </Loadable>

      <div className="mt-8">
        <div className="rise flex items-baseline justify-between" style={{ "--stagger": 3 } as React.CSSProperties}>
          <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-body">Strategies</h3>
          <span className="text-xs text-faint">click one to drill in</span>
        </div>
        <Loadable loading={strategies.isPending} error={strategies.isError} retry={() => strategies.refetch()} what="strategies">
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.length === 0 && <Card className="p-8 text-center text-faint md:col-span-2 xl:col-span-3">No strategies yet.</Card>}
          {rows.map((s, i) => {
            const st = stats[i]?.data;
            const pts = curves[i]?.data ?? [];
            const p = perStrategy[i]!;
            return (
              <button key={s.strategyId} onClick={() => onOpenStrategy(s.strategyId)} className="group text-left">
                <Card
                  className="p-5 transition group-hover:border-accent/50 group-hover:bg-raised"
                  stagger={4 + i}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-bold text-bright">{s.strategyId}</span>
                    <span className="text-xs text-faint">{age(s.lastSeen)}</span>
                  </div>
                  <div className="mt-2.5 flex items-baseline gap-3" title="net P&L = realized + open (this strategy, on a shared account)">
                    <span className={`font-mono text-2xl font-semibold ${p.net == null || positionsStale ? "text-faint" : p.net >= 0 ? "text-up" : "text-down"}`}>
                      {p.net == null ? "—" : `${p.net >= 0 ? "+" : "−"}${money(Math.abs(p.net))}`}
                    </span>
                    <ReturnPct net={p.net} base={p.row.startingBalance} dim={positionsStale} />
                  </div>
                  <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">net P&L · notional {money(p.row.startingBalance)}</div>
                  <div className={`mt-1 text-xs ${positionsStale ? "text-faint" : "text-muted"}`}>
                    realized {money(p.realized)} · open {money(p.open)}
                  </div>
                  <div className="mt-2 -mx-1">
                    <Sparkline points={pts} />
                  </div>
                  <div className="mt-2 flex gap-4 text-xs text-muted">
                    <span>
                      win <span className="font-mono text-body">{pct(st?.winRate)}</span>
                    </span>
                    <span>
                      sharpe <span className="font-mono text-body">{num(st?.sharpe)}</span>
                    </span>
                    <span>
                      trades <span className="font-mono text-body">{st?.tradeCount ?? "—"}</span>
                    </span>
                  </div>
                </Card>
              </button>
            );
          })}
        </div>
        </Loadable>
      </div>

      <div className="mt-8">
        <Panel stagger={6} title="Instances" hint="every qkt box the collector has heard from">
          <Loadable loading={health.isPending} error={health.isError} retry={() => health.refetch()} what="instance health" lines={1}>
          <div className="flex flex-wrap gap-3 p-4">
            {(health.data ?? []).length === 0 && <Empty>No instances reporting yet</Empty>}
            {(health.data ?? []).map((h) => {
              const fresh = Date.now() - h.lastSeen < 30_000;
              return (
                <div key={h.instanceId} className="flex items-center gap-3 rounded-lg border border-line bg-raised px-4 py-2.5">
                  <LiveDot on={fresh} />
                  <span className="font-semibold text-bright">{h.instanceId}</span>
                  <span className="text-xs text-muted">{age(h.lastSeen)}</span>
                  <span className="font-mono text-xs text-faint">seq {h.lastSeq}</span>
                  <Pill tone={fresh ? "up" : "neutral"}>{fresh ? "live" : "idle"}</Pill>
                </div>
              );
            })}
          </div>
          </Loadable>
        </Panel>
      </div>
    </div>
  );
}
