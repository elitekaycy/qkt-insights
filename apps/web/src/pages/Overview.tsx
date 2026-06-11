import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type EquityPoint, type HealthRow, type OpenPositionRow, type PerformanceBundle, type StrategyRow, type StrategyStats } from "../api";
import { ComparisonChart, type ComparisonSeries } from "../components/EquityChart";
import { Sparkline } from "../components/Sparkline";
import { Card, Cell, Delta, Empty, LiveDot, PageHeader, Panel, Pill, Row, SideTag, Stat, Table } from "../components/ui";
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
  let dayPnl = 0, weekPnl = 0;
  for (const q of perf) {
    for (const dn of q.data?.dailyNets ?? []) {
      if (dn.day === today) dayPnl += dn.net;
      if (dn.day >= monday) weekPnl += dn.net;
    }
  }
  const posRows = positions.data ?? [];

  const totalEquity = rows.reduce((acc, s) => acc + (s.equity ?? 0), 0);
  const totalStart = rows.reduce((acc, s) => acc + (s.startingBalance ?? 0), 0);
  const totalReturn = totalStart > 0 ? (totalEquity - totalStart) / totalStart : null;
  const totalTrades = stats.reduce((acc, q) => acc + (q.data?.tradeCount ?? 0), 0);
  const realized = stats.reduce((acc, q) => acc + (q.data?.realizedPnl ?? 0), 0);
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

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-6 xl:col-span-2" stagger={0}>
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
            <div className="flex flex-wrap gap-2">
              {series.map((s) => (
                <Pill key={s.strategyId}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.strategyId}
                </Pill>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <ComparisonChart series={series} height={220} />
          </div>
        </Card>

        <div className="grid content-start gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Day P&L" value={money(dayPnl)} tone={dayPnl > 0 ? "up" : dayPnl < 0 ? "down" : "neutral"} sub="UTC today" stagger={1} />
            <Stat label="Week P&L" value={money(weekPnl)} tone={weekPnl > 0 ? "up" : weekPnl < 0 ? "down" : "neutral"} sub="since Monday" stagger={1} />
            <Stat label="Realized PnL" value={money(realized)} tone={realized >= 0 ? "up" : "down"} stagger={2} />
            <Stat label="Trades" value={String(totalTrades)} stagger={2} />
            <Stat label="Strategies" value={String(rows.length)} stagger={3} />
            <Stat
              label="Instances live"
              value={`${liveInstances}/${(health.data ?? []).length}`}
              tone={liveInstances > 0 ? "accent" : "neutral"}
              stagger={3}
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
