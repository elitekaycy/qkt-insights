import { useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { LOG_KEYS, parseQuery, UNATTRIBUTED_STRATEGY } from "@qkt-insights/contract/query";
import { get, type LogRow, type StrategyRow } from "../api";
import { Card, Empty, Loadable, PageHeader, Panel, RangeChips, rangeStart, Spinner, useRangeParam } from "../components/ui";
import { useSearchParam } from "../router";
import { LogLine } from "../components/LogLine";
import { useLiveStream } from "../useLiveStream";
import { count } from "../format";
import { LOG_PRESETS, QueryBar } from "../query/QueryBar";

const LOG_TYPES = ["log"];
const PAGE = 200;

/** One page of /logs/page: newest first; `total` (first page only) is how many lines the whole query matches. */
interface LogPage {
  rows: LogRow[];
  nextCursor: string | null;
  total: number | null;
}

/** Words as an FTS query that matches each literally: `rejected:` is a word, not syntax. */
function ftsWords(words: string[]): string {
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
}

export default function Logs({ instanceId }: { instanceId: string | null }) {
  const [q, setQ] = useSearchParam("q");
  const [range, setRange] = useRangeParam();

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
    const p = new URLSearchParams({ instance: instanceId ?? "", limit: String(PAGE) });
    if (f.level) p.set("level", f.level);
    if (f.strategy !== undefined) p.set("strategy", f.strategy ?? UNATTRIBUTED_STRATEGY);
    if (f.logger) p.set("logger", f.logger);
    if (f.text.length) p.set("q", ftsWords(f.text));
    if (from) p.set("from", String(from));
    if (to) p.set("to", String(to));
    return p.toString();
  }, [instanceId, f, from, to]);

  // The range, the filters and the words all run on the server; pages follow by cursor, so every
  // matching line in the range is reachable by scrolling, and the count is the query's own.
  const logs = useInfiniteQuery({
    queryKey: ["logs-page", params],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => get<LogPage>(`/logs/page?${params}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!instanceId,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = logs;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const live = useLiveStream(instanceId, 100, LOG_TYPES);
  const liveLogs = live.filter((e) => {
    if (e.type !== "log") return false;
    const msg = String(e.payload.message ?? "").toLowerCase();
    return (f.strategy === undefined || (e.strategyId ?? null) === f.strategy)
      && (!f.level || e.payload.level === f.level)
      && (!f.logger || String(e.payload.logger ?? "").toLowerCase().includes(f.logger.toLowerCase()))
      && f.text.every((w) => msg.includes(w.toLowerCase()))
      && (!from || e.ts >= from) && (!to || e.ts < to);
  });

  if (!instanceId) return <Card className="p-8 text-center text-faint">No instance selected.</Card>;

  const rows = logs.data?.pages.flatMap((p) => p.rows) ?? [];
  const total = logs.data?.pages[0]?.total ?? null;

  return (
    <div>
      <PageHeader
        title="Logs"
        sub={`Engine logs shipped from ${instanceId}; live tail on top, history below. Times UTC.`}
        scope={
          <>
            <QueryBar
              value={q}
              onChange={setQ}
              keys={LOG_KEYS}
              data={{ strategies: names }}
              page="Logs"
              presets={LOG_PRESETS}
              placeholder="Search log text or filter: level:error, strategy:, logger:MT5Broker, time:1h…"
              trailing={
                <>
              <RangeChips value={range} onChange={setRange} />
              <span className={`text-sm text-muted ${logs.isFetching ? "opacity-60" : ""}`} aria-live="polite">
                {logs.data == null ? (
                  <Spinner label="Loading…" show />
                ) : (
                  <>
                    Showing <b className="font-semibold text-bright">{count(rows.length)}</b> of {count(total ?? rows.length)} matching lines
                  </>
                )}
              </span>
                </>
              }
            />
          </>
        }
      />

      {liveLogs.length > 0 && (
        <Panel className="mt-5" title="Live" right={<span className="text-xs text-muted">newest {new Date(liveLogs[0]!.ts).toISOString().slice(11, 19)} UTC</span>} scroll="max-h-[20rem]">
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
        <Loadable loading={logs.isPending} error={logs.isError} retry={() => logs.refetch()} what="log history" shape="lines" lines={8}>
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
          {hasNextPage && (
            <div ref={sentinel} className="flex items-center justify-center gap-3 border-t border-line p-3 text-xs text-muted">
              {isFetchingNextPage ? (
                <Spinner label="Loading older lines…" show />
              ) : (
                <button
                  type="button"
                  onClick={() => void fetchNextPage()}
                  className="h-7 rounded-md border border-ctl bg-raised px-3 text-xs font-medium text-bright transition hover:bg-well"
                >
                  Load {PAGE} older
                </button>
              )}
            </div>
          )}
        </Loadable>
      </Panel>
    </div>
  );
}

