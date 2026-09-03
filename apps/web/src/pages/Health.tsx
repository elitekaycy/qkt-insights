import { Fragment, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type HealthRow, type LiveAccount, type LiveStateSnapshot } from "../api";
import { Cell, DataList, Empty, LiveDot, PageHeader, Panel, Pill, Row, Table } from "../components/ui";
import { age, money } from "../format";

function sinkTone(row: HealthRow): "neutral" | "up" | "down" {
  if (row.insightsSent == null) return "neutral";
  return (row.insightsFailed ?? 0) > 0 || (row.insightsDropped ?? 0) > 0 ? "down" : "up";
}

function journalLabel(row: HealthRow): string {
  if (row.insightsSent == null) return "unknown";
  if (!row.insightsJournalEnabled) return "off";
  return `${row.insightsJournalPending ?? 0} pending`;
}

function accountSummary(accounts: LiveAccount[]): LiveAccount | null {
  if (accounts.length === 0) return null;
  return accounts.reduce((best, cur) => (cur.lastSeen > best.lastSeen ? cur : best), accounts[0]!);
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-[0.1em] text-faint">{label}</div>
      <div className={`truncate ${mono ? "font-mono" : ""} text-bright`}>{children}</div>
    </div>
  );
}

/** Collector delivery counters plus every broker account the instance reports. */
function InstanceDetail({ row, accounts }: { row: HealthRow; accounts: LiveAccount[] }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_2fr]">
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Collector delivery</div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <Fact label="sent" mono>
            {row.insightsSent ?? "—"}
          </Fact>
          <Fact label="queued" mono>
            {row.insightsQueued ?? "—"}
          </Fact>
          <Fact label="health pulse" mono>
            {row.insightsHealthTs == null ? "—" : age(row.insightsHealthTs)}
          </Fact>
          <Fact label="journal" mono>
            {journalLabel(row)}
          </Fact>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-panel">
        <DataList
          head={["Broker", "Status", "Last poll", "Balance", "Equity", "Open P&L", "Server"]}
          rows={accounts}
          keyOf={(a) => `${a.instanceId}:${a.broker}`}
          empty="No broker account state yet — waiting for the state poller."
          cells={(a) => (
            <>
              <Cell className="font-semibold text-bright">{a.login ? `${a.broker} · #${a.login}` : a.broker}</Cell>
              <Cell>
                <Pill tone={a.stale ? "neutral" : "up"}>{a.stale ? "stale" : "live"}</Pill>
              </Cell>
              <Cell className="whitespace-nowrap text-muted">{age(a.lastSeen)}</Cell>
              <Cell className="font-mono text-muted">{money(a.balance)}</Cell>
              <Cell className="font-mono text-bright">{money(a.equity)}</Cell>
              <Cell className={`font-mono ${openTone(a.openProfit)}`}>{money(a.openProfit)}</Cell>
              <Cell className="text-muted">{a.server ?? a.name ?? "—"}</Cell>
            </>
          )}
          card={(a) => (
            <>
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold text-bright">{a.login ? `${a.broker} · #${a.login}` : a.broker}</span>
                <Pill tone={a.stale ? "neutral" : "up"}>{a.stale ? "stale" : "live"}</Pill>
                <span className="ml-auto whitespace-nowrap text-xs text-muted">{age(a.lastSeen)}</span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
                <Fact label="balance" mono>
                  {money(a.balance)}
                </Fact>
                <Fact label="equity" mono>
                  {money(a.equity)}
                </Fact>
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.1em] text-faint">open p&l</div>
                  <div className={`truncate font-mono ${openTone(a.openProfit)}`}>{money(a.openProfit)}</div>
                </div>
              </div>
            </>
          )}
        />
      </div>
    </div>
  );
}

function openTone(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-muted";
  return v > 0 ? "text-up" : "text-down";
}

