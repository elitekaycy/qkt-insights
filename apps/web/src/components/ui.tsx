import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParam } from "../router";
import { DASH, glyph, pnl, signedMoney, signedPct, toneClass, tsDay, tsShort } from "../format";

/*
 * The component kit every page is built from. Pages compose these and never
 * hand-roll panel/table/badge markup, so a restyle happens here (or in the
 * tokens in index.css) and nowhere else.
 */

/** A widget surface: hairline border that strengthens on hover, no shadow. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`@container rounded-card border border-line bg-panel transition-colors hover:border-line-strong ${className}`}>
      {children}
    </div>
  );
}

/** Page title (20px, 650) with a one-line muted hint, the journal's section header. */
export function PageHeader({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-headline text-bright">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
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
  // Portal to <body>: an ancestor with a transform would otherwise become the
  // containing block and trap this fixed overlay inside a card.
  // On a phone the panel is a bottom sheet — full width, rising from the edge,
  // dismissed by a drag on its header — and a centered card from `sm` up.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-in pad-safe-bottom @container flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-card border border-line-strong bg-panel shadow-pop sm:max-h-[90vh] sm:w-[var(--modal-w)] sm:rounded-card"
        style={{ "--modal-w": width } as React.CSSProperties}
      >
        <SheetHeader onClose={onClose}>
          <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2.5">
            <h2 className="text-[15px] font-headline text-bright">{title}</h2>
            {hint && <span className="truncate text-xs text-muted">{hint}</span>}
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
      <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-well sm:hidden" />
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
  className = "",
  scroll,
}: {
  title: string;
  hint?: string;
  toolbar?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Max-height class for the inline body, e.g. "max-h-[28rem]". The body scrolls on its own instead of growing the page; the expanded modal scrolls itself regardless. */
  scroll?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <Card className={className}>
        {/* header lays out by the panel's own width: a half-width column stacks the
            toolbar under the title instead of wrapping its controls one per line */}
        <div className="flex flex-col gap-2 border-b border-line px-4 py-3 @3xl:flex-row @3xl:items-center">
          <div className="flex min-w-0 flex-col items-start gap-0.5 @3xl:flex-row @3xl:items-baseline @3xl:gap-2.5">
            <h3 className="shrink-0 text-sm font-medium text-body">{title}</h3>
            {hint && <span className="text-xs text-muted">{hint}</span>}
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
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line-strong bg-raised text-muted transition hover:bg-well hover:text-bright disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-raised disabled:hover:text-muted"
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
  up: "text-gain",
  down: "text-loss",
  warn: "text-warn",
  info: "text-info",
  accent: "text-accent-ink",
};

const TONE_PILL: Record<Tone, string> = {
  neutral: "border-line bg-raised text-body",
  up: "border-transparent bg-gain-fill/15 text-gain",
  down: "border-transparent bg-loss-fill/15 text-loss",
  warn: "border-warn/45 bg-transparent text-warn",
  info: "border-transparent bg-accent-soft text-accent-ink",
  accent: "border-transparent bg-accent-soft text-accent-ink",
};

export function Stat({
  label,
  value,
  signed,
  tone = "neutral",
  sub,
  expand,
}: {
  label: string;
  /** The figure as text; omit it and pass `signed` for a P&L figure. */
  value?: ReactNode;
  /** A signed money figure: rendered "▲ +1,234.50" in the gain or loss tone. */
  signed?: number | null;
  tone?: Tone;
  sub?: string;
  /** Breakdown shown in a modal, opened by a visible "explain" button (click or tap, never hover-only). */
  expand?: { hint?: string; width?: string; content: ReactNode };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card className="relative min-w-0 p-4">
        <div className={`truncate text-sm font-medium text-muted ${expand ? "pr-8" : ""}`}>{label}</div>
        {value === undefined ? (
          <div className="mt-1.5 truncate text-xl font-headline">
            <Pnl value={signed} />
          </div>
        ) : (
          <div className={`mt-1.5 truncate text-xl font-headline ${TONE_TEXT[tone]}`}>{value}</div>
        )}
        {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
        {expand && <ExplainButton label={`Explain ${label}`} onClick={() => setOpen(true)} />}
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

/** Always-visible "what does this mean" control in a card corner; opens on click or tap. */
export function ExplainButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-faint transition hover:bg-hover hover:text-bright"
    >
      <InfoIcon />
    </button>
  );
}

export function InfoIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

/**
 * Click- or tap-to-open popover anchored under its trigger, for short explanations that would
 * otherwise hide in a hover-only title. Closes on Escape, an outside press, or a second click.
 */
export function Popover({ trigger, label, children, align = "left" }: { trigger: ReactNode; label: string; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex items-center rounded-md"
      >
        {trigger}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className={`pop-in absolute top-full z-40 mt-1.5 w-max max-w-[min(20rem,80vw)] rounded-xl border border-line-strong bg-panel p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-body shadow-pop ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** Segmented control: the journal's tab and toggle group. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { key: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-line bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          onClick={() => onChange(o.key)}
          className={`h-7 whitespace-nowrap rounded-md px-3 text-sm font-medium transition ${
            value === o.key ? "bg-well text-bright" : "text-body hover:bg-hover hover:text-bright"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium ${TONE_PILL[tone]}`}
    >
      {children}
    </span>
  );
}

/** A fractional change as "▲ +1.25%"; colour pairs with the glyph and the sign. */
export function Delta({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-faint">{DASH}</span>;
  return (
    <span className={`text-sm font-semibold ${toneClass(value * 100)}`}>
      {glyph(value * 100)} {signedPct(value * 100)}
    </span>
  );
}

/**
 * Signed money with its direction glyph, "▲ +1,234.50" / "▼ −56.00", in the gain or loss tone.
 * `dim` greys it when the live source is stale. Every P&L figure renders through this.
 */
export function Pnl({ value, dim, className = "", glyphs = true }: { value: number | null | undefined; dim?: boolean; className?: string; glyphs?: boolean }) {
  return (
    <span className={`whitespace-nowrap ${dim ? "text-faint" : toneClass(value)} ${className}`}>
      {glyphs ? pnl(value) : signedMoney(value)}
    </span>
  );
}

/**
 * The signed return on base as "▲ +12.3%", paired with a money headline so the percentage is not a
 * second copy of the amount. A null base (no notional) renders a dash.
 */
export function ReturnPct({ net, base, dim }: { net: number | null | undefined; base?: number | null; dim?: boolean }) {
  if (net == null || !base) return <span className="text-faint">{DASH}</span>;
  const r = (net / base) * 100;
  return (
    <span className={`text-sm font-semibold ${dim ? "text-faint" : toneClass(r, 1)}`}>
      {glyph(r, 1)} {signedPct(r, 1)}
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
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "live-dot bg-ok" : down ? "bg-danger" : "bg-faint"}`}
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
              <th key={h} className="eyebrow whitespace-nowrap px-3 py-2 @3xl:px-4">
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
      className={`border-b border-line text-bright transition-colors last:border-b-0 hover:bg-hover ${onClick ? "cursor-pointer" : ""}`}
    >
      {children}
    </tr>
  );
}

export function Cell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-[7px] @3xl:px-4 ${className}`}>{children}</td>;
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
  if (rows.length === 0) return <div className="px-4 py-10 text-center text-sm text-muted">{empty}</div>;
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
      <ul className="divide-y divide-line @xl:hidden">
        {rows.map((r) => (
          <li key={keyOf(r)}>
            {onRow ? (
              <button type="button" onClick={() => onRow(r)} className="block w-full px-4 py-3 text-left transition hover:bg-hover active:bg-press">
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
  const inner = <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
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
        className="h-7 rounded-md border border-ctl bg-raised px-3 text-xs font-medium text-bright transition hover:bg-well"
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

/** The page's date range, held in the URL as `range` so links and reloads keep it. */
export function useRangeParam(): [RangeKey, (v: RangeKey) => void] {
  const [raw, set] = useSearchParam("range", "all");
  const key = (RANGES.find((r) => r.key === raw)?.key ?? "all") as RangeKey;
  return [key, (v) => set(v)];
}

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
      className={`h-8 rounded-lg border border-ctl bg-panel px-3 text-sm text-bright outline-none transition placeholder:text-muted hover:border-muted focus:border-accent-hi focus:ring-3 focus:ring-accent-soft ${className}`}
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
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35" />
      </svg>
      <input
        {...rest}
        className="h-8 w-full rounded-lg border border-ctl bg-panel pl-9 pr-3 text-sm text-bright outline-none transition placeholder:text-muted hover:border-muted focus:border-accent-hi focus:ring-3 focus:ring-accent-soft"
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
        className={`h-8 w-full appearance-none truncate rounded-lg border border-ctl bg-panel pl-3 pr-8 text-sm text-bright outline-none transition hover:border-muted focus:border-accent-hi focus:ring-3 focus:ring-accent-soft ${className}`}
      />
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
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
      ? "bg-accent text-on-accent hover:bg-accent-hi"
      : "border border-ctl bg-raised text-bright hover:bg-well";
  return (
    <button
      {...rest}
      className={`h-8 rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${styles} ${className}`}
    />
  );
}

/** One label/value pair inside a detail modal. */
export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-line bg-raised px-3 py-2.5 ${wide ? "sm:col-span-2" : ""}`}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 break-all text-sm text-bright">{children}</div>
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
      <div className="m-4 flex items-center justify-between gap-3 rounded-lg border border-danger/45 bg-danger/10 px-3 py-2 text-sm text-loss">
        <span>Failed to load {what}.</span>
        <Button onClick={() => retry()}>Retry</Button>
      </div>
    );
  if (loading) return <Skeleton lines={lines} />;
  return <>{children}</>;
}

/** Placeholder while a page's code chunk loads: sized like a page header and a card row. */
export function PageFallback() {
  return (
    <div className="animate-pulse" role="status" aria-label="Loading">
      <div className="h-6 w-40 rounded bg-raised" />
      <div className="mt-2 h-4 w-72 max-w-full rounded bg-raised" />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 rounded-card border border-line bg-panel" />
        ))}
      </div>
    </div>
  );
}
