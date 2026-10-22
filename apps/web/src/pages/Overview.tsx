import { useQuery } from "@tanstack/react-query";
import { get, type AccountRiskRow, type AccountSummary, type InstanceRow, type LivePositionRow, type StrategyRow } from "../api";
import { groupAccounts } from "../accounts";
import { AccountStrip } from "../components/HomeAccount";
import { MonthCalendar, PnlChart } from "../components/HomeCharts";
import { OpenPositions, PublicOpenPositions } from "../components/HomePositions";
import { StrategyTable, type StrategyLine } from "../components/HomeStrategies";
import { ShareControl } from "../components/ShareControl";
import { Card, Loadable, PageHeader } from "../components/ui";
import { day as utcDay } from "../format";
import { dayBasisLabel, floatingByStrategy, HOME_RANGES, noAccountMessage, openRisk, riskRowFor, strategyLines, strategyPeriods, type HomeRange } from "../home";
import { strategyDisplayName } from "../portfolio";
import { useSearchParam } from "../router";
import { useLiveState } from "../useLiveState";
import { useLiveStream } from "../useLiveStream";
import { usePublicPageView, useView } from "../view";

// Home needs only broker state pushes for live account and position truth.
const FEED_TYPES = ["state.account", "state.positions"];
const DAY_MS = 86_400_000;

/**
 * Home answers "am I safe right now": the account strip (balance, equity, today, open risk to the
 * stops, loss limits), the open positions, every strategy's periods, the realized P&L history and
 * the month. Shared links show the same page 15 minutes behind, without positions.
 */
export default function Home({ instanceId }: { instanceId: string | null }) {
  const view = useView();
  usePublicPageView("overview");
  const enc = encodeURIComponent(instanceId ?? "");
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${enc}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });
  const live = useLiveStream(instanceId, 40, FEED_TYPES);
  const liveState = useLiveState(live);
  // every close on the account: retired strategies and unattributed deals included
  const summary = useQuery({
    queryKey: ["accountSummary", instanceId],
    queryFn: () => get<AccountSummary>(`/account/summary?instance=${enc}`),
    enabled: !!instanceId,
    refetchInterval: 60_000,
  });
  const risk = useQuery({
    queryKey: ["accountRisk", instanceId],
    queryFn: () => get<AccountRiskRow[]>(`/account/risk?instance=${enc}`),
    enabled: !!instanceId,
    refetchInterval: 60_000,
  });
  // the same query the shell keeps; Home reads when the instance last reported
  const instances = useQuery({
    queryKey: ["instances"],
    queryFn: () => get<InstanceRow[]>("/instances"),
    enabled: !view.public,
    refetchInterval: 30_000,
  });
  const [rawRange, setRange] = useSearchParam("range", "all");
  const range = (HOME_RANGES.find((r) => r.key === rawRange)?.key ?? "all") as HomeRange;

  if (!instanceId) {
    return (
      <Card className="p-10 text-center text-muted">
        No instances reporting yet: enable the insights block on a qkt instance and it will appear here.
      </Card>
    );
  }

  // a shared link is a still picture at its cutoff, never the live clock
  const now = view.public ? Date.now() - view.meta.delayMinutes * 60_000 : Date.now();
  const accountGroups = groupAccounts((liveState.data?.accounts ?? []).filter((a) => a.instanceId === instanceId));
  const accounts = accountGroups.map((g) => g.account);
  const groups = (liveState.data?.positions ?? []).filter((g) => g.instanceId === instanceId);
  const positions: LivePositionRow[] = groups.flatMap((g) => g.list);
  const rows = strategies.data ?? [];
  const byId = new Map(rows.map((r) => [r.strategyId, r]));
  const riskRows = risk.data ?? [];

  // Strategy Today follows the account's trading day; without a risk row it is the UTC day.
  const primaryRisk = accounts[0] ? riskRowFor(accounts[0], riskRows) : riskRows[0] ?? null;
  const dayStart = primaryRisk?.dailyLoss.dayStart ?? Math.floor(now / DAY_MS) * DAY_MS;
  const dayLabel = primaryRisk ? dayBasisLabel(primaryRisk) : "day from 00:00 UTC";
  const floating = view.public
    ? new Map<string | null, number>(Object.entries(liveState.data?.openByStrategy ?? {}))
    : floatingByStrategy(positions);
  const periods = summary.data ? strategyPeriods(summary.data.closes, { now, dayStart, floating }) : null;
  const lines: StrategyLine[] = periods ? strategyLines(rows, periods) : [];
  // the account's realized today when it has no risk row yet: the strategies' sum over the same day
  const realizedFallback = periods ? [...periods.values()].reduce((a, p) => a + p.todayRealized, 0) : 0;

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Home"
        sub={view.public ? `${instanceId} · shared view, figures ${view.meta.delayMinutes} minutes behind · times UTC` : `${instanceId}: where the account stands right now · times UTC`}
        right={<ShareControl instanceId={instanceId} kind="overview" />}
      />

      <Loadable loading={liveState.isPending} error={liveState.isError} retry={() => liveState.refetch()} what="the account" lines={3}>
        {accounts.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted">
            {view.public
              ? `Account figures appear ${view.meta.delayMinutes} minutes behind; none has reached this shared view yet.`
              : noAccountMessage(instanceId, instances.data?.find((i) => i.id === instanceId)?.lastSeen, now)}
          </Card>
        ) : (
          accountGroups.map(({ account: a, labels }) => {
            const row = riskRowFor(a, riskRows);
            const own = groups.filter((g) => labels.includes(g.broker)).flatMap((g) => g.list);
            return (
              <AccountStrip
                key={`${a.broker}:${a.login ?? ""}`}
                account={a}
                labels={labels}
                risk={row}
                realizedToday={row?.dailyLoss.realizedToday ?? realizedFallback}
                dayLabel={row ? dayBasisLabel(row) : dayLabel}
                open={view.public ? null : openRisk(accounts.length === 1 ? positions : own)}
                isPublic={view.public}
              />
            );
          })
        )}
      </Loadable>

      {view.public ? (
        <PublicOpenPositions summary={liveState.data?.openPositions ?? null} />
      ) : (
        liveState.data && <OpenPositions positions={positions} now={now} freshness={groups.length ? { at: Math.max(...groups.map((g) => g.at)), stale: groups.every((g) => g.stale) } : null} strategyName={(id) => (byId.get(id) ? strategyDisplayName(byId.get(id)!) : id)} />
      )}

      <Loadable
        loading={summary.isPending || strategies.isPending}
        error={summary.isError || strategies.isError}
        retry={() => { void summary.refetch(); void strategies.refetch(); }}
        what="the strategies"
        lines={5}
      >
        <StrategyTable lines={lines} now={now} search origin="Home" hint="Today includes open P&L · other columns are closed trades" />
      </Loadable>

      <Loadable loading={summary.isPending} error={summary.isError} retry={() => summary.refetch()} what="the P&L history" lines={6}>
        {summary.data && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <PnlChart days={summary.data.dailyNets} range={range} onRange={(r) => setRange(r, { push: true })} now={now} />
            </div>
            <MonthCalendar key={utcDay(now).slice(0, 7)} days={summary.data.dailyNets} now={now} />
          </div>
        )}
      </Loadable>
    </div>
  );
}
