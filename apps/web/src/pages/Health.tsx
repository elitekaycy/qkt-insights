import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type HealthRow, type LiveAccount, type LiveStateSnapshot } from "../api";
import { Cell, Empty, LiveDot, PageHeader, Panel, Pill, Row, Table } from "../components/ui";
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

export default function Health() {
  const [openInstance, setOpenInstance] = useState<string | null>(null);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => get<HealthRow[]>("/health/instances"),
    refetchInterval: 5000,
  });
  const liveState = useQuery({
    queryKey: ["live-state"],
    queryFn: () => get<LiveStateSnapshot>("/live/state"),
    refetchInterval: 5000,
  });

  const rows = health.data ?? [];
  const accounts = liveState.data?.accounts ?? [];

  return (
    <div>
      <PageHeader title="Health" sub="Runtime status, collector delivery, and broker account truth in one place." />

      <Panel className="mt-6" stagger={1} title="Runtime health" hint="live = recent qkt envelope or broker account poll within 30s" scroll="max-h-[72vh]">
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
                      <div className="grid gap-4 xl:grid-cols-[1.2fr_2fr]">
                        <div className="rounded-lg border border-line bg-panel p-4">
                          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Collector delivery</div>
                          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                            <div>
                              <div className="text-faint">sent</div>
                              <div className="font-mono text-bright">{r.insightsSent ?? "—"}</div>
                            </div>
                            <div>
                              <div className="text-faint">queued</div>
                              <div className="font-mono text-bright">{r.insightsQueued ?? "—"}</div>
                            </div>
                            <div>
                              <div className="text-faint">health pulse</div>
                              <div className="font-mono text-bright">{r.insightsHealthTs == null ? "—" : age(r.insightsHealthTs)}</div>
                            </div>
                            <div>
                              <div className="text-faint">journal</div>
                              <div className="font-mono text-bright">{journalLabel(r)}</div>
                            </div>
                          </div>
                        </div>
                        <div className="rounded-lg border border-line bg-panel">
                          <Table head={["Broker", "Status", "Last poll", "Balance", "Equity", "Open P&L", "Server"]}>
                            {rowAccounts.length === 0 && <Empty colSpan={7}>No broker account state yet — waiting for the state poller.</Empty>}
                            {rowAccounts.map((a) => (
                              <Row key={`${a.instanceId}:${a.broker}`}>
                                <Cell className="font-semibold text-bright">{a.login ? `${a.broker} · #${a.login}` : a.broker}</Cell>
                                <Cell>
                                  <Pill tone={a.stale ? "neutral" : "up"}>{a.stale ? "stale" : "live"}</Pill>
                                </Cell>
                                <Cell className="whitespace-nowrap text-muted">{age(a.lastSeen)}</Cell>
                                <Cell className="font-mono text-muted">{money(a.balance)}</Cell>
                                <Cell className="font-mono text-bright">{money(a.equity)}</Cell>
                                <Cell className={`font-mono ${a.openProfit == null ? "text-muted" : a.openProfit > 0 ? "text-up" : a.openProfit < 0 ? "text-down" : "text-muted"}`}>
                                  {money(a.openProfit)}
                                </Cell>
                                <Cell className="text-muted">{a.server ?? a.name ?? "—"}</Cell>
                              </Row>
                            ))}
                          </Table>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </Table>
      </Panel>
    </div>
  );
}
