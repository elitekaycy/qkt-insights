import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type LogRow, type SearchHit } from "../api";
import { LEVEL_COLOR } from "../components/StatCard";
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

  if (!instanceId) return <p className="text-zinc-500">No instance selected.</p>;

  const eventHits = events.data ?? [];
  const logHits = logs.data ?? [];

  return (
    <div>
      <h2 className="text-xl font-semibold">Search</h2>
      <p className="mt-1 text-sm text-zinc-500">Full-text search across every event and log line of {instanceId}.</p>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(input.trim());
        }}
      >
        <input
          value={input}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          placeholder="symbol, order id, reason, log text…"
          className="w-96 rounded bg-zinc-800 p-2 text-sm outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <button type="submit" className="rounded bg-zinc-100 px-4 text-sm font-medium text-zinc-900">
          Search
        </button>
      </form>

      {q && (
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          <section>
            <h3 className="text-sm font-semibold text-zinc-400">
              Events <span className="text-zinc-600">({eventHits.length})</span>
            </h3>
            <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
              {eventHits.map((h) => (
                <div key={h.id} className="border-t border-zinc-800/70 px-3 py-2 text-xs first:border-t-0">
                  <span className="text-zinc-500">{ts(h.ts)}</span> <span className="text-sky-400">{h.type}</span>{" "}
                  <span className="break-all font-mono text-zinc-300">{JSON.stringify(h.payload)}</span>
                </div>
              ))}
              {eventHits.length === 0 && <div className="p-4 text-center text-sm text-zinc-600">No event hits</div>}
            </div>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-zinc-400">
              Logs <span className="text-zinc-600">({logHits.length})</span>
            </h3>
            <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
              {logHits.map((l) => (
                <div key={l.id} className="flex items-start gap-2 border-t border-zinc-800/70 px-3 py-2 text-xs first:border-t-0">
                  <span className="whitespace-nowrap text-zinc-500">{ts(l.ts)}</span>
                  <span className={`rounded-full px-1.5 ${LEVEL_COLOR[l.level] ?? ""}`}>{l.level}</span>
                  <span className="break-all text-zinc-300">{l.message}</span>
                </div>
              ))}
              {logHits.length === 0 && <div className="p-4 text-center text-sm text-zinc-600">No log hits</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
