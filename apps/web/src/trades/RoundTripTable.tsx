import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { accountName, accountOfLabel } from "../accounts";
import { DASH, duration, openPnl, quantity, signedMoney, toneClass } from "../format";
import { instrumentType, optionFromSymbol, optionLine, shortInstrument, sizeInWords, TYPE_LABEL } from "../instruments";
import { Pill, RowChevron, SideWord, Skeleton, Spinner } from "../components/ui";
import { useStrategyNames } from "../hooks/useStrategies";
import { useView } from "../view";
import { useLiveState } from "../useLiveState";
import { useRoundTrips, type RoundTrip, type RoundTripTotals, type SortKey, type TripScope } from "./data";
import { minuteStamp, px, rMultiple, tableStamp, tripInstrument } from "./format";
import { EndedWord } from "./bits";
import { TradeDrawer, useOpenTrade } from "./TradeDrawer";

/*
 * The round-trip table: server-paged (keyset cursor) and virtualised, so a year of trades costs
 * what one screen does. Rows load as you scroll, headers sort on the server, j/k move the
 * selection and Enter opens the trade. One line per trade: its type, account, prices, R and hold time are on the
 * row's tooltip and in the drawer. Phones get a two-line card per trade.
 */

const ROW = 36;
const CARD = 58;
const OVERSCAN = 8;

interface Column { key: string; label: string; w: string; sort?: SortKey; right?: boolean; title?: string }

const COLUMNS: Column[] = [
  { key: "entry", label: "Opened (UTC)", w: "minmax(104px,0.7fr)", sort: "entry", title: "Keys: / search · j and k move · Enter opens a trade" },
  { key: "instrument", label: "Symbol", w: "minmax(120px,1fr)", sort: "symbol", title: "Hover a row for its type, account, prices, R and hold time" },
  { key: "strategy", label: "Strategy", w: "minmax(120px,1.1fr)", sort: "strategy" },
  { key: "side", label: "Side", w: "64px", sort: "side" },
  { key: "size", label: "Size", w: "80px", sort: "size", right: true },
  { key: "pnl", label: "P&L", w: "96px", sort: "pnl", right: true, title: "Realized, after commission, swap and fees; an open trade's worth now in italics" },
  { key: "ended", label: "Ended", w: "72px", sort: "ended", title: "What closed it: the stop, the target, the strategy's signal, the venue or a hand" },
];

function tripType(t: RoundTrip) {
  return instrumentType(t.kind, t.category);
}

function StrategyName({ id, name }: { id: string | null; name: (id: string) => string }) {
  return id ? <span className="truncate text-bright" title={id}>{name(id)}</span> : <span className="text-muted">unattributed</span>;
}

function Cell({ children, right, className = "" }: { children: ReactNode; right?: boolean; className?: string }) {
  return (
    <div role="cell" className={`min-w-0 truncate px-2 ${right ? "text-right" : ""} ${className}`}>
      {children}
    </div>
  );
}

/**
 * A row's P&L. Under an `exit:` window, a position closed in parts across its edge shows what its
 * legs inside the window realized (so the rows add up to the count line's net), marked "part",
 * with the whole position's P&L in the tooltip.
 */
function TripPnl({ t }: { t: RoundTrip }) {
  if (t.pnlInExit == null) return <>{signedMoney(t.pnl)}</>;
  return (
    <span title={`${signedMoney(t.pnlInExit)} closed in this range; the position's other closing legs fell on other days (whole position ${signedMoney(t.pnl)})`}>
      <span className="mr-1 font-sans text-xs font-normal text-muted">part</span>{signedMoney(t.pnlInExit)}
    </span>
  );
}

/** An open trade's P&L cell: what it is worth now, from the live positions, in muted italics so it never reads as realized. */
function OpenPnl({ value }: { value: number | undefined }) {
  if (value == null) return <span className="text-muted">{DASH}</span>;
  return <span className="font-normal italic text-muted" title="Open: what it is worth now, not realized">{signedMoney(value)}</span>;
}

