import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { money, tsDay, tsShort } from "../format";

/*
 * The component kit every page is built from. Pages compose these and never
 * hand-roll panel/table/badge markup, so a restyle happens here (or in the
 * tokens in index.css) and nowhere else.
 */

export function Card({
  children,
  className = "",
  stagger,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
}) {
  return (
    <div
      className={`rise @container rounded-card border border-line bg-panel ${className}`}
      style={stagger != null ? ({ "--stagger": stagger } as React.CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="rise flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-2xl font-extrabold tracking-tight text-bright">{title}</h2>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/** Dimmed, blurred backdrop with a centered panel. Closes on Escape or backdrop click. */
export function Modal({
  open,
  onClose,
  title,
  hint,
  toolbar,
  children,
  width = "min(96vw, 1240px)",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  hint?: string;
  toolbar?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  // Portal to <body>: ancestors with a transform (e.g. the .rise entrance) would
  // otherwise become the containing block and trap this fixed overlay inside a card.
  // On a phone the panel is a bottom sheet — full width, rising from the edge,
  // dismissed by a drag on its header — and a centered card from `sm` up.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 backdrop-blur-md sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-in pad-safe-bottom @container flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-card border border-line-strong bg-panel shadow-2xl shadow-black/60 sm:rise sm:max-h-[90vh] sm:w-[var(--modal-w)] sm:rounded-card"
        style={{ "--modal-w": width } as React.CSSProperties}
      >
        <SheetHeader onClose={onClose}>
          <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2.5">
            <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-bright">{title}</h3>
            {hint && <span className="truncate text-xs text-faint">{hint}</span>}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {toolbar}
            <IconButton label="close" onClick={onClose} d="M18 6L6 18M6 6l12 12" />
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

const SHEET_DISMISS_PX = 70;

/** Modal header: grab handle on phones, and a downward drag on it closes the sheet. */
function SheetHeader({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const startY = useRef<number | null>(null);
  return (
    <div
      className="shrink-0 border-b border-line"
      onTouchStart={(e) => {
        startY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        const y0 = startY.current;
        const y1 = e.changedTouches[0]?.clientY;
        startY.current = null;
        if (y0 != null && y1 != null && y1 - y0 > SHEET_DISMISS_PX) onClose();
      }}
    >
      <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong sm:hidden" />
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5 sm:py-3.5">{children}</div>
    </div>
  );
}

/**
 * A dashboard panel: card + titled header with an optional toolbar, expandable
 * into a Modal for a bigger view of the same content (e.g. a cramped trades
 * table on the strategy page → full-width table with its filters).
 */
export function Panel({
  title,
  hint,
  toolbar,
  right,
  children,
  stagger,
  className = "",
  scroll,
}: {
  title: string;
  hint?: string;
  toolbar?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  stagger?: number;
  className?: string;
  /** Max-height class for the inline body, e.g. "max-h-[28rem]". The body scrolls on its own instead of growing the page; the expanded modal scrolls itself regardless. */
  scroll?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <Card stagger={stagger} className={className}>
        {/* header lays out by the panel's own width: a half-width column stacks the
            toolbar under the title instead of wrapping its controls one per line */}
        <div className="flex flex-col gap-3 border-b border-line px-5 py-3 @3xl:flex-row @3xl:items-center">
          <div className="flex min-w-0 flex-col items-start gap-0.5 @3xl:flex-row @3xl:items-baseline @3xl:gap-2.5">
            <h3 className="shrink-0 text-sm font-bold uppercase tracking-[0.08em] text-body">{title}</h3>
            {hint && <span className="text-xs text-faint">{hint}</span>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 @3xl:ml-auto @3xl:shrink-0 @3xl:justify-end">
            {toolbar}
            {right}
            {/* expanding to a near-full-screen modal buys nothing on a phone */}
            <span className="hidden sm:inline-flex">
              <IconButton
                label="expand"
                onClick={() => setExpanded(true)}
                d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
              />
            </span>
          </div>
        </div>
        {scroll ? <div className={`overflow-auto ${scroll}`}>{children}</div> : children}
      </Card>
      <Modal open={expanded} onClose={() => setExpanded(false)} title={title} hint={hint} toolbar={toolbar}>
        {children}
      </Modal>
    </>
  );
}

export function IconButton({ label, onClick, d, disabled }: { label: string; onClick: () => void; d: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-line bg-raised p-1.5 text-muted transition hover:border-line-strong hover:text-body disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-line disabled:hover:text-muted"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </button>
  );
}

export type Tone = "neutral" | "up" | "down" | "warn" | "info" | "accent";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-bright",
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
  info: "text-info",
  accent: "text-accent",
};

const TONE_PILL: Record<Tone, string> = {
  neutral: "bg-raised text-muted",
  up: "bg-up/15 text-up",
  down: "bg-down/15 text-down",
  warn: "bg-warn/15 text-warn",
  info: "bg-info/15 text-info",
  accent: "bg-accent/15 text-accent",
};

export function Stat({
  label,
  value,
  tone = "neutral",
  sub,
  stagger,
  expand,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  sub?: string;
  stagger?: number;
  /** Breakdown shown in a modal; reveals a hover-only expand icon so the card design stays intact. */
  expand?: { hint?: string; width?: string; content: ReactNode };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card className="group relative px-4 py-3.5" stagger={stagger}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</div>
        <div className={`mt-1.5 font-mono text-xl font-semibold ${TONE_TEXT[tone]}`}>{value}</div>
        {sub && <div className="mt-0.5 text-xs text-faint">{sub}</div>}
        {expand && <HoverExpand label={`expand ${label}`} onClick={() => setOpen(true)} />}
      </Card>
      {expand && (
        <Modal open={open} onClose={() => setOpen(false)} title={label} hint={expand.hint} width={expand.width ?? "min(94vw, 760px)"}>
          {expand.content}
        </Modal>
      )}
    </>
  );
}

/**
 * Replays a one-shot background flash whenever `value` changes: the key swap
 * remounts the span, restarting the .value-flash CSS animation. Wrap live
 * numbers so a WS tick is visible, e.g. <FlashValue value={a.equity}>{money(a.equity)}</FlashValue>.
 */
export function FlashValue({ value, children, className = "" }: { value: unknown; children: ReactNode; className?: string }) {
  return (
    <span key={String(value)} className={`value-flash ${className}`}>
      {children}
    </span>
  );
}

/** Expand icon that fades in when its parent `.group` card is hovered. */
export function HoverExpand({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute right-2.5 top-2.5 rounded-lg border border-line bg-raised p-1.5 text-muted opacity-0 transition hover:border-line-strong hover:text-body focus:opacity-100 group-hover:opacity-100"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
      </svg>
    </button>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold ${TONE_PILL[tone]}`}
    >
      {children}
    </span>
  );
}

export function Delta({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-faint">—</span>;
  const up = value >= 0;
  return (
    <span className={`font-mono text-sm font-semibold ${up ? "text-up" : "text-down"}`}>
      {up ? "▲" : "▼"} {(Math.abs(value) * 100).toFixed(2)}%
    </span>
  );
}

/**
 * Compact P&L line under an allocation figure: arrow, signed dollars, and the
 * return on the allocated capital. e.g. net -2658.7 on base 10000 →
 * "▼ −2,658.70 (−26.6%)". `dim` greys it when the live source is stale.
 */
export function PnlLine({ net, base, dim }: { net: number | null | undefined; base?: number | null; dim?: boolean }) {
  if (net == null) return <span className="text-faint">—</span>;
  const up = net >= 0;
  const sign = up ? "+" : "−";
  const pct = base ? ` (${sign}${Math.abs((net / base) * 100).toFixed(1)}%)` : "";
  return (
    <span className={`font-mono text-sm font-semibold ${dim ? "text-faint" : up ? "text-up" : "text-down"}`}>
      {up ? "▲" : "▼"} {sign}
      {money(Math.abs(net))}
      {pct}
    </span>
  );
}

/**
 * Just the signed return on base as "▲ 12.3%" — pairs with a P&L dollar headline
 * so the percentage isn't a second copy of the amount. e.g. net -5049.73 on base
 * 10000 → "▼ 50.5%". A null base (no notional) renders a dash.
 */
export function ReturnPct({ net, base, dim }: { net: number | null | undefined; base?: number | null; dim?: boolean }) {
  if (net == null || !base) return <span className="text-faint">—</span>;
  const up = net >= 0;
  return (
    <span className={`font-mono text-sm font-semibold ${dim ? "text-faint" : up ? "text-up" : "text-down"}`}>
      {up ? "▲" : "▼"} {Math.abs((net / base) * 100).toFixed(1)}%
    </span>
  );
}

/** Direction badge for a dollar amount: arrow and tone from the sign. `dim` greys it when the source is stale. */
export function MoneyDelta({ value, dim }: { value: number | null | undefined; dim?: boolean }) {
  if (value == null) return <span className="text-faint">—</span>;
  const up = value >= 0;
  return (
    <span className={`font-mono text-sm font-semibold ${dim ? "text-faint" : up ? "text-up" : "text-down"}`}>
      {up ? "▲" : "▼"} {money(Math.abs(value))}
    </span>
  );
}

export function SideTag({ side }: { side: string | null | undefined }) {
  if (!side) return <span className="text-faint">—</span>;
  return <Pill tone={side === "BUY" ? "up" : "down"}>{side}</Pill>;
}

export const LEVEL_TONE: Record<string, Tone> = {
  ERROR: "down",
  WARN: "warn",
  INFO: "info",
  DEBUG: "neutral",
};

export const STATE_TONE: Record<string, Tone> = {
  FILLED: "up",
  WORKING: "info",
  SUBMITTED: "info",
  PARTIALLY_FILLED: "warn",
  CANCELLED: "neutral",
  REJECTED: "down",
};

export function LiveDot({ on, down = false }: { on: boolean; down?: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "live-dot bg-up" : down ? "bg-down" : "bg-faint"}`}
      title={on ? "live" : down ? "down" : "idle"}
    />
  );
}

export function Table({ head, children }: { head?: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-sm">
      {head && (
        <thead>
          <tr className="border-b border-line text-left">
            {head.map((h) => (
              <th key={h} className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted @3xl:px-4">
                {h}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>{children}</tbody>
    </table>
  );
}

export function Row({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={`border-b border-line/60 text-body last:border-b-0 ${onClick ? "cursor-pointer transition hover:bg-raised/60" : ""}`}
    >
      {children}
    </tr>
  );
}

export function Cell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 @3xl:px-4 ${className}`}>{children}</td>;
}

/**
 * One dataset, two shapes: a column table from `sm` up, and a stacked card list
 * on phones where a nine-column table would push everything that matters off
 * the right edge behind a nested horizontal scroll.
 */
export function DataList<T>({
  head,
  rows,
  keyOf,
  cells,
  card,
  onRow,
  empty,
}: {
  head: string[];
  rows: T[];
  keyOf: (row: T) => string;
  cells: (row: T) => ReactNode;
  card: (row: T) => ReactNode;
  onRow?: (row: T) => void;
  empty: string;
}) {
  if (rows.length === 0) return <div className="px-4 py-10 text-center text-sm text-faint">{empty}</div>;
  // the switch is on the list's own width, so a table also gives way to cards
  // inside a narrow desktop column or a modal, not only on a phone
  return (
    <div className="@container">
      <div className="hidden @xl:block">
        <Table head={head}>
          {rows.map((r) => (
            <Row key={keyOf(r)} onClick={onRow ? () => onRow(r) : undefined}>
              {cells(r)}
            </Row>
          ))}
        </Table>
      </div>
      <ul className="divide-y divide-line/60 @xl:hidden">
        {rows.map((r) => (
          <li key={keyOf(r)}>
            {onRow ? (
              <button type="button" onClick={() => onRow(r)} className="block w-full px-4 py-3 text-left transition active:bg-raised">
                {card(r)}
              </button>
            ) : (
              <div className="px-4 py-3">{card(r)}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Timestamp cell: weekday + full date once the table is wide, a short stamp otherwise. */
export function TimeCell({ ts }: { ts: number }) {
  return (
    <Cell className="whitespace-nowrap text-muted">
      <span className="@4xl:hidden">{tsShort(ts)}</span>
      <span className="hidden @4xl:inline">{tsDay(ts)}</span>
    </Cell>
  );
}

export function Empty({ children, colSpan }: { children: ReactNode; colSpan?: number }) {
  const inner = <div className="px-4 py-10 text-center text-sm text-faint">{children}</div>;
  if (colSpan == null) return inner;
  return (
    <tr>
      <td colSpan={colSpan}>{inner}</td>
    </tr>
  );
}

/** "Showing 30 of 480 · Load more" footer for capped lists. */
export function LoadMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <div className="flex items-center justify-center gap-3 border-t border-line px-4 py-2.5">
      <span className="text-xs text-faint">
        showing {shown} of {total}
      </span>
      <button
        type="button"
        onClick={onMore}
        className="rounded-lg border border-line bg-raised px-3 py-1 text-xs font-semibold text-body transition hover:border-accent/50 hover:text-accent"
      >
        Load more
      </button>
    </div>
  );
}

export const RANGES = [
  { key: "24h", label: "Last 24h", ms: 86_400_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { key: "all", label: "All time", ms: Infinity },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

export function rangeStart(key: RangeKey): number {
  const r = RANGES.find((x) => x.key === key)!;
  return r.ms === Infinity ? 0 : Date.now() - r.ms;
}

export function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as RangeKey)}>
      {RANGES.map((r) => (
        <option key={r.key} value={r.key}>
          {r.label}
        </option>
      ))}
    </Select>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`h-9 rounded-lg border border-line bg-raised px-3 text-sm text-body placeholder-faint outline-none transition focus:border-accent/60 focus:bg-panel ${className}`}
    />
  );
}

/** Text input with a magnifier icon, sized for query-as-you-type filtering. */
export function SearchInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35" />
      </svg>
      <input
        {...rest}
        className="h-9 w-full rounded-lg border border-line bg-raised pl-9 pr-3 text-sm text-body placeholder-faint outline-none transition focus:border-accent/60 focus:bg-panel"
      />
    </div>
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  // phones: share the toolbar row, but never squeeze below a readable label —
  // two fit side by side, a third wraps
  return (
    <div className={`relative ${className.includes("w-full") ? "w-full" : "min-w-[9rem] flex-1 sm:inline-block sm:min-w-0 sm:flex-none"}`}>
      <select
        {...rest}
        className={`h-9 w-full appearance-none truncate rounded-lg border border-line bg-raised pl-3 pr-8 text-sm text-body outline-none transition hover:border-line-strong focus:border-accent/60 ${className}`}
      />
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  );
}

export function Button({
  variant = "ghost",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const styles =
    variant === "primary"
      ? "bg-accent text-ink font-bold hover:bg-accent-dim"
      : "border border-line bg-raised text-body hover:border-line-strong";
  return (
    <button
      {...rest}
      className={`h-9 rounded-lg px-4 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

/** One label/value pair inside a detail modal. */
export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-line bg-raised px-4 py-3 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 break-all font-mono text-sm text-bright">{children}</div>
    </div>
  );
}

/** Pulsing placeholder bars shown where content will land once its query resolves. */
export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`animate-pulse space-y-3 p-4 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 rounded bg-raised" style={{ width: `${100 - (i % 3) * 18}%` }} />
      ))}
    </div>
  );
}

/**
 * Per-panel gate around one query: skeleton while the first load is in
 * flight, an inline error with a Retry button if the fetch failed, otherwise
 * the content. Wrapping each panel separately keeps one broken endpoint from
 * blanking the whole page.
 * e.g. `<Loadable loading={q.isPending} error={q.isError} retry={q.refetch}>…</Loadable>`
 */
export function Loadable({
  loading,
  error,
  retry,
  what = "this panel",
  lines,
  children,
}: {
  loading: boolean;
  error: boolean;
  retry: () => void;
  what?: string;
  lines?: number;
  children: ReactNode;
}) {
  if (error)
    return (
      <div className="m-4 flex items-center justify-between gap-3 rounded-lg border border-down/40 bg-down/10 px-4 py-3 text-sm text-down">
        <span>Failed to load {what}.</span>
        <Button onClick={() => retry()}>Retry</Button>
      </div>
    );
  if (loading) return <Skeleton lines={lines} />;
  return <>{children}</>;
}
