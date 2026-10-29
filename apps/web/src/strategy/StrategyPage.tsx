import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { LOG_ATTENTION, parseQuery, TRADE_KEYS } from "@qkt-insights/contract/query";
import { get, type LogRow, type StrategyRow, type StrategyStats } from "../api";
import { LogLine } from "../components/LogLine";
import { ShareControl } from "../components/ShareControl";
import { Card, Loadable, OriginBack, Pill, Popover, RangeChips, rangeStart, ReturnPct, Segmented, Skeleton, useRangeParam } from "../components/ui";
import { age, DASH, glyph, money, openPnl, signedMoney, toneClass } from "../format";
import { haltClearing, haltReasonText, haltSince, resumeCommand } from "../halt";
import { strategyCapital, strategyDisplayName } from "../portfolio";
import { QueryBar, TRADE_PRESETS } from "../query/QueryBar";
import { Link, PAGE_PATHS, PERIOD_VIEWS, PRIVATE_STRATEGY_TABS, routePath, STRATEGY_TABS, useRoute, useSearchParam, type PeriodView, type StrategyTab } from "../router";
import { useTripAnalytics, type TripAnalytics } from "../trades/analytics";
import { tripParams, useTripFacets, type RoundTripTotals, type TripScope } from "../trades/data";
import { RoundTripTable } from "../trades/RoundTripTable";
import { TripCount, useSortParams } from "../trades/scope";
import { TradeDrawer, useOpenTrade } from "../trades/TradeDrawer";
import { LegSummary } from "../components/InstrumentType";
import { strategyEnvironment, strategyLegs } from "../instruments";
import { useLiveState } from "../useLiveState";
import { usePublicPageView, useView } from "../view";
import { CalendarSection, DailySection, MonthlySection } from "./Days";
import { chipOf, toggleToken, without } from "./journal";
import { OverviewSection } from "./Overview";
import { TimeRiskSection } from "./TimeRisk";
import { BigPnl, Icon, ICON, Widget } from "./widgets";

// The highlighter and its grammar load only when the Code section opens.
const CodeSection = lazy(() => import("./Code"));

/*
 * One strategy in the journal's layout: a header with its net, return on its own base, status and
 * runtime; a halt banner when the engine has stopped it; then sections in the URL (Overview,
 * Calendar, Daily, Monthly, Trades, Time & risk, Logs) that all read the same scope: the date
 * range and the query bar. Every aggregate on them is clickable and narrows the query to the
 * round trips behind it; a second click clears it.
 */

const TAB_LABEL: Record<StrategyTab, string> = {
  overview: "Overview", periods: "Periods", trades: "Trades", time: "Time & risk", code: "Code", logs: "Logs",
};

const PERIOD_LABEL: Record<PeriodView, string> = { calendar: "Calendar", days: "Days", months: "Months" };

/** A strategy page leaves its own name out of each row. */
const STRATEGY_HIDDEN = ["strategy", "id"];
const RECENT_LOGS = 50;

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Open P&L and open positions of one strategy from the live broker state (shared links: the delayed sum). */
function useOpen(instanceId: string, strategyId: string): { pnl: number | null; positions: number; stale: boolean } {
  const view = useView();
  const live = useLiveState();
  if (view.public) {
    const v = live.data?.openByStrategy?.[strategyId];
    return { pnl: v ?? (live.data ? 0 : null), positions: 0, stale: false };
  }
  const groups = (live.data?.positions ?? []).filter((g) => g.instanceId === instanceId);
  const mine = groups.flatMap((g) => g.list).filter((p) => p.strategyId === strategyId);
  return {
    pnl: groups.length > 0 ? mine.reduce((a, p) => a + openPnl(p), 0) : null,
    positions: mine.length,
    stale: groups.length > 0 && groups.every((g) => g.stale),
  };
}

