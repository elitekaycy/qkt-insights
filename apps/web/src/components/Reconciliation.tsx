import { useQueries } from "@tanstack/react-query";
import { get, type AccountReconciliation, type ReconciledDay, type ReconciliationView } from "../api";
import { useRoute } from "../router";
import { count, glyph, signedMoney } from "../format";
import {
  DAY_REASON, EMPTY_TEXT, checkedLabel, dayCounts, dayMonth, dayTradesPath, ledgerLine, positionIssues, positionsLine, verdict, type ReconciliationTone,
} from "../reconciliation";
import { Cell, DataList, InfoIcon, Panel, Pnl, Popover, Skeleton, StatusWord, type Tone } from "./ui";

const TONE: Record<ReconciliationTone, Tone> = { ok: "ok", bad: "bad", neutral: "neutral" };

const HINT = "every night at 02:00 UTC, from what qkt sends · each UTC day's balance change against the account's deals, open positions against the venue, round trips against their deals · tap a differing day for its trades";

/** What no stored deal explains: a signed amount with its glyph, never coloured as P&L. */
function Unexplained({ value, digits }: { value: number | null; digits: number }) {
  if (value == null) return <span className="text-faint">—</span>;
  const g = glyph(value, digits);
  return <span className="whitespace-nowrap font-semibold text-bright">{g ? `${g} ` : ""}{signedMoney(value, digits)}</span>;
}

/** "Sat 3 Oct 2026" for "2026-10-03". */
function dayLabel(day: string): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T00:00:00Z`).getUTCDay()];
  return `${weekday} ${dayMonth(day)} ${day.slice(0, 4)}`;
}

/** A tap-to-open list behind a one-line result. */
function Details({ label, lines }: { label: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <Popover label={label} trigger={<span className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink"><InfoIcon className="h-3.5 w-3.5" />details</span>}>
      <ul className="space-y-1">
        {lines.map((l) => (
          <li key={l} className="font-mono text-[11px] text-body">{l}</li>
        ))}
      </ul>
    </Popover>
  );
}

function DiffDays({ days, digits, onDay }: { days: ReconciledDay[]; digits: number; onDay: (d: ReconciledDay) => void }) {
  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-line">
      <DataList
        head={["Day (UTC)", "Balance change", "Deals sum", "Unexplained", "Deals", "Why", ""]}
        rows={days}
        keyOf={(d) => d.day}
        onRow={onDay}
        empty=""
        cells={(d) => (
          <>
            <Cell className="whitespace-nowrap text-bright">{dayLabel(d.day)}</Cell>
            <Cell><Pnl value={d.balanceChange} /></Cell>
            <Cell><Pnl value={d.dealNet} /></Cell>
            <Cell><Unexplained value={d.diff} digits={digits} /></Cell>
            <Cell className="text-muted">{count(d.deals)}</Cell>
            <Cell className="min-w-[16rem] text-xs text-muted">{d.reason ? DAY_REASON[d.reason] : "—"}</Cell>
            <Cell className="whitespace-nowrap text-right text-xs font-medium text-accent-ink">trades →</Cell>
          </>
        )}
        card={(d) => (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-bright">{dayLabel(d.day)}</span>
              <span className="ml-auto text-right text-sm"><Unexplained value={d.diff} digits={digits} /></span>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.06em] text-faint">balance</div>
                <Pnl value={d.balanceChange} />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.06em] text-faint">deals sum</div>
                <Pnl value={d.dealNet} />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.06em] text-faint">deals</div>
                <span className="text-bright">{count(d.deals)}</span>
              </div>
            </div>
            <div className="mt-1.5 text-xs text-muted">{d.reason ? DAY_REASON[d.reason] : ""}</div>
            <div className="mt-1 text-xs font-medium text-accent-ink">Open the day's trades →</div>
          </>
        )}
      />
    </div>
  );
}

function AccountBlock({ a, view, showInstance }: { a: AccountReconciliation; view: ReconciliationView; showInstance: boolean }) {
  const { navigate } = useRoute();
  const v = verdict(a);
  const positions = positionsLine(a.positions);
  const ledger = ledgerLine(a.ledger, view.digits);
  const diffs = a.days.filter((d) => d.status === "diff");
  const incomplete = a.days.filter((d) => d.status === "incomplete");
  return (
    <li className="min-w-0 px-4 py-3.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-semibold text-bright">{a.label}</span>
        {showInstance && <span className="truncate font-mono text-[11px] text-faint">{view.instanceId}</span>}
        <StatusWord tone={TONE[v.tone]}>{v.text}</StatusWord>
        <span className="text-xs text-muted">{checkedLabel(a.checkedAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
        <span>{dayCounts(a)}</span>
        {a.firstDay && <span className="text-faint">since {dayMonth(a.firstDay)} {a.firstDay.slice(0, 4)}</span>}
        <Details label="Incomplete days" lines={incomplete.map((d) => `${d.day}: ${d.reason ? DAY_REASON[d.reason] : "incomplete"}`)} />
      </div>
      {diffs.length > 0 && (
        <DiffDays days={diffs} digits={view.digits} onDay={(d) => navigate(dayTradesPath(view.instanceId, d.day), { from: "Health · Reconciliation" })} />
      )}
      <ul className="mt-2.5 space-y-1.5">
        <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusWord tone={TONE[positions.tone]} wrap>
            {positions.text}
          </StatusWord>
          <Details label="Positions that differ" lines={positionIssues(a.positions)} />
        </li>
        <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StatusWord tone={TONE[ledger.tone]} wrap>
            {ledger.text}
          </StatusWord>
          <Details label="Round trips that differ from their deals" lines={a.ledger.mismatched.map((t) => `#${t.ticket}: trip ${signedMoney(t.realized, view.digits)}, deals ${signedMoney(t.dealsNet, view.digits)}`)} />
        </li>
      </ul>
    </li>
  );
}

/** The Health page's Reconciliation card: every venue account of every reporting instance. */
export function ReconciliationCard({ instances }: { instances: string[] }) {
  const results = useQueries({
    queries: instances.map((i) => ({
      queryKey: ["reconciliation", i],
      queryFn: () => get<ReconciliationView>(`/health/reconciliation?instance=${encodeURIComponent(i)}`),
      refetchInterval: 60_000,
    })),
  });
  const views = results.flatMap((r) => (r.data ? [r.data] : []));
  const loading = results.some((r) => r.isLoading);
  const failed = results.some((r) => r.isError && !r.data);
  const accounts = views.flatMap((view) => view.accounts.map((a) => ({ view, a })));
  return (
    <Panel className="mt-6" title="Reconciliation" hint={HINT}>
      {loading && accounts.length === 0 && <Skeleton lines={3} className="p-4" />}
      {failed && <div className="px-4 py-3 text-sm text-loss">Could not load a reconciliation from the collector. Retrying.</div>}
      {!loading && !failed && accounts.length === 0 && <div className="px-4 py-10 text-center text-sm text-faint">{EMPTY_TEXT}</div>}
      {accounts.length > 0 && (
        <ul className="divide-y divide-line/60">
          {accounts.map(({ view, a }) => (
            <AccountBlock key={`${view.instanceId}:${a.account}`} a={a} view={view} showInstance={instances.length > 1} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
