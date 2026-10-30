import { accountKey, accountName, accountProfiles, accountTitle, groupAccounts, realAccounts } from "../accounts";
import { useQuery } from "@tanstack/react-query";
import { get, type AccountRiskRow, type AccountSummary, type StrategyRow } from "../api";
import { useMemo, useState } from "react";
import { StrategySearch, type StrategyLine } from "../components/HomeStrategies";
import { CardGrid, PortfolioGroup, StrategyCard } from "../components/StrategyCards";
import { Card, Cell, CurrencyMix, Empty, Loadable, PageHeader, Panel, Pill, Pnl, Popover, Row, Select, Stat, Table } from "../components/ui";
import { age, count, money, openPnl, pct, signedMoney } from "../format";
import { emptyPeriods, floatingByStrategy, positionRisks, riskRowFor, strategyLines, strategyPeriods } from "../home";
import { Link, routePath, useRoute, useSearchParam } from "../router";
import { asksForRetired, matchesStrategy } from "../strategyFilter";
import { CARD_SORTS, cardGroups, cardName, cardsTotal, isFolded, mergeCurves, notTradedYet, realizedCurves, sortCards, type CardSort } from "../strategyCards";
import { strategyCurrencies, strategyLegs } from "../instruments";
import { currencyMix, useInstanceCurrencyMix } from "../currencies";
import { AccountTabs, useAccountChoice } from "../components/AccountSwitch";
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
 * Every strategy on the instance as a card, from the same figures as Home's table: a group card per
 * portfolio with its sleeves beneath, then the standalone strategies; a card opens the strategy.
 */
export default function Strategies({ instanceId }: { instanceId: string | null }) {
  const view = useView();
  const { route, navigate } = useRoute();
  const selected = route.strategy ?? null;
  const selectedPortfolio = route.portfolio ?? null;
  usePublicPageView(selected || selectedPortfolio ? null : "strategies");
  const enc = encodeURIComponent(instanceId ?? "");
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${enc}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });
  const listing = !selected && !selectedPortfolio;
  const liveState = useLiveState();
  // the same account switcher as Home and Equity & risk: one scope across pages, in the URL
  const choice = useAccountChoice(groupAccounts((liveState.data?.accounts ?? []).filter((a) => a.instanceId === instanceId)), view.public);
  const scoped = choice.many && choice.chosen ? choice.chosen : null;
  const accountParam = scoped ? `&account=${encodeURIComponent(accountKey(scoped.account))}` : "";
  // the same figures as Home's table: every close on the account, on the account's trading day
  const summary = useQuery({
    queryKey: ["accountSummary", instanceId, accountParam],
    queryFn: () => get<AccountSummary>(`/account/summary?instance=${enc}${accountParam}`),
    enabled: !!instanceId && listing && !(choice.asked && liveState.isPending),
    refetchInterval: 60_000,
  });
  const risk = useQuery({
    queryKey: ["accountRisk", instanceId],
    queryFn: () => get<AccountRiskRow[]>(`/account/risk?instance=${enc}`),
    enabled: !!instanceId && listing,
    refetchInterval: 60_000,
  });
  const [sort, setSort] = useSearchParam("sort", "attention");
  const mix = useInstanceCurrencyMix(instanceId);

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;
  if (selected) return <StrategyDetail instanceId={instanceId} strategyId={selected} />;

  const rows = strategies.data ?? [];
  if (selectedPortfolio) {
    const children = rows.filter((r) => portfolioGroupId(r) === selectedPortfolio);
    return (
      <Loadable loading={strategies.isPending} error={strategies.isError} retry={() => strategies.refetch()} what="the portfolio">
        {children.length > 0 ? (
          <PortfolioDetail instanceId={instanceId} portfolioId={selectedPortfolio} children={children} onSelectChild={(id) => navigate(routePath({ page: "strategies", strategy: id }), { from: selectedPortfolio })} />
        ) : (
          <Card className="p-8 text-center text-muted">No portfolio {selectedPortfolio} on this instance.</Card>
        )}
      </Loadable>
    );
  }

  const now = view.public ? Date.now() - view.meta.delayMinutes * 60_000 : Date.now();
  const accounts = realAccounts((liveState.data?.accounts ?? []).filter((a) => a.instanceId === instanceId));
  const groups = (liveState.data?.positions ?? []).filter((g) => g.instanceId === instanceId);
  const positions = (scoped ? groups.filter((g) => accountProfiles(scoped.account, scoped.labels).includes(g.broker)) : groups).flatMap((g) => g.list);
  const riskRows = risk.data ?? [];
  const dayAccount = choice.chosen?.account ?? accounts[0];
  const primaryRisk = dayAccount ? riskRowFor(dayAccount, riskRows) : riskRows[0] ?? null;
  const dayStart = primaryRisk?.dailyLoss.dayStart ?? Math.floor(now / DAY_MS) * DAY_MS;
  const floating = view.public
    ? new Map<string | null, number>(Object.entries(liveState.data?.openByStrategy ?? {}))
    : floatingByStrategy(positions);
  const closes = summary.data?.closes ?? [];
  const periods = summary.data ? strategyPeriods(closes, { now, dayStart, floating }) : null;
  // an account's tab lists the strategies that traded on it (a close, or an open position there)
  const lines: StrategyLine[] = periods ? strategyLines(rows.filter((r) => !scoped || periods.has(r.strategyId)), periods) : [];
  const halted = rows.filter((r) => r.active && r.halted).length;
  const live = rows.filter((r) => r.active).length;
  const risks = positionRisks(positions);
  const noStop = new Set(positions.flatMap((p) => (p.strategyId && risks.get(p.ticket)?.noStop ? [p.strategyId] : [])));

  return (
    <div className="@container grid gap-4">
      <PageHeader
        title="Strategies"
        sub={`${live} ${live === 1 ? "strategy" : "strategies"}${halted ? ` · ${halted} halted` : ""} · figures net incl. open${view.public ? ` · ${view.meta.delayMinutes} minutes behind` : ""}`}
        right={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <StrategySearch className="flex-1 sm:flex-none" />
            <Select aria-label="Sort strategies" title="Order the cards" value={sort} onChange={(e) => setSort(e.target.value)} className="sm:w-36">
              {CARD_SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </Select>
          </div>
        }
      />
      <AccountTabs choice={choice} isPublic={view.public} />
      <Loadable
        loading={strategies.isPending || summary.isPending}
        error={strategies.isError || summary.isError}
        retry={() => { void strategies.refetch(); void summary.refetch(); }}
        what="the strategies"
        shape="kpis"
        lines={6}
      >
        {rows.length === 0 && lines.length === 0 ? (
          <Card className="p-8 text-center text-muted">No strategies yet. They show up here when qkt starts one.</Card>
        ) : (
          <StrategyCardList lines={lines} closes={closes} now={now} instanceId={instanceId} noStop={noStop} mix={scoped ? null : mix} />
        )}
      </Loadable>
    </div>
  );
}

