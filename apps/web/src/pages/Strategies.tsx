import { useQuery } from "@tanstack/react-query";
import { get, type AccountRiskRow, type AccountSummary, type StrategyRow } from "../api";
import { StrategyTable, type StrategyLine } from "../components/HomeStrategies";
import { Card, Cell, Empty, Loadable, PageHeader, Panel, Pill, Pnl, Popover, ReturnPct, Row, Stat, Table } from "../components/ui";
import { age, count, money, openPnl, pct } from "../format";
import { floatingByStrategy, riskRowFor, strategyLines, strategyPeriods } from "../home";
import { Link, routePath, useRoute } from "../router";
import { useLiveState } from "../useLiveState";
import { portfolioGroupId, strategyCapital, strategyDisplayName as displayName, summarizePortfolio } from "../portfolio";
import { ShareControl } from "../components/ShareControl";
import { usePublicPageView, useView } from "../view";
import { haltSummary } from "../halt";
import { StrategyDetail } from "../strategy/StrategyPage";

export { StrategyDetail };

const DAY_MS = 86_400_000;

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

function metaNumber(meta: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

function portfolioAlias(row: StrategyRow): string | null {
  const v = row.metadata?.portfolioAlias;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Every strategy on the instance as the sortable table Home uses (status and halt reason, Today,
 * 7D, MTD, all-time, max drawdown, trades, win rate, last close), one table per portfolio and one
 * for standalone strategies; a row opens the strategy.
 */
export default function Strategies({ instanceId }: { instanceId: string | null }) {
  const view = useView();
  const { route, navigate } = useRoute();
  const selected = route.strategy ?? null;
  const selectedPortfolio = route.portfolio ?? null;
  const toList = () => navigate(routePath({ page: "strategies" }));
  usePublicPageView(selected || selectedPortfolio ? null : "strategies");
  const enc = encodeURIComponent(instanceId ?? "");
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${enc}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });
  const listing = !selected && !selectedPortfolio;
  // the same figures as Home's table: every close on the account, on the account's trading day
  const summary = useQuery({
    queryKey: ["accountSummary", instanceId],
    queryFn: () => get<AccountSummary>(`/account/summary?instance=${enc}`),
    enabled: !!instanceId && listing,
    refetchInterval: 60_000,
  });
  const risk = useQuery({
    queryKey: ["accountRisk", instanceId],
    queryFn: () => get<AccountRiskRow[]>(`/account/risk?instance=${enc}`),
    enabled: !!instanceId && listing,
    refetchInterval: 60_000,
  });
  const liveState = useLiveState();

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;
  if (selected) return <StrategyDetail instanceId={instanceId} strategyId={selected} onBack={toList} />;

  const rows = strategies.data ?? [];
  if (selectedPortfolio) {
    const children = rows.filter((r) => portfolioGroupId(r) === selectedPortfolio);
    return (
      <Loadable loading={strategies.isPending} error={strategies.isError} retry={() => strategies.refetch()} what="the portfolio">
        {children.length > 0 ? (
          <PortfolioDetail instanceId={instanceId} portfolioId={selectedPortfolio} children={children} onBack={toList} onSelectChild={(id) => navigate(routePath({ page: "strategies", strategy: id }))} />
        ) : (
          <Card className="p-8 text-center text-muted">No portfolio {selectedPortfolio} on this instance.</Card>
        )}
      </Loadable>
    );
  }

  const now = view.public ? Date.now() - view.meta.delayMinutes * 60_000 : Date.now();
  const accounts = (liveState.data?.accounts ?? []).filter((a) => a.instanceId === instanceId);
  const positions = (liveState.data?.positions ?? []).filter((g) => g.instanceId === instanceId).flatMap((g) => g.list);
  const riskRows = risk.data ?? [];
  const primaryRisk = accounts[0] ? riskRowFor(accounts[0], riskRows) : riskRows[0] ?? null;
  const dayStart = primaryRisk?.dailyLoss.dayStart ?? Math.floor(now / DAY_MS) * DAY_MS;
  const floating = view.public
    ? new Map<string | null, number>(Object.entries(liveState.data?.openByStrategy ?? {}))
    : floatingByStrategy(positions);
  const periods = summary.data ? strategyPeriods(summary.data.closes, { now, dayStart, floating }) : null;
  const lines: StrategyLine[] = periods ? strategyLines(rows, periods) : [];
  const groups = new Map<string, StrategyLine[]>();
  const standalone: StrategyLine[] = [];
  for (const l of lines) {
    const g = l.row ? portfolioGroupId(l.row) : null;
    if (g) groups.set(g, [...(groups.get(g) ?? []), l]);
    else standalone.push(l);
  }
  const halted = rows.filter((r) => r.active && r.halted).length;
  const live = rows.filter((r) => r.active).length;

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Strategies"
        sub={`${live} deployed${halted ? ` · ${halted} halted` : ""}${groups.size ? ` · ${groups.size} portfolio${groups.size === 1 ? "" : "s"}` : ""} · realized P&L from every close on the account, Today on the account's trading day${view.public ? `, ${view.meta.delayMinutes} minutes behind` : ""}`}
      />
      <Loadable
        loading={strategies.isPending || summary.isPending}
        error={strategies.isError || summary.isError}
        retry={() => { void strategies.refetch(); void summary.refetch(); }}
        what="the strategies"
        lines={6}
      >
        {rows.length === 0 && lines.length === 0 ? (
          <Card className="p-8 text-center text-muted">No strategies yet: they appear with the first strategy.started from qkt.</Card>
        ) : (
          <>
            {[...groups.entries()].map(([id, group]) => {
              const all = group.reduce((a, l) => a + l.periods.all + l.periods.floating, 0);
              const children = group.flatMap((l) => (l.row ? [l.row] : []));
              const capital = summarizePortfolio(id, children, new Map(), false).allocatedCapital;
              return (
                <StrategyTable
                  key={id}
                  lines={group}
                  now={now}
                  isPublic={view.public}
                  title={id}
                  hint="portfolio · click a row to open the sleeve"
                  footer="the portfolio's sleeves; realized from their closes, Today adds what they float"
                  right={
                    <>
                      <Pnl value={all} className="text-sm font-semibold" />
                      <ReturnPct net={all} base={capital} />
                      <Link to={routePath({ page: "strategies", portfolio: id })} className="text-xs font-medium text-accent-ink hover:underline">Portfolio →</Link>
                    </>
                  }
                />
              );
            })}
            {standalone.length > 0 && (
              <StrategyTable
                lines={standalone}
                now={now}
                isPublic={view.public}
                title={groups.size ? "Standalone strategies" : "Strategies"}
              />
            )}
          </>
        )}
      </Loadable>
    </div>
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
  const { route, navigate } = useRoute();
  const selected = route.strategy ?? null;
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId)}`),
    refetchInterval: 30_000,
  });
  if (selected) return <StrategyDetail instanceId={instanceId} strategyId={selected} onBack={() => navigate("/")} />;
  return (
    <Loadable loading={strategies.isPending} error={strategies.isError} retry={() => strategies.refetch()} what="the portfolio">
      <PortfolioDetail
        instanceId={instanceId}
        portfolioId={id}
        children={strategies.data ?? []}
        onSelectChild={(child) => navigate(routePath({ page: "strategies", strategy: child }))}
      />
    </Loadable>
  );
}

