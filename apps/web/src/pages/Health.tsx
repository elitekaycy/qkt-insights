import { useQuery } from "@tanstack/react-query";
import { get, type HealthRow } from "../api";
import { Cell, Empty, LiveDot, PageHeader, Panel, Pill, Row, Table } from "../components/ui";
import { age } from "../format";

export default function Health() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => get<HealthRow[]>("/health/instances"),
    refetchInterval: 5000,
  });

  const rows = health.data ?? [];

  return (
    <div>
      <PageHeader title="Health" sub="Every qkt instance the collector has heard from." />
      <Panel className="mt-6" stagger={1} title="Instances">
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
    </div>
  );
}
