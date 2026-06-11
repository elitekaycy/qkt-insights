import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type LogRow, type StrategyRow } from "../api";
import { LEVEL_COLOR } from "../components/StatCard";
import { ts } from "../format";
import { useLiveStream } from "../useLiveStream";

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"];

export default function Logs({ instanceId }: { instanceId: string | null }) {
  const [level, setLevel] = useState("");
  const [strategy, setStrategy] = useState("");
  const [q, setQ] = useState("");

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  const logs = useQuery({
    queryKey: ["logs-page", instanceId, level, strategy, q],
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId!, limit: "300" });
      if (level) p.set("level", level);
      if (strategy) p.set("strategy", strategy);
      if (q) p.set("q", q);
      return get<LogRow[]>(`/logs?${p}`);
    },
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  const live = useLiveStream(instanceId, 100);
  const liveLogs = live.filter(
    (e) =>
      e.type === "log" &&
      (!strategy || e.strategyId === strategy) &&
      (!level || e.payload.level === level) &&
      (!q || String(e.payload.message ?? "").toLowerCase().includes(q.toLowerCase())),
  );

  if (!instanceId) return <p className="text-zinc-500">No instance selected.</p>;

  return (
    <div>
      <h2 className="text-xl font-semibold">Logs</h2>
      <p className="mt-1 text-sm text-zinc-500">Engine logs shipped from {instanceId}; live tail on top, history below.</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search logs…"
          className="w-64 rounded bg-zinc-800 p-1.5 text-sm outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded bg-zinc-800 p-1.5 text-sm">
          <option value="">any level</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="rounded bg-zinc-800 p-1.5 text-sm">
          <option value="">all strategies</option>
          {(strategies.data ?? []).map((s) => (
            <option key={s.strategyId} value={s.strategyId}>
              {s.strategyId}
            </option>
          ))}
        </select>
      </div>

      {liveLogs.length > 0 && (
        <div className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/20">
          <div className="border-b border-emerald-900/60 px-3 py-1.5 text-xs font-semibold text-emerald-400">LIVE</div>
          {liveLogs.slice(0, 20).map((e) => (
            <LogLine
              key={`${e.instanceId}-${e.id}`}
              log={{
                id: e.id,
                strategyId: e.strategyId ?? null,
                level: String(e.payload.level) as LogRow["level"],
                logger: String(e.payload.logger ?? ""),
                message: String(e.payload.message ?? ""),
                ts: e.ts,
              }}
            />
          ))}
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-lg border border-zinc-800">
        {(logs.data ?? []).map((l) => (
          <LogLine key={l.id} log={l} />
        ))}
        {(logs.data ?? []).length === 0 && <div className="p-6 text-center text-zinc-600">No logs match</div>}
      </div>
    </div>
  );
}

function LogLine({ log }: { log: LogRow }) {
  return (
    <div className="flex items-start gap-2 border-t border-zinc-800/70 px-3 py-1.5 font-mono text-xs first:border-t-0">
      <span className="whitespace-nowrap text-zinc-500">{ts(log.ts)}</span>
      <span className={`rounded-full px-1.5 ${LEVEL_COLOR[log.level] ?? ""}`}>{log.level}</span>
      {log.strategyId && <span className="text-zinc-500">[{log.strategyId}]</span>}
      <span className="break-all text-zinc-300">{log.message}</span>
      <span className="ml-auto hidden whitespace-nowrap text-zinc-600 lg:inline">{log.logger.split(".").pop()}</span>
    </div>
  );
}
