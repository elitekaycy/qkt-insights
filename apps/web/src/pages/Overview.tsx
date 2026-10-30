import { useQuery } from "@tanstack/react-query";
import { get, type AccountRiskRow, type AccountSummary, type InstanceRow, type LivePositionRow, type StrategyRow } from "../api";
import { accountKey, accountProfiles, accountTab, groupAccounts } from "../accounts";
import { AccountsTable, AccountTabs, useAccountChoice, type AccountLine } from "../components/AccountSwitch";
import { AccountStrip, AttentionLine, TodayHeadline } from "../components/HomeAccount";
import { MonthCalendar, PnlChart } from "../components/HomeCharts";
import { OpenPositions, PublicOpenPositions } from "../components/HomePositions";
import { StrategyTable, type StrategyLine } from "../components/HomeStrategies";
import { ShareControl } from "../components/ShareControl";
import { Card, Loadable, PageHeader } from "../components/ui";
import { day as utcDay, DAY_MS, ts } from "../format";
import { attentionItems, dayBasisLabel, floatingByStrategy, floatingNote, HOME_RANGES, noAccountMessage, openRisk, riskRowFor, strategyLines, strategyPeriods, todayHeadline, todaySplit, type HomeRange } from "../home";
import { haltWords } from "../halt";
import { strategyDisplayName } from "../portfolio";
import { useRoute, useSearchParam } from "../router";
import { useLiveState } from "../useLiveState";
import { useLiveStream } from "../useLiveStream";
import { usePublicPageView, useView } from "../view";
import { useInstanceCurrencyMix } from "../currencies";
import { useStrategies } from "../hooks/useStrategies";

// Home needs only broker state pushes for live account and position truth.
const FEED_TYPES = ["state.account", "state.positions"];

/**
 * Home answers "am I safe right now": the account strip (balance, equity, today, open risk to the
 * stops, loss limits), the open positions, every strategy's periods, the realized P&L history and
 * the month. Shared links show the same page 15 minutes behind, without positions.
 */
