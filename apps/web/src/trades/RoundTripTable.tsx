import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DASH, duration, openPnl, pnl, quantity, signedMoney, toneClass } from "../format";
import { TypeBadge } from "../components/InstrumentType";
import { instrumentType, optionFromSymbol, optionLine, sizeInWords } from "../instruments";
import { Pill, RowChevron, Skeleton, Spinner } from "../components/ui";
import { useStrategyNames } from "../hooks/useStrategyNames";
import { useView } from "../view";
import { useLiveState } from "../useLiveState";
import { useRoundTrips, type RoundTrip, type RoundTripTotals, type SortKey, type TripScope } from "./data";
import { minuteStamp, px, rMultiple, tableStamp, tripInstrument } from "./format";
import { EndedBadge, SideText } from "./bits";
import { TradeDrawer, useOpenTrade } from "./TradeDrawer";

/*
 * The round-trip table: server-paged (keyset cursor) and virtualised, so a year of trades costs
 * what one screen does. Rows load as you scroll, headers sort on the server, j/k move the
 * selection and Enter opens the trade. Phones get one card per round trip.
 */

const ROW = 36;
const CARD = 66;
const OVERSCAN = 8;

interface Column { key: string; label: string; w: string; sort?: SortKey; right?: boolean; title?: string }

const COLUMNS: Column[] = [
  { key: "id", label: "#", w: "minmax(72px,0.6fr)", sort: "ticket", title: "Venue position ticket" },
  { key: "strategy", label: "Strategy", w: "minmax(120px,1fr)", sort: "strategy" },
  { key: "instrument", label: "Symbol", w: "minmax(140px,1.4fr)", sort: "symbol", title: "The instrument; with its venue beneath when the instance trades it on more than one" },
  { key: "type", label: "Type", w: "72px", title: "What the position is: CFD, stock CFD, share, coin, perpetual or dated future, option; hover a badge for what it means" },
  { key: "side", label: "Side", w: "70px", sort: "side" },
  { key: "entry", label: "Entry (UTC)", w: "112px", sort: "entry" },
  { key: "entryPrice", label: "Entry", w: "92px", sort: "entryPrice", right: true },
  { key: "exit", label: "Exit (UTC)", w: "112px", sort: "exit" },
  { key: "exitPrice", label: "Exit", w: "92px", sort: "exitPrice", right: true },
  { key: "size", label: "Size", w: "64px", sort: "size", right: true },
  { key: "pnl", label: "P&L", w: "104px", sort: "pnl", right: true, title: "Realized, after commission, swap and fees" },
  { key: "r", label: "R", w: "66px", sort: "r", right: true, title: "P&L over the money at risk to the initial stop" },
  { key: "held", label: "Held", w: "66px", sort: "held", right: true },
  { key: "ended", label: "Ended by", w: "76px", sort: "ended" },
];

function tripType(t: RoundTrip) {
  return instrumentType(t.kind, t.category);
}

function StrategyName({ id, name }: { id: string | null; name: (id: string) => string }) {
  return id ? <span className="truncate text-bright" title={id}>{name(id)}</span> : <Pill>unattributed</Pill>;
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
  if (t.pnlInExit == null) return <>{pnl(t.pnl)}</>;
  return (
    <span title={`${pnl(t.pnlInExit)} closed in this range; the position's other closing legs fell on other days (whole position ${pnl(t.pnl)})`}>
      <span className="mr-1 text-[10px] font-medium text-faint">part</span>{pnl(t.pnlInExit)}
    </span>
  );
}

/** An open trade's P&L cell: what it is worth now, from the live positions, in grey italic so it never reads as realized. */
function OpenPnl({ value }: { value: number | undefined }) {
  if (value == null) return <span className="text-faint">{DASH}</span>;
  return <span className="font-normal italic text-muted" title="Open: what it is worth now, not realized">open {signedMoney(value)}</span>;
}

