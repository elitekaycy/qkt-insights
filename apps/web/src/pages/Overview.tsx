import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type HealthRow, type OpenPositionRow, type PerformanceBundle, type StrategyRow, type StrategyStats } from "../api";
import { ComparisonChart, type ComparisonSeries } from "../components/EquityChart";
import { Sparkline } from "../components/Sparkline";
import { Card, Cell, Delta, Empty, HoverExpand, LiveDot, Modal, PageHeader, Panel, Pill, QueryError, Row, SideTag, Stat, Table } from "../components/ui";
import { age, money, num, pct, ts } from "../format";
import { useLiveStream } from "../useLiveStream";

const PALETTE = ["#c8f74a", "#5cb8ff", "#a78bfa", "#3fe08c", "#fbbf24", "#ff6b6b", "#f472b6", "#22d3ee"];

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

  const live = useLiveStream(instanceId, 40);
  const [heroOpen, setHeroOpen] = useState(false);

  const positions = useQuery({
    queryKey: ["positions", instanceId],
    queryFn: () => get<OpenPositionRow[]>(`/positions?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 10000,
  });
  const perf = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["performance", instanceId, id, "all"],
      queryFn: () =>
        get<PerformanceBundle>(`/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 15000,
    })),
  });

  if (!instanceId) {
    return (
      <Card className="p-10 text-center text-muted">
        No instances reporting yet — enable the insights block on a qkt instance and it will appear here.
      </Card>
    );
  }

  // Day / week P&L summed across strategies from their daily nets (UTC days).
  const today = new Date().toISOString().slice(0, 10);
  const monday = (() => {
    const d = new Date();
    const dow = (d.getUTCDay() + 6) % 7;
    return new Date(Date.now() - dow * 86_400_000).toISOString().slice(0, 10);
  })();
  // Sums only claim a number once every strategy's bundle has loaded —
  // a partial sum rendered as "$0" reads as a fact, not a gap.
  const perfReady = ids.length === 0 || (perf.length === ids.length && perf.every((q) => q.data));
  let daySum = 0, weekSum = 0;
  for (const q of perf) {
    for (const dn of q.data?.dailyNets ?? []) {
      if (dn.day === today) daySum += dn.net;
      if (dn.day >= monday) weekSum += dn.net;
    }
  }
  const dayPnl = perfReady ? daySum : null;
  const weekPnl = perfReady ? weekSum : null;
  const posRows = positions.data ?? [];

  // Per-strategy slice of everything the stat cards aggregate, for their breakdown modals.
  const perStrategy = ids.map((id, i) => {
    const nets = perf[i]?.data?.dailyNets ?? [];
    const dayRows = nets.filter((dn) => dn.day === today);
    const weekRows = nets.filter((dn) => dn.day >= monday);
    return {
      id,
      row: rows[i]!,
      stats: stats[i]?.data,
      dayNet: dayRows.reduce((a, d) => a + d.net, 0),
      dayTrades: dayRows.reduce((a, d) => a + d.trades, 0),
      weekNet: weekRows.reduce((a, d) => a + d.net, 0),
      weekTrades: weekRows.reduce((a, d) => a + d.trades, 0),
    };
  });
  // Week P&L day-by-day across all strategies.
  const weekDays = (() => {
    const out = new Map<string, { net: number; trades: number }>();
    for (const q of perf)
      for (const dn of q.data?.dailyNets ?? []) {
        if (dn.day < monday) continue;
        const cur = out.get(dn.day) ?? { net: 0, trades: 0 };
        cur.net += dn.net;
        cur.trades += dn.trades;
        out.set(dn.day, cur);
      }
    return [...out.entries()].sort();
  })();

  const pnlBreakdown = (kind: "day" | "week") => (
    <div>
      {kind === "week" && (
        <Table head={["Day", "Net", "Fills"]}>
          {weekDays.map(([day, v]) => (
            <Row key={day}>
              <Cell className="font-mono text-muted">{day}</Cell>
              <Cell className={`font-mono ${v.net > 0 ? "text-up" : v.net < 0 ? "text-down" : "text-muted"}`}>{money(v.net)}</Cell>
              <Cell className="font-mono text-muted">{v.trades}</Cell>
            </Row>
          ))}
          {weekDays.length === 0 && <Empty colSpan={3}>No fills this week yet</Empty>}
        </Table>
      )}
      <div className="border-t border-line px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted first:border-t-0">
        By strategy
      </div>
      <Table head={["Strategy", "Net", "Fills"]}>
        {perStrategy.map((p) => {
          const net = kind === "day" ? p.dayNet : p.weekNet;
          const n = kind === "day" ? p.dayTrades : p.weekTrades;
          return (
            <Row key={p.id} onClick={() => onOpenStrategy(p.id)}>
              <Cell className="font-semibold text-bright">{p.id}</Cell>
              <Cell className={`font-mono ${net > 0 ? "text-up" : net < 0 ? "text-down" : "text-muted"}`}>{money(net)}</Cell>
              <Cell className="font-mono text-muted">{n}</Cell>
            </Row>
          );
        })}
        {perStrategy.length === 0 && <Empty colSpan={3}>No strategies yet</Empty>}
      </Table>
    </div>
  );

  const totalEquity = rows.length > 0 && rows.every((s) => s.equity != null)
    ? rows.reduce((acc, s) => acc + s.equity!, 0) : null;
  const totalStart = rows.length > 0 && rows.every((s) => s.startingBalance != null)
    ? rows.reduce((acc, s) => acc + s.startingBalance!, 0) : null;
  const totalReturn = totalEquity != null && totalStart ? (totalEquity - totalStart) / totalStart : null;
  const statsReady = stats.length === ids.length && stats.every((q) => q.data);
  const totalTrades = statsReady ? stats.reduce((acc, q) => acc + q.data!.tradeCount, 0) : null;
  const realized = statsReady ? stats.reduce((acc, q) => acc + (q.data!.realizedPnl ?? 0), 0) : null;
  const liveInstances = (health.data ?? []).filter((h) => Date.now() - h.lastSeen < 30_000).length;

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
      <QueryError
        on={
          strategies.isError || health.isError || positions.isError ||
          curves.some((q) => q.isError) || stats.some((q) => q.isError) || perf.some((q) => q.isError)
        }
        what="live data"
      />

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="group relative flex flex-col p-6 xl:col-span-2" stagger={0}>
          <HoverExpand label="expand portfolio equity" onClick={() => setHeroOpen(true)} />
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Portfolio equity</div>
              <div className="mt-2 flex items-baseline gap-3">
                <span className="font-mono text-4xl font-bold tracking-tight text-bright sm:text-5xl">{money(totalEquity)}</span>
                <Delta value={totalReturn} />
              </div>
              <div className="mt-1.5 text-sm text-faint">
                {rows.length} strateg{rows.length === 1 ? "y" : "ies"} · from {money(totalStart)} starting capital
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pr-8">
              {series.map((s) => (
                <Pill key={s.strategyId}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.strategyId}
                </Pill>
              ))}
            </div>
          </div>
          <div className="mt-4 min-h-[220px] flex-1">
            <ComparisonChart series={series} height="100%" />
          </div>
        </Card>
        <Modal open={heroOpen} onClose={() => setHeroOpen(false)} title="Portfolio equity" hint={`${money(totalEquity)} across ${rows.length} strategies`}>
          <div className="p-4">
            <ComparisonChart series={series} height={380} />
          </div>
          <Table head={["Strategy", "Equity", "Starting", "Return", "Realized", "Day", "Week"]}>
            {perStrategy.map((p) => {
              const ret = p.row.equity != null && p.row.startingBalance ? (p.row.equity - p.row.startingBalance) / p.row.startingBalance : null;
              return (
                <Row key={p.id} onClick={() => onOpenStrategy(p.id)}>
                  <Cell className="font-semibold text-bright">{p.id}</Cell>
                  <Cell className="font-mono">{money(p.row.equity)}</Cell>
                  <Cell className="font-mono text-muted">{money(p.row.startingBalance)}</Cell>
                  <Cell>
                    <Delta value={ret} />
                  </Cell>
                  <Cell className={`font-mono ${p.stats?.realizedPnl == null ? "text-muted" : p.stats.realizedPnl >= 0 ? "text-up" : "text-down"}`}>{money(p.stats?.realizedPnl)}</Cell>
                  <Cell className={`font-mono ${p.dayNet > 0 ? "text-up" : p.dayNet < 0 ? "text-down" : "text-muted"}`}>{money(p.dayNet)}</Cell>
                  <Cell className={`font-mono ${p.weekNet > 0 ? "text-up" : p.weekNet < 0 ? "text-down" : "text-muted"}`}>{money(p.weekNet)}</Cell>
                </Row>
              );
            })}
          </Table>
        </Modal>

        <div className="grid content-start gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label="Day P&L"
              value={money(dayPnl)}
              tone={dayPnl == null ? "neutral" : dayPnl > 0 ? "up" : dayPnl < 0 ? "down" : "neutral"}
              sub="UTC today"
              stagger={1}
              expand={{ hint: `UTC ${today}`, content: pnlBreakdown("day") }}
            />
            <Stat
              label="Week P&L"
              value={money(weekPnl)}
              tone={weekPnl == null ? "neutral" : weekPnl > 0 ? "up" : weekPnl < 0 ? "down" : "neutral"}
              sub="since Monday"
              stagger={1}
              expand={{ hint: `since ${monday}`, content: pnlBreakdown("week") }}
            />
            <Stat
              label="Realized PnL"
              value={money(realized)}
              tone={realized == null ? "neutral" : realized >= 0 ? "up" : "down"}
              stagger={2}
              expand={{
                hint: "closed P&L per strategy, all time",
                content: (
                  <Table head={["Strategy", "Realized", "Equity", "Return"]}>
                    {perStrategy.map((p) => {
                      const ret = p.row.equity != null && p.row.startingBalance ? (p.row.equity - p.row.startingBalance) / p.row.startingBalance : null;
                      return (
                        <Row key={p.id} onClick={() => onOpenStrategy(p.id)}>
                          <Cell className="font-semibold text-bright">{p.id}</Cell>
                          <Cell className={`font-mono ${p.stats?.realizedPnl == null ? "text-muted" : p.stats.realizedPnl >= 0 ? "text-up" : "text-down"}`}>{money(p.stats?.realizedPnl)}</Cell>
                          <Cell className="font-mono">{money(p.row.equity)}</Cell>
                          <Cell>
                            <Delta value={ret} />
                          </Cell>
                        </Row>
                      );
                    })}
                  </Table>
                ),
              }}
            />
            <Stat
              label="Trades"
              value={totalTrades == null ? "—" : String(totalTrades)}
              stagger={2}
              expand={{
                hint: "fills per strategy",
                content: (
                  <Table head={["Strategy", "Fills", "Buys", "Sells", "Volume"]}>
                    {perStrategy.map((p) => (
                      <Row key={p.id} onClick={() => onOpenStrategy(p.id)}>
                        <Cell className="font-semibold text-bright">{p.id}</Cell>
                        <Cell className="font-mono">{p.stats?.tradeCount ?? "—"}</Cell>
                        <Cell className="font-mono text-up">{p.stats?.buyCount ?? "—"}</Cell>
                        <Cell className="font-mono text-down">{p.stats?.sellCount ?? "—"}</Cell>
                        <Cell className="font-mono text-muted">{num(p.stats?.volume)}</Cell>
                      </Row>
                    ))}
                  </Table>
                ),
              }}
            />
            <Stat
              label="Strategies"
              value={String(rows.length)}
              stagger={3}
              expand={{
                hint: "click one to drill in",
                content: (
                  <Table head={["Strategy", "Equity", "Return", "Win rate", "Sharpe", "Last seen"]}>
                    {perStrategy.map((p) => {
                      const ret = p.row.equity != null && p.row.startingBalance ? (p.row.equity - p.row.startingBalance) / p.row.startingBalance : null;
                      return (
                        <Row key={p.id} onClick={() => onOpenStrategy(p.id)}>
                          <Cell className="font-semibold text-bright">{p.id}</Cell>
                          <Cell className="font-mono">{money(p.row.equity)}</Cell>
                          <Cell>
                            <Delta value={ret} />
                          </Cell>
                          <Cell className="font-mono text-muted">{pct(p.stats?.winRate)}</Cell>
                          <Cell className="font-mono text-muted">{num(p.stats?.sharpe)}</Cell>
                          <Cell className="text-muted">{age(p.row.lastSeen)}</Cell>
                        </Row>
                      );
                    })}
                  </Table>
                ),
              }}
            />
            <Stat
              label="Instances live"
              value={`${liveInstances}/${(health.data ?? []).length}`}
              tone={liveInstances > 0 ? "accent" : "neutral"}
              stagger={3}
              expand={{
                hint: "live = event in the last 30s",
                content: (
                  <Table head={["Instance", "Status", "Last event", "Last seq", "Strategies"]}>
                    {(health.data ?? []).map((h) => {
                      const fresh = Date.now() - h.lastSeen < 30_000;
                      return (
                        <Row key={h.instanceId}>
                          <Cell className="font-semibold text-bright">
                            <span className="flex items-center gap-2.5">
                              <LiveDot on={fresh} />
                              {h.instanceId}
                            </span>
                          </Cell>
                          <Cell>
                            <Pill tone={fresh ? "up" : "neutral"}>{fresh ? "live" : "idle"}</Pill>
                          </Cell>
                          <Cell className="text-muted">{age(h.lastSeen)}</Cell>
                          <Cell className="font-mono text-muted">{h.lastSeq}</Cell>
                          <Cell className="font-mono text-muted">{h.strategies}</Cell>
                        </Row>
                      );
                    })}
                    {(health.data ?? []).length === 0 && <Empty colSpan={5}>No instances reporting yet</Empty>}
                  </Table>
                ),
              }}
            />
          </div>

          <Panel stagger={3} title="Live feed" right={<LiveDot on={live.length > 0} />}>
            <div className="h-56 overflow-auto p-2 font-mono text-xs">
              {live.length === 0 && <div className="p-3 text-faint">Waiting for events…</div>}
              {live.slice(0, 30).map((e) => (
                <div key={`${e.instanceId}-${e.id}`} className="flex gap-2 border-b border-line/50 px-2 py-1.5 last:border-b-0">
                  <span className="shrink-0 text-faint">{ts(e.ts).slice(11)}</span>
                  <span className="shrink-0 text-info">{e.type}</span>
                  {e.strategyId && <span className="shrink-0 text-muted">{e.strategyId}</span>}
                  <span className="truncate text-body/80">{JSON.stringify(e.payload)}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <div className="mt-8">
        <div className="rise flex items-baseline justify-between" style={{ "--stagger": 3 } as React.CSSProperties}>
          <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-body">Strategies</h3>
          <span className="text-xs text-faint">click one to drill in</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.length === 0 && <Card className="p-8 text-center text-faint md:col-span-2 xl:col-span-3">No strategies yet.</Card>}
          {rows.map((s, i) => {
            const st = stats[i]?.data;
            const pts = curves[i]?.data ?? [];
            const ret =
              s.equity != null && s.startingBalance ? (s.equity - s.startingBalance) / s.startingBalance : null;
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
                  <div className="mt-2.5 flex items-baseline gap-3">
                    <span className="font-mono text-2xl font-semibold text-bright">{money(s.equity)}</span>
                    <Delta value={ret} />
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
      </div>

      <div className="mt-8">
        <Panel stagger={5} title="Open positions" hint="latest position snapshot per strategy and symbol" scroll="max-h-[22rem]">
          <Table head={["Strategy", "Symbol", "Side", "Qty", "Entry", "Opened"]}>
            {posRows.flatMap((p) =>
              p.legs.map((leg, i) => (
                <Row key={`${p.strategyId}-${p.symbol}-${i}`}>
                  <Cell>{p.strategyId}</Cell>
                  <Cell className="font-semibold text-bright">{p.symbol}</Cell>
                  <Cell>
                    <SideTag side={leg.side} />
                  </Cell>
                  <Cell className="font-mono">{leg.qty}</Cell>
                  <Cell className="font-mono text-muted">@ {leg.entryPrice}</Cell>
                  <Cell className="text-muted">{age(leg.entryTs)}</Cell>
                </Row>
              )),
            )}
            {posRows.length === 0 && <Empty colSpan={6}>Flat — no open positions reported.</Empty>}
          </Table>
        </Panel>
      </div>

      <div className="mt-8">
        <Panel stagger={6} title="Instances" hint="every qkt box the collector has heard from">
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
        </Panel>
      </div>
    </div>
  );
}
