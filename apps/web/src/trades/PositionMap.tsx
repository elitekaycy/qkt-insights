import { useMemo, useState } from "react";
import { DASH, human, signedMoney, toneClass, tsShort } from "../format";
import { EChart, useNarrowChart } from "../components/EChart";
import { Freshness, Segmented } from "../components/ui";
import { usePositionPath, type PositionPath } from "./data";
import { latency, preciseClock, px } from "./format";
import { bucketLabel, markerIndex, moments, pathOption, type Moment, type MomentKey, type PathView } from "./positionMap";

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
    <section className="px-5 py-4" aria-label="How the price moved">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-sm font-medium text-bright">How the price moved</h3>
        {path && path.status === "open" && path.last && <Freshness at={path.last.ts} stale={Date.now() - path.last.ts > STALE_MARK_MS} quiet />}
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
        <p className="rounded-lg border border-line bg-raised px-3 py-6 text-center text-sm text-loss">The chart could not be loaded.</p>
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
    <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">
      {path.status === "open" ? "The chart starts with the next price from the venue." : "No chart: prices are kept for 30 days after a trade closes."}
    </p>
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
  const option = useMemo(() => pathOption({ path, moments: ms, view, digits, narrow }), [path, ms, view, digits, narrow]);
  const index = useMemo(() => markerIndex(ms, view), [ms, view]);
  const markerSeries = 1;
  const active = hover ?? pinned;
  const at = active != null ? index.get(active) : undefined;
  const focus = at != null ? { seriesIndex: markerSeries, dataIndex: at } : null;
  const byIndex = useMemo(() => new Map([...index].map(([k, i]) => [i, k])), [index]);

  return (
    <div className="space-y-3">
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

      <ul className="divide-y divide-line" aria-label="Key moments">
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
      title={`${m.label}: ${human(m.ts)}${m.key === "exit" ? " · after costs" : ""}`}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 px-1 py-1.5 text-left text-xs transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-hi ${
        selected ? "bg-well" : "hover:bg-hover"
      } disabled:cursor-default disabled:opacity-60`}
    >
      <MomentGlyph k={m.key} />
      <span className="w-14 shrink-0 text-muted">{m.label}</span>
      <span className={`w-20 shrink-0 text-right font-mono font-medium tabular-nums ${tone}`}>{m.key === "entry" ? "" : m.pnl == null ? DASH : signedMoney(m.pnl)}</span>
      <span className="min-w-0 flex-1 truncate text-right font-mono tabular-nums text-muted">{px(m.price, digits)}</span>
      <span className="shrink-0 text-right font-mono tabular-nums text-muted">{tsShort(m.ts)}:{preciseClock(m.ts).slice(6, 8)}</span>
      <span className="hidden w-16 shrink-0 text-right font-mono tabular-nums text-muted sm:block">{m.afterEntryMs != null && m.key !== "entry" ? latency(m.afterEntryMs) : ""}</span>
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
