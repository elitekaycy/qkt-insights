import { useQuery } from "@tanstack/react-query";
import { get, type HealthRow, type LiveStateSnapshot } from "../api";
import { Cell, Empty, LiveDot, PageHeader, Panel, Pill, Row, Table } from "../components/ui";
import { age, money } from "../format";

export default function Health() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => get<HealthRow[]>("/health/instances"),
    refetchInterval: 5000,
  });
  // The broker poller hits the collector every 10s — the most reliable proof an
  // instance is alive and trading, separate from the last durable event.
  const liveState = useQuery({
    queryKey: ["live-state"],
    queryFn: () => get<LiveStateSnapshot>("/live/state"),
    refetchInterval: 5000,
  });

  const rows = health.data ?? [];
  const accounts = liveState.data?.accounts ?? [];

  return (
    <div>
      <PageHeader title="Health" sub="Every qkt instance the collector has heard from, and the broker poller behind it." />

      <Panel className="mt-6" stagger={1} title="Instances" hint="live = an envelope (incl. the 10s state poll) in the last 30s">
        <Table head={["Instance", "Last event", "Last seq", "Strategies", "Status"]}>
          {rows.length === 0 && (
            <Empty colSpan={5}>No instances reporting yet — enable the insights block on a qkt instance.</Empty>
          )}
          {rows.map((r) => {
            const fresh = Date.now() - r.lastSeen < 30_000;
            return (
              <Row key={r.instanceId}>
                <Cell className="font-semibold text-bright">
                  <span className="flex items-center gap-2.5">
                    <LiveDot on={fresh} />
                    {r.instanceId}
                  </span>
                </Cell>
                <Cell className="text-muted">{age(r.lastSeen)}</Cell>
                <Cell className="font-mono text-muted">{r.lastSeq}</Cell>
                <Cell className="font-mono text-muted">{r.strategies}</Cell>
                <Cell>
                  <Pill tone={fresh ? "up" : "neutral"}>{fresh ? "live" : "idle"}</Pill>
                </Cell>
              </Row>
            );
          })}
        </Table>
      </Panel>

      <Panel className="mt-6" stagger={2} title="Broker state poller" hint="the live account poll — broker-reported, stale after 30s without a poll">
        <Table head={["Instance", "Broker", "Status", "Last poll", "Balance", "Equity", "Open P&L"]}>
          {accounts.length === 0 && <Empty colSpan={7}>No broker account state yet — waiting for the poller.</Empty>}
          {accounts.map((a) => (
            <Row key={`${a.instanceId}:${a.broker}`}>
              <Cell className="font-semibold text-bright">
                <span className="flex items-center gap-2.5">
                  <LiveDot on={!a.stale} />
                  {a.instanceId}
                </span>
              </Cell>
              <Cell className="text-muted">{a.login ? `${a.broker} · #${a.login}` : a.broker}</Cell>
              <Cell>
                <Pill tone={a.stale ? "neutral" : "up"}>{a.stale ? "stale" : "live"}</Pill>
              </Cell>
              <Cell className="text-muted">{age(a.lastSeen)}</Cell>
              <Cell className="font-mono text-muted">{money(a.balance)}</Cell>
              <Cell className="font-mono">{money(a.equity)}</Cell>
              <Cell
                className={`font-mono ${a.openProfit == null ? "text-muted" : a.openProfit > 0 ? "text-up" : a.openProfit < 0 ? "text-down" : "text-muted"}`}
              >
                {money(a.openProfit)}
              </Cell>
            </Row>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