/** Portfolios first (each with its sleeves beneath), then standalone strategies, filtered by the search and in the chosen order. */
function StrategyCardList({ lines, closes, now, instanceId, noStop, mix }: {
  lines: StrategyLine[]; closes: AccountSummary["closes"]; now: number; instanceId: string | null; noStop: ReadonlySet<string>;
  /** Set when the cards add accounts in different currencies. */
  mix: { label: string; title: string } | null;
}) {
  const accounts = useLiveState().data?.accounts ?? [];
  const [find] = useSearchParam("find");
  const [sortParam] = useSearchParam("sort", "attention");
  const [showAll, setShowAll] = useState(false);
  const sort = (CARD_SORTS.find((o) => o.key === sortParam)?.key ?? "attention") as CardSort;
  const curves = useMemo(() => realizedCurves(closes, { now }), [closes, now]);
  const all = showAll || asksForRetired(find);
  const matched = lines.filter((l) => matchesStrategy(l.row, find));
  const shown = matched.filter((l) => all || !isFolded(l));
  const foldedCount = matched.filter(isFolded).length;
  // strategies yet to trade are one line at the end; the unattributed bucket is a row of its own, not a strategy
  const idle = shown.filter(notTradedYet);
  const unattributed = shown.find((l) => l.key == null) ?? null;
  const { portfolios, standalone } = cardGroups(shown.filter((l) => l.key != null && !notTradedYet(l)));
  const orderedPortfolios = sortCards(
    portfolios.map((g) => ({ key: g.id, row: null, group: g, periods: { ...emptyPeriods(g.id), all: g.net, todayRealized: g.today, lastTs: g.lastTs } })),
    sort,
  ).map((p) => p.group);
  const card = (l: StrategyLine, name?: string) => (
    <StrategyCard key={l.key ?? "(unattributed)"} line={l} curve={curves.get(l.key) ?? []} name={name} origin="Strategies"
      legs={strategyLegs(l.row, accounts, instanceId ?? undefined)} mix={currencyMix(strategyCurrencies(l.row, accounts, instanceId ?? undefined))} />
  );

  return (
    <div className="grid grid-cols-1 gap-5">
      {shown.length === 0 && (
        <Card className="p-8 text-center text-sm text-muted">
          {find ? `No strategy matches “${find}”.` : "No trades yet. Strategies show up here as they trade."}
        </Card>
      )}
      {orderedPortfolios.map((g) => (
        <PortfolioGroup
          key={g.id}
          group={g}
          curve={mergeCurves(closes, new Set(g.children.map((c) => c.key)), { now })}
          to={routePath({ page: "strategies", portfolio: g.id })}
          origin="Strategies"
        >
          <CardGrid>{sortCards(g.children, sort, noStop).map((l) => card(l, sleeveName(l, g.id)))}</CardGrid>
        </PortfolioGroup>
      ))}
      {standalone.length > 0 && (
        <section className="grid grid-cols-1 gap-2.5">
          {orderedPortfolios.length > 0 && <h2 className="eyebrow">Standalone strategies</h2>}
          <CardGrid>{sortCards(standalone, sort, noStop).map((l) => card(l))}</CardGrid>
        </section>
      )}
      {idle.length > 0 && (
        <p className="text-sm text-muted">
          <span className="font-medium text-body">Not traded yet ({count(idle.length)}):</span>{" "}
          {idle.map((l, i) => (
            <span key={l.key}>{i > 0 && ", "}<Link to={`/s/${encodeURIComponent(l.key!)}`} from="Strategies" className="text-body hover:underline">{cardName(l)}</Link></span>
          ))}
        </p>
      )}
      {unattributed && (
        <p className="text-sm italic text-muted" title="Closes and positions on the account that no strategy claimed: deals without a qkt strategy's magic or comment">
          Unattributed: net incl. open <span className="font-mono not-italic">{signedMoney(unattributed.periods.all + unattributed.periods.floating)}</span>
          {" · "}{count(unattributed.periods.trades)} {unattributed.periods.trades === 1 ? "close" : "closes"}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
        <CardsTotal lines={shown} mix={mix} />
        {foldedCount > 0 && !asksForRetired(find) && (
          <button type="button" onClick={() => setShowAll((s) => !s)} className="text-xs font-medium text-accent-ink hover:underline">
            {showAll ? "Hide retired" : `Show ${foldedCount} retired`}
          </button>
        )}
      </div>
    </div>
  );
}

/** The total of what the page shows, summed from what each card shows. */
function CardsTotal({ lines, mix }: { lines: StrategyLine[]; mix: { label: string; title: string } | null }) {
  const t = cardsTotal(lines);
  return (
    <span className="text-xs text-muted">
      Total <span className="font-mono text-body">{signedMoney(t.net)}</span> · today <span className="font-mono text-body">{signedMoney(t.today)}</span>
      <CurrencyMix mix={mix} />
    </span>
  );
}

/** A sleeve's name inside its portfolio's group: without the portfolio prefix the group already shows. */
function sleeveName(l: StrategyLine, portfolio: string): string {
  const name = l.row ? displayName(l.row) : l.key ?? "Unattributed";
  const prefix = name.indexOf(" / ");
  return prefix > 0 && name.slice(0, prefix).startsWith(portfolio) ? name.slice(prefix + 3) : name;
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
  onSelectChild,
}: {
  instanceId: string;
  portfolioId: string;
  children: StrategyRow[];
  onSelectChild: (strategyId: string) => void;
}) {
  const view = useView();
  usePublicPageView("portfolio");
  const live = useOpenByStrategy(instanceId);
  const state = useLiveState();
  const summary = summarizePortfolio(id, children, live.open, live.hasState);
  const accounts = realAccounts((state.data?.accounts ?? [])).filter(
    (account) => account.instanceId === instanceId,
  );
  const account = accounts.length === 1 ? accounts[0] : null;
  return (
    <div>
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
              ? `${accountName(account, view.public)} · shared account`
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
                      <Pnl value={net} />
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
                  <span className="font-semibold text-bright" title={accountTitle(a)}>{accountName(a)}</span>
                  {a.stale && <div className="text-xs text-warn">{a.stopped ? "stopped reporting" : "stale"}</div>}
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
  if (selected) return <StrategyDetail instanceId={instanceId} strategyId={selected} />;
  return (
    <Loadable loading={strategies.isPending} error={strategies.isError} retry={() => strategies.refetch()} what="the portfolio">
      <PortfolioDetail
        instanceId={instanceId}
        portfolioId={id}
        children={strategies.data ?? []}
        onSelectChild={(child) => navigate(routePath({ page: "strategies", strategy: child }), { from: id })}
      />
    </Loadable>
  );
}