/** The row's tooltip: everything the line leaves out, so a hover answers what a trade was without opening it. */
function rowTitle(t: RoundTrip, venueOf: (label: string) => string): string {
  const type = tripType(t);
  const premium = optionLine(t.symbol) ? optionFromSymbol(t.symbol)?.premium : null;
  const exit = t.status === "open" ? "still open" : `exit ${px(t.exitPrice, t.priceDigits)}${t.exitTs != null ? ` at ${minuteStamp(t.exitTs)}` : ""}`;
  return [
    tripInstrument(t),
    type ? TYPE_LABEL[type] : null,
    optionLine(t.symbol),
    t.venue ? venueOf(t.venue) : null,
    `entry ${px(t.entryPrice, t.priceDigits)}${premium ? ` ${premium}` : ""}`,
    exit,
    t.r != null ? rMultiple(t.r) : null,
    t.status === "open" ? null : `held ${duration(t.holdMs)}`,
    sizeInWords(t.qty, t),
    `ticket ${t.id}`,
  ].filter(Boolean).join(" · ");
}

function cells(t: RoundTrip, hide: ReadonlySet<string>, strategyName: (id: string) => string, floating: ReadonlyMap<string, number>): ReactNode[] {
  const all: Record<string, ReactNode> = {
    entry: <Cell className="font-mono text-xs text-muted">{tableStamp(t.entryTs)}</Cell>,
    instrument: <Cell className="font-medium text-bright">{shortInstrument(t.instrument, tripType(t))}</Cell>,
    strategy: <Cell><StrategyName id={t.strategyId} name={strategyName} /></Cell>,
    side: <Cell><SideWord side={t.side} /></Cell>,
    size: <Cell right className="font-mono text-muted"><span title={sizeInWords(t.qty, t)}>{quantity(t.qty)}</span></Cell>,
    pnl: <Cell right className={`font-mono font-medium ${toneClass(t.pnlInExit ?? t.pnl)}`}>{t.pnl == null ? (t.status === "open" ? <OpenPnl value={floating.get(t.id)} /> : DASH) : <TripPnl t={t} />}</Cell>,
    ended: <Cell>{t.status === "open" ? <Pill tone="info">Open</Pill> : <EndedWord ended={t.ended} />}</Cell>,
  };
  return COLUMNS.filter((c) => !hide.has(c.key)).map((c) => <span key={c.key} className="contents">{all[c.key]}</span>);
}

