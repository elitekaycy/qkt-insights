import { accountKey, accountName, accountTab, groupAccounts, type AccountGroup } from "../accounts";
import { chartColors } from "../components/EChart";
import { useState } from "react";
import { usePublicPageView, useView } from "../view";
import { useStrategyNames } from "../hooks/useStrategyNames";
import { useSearchParam } from "../router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type AccountEquityPoint, type AccountSummary, type DrawdownPeriod, type EquityPoint, type PerformanceBundle, type StrategyRow } from "../api";
import { AccountTabs, useAccountChoice } from "../components/AccountSwitch";
import { ComparisonChart, EquityChart, UnderwaterChart, type ComparisonSeries } from "../components/EquityChart";
import { DataList, Card, Cell, Empty, Field, Loadable, Modal, PageHeader, Panel, Pill, Select } from "../components/ui";
import { days, duration, fixed, human, pctValue, signedMoney, signedPct, tsDay } from "../format";
import { useLiveState } from "../useLiveState";
import { biggestMovers, deepestId } from "../equity";

const PALETTE = chartColors.series;
/** The drawdown table opens on the deepest few; every period is one click away. */
const PERIODS_SHOWN = 8;

export default function Equity({ instanceId }: { instanceId: string | null }) {
  usePublicPageView("equity");
  const view = useView();
  const liveState = useLiveState();
  const choice = useAccountChoice(groupAccounts((liveState.data?.accounts ?? []).filter((a) => a.instanceId === instanceId)), view.public);
  const scoped = choice.many && choice.chosen ? choice.chosen : null;
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });
  // an account's tab compares the strategies that closed on it: the same roll-up Home reads for that tab
  const accountParam = scoped ? `&account=${encodeURIComponent(accountKey(scoped.account))}` : "";
  const scopedSummary = useQuery({
    queryKey: ["accountSummary", instanceId, accountParam],
    queryFn: () => get<AccountSummary>(`/account/summary?instance=${encodeURIComponent(instanceId!)}${accountParam}`),
    enabled: !!instanceId && !!scoped,
    refetchInterval: 60_000,
  });

  // Broker account curve, 1-minute rollup — refetch matches the flush cadence.
  const account = useQuery({
    queryKey: ["account-equity", instanceId],
    queryFn: () => get<AccountEquityPoint[]>(`/account/equity?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 60000,
  });

  const traded = scoped ? new Set((scopedSummary.data?.byStrategy ?? []).map((b) => b.key)) : null;
  const ids = (strategies.data ?? []).map((s) => s.strategyId).filter((id) => !traded || traded.has(id));
  const curves = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["equity", instanceId, id],
      queryFn: () =>
        get<EquityPoint[]>(`/equity?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 30_000,
    })),
  });

  const [ddStrategy, setDdStrategy] = useSearchParam("strategy");
  const [openDd, setOpenDd] = useState<DrawdownPeriod | null>(null);
  const [allPeriods, setAllPeriods] = useState(false);
  // the comparison shows the four lines that moved most until the viewer picks; underwater opens on the deepest fall
  const [picked, setPicked] = useState<string[] | null>(null);
  const curveList = ids.map((id, i) => ({ id, points: curves[i]?.data ?? [] }));
  const focusId = ids.includes(ddStrategy) ? ddStrategy : deepestId(curveList) ?? ids[0] ?? "";
  const focusIdx = ids.indexOf(focusId);
  const focusCurve = focusIdx >= 0 ? (curves[focusIdx]?.data ?? []) : [];

  const performance = useQuery({
    queryKey: ["performance", instanceId, focusId, "all"],
    queryFn: () =>
      get<PerformanceBundle>(`/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(focusId)}`),
    enabled: !!instanceId && !!focusId,
    refetchInterval: 30_000,
  });

  const strategyName = useStrategyNames(instanceId);
  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const shownIds = picked ?? biggestMovers(curveList);
  const series: ComparisonSeries[] = shownIds
    .map((id, i) => {
      const pts = curves[ids.indexOf(id)]?.data ?? [];
      const base = pts[0]?.equity;
      return {
        name: strategyName(id),
        color: PALETTE[i % PALETTE.length]!,
        points: base ? pts.map((p) => ({ ts: p.ts, pct: (p.equity / base - 1) * 100 })) : [],
      };
    })
    .filter((s) => s.points.length > 0);
  const togglePick = (id: string) => setPicked((cur) => {
    const now = cur ?? shownIds;
    return now.includes(id) ? now.filter((x) => x !== id) : now.length >= PALETTE.length ? now : [...now, id];
  });

  // One curve per venue account: the server stitches the labels one account reported under
  // (by account id, else labels that take turns). EquityChart wants EquityPoint; realized/unrealized
  // are unused by the chart.
  const accountByBrokerMinute = new Map<string, Map<number, EquityPoint>>();
  // the label each account reported under last, for the heading when there are several
  const accountLabel = new Map<string, string>();
  for (const p of account.data ?? []) {
    if (p.equity == null) continue;
    const broker = p.account;
    accountLabel.set(broker, p.broker);
    const byMinute = accountByBrokerMinute.get(broker) ?? new Map<number, EquityPoint>();
    byMinute.set(p.minuteTs, { ts: p.minuteTs, equity: p.equity, realized: p.balance ?? 0, unrealized: p.openProfit ?? 0 });
    accountByBrokerMinute.set(broker, byMinute);
  }
  const accountByBroker = new Map(
    [...accountByBrokerMinute.entries()].map(([broker, byMinute]) => [
      broker,
      [...byMinute.values()].sort((a, b) => a.ts - b.ts),
    ]),
  );
  // the curve of a live account: by its key, else by a label folded into it
  const curveKeyOf = (g: AccountGroup) => [...accountByBroker.keys()].find((k) => k === accountKey(g.account) || g.labels.includes(k) || g.labels.includes(accountLabel.get(k) ?? ""));
  const nameOf = (key: string) => {
    const g = choice.accounts.find((a) => curveKeyOf(a) === key);
    return accountName(g ? g.account : { broker: accountLabel.get(key) ?? key }, view.public);
  };
  const shownCurve = scoped ? curveKeyOf(scoped) : null;
  // one hue rule: real venue accounts take the series colours, paper accounts stay grey
  const isPaperKey = (key: string) => {
    const g = choice.accounts.find((a) => curveKeyOf(a) === key);
    return g != null && (g.account.connector === "paper" || g.account.adapter === "paper");
  };
  let venueIdx = 0;
  const accountSeries: ComparisonSeries[] = [...accountByBroker.entries()].map(([key, pts]) => ({
    name: nameOf(key),
    color: isPaperKey(key) ? chartColors.muted : PALETTE[venueIdx++ % PALETTE.length]!,
    points: pts.length > 0 ? pts.map((p) => ({ ts: p.ts, pct: (p.equity / pts[0]!.equity - 1) * 100 })) : [],
  }));

  const periods = performance.data?.drawdownPeriods ?? [];
  const ddSelect = (
    <Select value={focusId} onChange={(e) => setDdStrategy(e.target.value)}>
      {ids.map((id) => (
        <option key={id} value={id}>
          {strategyName(id)}
        </option>
      ))}
    </Select>
  );

  return (
    <div>
      <PageHeader title="Equity & risk" />
      {choice.many && <div className="mt-4"><AccountTabs choice={choice} isPublic={view.public} /></div>}
      <Panel
        className="mt-5"
        title="Account equity"
        hint={choice.many && !scoped ? "% change" : undefined}
      >
        <Loadable loading={account.isPending} error={account.isError} retry={() => account.refetch()} what="the account curve" shape="chart">
          {accountByBroker.size === 0 ? (
            <Empty>No equity history yet. It shows up after the first account update.</Empty>
          ) : scoped ? (
            shownCurve ? <div className="p-4"><EquityChart points={accountByBroker.get(shownCurve)!} height={320} /></div>
              : <Empty>No equity history for {accountTab(scoped.account, view.public).name} yet.</Empty>
          ) : accountByBroker.size > 1 ? (
            <div className="p-4">
              <ComparisonChart series={accountSeries} height={320} label="Account equity, percent change from each account's first point" />
            </div>
          ) : (
            [...accountByBroker.values()].map((pts, i) => <div key={i} className="p-4"><EquityChart points={pts} height={320} /></div>)
          )}
        </Loadable>
      </Panel>

      <Panel
        className="mt-5"
        title="Strategy equity"
        hint={`% change · ${series.length} of ${ids.length}`}
      >
        <Loadable
          loading={strategies.isPending || (!!scoped && scopedSummary.isPending) || curves.some((c) => c.isPending)}
          error={strategies.isError || scopedSummary.isError || curves.some((c) => c.isError)}
          retry={() => {
            void strategies.refetch();
            curves.forEach((c) => void c.refetch());
          }}
          what="strategy equity"
          lines={4}
        >
          <div className="p-4">
            <ComparisonChart series={series} height={360} />
            {ids.length > series.length || picked != null ? (
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Strategies to compare">
                {ids.map((id) => {
                  const on = shownIds.includes(id);
                  return (
                    <button key={id} type="button" aria-pressed={on} onClick={() => togglePick(id)}
                      className={`h-7 rounded-full border px-2.5 text-xs font-medium transition ${on ? "border-accent-hi/50 bg-accent-soft text-bright" : "border-line bg-raised text-muted hover:text-body"}`}>
                      {strategyName(id)}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </Loadable>
      </Panel>

      <div className="mt-5 grid grid-cols-1 items-start gap-5 2xl:grid-cols-2">
        <Panel title="Underwater" hint="5 deepest shaded" toolbar={ddSelect}>
          <Loadable
            loading={strategies.isPending || (focusIdx >= 0 && (curves[focusIdx]?.isPending ?? false))}
            error={focusIdx >= 0 && (curves[focusIdx]?.isError ?? false)}
            retry={() => void curves[focusIdx]?.refetch()}
            what="the underwater curve"
            shape="chart"
          >
            <div className="grid gap-2 p-4">
              <EquityChart
                points={focusCurve}
                shade={[...periods].sort((a, b) => b.depth - a.depth).slice(0, 5)}
                height={200}
              />
              <UnderwaterChart points={focusCurve} height={140} />
            </div>
          </Loadable>
        </Panel>

        <Panel title="Drawdown periods" hint={focusId ? strategyName(focusId) : undefined}>
          <Loadable
            loading={strategies.isPending || (!!focusId && performance.isPending)}
            error={performance.isError}
            retry={() => performance.refetch()}
            what="drawdown periods"
          >
          <DataList
            head={["Peak (UTC)", "Trough (UTC)", "Depth", "Length", "Recovery"]}
            rows={allPeriods ? periods : [...periods].sort((a, b) => b.depth - a.depth).slice(0, PERIODS_SHOWN)}
            keyOf={(p) => String(p.peakTs)}
            onRow={(p) => setOpenDd(p)}
            empty="No drawdowns yet."
            cells={(p) => (
              <>
                <Cell className="whitespace-nowrap text-muted">{tsDay(p.peakTs).slice(0, 14)}</Cell>
                <Cell className="whitespace-nowrap text-muted">{tsDay(p.troughTs).slice(0, 14)}</Cell>
                <Cell className="text-loss">
                  {signedMoney(-p.depth)} <span className="text-faint">({signedPct(-p.depthPct)})</span>
                </Cell>
                <Cell className="text-muted">{days(p.lengthDays)}</Cell>
                <Cell>
                  {p.recoveryTs != null ? (
                    <Pill tone="ok">recovered {days(p.recoveryDays)}</Pill>
                  ) : (
                    <Pill tone="warn">ongoing</Pill>
                  )}
                </Cell>
              </>
            )}
            card={(p) => (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-loss">{signedMoney(-p.depth)}</span>
                  <span className="text-xs text-faint">({signedPct(-p.depthPct)})</span>
                  <span className="ml-auto shrink-0">
                    {p.recoveryTs != null ? (
                      <Pill tone="ok">recovered {days(p.recoveryDays)}</Pill>
                    ) : (
                      <Pill tone="warn">ongoing</Pill>
                    )}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-faint">
                  <span className="whitespace-nowrap">
                    {tsDay(p.peakTs).slice(4, 14)} → {tsDay(p.troughTs).slice(4, 14)}
                  </span>
                  <span className="ml-auto whitespace-nowrap ">{days(p.lengthDays)}</span>
                </div>
              </>
            )}
          />
          {!allPeriods && periods.length > PERIODS_SHOWN && (
            <button type="button" onClick={() => setAllPeriods(true)} className="w-full border-t border-line px-4 py-2 text-left text-xs font-medium text-accent-ink hover:underline">
              Show all {periods.length}, by date
            </button>
          )}
          </Loadable>
        </Panel>
      </div>

      {openDd && (
        <Modal open onClose={() => setOpenDd(null)} title="Drawdown" hint={focusId} width="min(94vw, 720px)">
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
            <Field label="Peak (equity high before the fall)">{human(openDd.peakTs)}</Field>
            <Field label="Trough (deepest point)">{human(openDd.troughTs)}</Field>
            <Field label="Depth">
              <span className="text-loss">{signedMoney(-openDd.depth)}</span>
              <span className="ml-2 text-xs text-faint">{pctValue(openDd.depthPct)} below the peak</span>
            </Field>
            <Field label="Peak to trough">{duration(openDd.troughTs - openDd.peakTs)}</Field>
            <Field label="Recovered (back at the peak)">
              {openDd.recoveryTs != null ? human(openDd.recoveryTs) : <Pill tone="warn">still ongoing</Pill>}
            </Field>
            <Field label="Time underwater">
              {fixed(openDd.lengthDays, 1)} days
              {openDd.recoveryDays != null && (
                <span className="ml-2 text-xs text-faint">{days(openDd.recoveryDays)} of that climbing back</span>
              )}
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
