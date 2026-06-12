import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type LogRow, type StrategyRow } from "../api";
import {
  Card, Empty, LEVEL_TONE, LoadMore, PageHeader, Panel, Pill, QueryError, RangeSelect, rangeStart, SearchInput, Select,
  type RangeKey,
} from "../components/ui";
import { ts } from "../format";
import { useLiveStream } from "../useLiveStream";

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"];
const LOG_TYPES = ["log"];

export default function Logs({ instanceId }: { instanceId: string | null }) {
  const [level, setLevel] = useState("");
  const [strategy, setStrategy] = useState("");
  const [q, setQ] = useState("");
  const [range, setRange] = useState<RangeKey>("all");
  const [cap, setCap] = useState(30);

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });

  const logs = useQuery({
    queryKey: ["logs-page", instanceId, level, strategy, q],
    queryFn: () => {
      const p = new URLSearchParams({ instance: instanceId!, limit: "1000" });
      if (level) p.set("level", level);
      if (strategy) p.set("strategy", strategy);
      if (q) p.set("q", q);
      return get<LogRow[]>(`/logs?${p}`);
    },
    enabled: !!instanceId,
    refetchInterval: 5000,
  });

  const live = useLiveStream(instanceId, 100, LOG_TYPES);
  const liveLogs = live.filter(
    (e) =>
      e.type === "log" &&
      (!strategy || e.strategyId === strategy) &&
      (!level || e.payload.level === level) &&
      (!q || String(e.payload.message ?? "").toLowerCase().includes(q.toLowerCase())),
  );

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const filtered = (logs.data ?? []).filter((l) => l.ts >= rangeStart(range));
  const shown = filtered.slice(0, cap);

  return (
    <div>
      <PageHeader title="Logs" sub={`Engine logs shipped from ${instanceId}; live tail on top, history below.`} />
      <QueryError on={strategies.isError || logs.isError} what="logs" />

      {liveLogs.length > 0 && (
        <Panel className="mt-5 border-up/30" stagger={0} title="Live" right={<PulseDot />} scroll="max-h-[20rem]">
          <div className="p-2">
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
        </Panel>
      )}

      <Panel
        className="mt-5"
        stagger={1}
        title="History"
        scroll="max-h-[34rem]"
        toolbar={
          <>
            <SearchInput
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setCap(30);
              }}
              placeholder="search log text…"
              className="w-72"
            />
            <Select
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                setCap(30);
              }}
            >
              <option value="">any level</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
            <Select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value);
                setCap(30);
              }}
            >
              <option value="">all strategies</option>
              {(strategies.data ?? []).map((s) => (
                <option key={s.strategyId} value={s.strategyId}>
                  {s.strategyId}
                </option>
              ))}
            </Select>
            <RangeSelect
              value={range}
              onChange={(v) => {
                setRange(v);
                setCap(30);
              }}
            />
          </>
        }
      >
        <div className="p-2">
          {shown.map((l) => (
            <LogLine key={l.id} log={l} />
          ))}
          {shown.length === 0 && <Empty>No logs match</Empty>}
        </div>
        <LoadMore shown={shown.length} total={filtered.length} onMore={() => setCap((c) => c + 30)} />
      </Panel>
    </div>
  );
}

function PulseDot() {
  return <span className="live-dot inline-block h-2 w-2 rounded-full bg-up" />;
}

function LogLine({ log }: { log: LogRow }) {
  return (
    <div className="flex flex-wrap items-start gap-2 border-b border-line/50 px-2 py-1.5 font-mono text-xs last:border-b-0 sm:flex-nowrap">
      <span className="whitespace-nowrap text-faint">{ts(log.ts)}</span>
      <Pill tone={LEVEL_TONE[log.level] ?? "neutral"}>{log.level}</Pill>
      {log.strategyId && <span className="text-muted">[{log.strategyId}]</span>}
      <span className="break-all text-body">{log.message}</span>
      <span className="ml-auto hidden whitespace-nowrap text-faint lg:inline">{log.logger.split(".").pop()}</span>
    </div>
  );
}