function cells(t: RoundTrip, hide: ReadonlySet<string>, strategyName: (id: string) => string, floating: ReadonlyMap<string, number>): ReactNode[] {
  const option = optionLine(t.symbol);
  const premium = option ? optionFromSymbol(t.symbol)?.premium : null;
  const all: Record<string, ReactNode> = {
    id: <Cell className="font-mono text-xs text-faint">{t.id}</Cell>,
    strategy: <Cell><StrategyName id={t.strategyId} name={strategyName} /></Cell>,
    instrument: (
      <Cell className="font-semibold text-bright">
        {t.venue || option ? (
          <span title={tripInstrument(t)}>
            <span className="block truncate leading-tight">{t.instrument}</span>
            <span className="block truncate text-[10px] font-normal leading-tight text-muted">{[option, t.venue].filter(Boolean).join(" · ")}</span>
          </span>
        ) : t.instrument}
      </Cell>
    ),
    type: <Cell>{tripType(t) ? <TypeBadge type={tripType(t)} short /> : <span className="text-faint" title="qkt did not state this instrument's type">{DASH}</span>}</Cell>,
    side: <Cell><SideText side={t.side} /></Cell>,
    entry: <Cell className="font-mono text-xs text-body"><span title={`${minuteStamp(t.entryTs)} UTC`}>{tableStamp(t.entryTs)}</span></Cell>,
    entryPrice: (
      <Cell right className="text-body">
        {premium ? (
          <span title={`Option premium per contract, in ${premium}`}>
            <span className="block truncate leading-tight">{px(t.entryPrice, t.priceDigits)}</span>
            <span className="block truncate text-[10px] leading-tight text-muted">{premium}</span>
          </span>
        ) : px(t.entryPrice, t.priceDigits)}
      </Cell>
    ),
    exit: <Cell className="font-mono text-xs text-body">{t.status === "open" ? <Pill tone="info">open</Pill> : <span title={`${minuteStamp(t.exitTs)} UTC`}>{tableStamp(t.exitTs)}</span>}</Cell>,
    exitPrice: <Cell right className="text-body">{t.status === "open" ? DASH : px(t.exitPrice, t.priceDigits)}</Cell>,
    size: (
      <Cell right className="text-body">
        {t.unit ? (
          <span title={sizeInWords(t.qty, t)}>
            <span className="block truncate leading-tight">{quantity(t.qty)}</span>
            <span className="block truncate text-[10px] leading-tight text-muted">{t.unit}</span>
          </span>
        ) : quantity(t.qty)}
      </Cell>
    ),
    pnl: <Cell right className={`font-semibold ${toneClass(t.pnlInExit ?? t.pnl)}`}>{t.pnl == null ? (t.status === "open" ? <OpenPnl value={floating.get(t.id)} /> : DASH) : <TripPnl t={t} />}</Cell>,
    r: <Cell right className={t.r == null ? "text-faint" : toneClass(t.r)}>{t.r == null ? (t.status === "open" ? DASH : <span title="No stop known for this entry (none was sent, or its events are past retention), so no R">no stop</span>) : rMultiple(t.r)}</Cell>,
    held: <Cell right className="text-body">{t.status === "open" ? DASH : duration(t.holdMs)}</Cell>,
    ended: <Cell>{t.status === "open" ? null : <EndedBadge ended={t.ended} />}</Cell>,
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
  /** Whether j/k/Enter drive this table (one table per page does). */
  keyboard?: boolean;
  empty?: ReactNode;
}

export function RoundTripTable({ scope, q, sort, dir, onSort, hide = [], height = "min(70dvh, 46rem)", fit = false, onTotals, keyboard = true, empty }: RoundTripTableProps) {
  const view = useView();
  // the open trade (?trade=) is highlighted, kept in view, and j/k continue from it
  const [openId, onOpen] = useOpenTrade();
  const wide = useWide();
  // a shared link's tickets are opaque stand-ins: no use as a column
  const hidden = useMemo(() => new Set(view.public ? [...hide, "id"] : hide), [hide, view.public]);
  const cols = COLUMNS.filter((c) => !hidden.has(c.key));
  // the last track holds the row's "opens" chevron
  const template = `${cols.map((c) => c.w).join(" ")} 1.75rem`;
  const minWidth = cols.reduce((a, c) => a + (parseInt(c.w.replace(/^minmax\((\d+)px.*$/, "$1"), 10) || 0), 0);
  const data = useRoundTrips(scope, q, sort, dir);
  const strategyName = useStrategyNames(scope?.instanceId);
  // open trades show what they are worth now, from the live positions (never on a shared link)
  const live = useLiveState();
  const floating = useMemo(() => {
    const out = new Map<string, number>();
    if (view.public) return out;
    for (const g of live.data?.positions ?? []) if (!scope || g.instanceId === scope.instanceId) for (const p of g.list) out.set(p.ticket, openPnl(p));
    return out;
  }, [live.data, scope, view.public]);
  const rows = useMemo(() => data.data?.pages.flatMap((p) => p.rows) ?? [], [data.data]);
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
    if (!keyboard) return;
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
  }, [keyboard, rows, sel, openId, onOpen, view.public]);

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
          <span className="min-w-0 truncate font-semibold text-bright" title={tripInstrument(t)}>{tripInstrument(t)}</span>
          <TypeBadge type={tripType(t)} short />
          <SideText side={t.side} />
          <span className={`ml-auto shrink-0 font-semibold ${toneClass(t.pnlInExit ?? t.pnl)}`}>{t.status === "open" ? <OpenPnl value={floating.get(t.id)} /> : <TripPnl t={t} />}</span>
          {clickable && <RowChevron />}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">{t.strategyId ?? "unattributed"}</span>
          <span className="shrink-0">· {rMultiple(t.r)}</span>
          <span className={`ml-auto shrink-0 whitespace-nowrap font-mono ${clickable ? "pr-6" : ""}`}>{minuteStamp(t.exitTs ?? t.entryTs)} UTC</span>
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
              Round trips could not be loaded.
              <button type="button" onClick={() => void data.refetch()} className="h-8 rounded-lg border border-ctl bg-raised px-3 font-medium text-bright hover:bg-well">
                Retry
              </button>
            </div>
          ) : data.isPending ? (
            <Skeleton lines={8} what="round trips" />
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted">{empty ?? <><b className="font-semibold text-body">No round trips match.</b> Loosen the query above.</>}</div>
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
