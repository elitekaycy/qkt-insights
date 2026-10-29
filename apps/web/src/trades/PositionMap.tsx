import { useMemo, useState, type ReactNode } from "react";
import { DASH, duration, human, signedMoney, toneClass, tsShort } from "../format";
import { EChart, useNarrowChart } from "../components/EChart";
import { Freshness, Segmented } from "../components/ui";
import { usePositionPath, type PositionPath } from "./data";
import { latency, preciseClock, px } from "./format";
import { bucketLabel, levels, markerIndex, moments, pathOption, pathSummary, type Moment, type MomentKey, type PathView } from "./positionMap";

/*
 * The position map in the trade drawer: where the position went while it was held, drawn from
 * the venue's marks as candles (or the P&L line), with the entry, the best and the worst mark and
 * the latest mark or the exit placed exactly, and the times between them. Hovering a moment below
 * the chart points at it on the chart; clicking a marker on the chart selects its moment.
 */

/** Marks older than this on an open position mean the poll stopped: the heartbeat is every 5 minutes. */
const STALE_MARK_MS = 11 * 60_000;
const VIEWS = [{ key: "price", label: "Price" }, { key: "pnl", label: "P&L" }] as const;

export function PositionMap({ instanceId, ticket, open, digits, realized }: {
  instanceId: string | null;
  ticket: string;
  open: boolean;
  digits: number;
  /** The closed trip's realized net after costs, which the exit shows. */
  realized: number | null;
}) {
  const [bucket, setBucket] = useState<number | null>(null);
  const [view, setView] = useState<PathView>("price");
  const [hover, setHover] = useState<MomentKey | null>(null);
  const [pinned, setPinned] = useState<MomentKey | null>(null);
  const q = usePositionPath(instanceId, ticket, bucket, open);
  const narrow = useNarrowChart();
  const path = q.data && q.data.ticket === ticket ? q.data : null;

  return (
    <section className="px-5 pb-5" aria-label="Position map">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Position map</h3>
        {path && path.status === "open" && path.last && <Freshness at={path.last.ts} stale={Date.now() - path.last.ts > STALE_MARK_MS} />}
        {path && path.candles.length > 0 && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
            {view === "price" && path.buckets.length > 1 && (
              <Segmented
                label="Candle size"
                dense
                value={String(path.bucketMs)}
                options={path.buckets.map((b) => ({ key: String(b), label: bucketLabel(b) }))}
                onChange={(v) => setBucket(Number(v))}
              />
            )}
            <Segmented label="Chart" dense value={view} options={VIEWS} onChange={setView} />
          </div>
        )}
      </div>
      {q.isError ? (
        <p className="rounded-lg border border-line bg-raised px-3 py-6 text-center text-sm text-loss">The position's path could not be loaded.</p>
      ) : !path ? (
        <div className="space-y-3" aria-busy>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-9 rounded bg-raised" />)}
          </div>
          <div className="h-[240px] rounded-lg bg-raised" />
        </div>
      ) : path.marks === 0 ? (
        <NoMarks path={path} />
      ) : (
        <PathChart path={path} view={view} digits={digits} realized={realized} narrow={narrow} hover={hover} setHover={setHover} pinned={pinned} setPinned={setPinned} />
      )}
    </section>
  );
}

function NoMarks({ path }: { path: PositionPath }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center">
      <p className="text-sm text-body">No venue marks for this position{path.status === "open" ? " yet" : ""}.</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted">
        {path.status === "open"
          ? "Insights records the price and P&L each time qkt reports the account's positions; the first poll after the entry starts the map."
          : "Marks are recorded while a position is open and kept for 30 days after it closes, so older trades have no map."}
      </p>
    </div>
  );
}