export interface SectionProps {
  instanceId: string;
  strategyId: string;
  scope: TripScope;
  q: string;
  /** Adds the token to the query, or takes it away when it is already there; a step Back undoes it. */
  toggle: (token: string) => void;
  /** The aggregates of the query on screen, and of the query without its exit day or month. */
  a: TripAnalytics | undefined;
  base: TripAnalytics | undefined;
  busy: boolean;
  capital: { amount: number | null; label: string };
  /** What the strategy's open positions are worth now; null without live state. */
  open: number | null;
  openTrade: ((id: string) => void) | null;
  goTab: (tab: StrategyTab, q?: string, period?: PeriodView) => void;
}

export function StrategyDetail({ instanceId, strategyId }: { instanceId: string; strategyId: string }) {
  const view = useView();
  usePublicPageView("strategy", strategyId);
  const { route, navigate } = useRoute();
  const asked: StrategyTab = route.strategy === strategyId ? (route.tab ?? "overview") : "overview";
  // shared links carry no logs and no code
  const tab: StrategyTab = view.public && PRIVATE_STRATEGY_TABS.has(asked) ? "overview" : asked;
  const period: PeriodView = route.period ?? "calendar";
  const [q, setQ] = useSearchParam("q");
  const [range, setRange] = useRangeParam();
  const [, openTrade] = useOpenTrade();
  const enc = `instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}`;

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId)}`),
    refetchInterval: 30_000,
  });
  const stats = useQuery({
    queryKey: ["stats", instanceId, strategyId],
    queryFn: () => get<StrategyStats>(`/stats?${enc}`),
    refetchInterval: 30_000,
  });
  const open = useOpen(instanceId, strategyId);
  const liveAccounts = useLiveState().data?.accounts;
  const facets = useTripFacets(instanceId, strategyId);

  const from = rangeStart(range);
  // minute steps: a range that moves with the clock still hits the cache between polls
  const scope = useMemo<TripScope>(() => ({ instanceId, strategy: strategyId, from: from > 0 ? Math.floor(from / 60_000) * 60_000 : undefined }), [instanceId, strategyId, from]);
  const analytics = useTripAnalytics(scope, q);
  // Calendar, Daily and Monthly keep their whole period on screen while a day or month is picked
  const baseQ = without(q, ["exit"]);
  const daySections = tab === "periods";
  const base = useTripAnalytics(daySections ? scope : null, baseQ);

  const row = (strategies.data ?? []).find((r) => r.strategyId === strategyId) ?? null;
  const capital = row ? strategyCapital(row) : { amount: stats.data?.startingBalance ?? null, source: null };
  const capitalLabel = capital.amount == null ? "no capital known" : `on ${money(capital.amount, 0)} ${capital.source === "defined" ? "defined capital" : capital.source ?? "capital"}`;
  const env = strategyEnvironment(row);
  const realized = stats.data?.realizedPnl ?? row?.realizedNet ?? null;
  const net = realized == null && open.pnl == null ? null : (realized ?? 0) + (open.pnl ?? 0);

  const goTab = (t: StrategyTab, nextQ?: string, view?: PeriodView) => {
    const path = routePath({ page: "strategies", strategy: strategyId, tab: t, period: view });
    // a figure that opens another section is a drill-down: its way back is this section
    navigate(nextQ === undefined ? path : `${path}${nextQ ? `?q=${encodeURIComponent(nextQ)}` : ""}`, { from: TAB_LABEL[tab] });
  };
  const switchTab = (t: StrategyTab) => navigate(routePath({ page: "strategies", strategy: strategyId, tab: t }));
  const switchPeriod = (v: PeriodView) => navigate(routePath({ page: "strategies", strategy: strategyId, tab: "periods", period: v }), { replace: true });
  const toggle = (token: string) => setQ(toggleToken(q, token), { push: true });
  const a = analytics.data;
  const totals: RoundTripTotals | null = a
    ? { total: a.total, matched: a.matched, closed: a.closed, open: a.open, net: a.pnl, netInExit: chipOf(q, "exit") != null, wins: a.wins, losses: a.losses, winRate: a.winRate, avg: a.expectancy, best: a.best?.pnl ?? null, worst: a.worst?.pnl ?? null, currencies: a.currencies }
    : null;
  const suggestData = useMemo(
    () => ({
      instruments: (facets.data?.instruments ?? []).map((i) => i.name),
      days: facets.data?.days ?? [],
      sizes: facets.data?.sizes ?? [],
    }),
    [facets.data],
  );
  // the count line repeats the cards unless a search or a range narrows what they cover
  const narrowed = q.trim() !== "" || range !== "all";
  const filterCount = useMemo(() => parseQuery(q, { instruments: suggestData.instruments }).chips.length, [q, suggestData.instruments]);
  // phones: the header folds to one line and the query bar to a search button until tapped
  const [details, setDetails] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBox = useRef<HTMLDivElement>(null);
  const openSearch = () => {
    if (searchOpen) return setSearchOpen(false);
    // rendered before focusing, inside the tap, so a phone raises its keyboard
    flushSync(() => setSearchOpen(true));
    searchBox.current?.querySelector("input")?.focus();
  };

  const props: SectionProps = {
    instanceId, strategyId, scope, q, toggle, a, base: base.data ?? (baseQ === q ? a : undefined),
    busy: analytics.isFetching && analytics.isPlaceholderData, capital: { amount: capital.amount, label: capitalLabel }, open: open.pnl,
    openTrade: view.public ? null : openTrade, goTab,
  };
  const loading = analytics.isPending;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div>
        <div className="flex min-w-0 items-center gap-1.5 sm:hidden">
          <OriginBack iconOnly />
          <h1 className="min-w-0 truncate text-base font-headline text-bright" title={strategyId}>{row ? strategyDisplayName(row) : strategyId}</h1>
          <Status row={row} isPublic={view.public} compact />
          <span className={`ml-auto shrink-0 text-sm font-semibold tabular-nums ${toneClass(net)}`}>
            {net == null ? DASH : `${glyph(net)} ${signedMoney(net)}`}
          </span>
          <button
            type="button"
            aria-label={details ? "Hide strategy details" : "Show strategy details"}
            aria-expanded={details}
            onClick={() => setDetails((d) => !d)}
            className="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-muted transition hover:text-body"
          >
            <Icon d={details ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} className="h-4 w-4" />
          </button>
        </div>
        {row?.halted && <HaltBanner row={row} />}
        <header className={`${details ? "mt-2 flex" : "hidden"} sm:mt-0 flex-wrap items-start justify-between gap-x-6 gap-y-3 sm:flex`}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {/* phones show the name, status and net in the one-line header above */}
              <OriginBack className="max-sm:hidden" />
              <h1 className="min-w-0 break-words text-xl font-headline text-bright max-sm:hidden">{row ? strategyDisplayName(row) : strategyId}</h1>
              {row && strategyDisplayName(row) !== strategyId && <span className="font-mono text-xs text-muted max-sm:hidden">{strategyId}</span>}
              <span className="contents max-sm:hidden"><Status row={row} isPublic={view.public} /></span>
              {env.map((e) => <span key={e.label} title={e.title}><Pill>{e.label}</Pill></span>)}
              {metaString(row?.metadata, "portfolioId") && (
                <Link to={routePath({ page: "strategies", portfolio: metaString(row?.metadata, "portfolioId")!.replace(/_\d+$/u, "") })} from={strategyId} className="hover:opacity-80">
                  <Pill tone="info">in {metaString(row?.metadata, "portfolioName") ?? metaString(row?.metadata, "portfolioId")} ›</Pill>
                </Link>
              )}
            </div>
            <div className="mt-2 text-xs text-muted">Net incl. open</div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <BigPnl value={net} className="max-sm:hidden" />
              <span title={capital.amount == null ? "no capital known" : `Return ${capitalLabel}`}><ReturnPct net={net} base={capital.amount} /></span>
            </div>
            <div className="mt-1 text-xs text-muted">
              realized <span className="font-mono">{signedMoney(realized)}</span> · open <span className="font-mono">{open.pnl == null ? DASH : signedMoney(open.pnl)}</span>
              {open.positions > 0 && ` on ${open.positions} position${open.positions === 1 ? "" : "s"}`}
              {open.stale && <span className="ml-1.5 font-medium text-warn">· open P&L from stale broker state</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ShareControl instanceId={instanceId} kind="strategy" subject={strategyId} />
          </div>
        </header>
        <LegSummary legs={strategyLegs(row, liveAccounts, instanceId)} className="mt-3" />
      </div>

      <nav aria-label="Strategy sections" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 sm:hidden">
        {STRATEGY_TABS.filter((t) => !(view.public && PRIVATE_STRATEGY_TABS.has(t))).map((t) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? "page" : undefined}
            onClick={() => switchTab(t)}
            className={`h-7 shrink-0 whitespace-nowrap rounded-full border px-3 text-[13px] font-medium transition ${
              tab === t ? "border-accent-hi/50 bg-accent-soft text-bright" : "border-line bg-raised text-body"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>
      <nav className="-mx-1 hidden overflow-x-auto px-1 sm:block">
        <Segmented
          label="Strategy sections"
          value={tab}
          onChange={(t) => switchTab(t)}
          options={STRATEGY_TABS.filter((t) => !(view.public && PRIVATE_STRATEGY_TABS.has(t))).map((t) => ({ key: t, label: TAB_LABEL[t] }))}
        />
      </nav>

      {tab === "periods" && (
        <div>
          <Segmented label="Periods" value={period} onChange={switchPeriod} options={PERIOD_VIEWS.map((v) => ({ key: v, label: PERIOD_LABEL[v] }))} />
        </div>
      )}

      {tab !== "logs" && tab !== "code" && (
        <div className="grid gap-2 border-b border-line pb-3">
          {/* phones: a search button with the active filter count, the range chips and the count on one row;
              a count too wide for what is left (a long net) wraps under the chips rather than leaving the screen */}
          <div className="flex flex-wrap items-center gap-1.5 sm:hidden">
            <button
              type="button"
              aria-label={filterCount ? `Search and filter, ${filterCount} active` : "Search and filter"}
              aria-expanded={searchOpen}
              onClick={openSearch}
              className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition ${searchOpen ? "border-accent-hi bg-accent-soft text-bright" : "border-ctl bg-raised text-body"}`}
            >
              <Icon d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35" className="h-4 w-4" />
              {filterCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">{filterCount}</span>
              )}
            </button>
            <RangeChips value={range} onChange={setRange} dense />
            {narrowed && <TripCount totals={totals} loading={analytics.isFetching} compactOnPhone />}
          </div>
          <div ref={searchBox} className={searchOpen ? "" : "hidden sm:block"}>
            <QueryBar
              value={q}
              onChange={(v) => setQ(v)}
              keys={TRADE_KEYS}
              data={suggestData}
              page="this strategy"
              presets={TRADE_PRESETS}
              errors={a?.query.errors ?? []}
              placeholder="Search trades"
              trailing={
                <span className="hidden sm:contents">
                  <RangeChips value={range} onChange={setRange} />
                  {narrowed && <TripCount totals={totals} loading={analytics.isFetching} />}
                </span>
              }
            />
          </div>
        </div>
      )}

      {tab === "logs" ? (
        <StrategyLogs instanceId={instanceId} strategyId={strategyId} />
      ) : tab === "code" ? (
        <Suspense fallback={<Skeleton shape="lines" lines={10} what="this section" />}>
          {row?.metadata && <div className="mb-3 flex justify-end"><Runtime meta={row.metadata} /></div>}
          <CodeSection instanceId={instanceId} strategyId={strategyId} meta={row?.metadata ?? null} />
        </Suspense>
      ) : tab === "trades" ? (
        <StrategyTrades scope={scope} q={q} exportHref={view.public ? null : `/round-trips/export?${tripParams(scope, q, "entry", "desc")}`} />
      ) : (
        <Loadable loading={loading} error={analytics.isError && !a} retry={() => analytics.refetch()} what="the strategy's trades" shape="kpis" lines={6}>
          {tab === "overview" && <OverviewSection {...props} range={range} />}
          {tab === "periods" && period === "calendar" && <CalendarSection {...props} />}
          {tab === "periods" && period === "days" && <DailySection {...props} />}
          {tab === "periods" && period === "months" && <MonthlySection {...props} />}
          {tab === "time" && <TimeRiskSection {...props} />}
        </Loadable>
      )}

      {/* sections without a round-trip list still open trades from their bars and rows */}
      {!view.public && (tab === "overview" || tab === "time") && <TradeDrawer instanceId={instanceId} order={(a?.trades ?? []).map((t) => t.id).reverse()} />}
    </div>
  );
}

/** Status from the engine: halted (with why), retired, or running. */
function Status({ row, isPublic, compact = false }: { row: StrategyRow | null; isPublic: boolean; compact?: boolean }) {
  if (!row) return null;
  if (row.halted) return <Pill tone="warn">halted</Pill>;
  if (!row.active) return <Pill>retired</Pill>;
  if (isPublic) return null;
  return compact ? <span className="sr-only">running</span> : <span className="text-xs text-muted">running</span>;
}

/** The halt, at the top of the page where it cannot be missed: why, since when, how it ends. */
function HaltBanner({ row }: { row: StrategyRow }) {
  const command = resumeCommand(row);
  return (
    <div role="status" className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-card border border-warn/45 bg-warn/10 px-4 py-3 text-sm">
      <span className="flex items-center gap-2 font-semibold text-warn">
        <Icon d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" className="h-4 w-4" />
        Halted by the engine
      </span>
      <span className="min-w-0 text-body">
        <span title={row.haltReason ?? undefined}>{haltReasonText(row.haltReason)}</span>
        {row.haltedAt != null && <span className="text-muted" title={row.haltedBefore ? "re-asserted at a restart; its start is not stored" : undefined}> {haltSince(row)} ({row.haltedBefore ? "at least " : ""}{age(row.haltedAt)})</span>}
        <span className="text-muted"> · {haltClearing(row)}</span>
      </span>
      {command && <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-bright">{command}</code>}
    </div>
  );
}

/** The deploy behind the strategy, from its latest strategy.started event. */
function Runtime({ meta }: { meta: Record<string, unknown> }) {
  const streams = Array.isArray(meta.streams) ? (meta.streams as Array<Record<string, unknown>>) : [];
  const symbols = Array.isArray(meta.symbols) ? meta.symbols.filter((x): x is string => typeof x === "string") : [];
  const fields: Array<[string, ReactNode, boolean?]> = [
    ["Mode", metaString(meta, "runtimeMode") ?? DASH],
    ["DSL version", typeof meta.dslVersion === "number" ? meta.dslVersion : DASH],
    ["Source", metaString(meta, "sourcePath") ?? DASH, true],
    ["Source hash", metaString(meta, "sourceSha256") ?? DASH, true],
    ["Symbols", symbols.join(", ") || DASH],
    ["Streams", streams.length === 0 ? DASH : streams.map((s) => `${String(s.alias ?? "?")}:${String(s.qktSymbol ?? s.symbol ?? "?")}@${String(s.timeframe ?? "?")}`).join(", "), true],
  ];
  return (
    <Popover
      label="Runtime"
      align="right"
      trigger={
        <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ctl bg-raised px-2.5 text-xs font-semibold text-bright transition hover:bg-well">
          <Icon d="M4 17l6-6-6-6M12 19h8" className="h-3.5 w-3.5" />
          Runtime details
        </span>
      }
    >
      <div className="eyebrow pb-2">From the latest strategy.started</div>
      <dl className="grid grid-cols-1 gap-2">
        {fields.map(([k, v, mono]) => (
          <div key={k}>
            <dt className="text-[11px] text-muted">{k}</dt>
            <dd className={`break-all text-bright ${mono ? "font-mono text-[11px]" : ""}`}>{v}</dd>
          </div>
        ))}
      </dl>
    </Popover>
  );
}

/** The strategy's round trips for the query on screen: the Trades page, scoped to one strategy. */
function StrategyTrades({ scope, q, exportHref }: { scope: TripScope; q: string; exportHref: string | null }) {
  const [sort, dir, setSort] = useSortParams();
  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
        <h3 className="text-sm font-medium text-body">Trades</h3>
        {exportHref && (
          <a
            href={exportHref}
            download
            className="ml-auto inline-flex h-7 items-center rounded-lg border border-ctl bg-raised px-2.5 text-xs font-medium text-bright transition hover:bg-well"
            title="Every round trip the query matches, as CSV"
          >
            Export CSV
          </a>
        )}
      </div>
      <RoundTripTable scope={scope} q={q} sort={sort} dir={dir} onSort={setSort} hide={STRATEGY_HIDDEN} height="calc(100dvh - 22rem)" fit />
    </Card>
  );
}

/** The latest log lines; the Logs page holds the history, filtered to this strategy. */
function StrategyLogs({ instanceId, strategyId }: { instanceId: string; strategyId: string }) {
  const [all, setAll] = useState(false);
  // the strategy's story first: its order flow and anything that went wrong; every line is one click away
  const which = all ? "" : `&level=${LOG_ATTENTION.levels.join(",")}&orLogger=${LOG_ATTENTION.loggers.join(",")}`;
  const logs = useQuery({
    queryKey: ["logs", instanceId, strategyId, RECENT_LOGS, all],
    queryFn: () => get<LogRow[]>(`/logs?instance=${encodeURIComponent(instanceId)}&strategy=${encodeURIComponent(strategyId)}&limit=${RECENT_LOGS}${which}`),
    refetchInterval: 30_000,
  });
  const rows = logs.data ?? [];
  return (
    <Widget
      icon={ICON.logs}
      title={`Latest ${RECENT_LOGS} lines`}
      pad={false}
      hint={
        <Link to={`${PAGE_PATHS.logs}?q=${encodeURIComponent(`strategy:${strategyId}`)}`} from={`${strategyId} · Logs`} className="font-medium text-accent-ink hover:underline">
          Full history and search on Logs →
        </Link>
      }
    >
      <Loadable loading={logs.isPending} error={logs.isError} retry={() => logs.refetch()} what="logs" shape="lines" lines={8}>
        <div className="px-4 pb-2">
          <Segmented label="Which lines" value={all ? "all" : "orders"} onChange={(v) => setAll(v === "all")} options={[{ key: "orders", label: "Warnings & orders" }, { key: "all", label: "All lines" }]} />
        </div>
        <div className="px-2 pb-2">
          {rows.map((l) => <LogLine key={l.id} log={l} showStrategy={false} />)}
          {rows.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">{all ? "No log lines yet." : "No warnings or orders yet."}</div>}
        </div>
        <div className="border-t border-line px-4 py-2 text-[11px] text-muted sm:hidden">
          <Link to={`${PAGE_PATHS.logs}?q=${encodeURIComponent(`strategy:${strategyId}`)}`} from={`${strategyId} · Logs`} className="font-medium text-accent-ink">Full history on Logs →</Link>
        </div>
      </Loadable>
    </Widget>
  );
}