function useWide(): boolean {
  const q = "(min-width: 768px)";
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

export interface RoundTripTableProps {
  scope: TripScope | null;
  q: string;
  sort: SortKey;
  dir: "asc" | "desc";
  onSort?: (sort: SortKey, dir: "asc" | "desc") => void;
  /** Columns to leave out, e.g. "strategy" on a strategy's own page. */
  hide?: readonly string[];
  /** CSS height of the scrolling body. */
  height?: string;
  /** Shrink to the rows when they take less than `height` (then `height` is the most it grows to). */
  fit?: boolean;
  /** Reports the first page's totals (the whole match) and the server's reading of the query. */
  onTotals?: (t: RoundTripTotals | null, query: { canonical: string; errors: string[] } | null, loading: boolean) => void;
}

export function RoundTripTable({ scope, q, sort, dir, onSort, hide = [], height = "min(70dvh, 46rem)", fit = false, onTotals }: RoundTripTableProps) {
  const view = useView();
  // the open trade (?trade=) is highlighted, kept in view, and j/k continue from it
  const [openId, onOpen] = useOpenTrade();
  const wide = useWide();
  const hidden = useMemo(() => new Set(hide), [hide]);
  const cols = COLUMNS.filter((c) => !hidden.has(c.key));
  // the last track holds the row's "opens" chevron
  const template = `${cols.map((c) => c.w).join(" ")} 1.75rem`;
  const minWidth = cols.reduce((a, c) => a + (parseInt(c.w.replace(/^minmax\((\d+)px.*$/, "$1"), 10) || 0), 0);
  const data = useRoundTrips(scope, q, sort, dir);
  const strategyName = useStrategyNames(scope?.instanceId);
  // open trades show what they are worth now, from the live positions (never on a shared link)
  const live = useLiveState();
  // a venue label (PAPER_F) reads as its account's name (Paper F); a label no live account reports stays as it is
  const venueOf = useCallback((label: string) => {
    const peers = (live.data?.accounts ?? []).filter((x) => x.instanceId === scope?.instanceId);
    const a = scope ? accountOfLabel(peers, scope.instanceId, label) : null;
    return a ? accountName(a, view.public, peers) : label;
  }, [live.data, scope, view.public]);
  const floating = useMemo(() => {
    const out = new Map<string, number>();
    if (view.public) return out;
    for (const g of live.data?.positions ?? []) if (!scope || g.instanceId === scope.instanceId) for (const p of g.list) out.set(p.ticket, openPnl(p));
    return out;
  }, [live.data, scope, view.public]);
  const rows = useMemo(() => data.data?.pages.flatMap((p) => p.rows) ?? [], [data.data]);
  // a unit every row shares is said once, in the header; mixed units are on each size's tooltip
  const commonUnit = rows.length > 0 && rows.every((r) => r.unit && r.unit === rows[0]!.unit) ? rows[0]!.unit ?? null : null;
  const first = data.data?.pages[0];
  const matched = first?.totals?.matched ?? rows.length;
  const rowH = wide ? ROW : CARD;
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, h: 600 });
  const [sel, setSel] = useState(-1);

  useEffect(() => {
    onTotals?.(first?.totals ?? null, first?.query ?? null, data.isFetching && !data.isFetchingNextPage);
  }, [first, data.isFetching, data.isFetchingNextPage, onTotals]);

  // a new query or sort starts at the top
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setSel(-1);
  }, [q, sort, dir, scope?.instanceId, scope?.strategy, scope?.from]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport((v) => ({ ...v, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const from = Math.max(0, Math.floor(viewport.top / rowH) - OVERSCAN);
  const to = Math.min(rows.length - 1, Math.ceil((viewport.top + viewport.h) / rowH) + OVERSCAN);
  useEffect(() => {
    if (to >= rows.length - OVERSCAN * 2 && data.hasNextPage && !data.isFetchingNextPage) void data.fetchNextPage();
  }, [to, rows.length, data]);

  const reveal = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = i * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  };

  // the open trade keeps the selection, so j/k continue from it
  useEffect(() => {
    if (!openId) return;
    const i = rows.findIndex((r) => r.id === openId);
    if (i >= 0) {
      setSel(i);
      reveal(i);
    }
  }, [openId, rows]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "j" || e.key === "k") {
        if (!rows.length) return;
        e.preventDefault();
        const n = Math.min(rows.length - 1, Math.max(0, sel + (e.key === "j" ? 1 : -1)));
        setSel(n);
        reveal(n);
        // with a trade open, j/k page through the trades in the drawer
        if (openId) onOpen(rows[n]!.id);
      } else if (e.key === "Enter" && sel >= 0 && rows[sel] && !view.public) {
        const inDialog = t?.closest("[role=dialog]");
        if (inDialog) return;
        e.preventDefault();
        onOpen(rows[sel]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, sel, openId, onOpen, view.public]);

  const clickable = !view.public;
  const header = (
    <div role="row" className="sticky top-0 z-10 grid border-b border-line bg-panel" style={{ gridTemplateColumns: template }}>
      {cols.map((c) => {
        const active = c.sort === sort;
        const toggle = () => {
          if (!c.sort || !onSort) return;
          onSort(c.sort, active ? (dir === "asc" ? "desc" : "asc") : c.sort === "strategy" || c.sort === "symbol" || c.sort === "side" || c.sort === "ended" ? "asc" : "desc");
        };
        return (
          <div
            key={c.key}
            role="columnheader"
            aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
            title={c.title}
            tabIndex={c.sort && onSort ? 0 : undefined}
            onClick={toggle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
              }
            }}
            className={`eyebrow select-none truncate px-2 py-2.5 ${c.right ? "text-right" : ""} ${c.sort && onSort ? "cursor-pointer hover:text-bright" : ""} ${active ? "!text-bright" : ""}`}
          >
            {c.label}
            {c.key === "size" && commonUnit ? <span className="font-normal"> ({commonUnit})</span> : null}
            {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
          </div>
        );
      })}
      <div role="columnheader" aria-label="Open" />
    </div>
  );

  const body = (i: number, t: RoundTrip) => {
    const selected = i === sel || t.id === openId;
    const common = {
      role: "row",
      "aria-selected": selected,
      "data-row": i,
      onClick: () => {
        setSel(i);
        if (clickable) onOpen(t.id);
      },
      title: rowTitle(t, venueOf),
      style: { top: i * rowH, height: rowH, ...(wide ? { gridTemplateColumns: template } : {}) },
    } as const;
    if (wide) {
      return (
        <div key={t.id} {...common} className={`group absolute inset-x-0 grid items-center border-b border-line text-sm transition-colors ${clickable ? "cursor-pointer" : ""} ${selected ? "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent-hi)]" : "hover:bg-hover"}`}>
          {cells(t, hidden, strategyName, floating)}
          <div role="cell" className="flex justify-center">{clickable && <RowChevron className={selected ? "opacity-100" : ""} />}</div>
        </div>
      );
    }
    return (
      <div key={t.id} {...common} className={`group absolute inset-x-0 flex flex-col justify-center gap-1 border-b border-line pl-3 pr-1.5 text-sm ${clickable ? "cursor-pointer active:bg-press" : ""} ${selected ? "bg-accent-soft" : ""}`}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate font-medium text-bright">{shortInstrument(t.instrument, tripType(t))}</span>
          <span className={`ml-auto shrink-0 font-mono font-medium ${toneClass(t.pnlInExit ?? t.pnl)}`}>{t.status === "open" ? <OpenPnl value={floating.get(t.id)} /> : <TripPnl t={t} />}</span>
          {clickable && <RowChevron />}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">{t.strategyId ? strategyName(t.strategyId) : "unattributed"}</span>
          <SideWord side={t.side} />
          {t.status === "open" && <Pill tone="info">Open</Pill>}
          <span className={`ml-auto shrink-0 whitespace-nowrap font-mono ${clickable ? "pr-6" : ""}`}>{tableStamp(t.exitTs ?? t.entryTs)}</span>
        </div>
      </div>
    );
  };

  const visible: ReactNode[] = [];
  for (let i = from; i <= to && i < rows.length; i++) visible.push(body(i, rows[i]!));
  const loadingMore = data.isFetchingNextPage || (data.hasNextPage && to >= rows.length - 1);

  return (
    <div role="table" aria-label="Round trips" aria-rowcount={matched} className="relative">
      <div
        ref={scroller}
        onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}
        className="relative overflow-auto overscroll-contain"
        style={fit ? { maxHeight: height } : { height }}
      >
        <div style={{ minWidth: wide ? minWidth : undefined }}>
          {wide && header}
          {data.isError && rows.length === 0 ? (
            <div className="flex items-center justify-between gap-3 p-4 text-sm text-loss">
              Trades could not be loaded.
              <button type="button" onClick={() => void data.refetch()} className="h-8 rounded-lg border border-ctl bg-raised px-3 font-medium text-bright hover:bg-well">
                Retry
              </button>
            </div>
          ) : data.isPending ? (
            <Skeleton lines={8} what="trades" />
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted"><b className="font-medium text-bright">No trades match.</b> Loosen the search above.</div>
          ) : (
            <div className={`relative ${data.isPlaceholderData ? "opacity-60 transition-opacity" : ""}`} style={{ height: rows.length * rowH + (loadingMore ? rowH : 0) }}>
              {visible}
              {loadingMore && (
                <div className="absolute inset-x-0 flex items-center justify-center" style={{ top: rows.length * rowH, height: rowH }}>
                  <Spinner label="Loading more…" show />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {!view.public && scope && <TradeDrawer instanceId={scope.instanceId} order={rows.map((r) => r.id)} />}
    </div>
  );
}
