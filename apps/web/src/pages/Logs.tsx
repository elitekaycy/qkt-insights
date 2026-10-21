import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LOG_KEYS, parseQuery } from "@qkt-insights/contract/query";
import { get, type LogRow, type StrategyRow } from "../api";
import { Card, Empty, Loadable, PageHeader, Panel, RangeSelect, rangeStart, useRangeParam } from "../components/ui";
import { useSearchParam } from "../router";
import { LogLine } from "../components/LogLine";
import { useLiveStream } from "../useLiveStream";
import { count } from "../format";
import { LOG_PRESETS, QueryBar } from "../query/QueryBar";

const LOG_TYPES = ["log"];
const PAGE = 200;
const MAX = 1000;

/** Words as an FTS query that matches each literally: `rejected:` is a word, not syntax. */
function ftsWords(words: string[]): string {
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
}

export default function Logs({ instanceId }: { instanceId: string | null }) {
  const [q, setQ] = useSearchParam("q");
  const [range, setRange] = useRangeParam();
  const [limit, setLimit] = useState(PAGE);

  const strategies = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
  });
  const names = useMemo(() => (strategies.data ?? []).map((s) => s.strategyId), [strategies.data]);
  const parsed = useMemo(() => parseQuery(q, { strategies: names }), [q, names]);
  const f = parsed.filter;
  const rangeFrom = rangeStart(range);
  const from = Math.max(rangeFrom > 0 ? Math.floor(rangeFrom / 60_000) * 60_000 : 0, f.time?.from ?? 0) || undefined;
  const to = f.time?.to;

  const params = useMemo(() => {
    const p = new URLSearchParams({ instance: instanceId ?? "", limit: String(limit) });
    if (f.level) p.set("level", f.level);
    if (f.strategy) p.set("strategy", f.strategy);
    if (f.logger) p.set("logger", f.logger);
    if (f.text.length) p.set("q", ftsWords(f.text));
    if (from) p.set("from", String(from));
    if (to) p.set("to", String(to));
    return p.toString();
  }, [instanceId, limit, f, from, to]);

  const logs = useQuery({
    queryKey: ["logs-page", params],
    queryFn: () => get<LogRow[]>(`/logs?${params}`),
    enabled: !!instanceId,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const live = useLiveStream(instanceId, 100, LOG_TYPES);
  const liveLogs = live.filter((e) => {
    if (e.type !== "log") return false;
    const msg = String(e.payload.message ?? "").toLowerCase();
    return (!f.strategy || e.strategyId === f.strategy)
      && (!f.level || e.payload.level === f.level)
      && (!f.logger || String(e.payload.logger ?? "").toLowerCase().includes(f.logger.toLowerCase()))
      && f.text.every((w) => msg.includes(w.toLowerCase()))
      && (!from || e.ts >= from) && (!to || e.ts < to);
  });

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const rows = logs.data ?? [];
  const capped = rows.length >= limit;

  return (
    <div>
      <PageHeader
        title="Logs"
        sub={`Engine logs shipped from ${instanceId}; live tail on top, history below. Times UTC.`}
        scope={
          <>
            <QueryBar
              value={q}
              onChange={(v) => {
                setQ(v);
                setLimit(PAGE);
              }}
              keys={LOG_KEYS}
              data={{ strategies: names }}
              page="Logs"
              presets={LOG_PRESETS}
              placeholder="Search log text or filter: level:error, strategy:, logger:MT5Broker, time:1h…"
            />
            <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
              <RangeSelect
                value={range}
                onChange={(v) => {
                  setRange(v);
                  setLimit(PAGE);
                }}
              />
              <span className={`text-sm text-muted ${logs.isFetching ? "opacity-60" : ""}`} aria-live="polite">
                {logs.data == null ? (
                  "Loading…"
                ) : capped ? (
                  <>
                    Showing the newest <b className="font-semibold text-bright">{count(rows.length)}</b> matching lines
                  </>
                ) : (
                  <>
                    Showing all <b className="font-semibold text-bright">{count(rows.length)}</b> matching lines
                  </>
                )}
              </span>
            </div>
          </>
        }
      />

      {liveLogs.length > 0 && (
        <Panel className="mt-5 border-gain-fill/30" title="Live" right={<PulseDot />} scroll="max-h-[20rem]">
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

      <Panel className="mt-5" title="History" hint="newest first" scroll="max-h-[calc(100dvh-20rem)]">
        <Loadable loading={logs.isPending} error={logs.isError} retry={() => logs.refetch()} what="log history">
          <div className={`p-2 ${logs.isPlaceholderData ? "opacity-60" : ""}`}>
            {rows.map((l) => (
              <LogLine key={l.id} log={l} />
            ))}
            {rows.length === 0 && (
              <Empty>
                <b className="font-semibold text-body">No log lines match.</b> Loosen the query above.
              </Empty>
            )}
          </div>
          {capped && (
            <div className="flex items-center justify-center gap-3 border-t border-line p-3 text-xs text-muted">
              {limit < MAX ? (
                <button
                  type="button"
                  onClick={() => setLimit((n) => Math.min(MAX, n + PAGE))}
                  className="h-7 rounded-md border border-ctl bg-raised px-3 text-xs font-medium text-bright transition hover:bg-well"
                >
                  Load {PAGE} more
                </button>
              ) : (
                <span>The newest {count(MAX)} matches are shown: narrow the query (time:, level:, logger:) to reach older lines.</span>
              )}
            </div>
          )}
        </Loadable>
      </Panel>
    </div>
  );
}

function PulseDot() {
  return <span className="live-dot inline-block h-2 w-2 rounded-full bg-gain-fill" />;
}