export default function Health() {
  const [openInstance, setOpenInstance] = useState<string | null>(null);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => get<HealthRow[]>("/health/instances"),
    refetchInterval: 15_000,
  });
  const liveState = useQuery({
    queryKey: ["live-state"],
    queryFn: () => get<LiveStateSnapshot>("/live/state"),
    refetchInterval: 15_000,
  });

  const rows = health.data ?? [];
  const accounts = liveState.data?.accounts ?? [];

  return (
    <div>
      <PageHeader title="Health" sub="Runtime status, collector delivery, and broker account truth in one place." />

      <Panel className="mt-6" stagger={1} title="Runtime health" hint="live = recent qkt envelope or broker account poll within 30s" scroll="max-h-[72vh]">
        <ul className="divide-y divide-line/60 sm:hidden">
          {rows.length === 0 && (
            <li className="px-4 py-10 text-center text-sm text-faint">No instances reporting yet — enable the insights block on a qkt instance.</li>
          )}
          {rows.map((r) => {
            const rowAccounts = accounts.filter((a) => a.instanceId === r.instanceId);
            const acct = accountSummary(rowAccounts);
            const fresh = Date.now() - r.lastSeen < 30_000 || (acct != null && !acct.stale);
            const expanded = openInstance === r.instanceId;
            return (
              <li key={r.instanceId} className="px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <LiveDot on={fresh} />
                  <span className="truncate font-semibold text-bright">{r.instanceId}</span>
                  <Pill tone={fresh ? "up" : "neutral"}>{fresh ? "live" : "idle"}</Pill>
                  <span className="ml-auto whitespace-nowrap text-xs text-muted">{age(r.lastSeen)}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <Fact label="broker">{acct ? (acct.login ? `${acct.broker} · #${acct.login}` : acct.broker) : "—"}</Fact>
                  <Fact label="equity" mono>
                    {acct ? money(acct.equity) : "—"}
                  </Fact>
                  <Fact label="seq" mono>
                    {r.lastSeq}
                  </Fact>
                  <Fact label="strategies" mono>
                    {r.strategies}
                  </Fact>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Pill tone={sinkTone(r)}>
                    {r.insightsSent == null ? "unknown" : `${r.insightsFailed ?? 0} failed · ${r.insightsDropped ?? 0} dropped`}
                  </Pill>
                  <Pill tone={r.insightsJournalPending == null ? "neutral" : r.insightsJournalPending > 0 ? "warn" : "up"}>
                    journal {journalLabel(r)}
                  </Pill>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpenInstance(expanded ? null : r.instanceId)}
                    className="ml-auto rounded-lg border border-line bg-raised px-3 text-xs font-semibold text-muted transition active:bg-line"
                  >
                    {expanded ? "hide" : "details"}
                  </button>
                </div>
                {expanded && (
                  <div className="mt-3">
                    <InstanceDetail row={r} accounts={rowAccounts} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="hidden sm:block">
        <Table head={["Instance", "Status", "Last event", "Seq", "Strategies", "Broker", "Equity", "Sink", "Journal", ""]}>
          {rows.length === 0 && <Empty colSpan={10}>No instances reporting yet — enable the insights block on a qkt instance.</Empty>}
          {rows.map((r) => {
            const rowAccounts = accounts.filter((a) => a.instanceId === r.instanceId);
            const acct = accountSummary(rowAccounts);
            const eventFresh = Date.now() - r.lastSeen < 30_000;
            const brokerFresh = acct != null && !acct.stale;
            const fresh = eventFresh || brokerFresh;
            const expanded = openInstance === r.instanceId;
            return (
              <Fragment key={r.instanceId}>
                <Row>
                  <Cell className="font-semibold text-bright">
                    <span className="flex items-center gap-2.5">
                      <LiveDot on={fresh} />
                      {r.instanceId}
                    </span>
                  </Cell>
                  <Cell>
                    <Pill tone={fresh ? "up" : "neutral"}>{fresh ? "live" : "idle"}</Pill>
                  </Cell>
                  <Cell className="whitespace-nowrap text-muted">{age(r.lastSeen)}</Cell>
                  <Cell className="font-mono text-muted">{r.lastSeq}</Cell>
                  <Cell className="font-mono text-muted">{r.strategies}</Cell>
                  <Cell className="text-muted">{acct ? (acct.login ? `${acct.broker} · #${acct.login}` : acct.broker) : "—"}</Cell>
                  <Cell className="font-mono text-bright">{acct ? money(acct.equity) : "—"}</Cell>
                  <Cell>
                    <Pill tone={sinkTone(r)}>
                      {r.insightsSent == null ? "unknown" : `${r.insightsFailed ?? 0} failed · ${r.insightsDropped ?? 0} dropped`}
                    </Pill>
                  </Cell>
                  <Cell>
                    <Pill tone={r.insightsJournalPending == null ? "neutral" : r.insightsJournalPending > 0 ? "warn" : "up"}>
                      {journalLabel(r)}
                    </Pill>
                  </Cell>
                  <Cell className="text-right">
                    <button
                      type="button"
                      onClick={() => setOpenInstance(expanded ? null : r.instanceId)}
                      className="rounded-lg border border-line bg-raised px-2.5 py-1 text-xs font-semibold text-muted transition hover:border-line-strong hover:text-body"
                    >
                      {expanded ? "hide" : "details"}
                    </button>
                  </Cell>
                </Row>
                {expanded && (
                  <tr key={`${r.instanceId}:details`} className="border-b border-line/60">
                    <td colSpan={10} className="bg-ink/35 px-4 py-4">
                      <InstanceDetail row={r} accounts={rowAccounts} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </Table>
        </div>
      </Panel>
    </div>
  );
}