function PathChart({ path, view, digits, realized, narrow, hover, setHover, pinned, setPinned }: {
  path: PositionPath;
  view: PathView;
  digits: number;
  realized: number | null;
  narrow: boolean;
  hover: MomentKey | null;
  setHover: (k: MomentKey | null) => void;
  pinned: MomentKey | null;
  setPinned: (k: MomentKey | null) => void;
}) {
  const ms = useMemo(() => moments(path, realized), [path, realized]);
  const summary = useMemo(() => pathSummary(path, realized), [path, realized]);
  const reduceMotion = typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const option = useMemo(() => pathOption({ path, moments: ms, view, digits, narrow, reduceMotion }), [path, ms, view, digits, narrow, reduceMotion]);
  const index = useMemo(() => markerIndex(ms, view), [ms, view]);
  const markerSeries = 1;
  const active = hover ?? pinned;
  const at = active != null ? index.get(active) : undefined;
  const focus = at != null ? { seriesIndex: markerSeries, dataIndex: at } : null;
  const byIndex = useMemo(() => new Map([...index].map(([k, i]) => [i, k])), [index]);
  const offChart = levels(path).filter((l) => !l.inView);
  const first = path.entry && path.firstMarkTs != null ? path.firstMarkTs - path.entry.ts : null;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <Figure label={path.status === "open" ? "Held so far" : "Held"}>{duration(summary.heldMs)}</Figure>
        <Figure label="Best came after" title="From the entry to the best mark">{duration(summary.toBestMs)}</Figure>
        <Figure label={path.status === "open" ? "Since the best" : "Best to exit"}>{duration(summary.sinceBestMs)}</Figure>
        {path.status === "open" ? (
          <Figure label="Off the best" title="The best mark's P&L less the latest mark's, both excluding swap">
            {summary.offBest == null ? DASH : summary.offBest <= 0 ? <span className="text-body">at the best</span> : <span className="text-loss">{signedMoney(-summary.offBest)}</span>}
          </Figure>
        ) : (
          <Figure label="Kept of the best" title="The realized net after costs over the best mark's P&L">
            {summary.keptPct == null ? DASH : summary.keptPct === 0 ? <span className="text-loss">none</span> : <span className="text-bright">{Math.round(summary.keptPct)}%</span>}
          </Figure>
        )}
      </dl>

      <div className="-mx-1">
        <EChart
          option={option}
          height={narrow ? 230 : 280}
          label={`${view === "price" ? "Price candles" : "P&L"} of the position from entry to ${path.status === "open" ? "the latest mark" : "exit"}, with the entry, best, worst and ${path.status === "open" ? "latest" : "exit"} marked`}
          focus={focus}
          onItemClick={({ seriesIndex, dataIndex }) => {
            if (seriesIndex !== markerSeries) return;
            const k = byIndex.get(dataIndex) ?? null;
            setPinned(k === pinned ? null : k);
          }}
        />
      </div>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Key moments">
        {ms.map((m) => (
          <li key={m.key}>
            <MomentCard
              m={m}
              digits={digits}
              selected={pinned === m.key}
              plotted={index.has(m.key)}
              onHover={(on) => setHover(on ? m.key : null)}
              onSelect={() => setPinned(pinned === m.key ? null : m.key)}
            />
          </li>
        ))}
      </ul>

      <p className="text-[11px] leading-relaxed text-faint">
        Sampled from {path.marks.toLocaleString("en-US")} venue mark{path.marks === 1 ? "" : "s"}: the price the position would close at, polled from the broker; a move between polls is not seen.
        P&L excludes swap{path.last?.swap ? ` (swap so far ${signedMoney(path.last.swap)})` : ""}. Times UTC.
        {first != null && first > 5 * 60_000 && <> The first mark came {duration(first)} after the entry.</>}
        {path.gaps > 0 && path.longestGap && (
          <>
            {" "}{path.gaps === 1 ? "One stretch" : `${path.gaps} stretches`} without marks {path.gaps === 1 ? "is" : "are"} shaded
            {path.gaps > 1 ? `; the longest ${duration(path.longestGap.to - path.longestGap.from)} from ${tsShort(path.longestGap.from)}` : `, ${duration(path.longestGap.to - path.longestGap.from)} from ${tsShort(path.longestGap.from)}`}.
          </>
        )}
        {path.flatSpans.length > 0 && <> Lighter shading: the price did not move for an hour or more (market closed or no quotes).</>}
        {offChart.map((l) => (
          <span key={l.key}> {l.key === "stop" ? "Initial stop" : "Target"} {px(l.price, digits)} is off the chart.</span>
        ))}
      </p>
    </div>
  );
}

function Figure({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-sm tabular-nums text-bright">{children}</dd>
    </div>
  );
}

function MomentCard({ m, digits, selected, plotted, onHover, onSelect }: {
  m: Moment;
  digits: number;
  selected: boolean;
  plotted: boolean;
  onHover: (on: boolean) => void;
  onSelect: () => void;
}) {
  const tone = m.pnl == null ? "text-bright" : toneClass(m.pnl);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={!plotted}
      title={`${m.label}: ${human(m.ts)}`}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onClick={onSelect}
      className={`group w-full rounded-lg border px-3 py-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hi ${
        selected ? "border-line-strong bg-well" : "border-line bg-raised hover:border-line-strong hover:bg-well"
      } disabled:cursor-default disabled:opacity-60`}
    >
      <div className="flex items-center gap-1.5">
        <MomentGlyph k={m.key} />
        <span className="text-[11px] font-medium text-muted">{m.label}</span>
        {m.afterEntryMs != null && m.key !== "entry" && <span className="ml-auto font-mono text-[10px] text-faint">{latency(m.afterEntryMs)}</span>}
      </div>
      <div className={`mt-1 font-mono text-sm font-semibold tabular-nums ${tone}`}>
        {m.key === "entry" ? px(m.price, digits) : m.pnl == null ? DASH : signedMoney(m.pnl)}
      </div>
      {m.key !== "entry" && <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-muted">@ {px(m.price, digits)}</div>}
      <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-faint">
        {tsShort(m.ts)}:{preciseClock(m.ts).slice(6, 8)}
      </div>
      {m.key === "exit" && <div className="mt-0.5 text-[10px] text-faint">realized, after costs</div>}
    </button>
  );
}

/** The marker's shape and colour, as the chart draws it. */
function MomentGlyph({ k }: { k: MomentKey }) {
  const cls = "h-2.5 w-2.5 shrink-0";
  switch (k) {
    case "entry":
      return <svg viewBox="0 0 10 10" className={`${cls} text-accent-hi`} aria-hidden><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>;
    case "best":
      return <svg viewBox="0 0 10 10" className={`${cls} text-gain-fill`} aria-hidden><path d="M5 1 9.5 9h-9z" fill="currentColor" /></svg>;
    case "worst":
      return <svg viewBox="0 0 10 10" className={`${cls} text-loss-fill`} aria-hidden><path d="M5 9 .5 1h9z" fill="currentColor" /></svg>;
    case "now":
      return <svg viewBox="0 0 10 10" className={`${cls} text-bright`} aria-hidden><path d="M5 .5 9.5 5 5 9.5.5 5z" fill="currentColor" /></svg>;
    case "exit":
      return <svg viewBox="0 0 10 10" className={`${cls} text-bright`} aria-hidden><rect x="1.5" y="1.5" width="7" height="7" fill="currentColor" /></svg>;
  }
}