export default function Home({ instanceId }: { instanceId: string | null }) {
  const view = useView();
  usePublicPageView("overview");
  const enc = encodeURIComponent(instanceId ?? "");
  const strategies = useStrategies(instanceId);
  const live = useLiveStream(instanceId, 40, FEED_TYPES);
  const liveState = useLiveState(live);
  const accountGroups = groupAccounts((liveState.data?.accounts ?? []).filter((a) => a.instanceId === instanceId));
  const choice = useAccountChoice(accountGroups, view.public);
  // one account's tab reads that account's closes only; All accounts and a single account read every close
  const scoped = choice.many && choice.chosen ? choice.chosen : null;
  const accountParam = scoped ? `&account=${encodeURIComponent(accountKey(scoped.account))}` : "";
  // every close on the account: retired strategies and unattributed deals included
  const summary = useQuery({
    queryKey: ["accountSummary", instanceId, accountParam],
    queryFn: () => get<AccountSummary>(`/account/summary?instance=${enc}${accountParam}`),
    enabled: !!instanceId && !(choice.asked && liveState.isPending),
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
  const mix = useInstanceCurrencyMix(instanceId);
  const { navigate } = useRoute();
  const [, setPositionsShown] = useSearchParam("pos");
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
  const accounts = accountGroups.map((g) => g.account);
  const groups = (liveState.data?.positions ?? []).filter((g) => g.instanceId === instanceId);
  // an account's positions are those reported by any broker profile of it
  const positionsOf = (g: { account: (typeof accounts)[number]; labels: string[] }) => {
    const profiles = accountProfiles(g.account, g.labels);
    return groups.filter((p) => profiles.includes(p.broker)).flatMap((p) => p.list);
  };
  // positions of another system on the account: counted by the collector, never listed
  const outsideOf = (list: typeof groups) => {
    const parts = list.flatMap((p) => (p.outside ? [p.outside] : []));
    if (parts.length === 0) return null;
    return { count: parts.reduce((a, o) => a + o.count, 0), floating: parts.some((o) => o.floating == null) ? null : parts.reduce((a, o) => a + o.floating!, 0) };
  };
  const groupsOf = (g: { account: (typeof accounts)[number]; labels: string[] }) => {
    const profiles = accountProfiles(g.account, g.labels);
    return groups.filter((p) => profiles.includes(p.broker));
  };
  const shownGroups = scoped ? groups.filter((p) => accountProfiles(scoped.account, scoped.labels).includes(p.broker)) : groups;
  const positions: LivePositionRow[] = shownGroups.flatMap((g) => g.list);
  const rows = strategies.data ?? [];
  const byId = new Map(rows.map((r) => [r.strategyId, r]));
  const riskRows = risk.data ?? [];

  // Strategy Today follows the shown account's trading day; without a risk row it is the UTC day.
  const dayAccount = choice.chosen?.account ?? accounts[0];
  const primaryRisk = dayAccount ? riskRowFor(dayAccount, riskRows) : riskRows[0] ?? null;
  const dayStart = primaryRisk?.dailyLoss.dayStart ?? Math.floor(now / DAY_MS) * DAY_MS;
  const dayLabel = primaryRisk ? dayBasisLabel(primaryRisk) : "day from 00:00 UTC";
  const floating = view.public
    ? new Map<string | null, number>(Object.entries(liveState.data?.openByStrategy ?? {}))
    : floatingByStrategy(positions);
  const periods = summary.data ? strategyPeriods(summary.data.closes, { now, dayStart, floating: scoped && view.public ? scopedFloating(floating, summary.data) : floating }) : null;
  // an account's tab lists the strategies that traded on it (a close, or an open position there)
  const onAccount = (row: StrategyRow) => !scoped || (periods?.has(row.strategyId) ?? false);
  const lines: StrategyLine[] = periods ? strategyLines(rows.filter(onAccount), periods) : [];
  // the account's realized today when it has no risk row yet: the strategies' sum over the same day
  const realizedFallback = periods ? [...periods.values()].reduce((a, p) => a + p.todayRealized, 0) : 0;
  const accountLines: AccountLine[] = choice.accounts.map((g) => {
    const row = riskRowFor(g.account, riskRows);
    return { group: g, risk: row, realizedToday: row?.dailyLoss.realizedToday ?? null, open: view.public ? null : openRisk(positionsOf(g)),
      note: view.public ? null : floatingNote(g.account, positionsOf(g), outsideOf(groupsOf(g))), pending: risk.isPending };
  });
  const shown = choice.chosen;
  const shownName = scoped ? accountTab(scoped.account, view.public).name : null;
  // the shown account's Today as the strip shows it (its risk row, else the strategies' closes today)
  const shownNote = shown && !view.public ? (choice.many ? floatingNote(shown.account, positionsOf(shown), outsideOf(groupsOf(shown))) : floatingNote(shown.account, positions, outsideOf(groups))) : null;
  const shownRealized = shown ? (riskRowFor(shown.account, riskRows)?.dailyLoss.realizedToday ?? (periods ? realizedFallback : null)) : null;
  const shownSplit = shown && shownRealized != null ? todaySplit(shown.account, shownRealized, shownNote) : null;
  const headline = todayHeadline(shown
    ? [{ key: accountKey(shown.account), name: accountTab(shown.account, view.public).name, currency: shown.account.currency, split: shownSplit }]
    : accountLines.map((l) => ({ key: accountKey(l.group.account), name: accountTab(l.group.account, view.public).name, currency: l.group.account.currency,
      split: l.realizedToday == null ? null : todaySplit(l.group.account, l.realizedToday, l.note) })));
  const headlinePending = liveState.isPending || risk.isPending || (shown != null && shownRealized == null && summary.isPending);
  const attention = attentionItems({
    strategies: rows.map((r) => ({ strategyId: r.strategyId, name: strategyDisplayName(r), active: r.active, halted: r.halted, why: haltWords(r)?.label })),
    accounts: choice.accounts.map((g) => ({ key: accountKey(g.account), name: accountTab(g.account).name, stale: g.account.stale, stopped: g.account.stopped, lastSeen: g.account.lastSeen })),
    noStop: openRisk(positions).noStop,
  });

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title="Home"
        sub={
          <>
            {view.public && <div>{`${instanceId} · shared view, figures ${view.meta.delayMinutes} minutes behind · times UTC`}</div>}
            {(accounts.length > 0 || liveState.isPending) && (
              <TodayHeadline
                parts={headline.parts}
                missing={headline.missing}
                pending={headlinePending}
                onQkt={() => document.getElementById("home-strategies")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              />
            )}
            {!view.public && !liveState.isPending && !strategies.isPending && (
              <div className="mt-1.5">
                <AttentionLine
                  items={attention}
                  others={headline.others}
                  onAccount={(key) => choice.choose(choice.accounts.find((g) => accountKey(g.account) === key) ?? null)}
                  onItem={(item) => {
                    if (item.kind === "halted") navigate(`/s/${encodeURIComponent(item.strategyId)}`, { from: "Home" });
                    else if (item.kind === "halted-many") navigate(`/s?find=${encodeURIComponent("status:halted")}`, { from: "Home" });
                    else if (item.kind === "account") navigate("/status", { from: "Home" });
                    else {
                      setPositionsShown("nostop", { push: true });
                      window.requestAnimationFrame(() => document.getElementById("home-positions")?.scrollIntoView({ behavior: "smooth", block: "start" }));
                    }
                  }}
                />
              </div>
            )}
          </>
        }
        right={
          <div className="flex items-center gap-3">
            {!view.public && accounts.length > 0 && (
              <span className="text-xs text-muted" title="when the newest account state arrived from the venue">as of {ts(Math.max(...accounts.map((a) => a.lastSeen))).slice(11)} UTC</span>
            )}
            <ShareControl instanceId={instanceId} kind="overview" />
          </div>
        }
      />

      <AccountTabs choice={choice} isPublic={view.public} />

      <Loadable loading={liveState.isPending} error={liveState.isError} retry={() => liveState.refetch()} what="the account" shape="kpis" lines={6}>
        {accounts.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted">
            {view.public
              ? `Account figures appear ${view.meta.delayMinutes} minutes behind; none has reached this shared view yet.`
              : noAccountMessage(instanceId, instances.data?.find((i) => i.id === instanceId)?.lastSeen, now)}
          </Card>
        ) : shown == null ? (
          <AccountsTable lines={accountLines} choice={choice} isPublic={view.public} />
        ) : (
          (() => {
            const row = riskRowFor(shown.account, riskRows);
            return (
              <AccountStrip
                key={accountKey(shown.account)}
                account={shown.account}
                labels={shown.labels}
                risk={row}
                realizedToday={row?.dailyLoss.realizedToday ?? realizedFallback}
                dayLabel={row ? dayBasisLabel(row) : dayLabel}
                open={view.public ? null : openRisk(choice.many ? positionsOf(shown) : positions)}
                note={shownNote}
                riskPending={risk.isPending}
                isPublic={view.public}
              />
            );
          })()
        )}
      </Loadable>

      {view.public ? (
        !scoped && <PublicOpenPositions summary={liveState.data?.openPositions ?? null} />
      ) : (
        liveState.data && <OpenPositions positions={positions} now={now} freshness={shownGroups.length ? { at: Math.max(...shownGroups.map((g) => g.at)), stale: shownGroups.every((g) => g.stale) } : null} strategyName={(id) => (byId.get(id) ? strategyDisplayName(byId.get(id)!) : id)} />
      )}

      <Loadable
        loading={summary.isPending || strategies.isPending}
        error={summary.isError || strategies.isError}
        retry={() => { void summary.refetch(); void strategies.refetch(); }}
        what="the strategies"
        lines={8}
      >
        <div id="home-strategies" className="scroll-mt-4">
          <StrategyTable
            lines={lines}
            search
            origin="Home"
            hint={shownName ? `on ${shownName}` : undefined}
            account={scoped || !choice.many ? shownSplit : null}
            mix={scoped ? null : mix}
          />
        </div>
      </Loadable>

      <Loadable loading={summary.isPending} error={summary.isError} retry={() => summary.refetch()} what="the P&L history" shape="chart">
        {summary.data && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <PnlChart days={summary.data.dailyNets} range={range} onRange={(r) => setRange(r, { push: true })} now={now} mix={scoped ? null : mix} />
            </div>
            <MonthCalendar key={utcDay(now).slice(0, 7)} days={summary.data.dailyNets} now={now} mix={scoped ? null : mix} />
          </div>
        )}
      </Loadable>
    </div>
  );
}

/** A shared link's open P&L by strategy is the instance's; an account's tab keeps the strategies that closed on it. */
function scopedFloating(floating: Map<string | null, number>, summary: AccountSummary): Map<string | null, number> {
  const own = new Set(summary.byStrategy.map((b) => b.key));
  return new Map([...floating].filter(([k]) => own.has(k)));
}
