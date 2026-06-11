import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type LogRow, type SearchHit } from "../api";
import { Button, Card, Empty, LEVEL_TONE, PageHeader, Panel, Pill, SearchInput } from "../components/ui";
import { ts } from "../format";

export default function Search({ instanceId }: { instanceId: string | null }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");

  const events = useQuery({
    queryKey: ["search-events", instanceId, q],
    queryFn: () => get<SearchHit[]>(`/search?q=${encodeURIComponent(q)}&instance=${encodeURIComponent(instanceId!)}&limit=100`),
    enabled: !!instanceId && q.length > 0,
  });
  const logs = useQuery({
    queryKey: ["search-logs", instanceId, q],
    queryFn: () => get<LogRow[]>(`/logs?instance=${encodeURIComponent(instanceId!)}&q=${encodeURIComponent(q)}&limit=100`),
    enabled: !!instanceId && q.length > 0,
  });

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const eventHits = events.data ?? [];
  const logHits = logs.data ?? [];

  return (
    <div>
      <PageHeader title="Search" sub={`Full-text search across every event and log line of ${instanceId}.`} />

      <form
        className="rise mt-5 flex gap-2"
        style={{ "--stagger": 1 } as React.CSSProperties}
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
      >
        <SearchInput
          value={input}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          placeholder="symbol, order id, reason, log text…"
          className="w-full max-w-xl"
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      {q && (
        <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-2">
          <Panel stagger={0} title="Events" hint={`${eventHits.length} hits`} scroll="max-h-[30rem]">
            <div className="p-2">
              {eventHits.map((h) => (
                <div key={h.id} className="border-b border-line/50 px-2 py-2 font-mono text-xs last:border-b-0">
                  <span className="text-faint">{ts(h.ts)}</span> <span className="text-info">{h.type}</span>{" "}
                  <span className="break-all text-body">{JSON.stringify(h.payload)}</span>
                </div>
              ))}
              {eventHits.length === 0 && <Empty>No event hits</Empty>}
            </div>
          </Panel>
          <Panel stagger={1} title="Logs" hint={`${logHits.length} hits`} scroll="max-h-[30rem]">
            <div className="p-2">
              {logHits.map((l) => (
                <div key={l.id} className="flex items-start gap-2 border-b border-line/50 px-2 py-2 font-mono text-xs last:border-b-0">
                  <span className="whitespace-nowrap text-faint">{ts(l.ts)}</span>
                  <Pill tone={LEVEL_TONE[l.level] ?? "neutral"}>{l.level}</Pill>
                  <span className="break-all text-body">{l.message}</span>
                </div>
              ))}
              {logHits.length === 0 && <Empty>No log hits</Empty>}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
