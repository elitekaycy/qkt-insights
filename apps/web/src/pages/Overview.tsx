import { chartColors } from "../components/EChart";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type AccountDrawdownRow, type AccountRiskRow, type AccountSummary as AccountSummaryData, type EquityPoint, type PerformanceBundle, type StrategyRow } from "../api";
import { AccountSummary } from "../components/AccountSummary";
import type { ComparisonSeries } from "../components/EquityChart";
import { OverviewDashboard } from "../components/OverviewDashboard";
import { Card, Cell, DataList, FlashValue, LiveDot, Loadable, PageHeader, Panel, Pill, Pnl, SideTag, Stat } from "../components/ui";
import { DASH, duration, human, money, pctValue, pnl, polarity, price, quantity, signedMoney } from "../format";
import { strategyDisplayName } from "../portfolio";
import { useLiveState } from "../useLiveState";
import { useLiveStream } from "../useLiveStream";
import { ShareControl } from "../components/ShareControl";
import { usePublicPageView, useView } from "../view";

const PALETTE = chartColors.series;

// Overview only needs broker state pushes for live account/position truth; raw
// event inspection belongs on Logs/Search so payloads cannot stretch the layout.
const FEED_TYPES = ["state.account", "state.positions"];

export default function Overview({
  instanceId,
}: {
  instanceId: string | null;
  onOpenStrategy: (strategyId: string) => void;
}) {
  const view = useView();
  usePublicPageView("overview");
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });

  // Only the live deployed roster feeds the overview aggregates; ids left over from a
  // prior bench topology (active=false) are excluded from counts, curves, and allocation.
  const rows = (strategies.data ?? []).filter((s) => s.active);
  const ids = rows.map((s) => s.strategyId);

  const curves = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["equity", instanceId, id],
      queryFn: () =>
        get<EquityPoint[]>(`/equity?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 30_000,
    })),
  });
  const live = useLiveStream(instanceId, 40, FEED_TYPES);
  const liveState = useLiveState(live);
  // Account totals come from every close on the account, not the sum of the active roster:
  // retired strategies and unattributed deals moved the balance too.
  const summary = useQuery({
    queryKey: ["accountSummary", instanceId],
    queryFn: () => get<AccountSummaryData>(`/account/summary?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 60_000,
  });
  // Excursions need per-position marks, which only the per-strategy bundle samples.
  const perf = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["perf-excursions", instanceId, id],
      queryFn: () =>
        get<Partial<PerformanceBundle>>(`/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}&include=excursions`),
      refetchInterval: 60000,
    })),
  });

  const risk = useQuery({
    queryKey: ["accountRisk", instanceId],
    queryFn: () => get<AccountRiskRow[]>(`/account/risk?instance=${encodeURIComponent(instanceId!)}`),
    enabled: instanceId != null,
    refetchInterval: 60_000,
  });

  const drawdown = useQuery({
    queryKey: ["accountDrawdown", instanceId],
    queryFn: () => get<AccountDrawdownRow[]>(`/account/drawdown?instance=${encodeURIComponent(instanceId!)}`),
    enabled: instanceId != null,
    refetchInterval: 60_000,
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
  const nameByStrategy = new Map((strategies.data ?? []).map((r) => [r.strategyId, strategyDisplayName(r)]));

  // Live truth: account figures summed across brokers, open P&L attributed per strategy.
  const accountEquity = accounts.length > 0 ? accounts.reduce((a, x) => a + x.equity, 0) : null;
  const accountOpenPnl = accounts.length > 0 ? accounts.reduce((a, x) => a + (x.openProfit ?? 0), 0) : null;
  const excursions = perf.flatMap((q) => q.data?.excursions ? [q.data.excursions] : []);

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
      <PageHeader
        title="Overview"
        sub={view.public ? `${instanceId} · public view, figures ${view.meta.delayMinutes} minutes behind` : `Everything ${instanceId} is doing, right now.`}
        right={<ShareControl instanceId={instanceId} kind="overview" />}
      />

      <div className="mt-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-body">Account</h3>
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
          <Card className="mt-3 p-8 text-center text-faint">
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
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Balance" value={money(a.balance)} sub={a.currency} />
              <Stat label="Equity" value={<FlashValue value={a.equity}>{money(a.equity)}</FlashValue>} />
              <Stat
                label="Open P&L"
                value={<FlashValue value={a.openProfit}>{pnl(a.openProfit)}</FlashValue>}
                tone={toneOf(a.openProfit)}
               
              />
              {!view.public && (
                <Stat
                  label="Margin level"
                  value={pctValue(a.marginLevel)}
                  sub={a.margin != null ? `margin ${money(a.margin)}` : undefined}
                 
                />
              )}
              {(() => {
                const all = drawdown.data ?? [];
                // TOTAL spans broker relabels and multi-account portfolios; a
                // single-label history has no TOTAL row and the label matches.
                const dd = all.find((d) => d.broker === "TOTAL") ?? all.find((d) => d.broker === a.broker) ?? all[0];
                const cur = dd?.currentDdPct; const max = dd?.maxDdPct;
                return (
                  <>
                    <Stat
                      label="DD from peak"
                      value={pctValue(cur)}
                      sub={dd?.peakEquity != null ? `peak ${money(dd.peakEquity)}` : undefined}
                      tone={cur == null ? "neutral" : cur > 5 ? "down" : cur > 0.005 ? "neutral" : "up"}
                     
                    />
                    <Stat
                      label="Max DD"
                      value={pctValue(max)}
                      sub="whole retained history"
                      tone={max != null && max > 5 ? "down" : "neutral"}
                     
                    />
                  </>
                );
              })()}
            </div>
          </div>
        ))}
        </Loadable>
        <div className="mt-4">
          {view.public ? (
            <PublicOpenPositions summary={liveState.data?.openPositions ?? null} loading={liveState.isPending} />
          ) : (
          <Panel title="Open positions" hint="live broker tickets, broker-valued" scroll="max-h-[22rem]">
            <Loadable
              loading={liveState.isPending}
              error={liveState.isError}
              retry={() => liveState.refetch()}
              what="open positions"
            >
            <DataList
              head={["Ticket", "Symbol", "Side", "Qty", "Entry", "Current", "Held", "Profit", "Swap", "Strategy"]}
              rows={brokerPositions.flatMap((g) => g.list.map((p) => ({ broker: g.broker, p })))}
              keyOf={({ broker, p }) => `${broker}-${p.ticket}`}
              empty={brokerPositions.length === 0 ? "No broker state yet." : "Flat — no open broker positions."}
              cells={({ p }) => (
                <>
                  <Cell className="font-mono text-xs text-faint">{p.ticket}</Cell>
                  <Cell className="font-semibold text-bright">{p.symbol}</Cell>
                  <Cell>
                    <SideTag side={p.side} />
                  </Cell>
                  <Cell>{quantity(p.qty)}</Cell>
                  <Cell className="whitespace-nowrap text-muted">@ {price(p.entryPrice)}</Cell>
                  <Cell>{price(p.currentPrice)}</Cell>
                  <Cell className="text-muted">
                    <span title={p.openedAt ? `opened ${human(p.openedAt)}` : undefined}>
                      {p.openedAt ? duration(Date.now() - p.openedAt) : "—"}
                    </span>
                  </Cell>
                  <Cell className="font-semibold">
                    <FlashValue value={p.profit}>
                      <Pnl value={p.profit} glyphs={false} />
                    </FlashValue>
                  </Cell>
                  <Cell className="text-muted">{signedMoney(p.swap)}</Cell>
                  <Cell>
                    {p.strategyId ? (
                      <span title={p.strategyId}>{nameByStrategy.get(p.strategyId) ?? p.strategyId}</span>
                    ) : (
                      <Pill>unattributed</Pill>
                    )}
                  </Cell>
                </>
              )}
              card={({ p }) => (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate font-semibold text-bright">{p.symbol}</span>
                    <SideTag side={p.side} />
                    <span className="ml-auto shrink-0 text-sm font-semibold">
                      <FlashValue value={p.profit}>
                        <Pnl value={p.profit} glyphs={false} />
                      </FlashValue>
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-faint">
                    <span className="min-w-0 truncate">
                      {p.strategyId ? nameByStrategy.get(p.strategyId) ?? p.strategyId : "unattributed"}
                    </span>
                    <span className="ml-auto shrink-0 whitespace-nowrap ">
                      {quantity(p.qty)} @ {price(p.entryPrice)} · {p.openedAt ? duration(Date.now() - p.openedAt) : DASH}
                    </span>
                  </div>
                </>
              )}
            />
            </Loadable>
          </Panel>
          )}
        </div>
      </div>

      <Loadable
        loading={summary.isPending || (rows.length > 0 && (perf.some((query) => query.isPending) || curves.some((query) => query.isPending)))}
        error={summary.isError || perf.some((query) => query.isError) || curves.some((query) => query.isError)}
        retry={() => { void Promise.all([summary, ...perf, ...curves].map((query) => query.refetch())); }}
        what="overview analysis"
        lines={8}
      >
        {summary.data && <>
        <AccountSummary
          summary={summary.data}
          strategyName={(id) => nameByStrategy.get(id) ?? id}
          risk={risk.data ?? []}
        />
        <OverviewDashboard
          data={{
            instanceId,
            dailyNets: summary.data.dailyNets,
            closes: summary.data.closes,
            sumWins: summary.data.sumWins,
            sumLosses: summary.data.sumLosses,
            excursions,
            series,
            accountEquity,
            accountOpenPnl,
            risk: risk.data ?? [],
          }}
        />
        </>}
      </Loadable>


    </div>
  );
}

/** Shared links show how many positions are open and their P&L, never what or where they are. */
function PublicOpenPositions({ summary, loading }: { summary: { count: number; unrealized: number | null } | null; loading: boolean }) {
  const count = summary?.count ?? 0;
  const unrealized = summary?.unrealized ?? null;
  return (
    <Card className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-4">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Open positions</span>
      <span className="text-xl font-semibold text-bright">{loading ? "…" : count}</span>
      <Pnl value={unrealized} className="text-xl font-headline" />
      <span className="text-xs text-faint">
        unrealized · details stay private until each position closes
      </span>
    </Card>
  );
}

function toneOf(v: number | null | undefined): "up" | "down" | "neutral" {
  const p = polarity(v);
  return p === "gain" ? "up" : p === "loss" ? "down" : "neutral";
}
