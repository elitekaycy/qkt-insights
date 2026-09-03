import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { get, type AccountEquityPoint, type DrawdownPeriod, type EquityPoint, type PerformanceBundle, type StrategyRow } from "../api";
import { ComparisonChart, EquityChart, UnderwaterChart, type ComparisonSeries } from "../components/EquityChart";
import { DataList, Card, Cell, Empty, Field, Loadable, Modal, PageHeader, Panel, Pill, Row, Select, Table } from "../components/ui";
import { duration, human, money, tsDay } from "../format";

const PALETTE = ["#c8f74a", "#5cb8ff", "#a78bfa", "#3fe08c", "#fbbf24", "#ff6b6b", "#f472b6", "#22d3ee"];

function accountBrokerGroup(broker: string): string {
  return broker.replace(/_S\d+$/u, "");
}

export default function Equity({ instanceId }: { instanceId: string | null }) {
  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  // Broker account curve, 1-minute rollup — refetch matches the flush cadence.
  const account = useQuery({
    queryKey: ["account-equity", instanceId],
    queryFn: () => get<AccountEquityPoint[]>(`/account/equity?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 60000,
  });

  const ids = (strategies.data ?? []).map((s) => s.strategyId);
  const curves = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["equity", instanceId, id],
      queryFn: () =>
        get<EquityPoint[]>(`/equity?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(id)}`),
      refetchInterval: 30_000,
    })),
  });

  const [ddStrategy, setDdStrategy] = useState("");
  const [openDd, setOpenDd] = useState<DrawdownPeriod | null>(null);
  const focusId = ddStrategy || ids[0] || "";
  const focusIdx = ids.indexOf(focusId);
  const focusCurve = focusIdx >= 0 ? (curves[focusIdx]?.data ?? []) : [];

  const performance = useQuery({
    queryKey: ["performance", instanceId, focusId, "all"],
    queryFn: () =>
      get<PerformanceBundle>(`/performance?instance=${encodeURIComponent(instanceId!)}&strategy=${encodeURIComponent(focusId)}`),
    enabled: !!instanceId && !!focusId,
    refetchInterval: 30_000,
  });

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

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

  // EquityChart wants EquityPoint; realized/unrealized are unused by the chart.
  const accountByBrokerMinute = new Map<string, Map<number, EquityPoint>>();
  for (const p of account.data ?? []) {
    if (p.equity == null) continue;
    const broker = accountBrokerGroup(p.broker);
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

  const periods = performance.data?.drawdownPeriods ?? [];
  const ddSelect = (
    <Select value={focusId} onChange={(e) => setDdStrategy(e.target.value)}>
      {ids.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </Select>
  );

  return (
    <div>
      <PageHeader
        title="Equity"
        sub={`Broker account equity for ${instanceId}; per-strategy equity below, normalized to % change so different capital sizes compare fairly.`}
        right={
          <div className="flex flex-wrap gap-2">
            {series.map((s) => (
              <Pill key={s.strategyId}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.strategyId}
              </Pill>
            ))}
          </div>
        }
      />
      <Panel className="mt-5" stagger={1} title="Account equity" hint="broker-reported, 1-minute rollup">
        <Loadable loading={account.isPending} error={account.isError} retry={() => account.refetch()} what="the account curve" lines={4}>
          {accountByBroker.size === 0 ? (
            <Empty>No account history yet — waiting for the broker state poller.</Empty>
          ) : (
            [...accountByBroker.entries()].map(([broker, pts]) => (
              <div key={broker} className="p-4">
                {accountByBroker.size > 1 && (
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{broker}</div>
                )}
                <EquityChart points={pts} height={320} />
              </div>
            ))
          )}
        </Loadable>
      </Panel>

      <Panel className="mt-5" stagger={2} title="Strategy equity" hint="broker deals when available, % change from first point">
        <Loadable
          loading={strategies.isPending || curves.some((c) => c.isPending)}
          error={strategies.isError || curves.some((c) => c.isError)}
          retry={() => {
            void strategies.refetch();
            curves.forEach((c) => void c.refetch());
          }}
          what="strategy equity"
          lines={4}
        >
          <div className="p-4">
            <ComparisonChart series={series} height={360} />
          </div>
        </Loadable>
      </Panel>

      <div className="mt-5 grid grid-cols-1 gap-5 2xl:grid-cols-2">
        <Panel stagger={2} title="Underwater" hint="5 deepest drawdowns shaded on the curve, depth below" toolbar={ddSelect}>
          <Loadable
            loading={strategies.isPending || (focusIdx >= 0 && (curves[focusIdx]?.isPending ?? false))}
            error={focusIdx >= 0 && (curves[focusIdx]?.isError ?? false)}
            retry={() => void curves[focusIdx]?.refetch()}
            what="the underwater curve"
            lines={4}
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

        <Panel stagger={3} title="Drawdown periods" hint={`${focusId} · click a row to inspect`}>
          <Loadable
            loading={!!focusId && performance.isPending}
            error={performance.isError}
            retry={() => performance.refetch()}
            what="drawdown periods"
          >
          <DataList
            head={["Peak", "Trough", "Depth", "Length", "Recovery"]}
            rows={periods}
            keyOf={(p) => String(p.peakTs)}
            onRow={(p) => setOpenDd(p)}
            empty="No drawdowns recorded — flat or rising equity."
            cells={(p) => (
              <>
                <Cell className="whitespace-nowrap text-muted">{tsDay(p.peakTs).slice(0, 14)}</Cell>
                <Cell className="whitespace-nowrap text-muted">{tsDay(p.troughTs).slice(0, 14)}</Cell>
                <Cell className="font-mono text-down">
                  {money(-p.depth)} <span className="text-faint">({p.depthPct.toFixed(2)}%)</span>
                </Cell>
                <Cell className="font-mono text-muted">{p.lengthDays.toFixed(1)}d</Cell>
                <Cell>
                  {p.recoveryTs != null ? (
                    <Pill tone="up">recovered {p.recoveryDays!.toFixed(1)}d</Pill>
                  ) : (
                    <Pill tone="warn">ongoing</Pill>
                  )}
                </Cell>
              </>
            )}
            card={(p) => (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold text-down">{money(-p.depth)}</span>
                  <span className="font-mono text-xs text-faint">({p.depthPct.toFixed(2)}%)</span>
                  <span className="ml-auto shrink-0">
                    {p.recoveryTs != null ? (
                      <Pill tone="up">recovered {p.recoveryDays!.toFixed(1)}d</Pill>
                    ) : (
                      <Pill tone="warn">ongoing</Pill>
                    )}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-faint">
                  <span className="whitespace-nowrap">
                    {tsDay(p.peakTs).slice(4, 14)} → {tsDay(p.troughTs).slice(4, 14)}
                  </span>
                  <span className="ml-auto whitespace-nowrap font-mono">{p.lengthDays.toFixed(1)}d</span>
                </div>
              </>
            )}
          />
          </Loadable>
        </Panel>
      </div>

      {openDd && (
        <Modal open onClose={() => setOpenDd(null)} title="Drawdown" hint={focusId} width="min(94vw, 720px)">
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
            <Field label="Peak (equity high before the fall)">{human(openDd.peakTs)}</Field>
            <Field label="Trough (deepest point)">{human(openDd.troughTs)}</Field>
            <Field label="Depth">
              <span className="text-down">{money(-openDd.depth)}</span>
              <span className="ml-2 text-xs text-faint">{openDd.depthPct.toFixed(2)}% below the peak</span>
            </Field>
            <Field label="Peak to trough">{duration(openDd.troughTs - openDd.peakTs)}</Field>
            <Field label="Recovered (back at the peak)">
              {openDd.recoveryTs != null ? human(openDd.recoveryTs) : <Pill tone="warn">still ongoing</Pill>}
            </Field>
            <Field label="Time underwater">
              {openDd.lengthDays.toFixed(1)} days
              {openDd.recoveryDays != null && (
                <span className="ml-2 text-xs text-faint">{openDd.recoveryDays.toFixed(1)}d of that climbing back</span>
              )}
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
