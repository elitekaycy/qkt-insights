import type { ReactNode } from "react";
import { DASH, signedMoney, toneClass } from "../format";
import { Popover } from "../components/ui";

/*
 * The journal's widget kit for the strategy page: a titled card whose title opens its explanation,
 * payoff bars, signed bars centred on zero and stat rows. Colours are theme tokens; every signed
 * figure carries its sign so colour is never the only signal.
 */

/**
 * The journal card: icon, title, a one-line hint on the right (what clicking does, or the scope
 * when the card ignores the search), optional explanation, then the body.
 */
export function Widget({
  title,
  hint,
  explain,
  children,
  className = "",
  pad = true,
  busy,
}: {
  title: string;
  hint?: ReactNode;
  explain?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
  /** A newer answer is loading: the old one stays, slightly dimmed. */
  busy?: boolean;
}) {
  return (
    <section className={`@container min-w-0 rounded-card border border-line bg-panel ${className}`}>
      <header className="flex min-h-11 items-center gap-2 px-4 pt-3">
                <h3 className="min-w-0 truncate text-sm text-muted">
          {explain ? (
            <Popover hover label={`What ${title} means`} trigger={<span className="cursor-help truncate underline decoration-line-strong decoration-dotted underline-offset-4">{title}</span>}>
              {explain}
            </Popover>
          ) : title}
        </h3>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {hint && <span className="hidden text-xs text-muted sm:inline">{hint}</span>}
                  </span>
      </header>
      {hint && <div className="px-4 text-xs text-muted sm:hidden">{hint}</div>}
      <div className={`${pad ? "px-4 pb-4 pt-2" : "pt-2"} transition-opacity ${busy ? "opacity-60" : ""}`}>{children}</div>
    </section>
  );
}

/** The page's hero money figure: "−1,002.40", 24px/650, tabular. */
export function BigPnl({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  if (value == null) return <div className={`text-2xl font-headline text-muted ${className}`}>{DASH}</div>;
  return (
    <div className={`text-2xl font-headline ${toneClass(value)} ${className}`}>{signedMoney(value)}</div>
  );
}

/** Two rows, average win and average loss, with bars scaled to the larger of the two. */
export function PayoffBars({ avgWin, avgLoss, onWin, onLoss }: { avgWin: number | null; avgLoss: number | null; onWin?: () => void; onLoss?: () => void }) {
  const max = Math.max(Math.abs(avgWin ?? 0), Math.abs(avgLoss ?? 0)) || 1;
  const row = (label: string, v: number | null, fill: string, onClick?: () => void) => (
    <button type="button" onClick={onClick} disabled={!onClick || v == null} className="grid w-full grid-cols-[3rem_1fr_auto] items-center gap-3 rounded-md py-1 text-left text-sm enabled:hover:bg-hover">
      <span className="text-muted">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-raised">
        <span className="block h-full rounded-full" style={{ width: `${(Math.abs(v ?? 0) / max) * 100}%`, background: fill }} />
      </span>
      <span className={`min-w-16 text-right font-semibold tabular-nums ${toneClass(v)}`}>{v == null ? DASH : signedMoney(v)}</span>
    </button>
  );
  return (
    <div className="grid grid-cols-1 gap-0.5">
      {row("Win", avgWin, "var(--color-gain-fill)", onWin)}
      {row("Loss", avgLoss, "var(--color-loss-fill)", onLoss)}
    </div>
  );
}

export interface SignedRow {
  key: string;
  label: string;
  value: number;
  n: number;
  /** Shown faded (thin sample) unless it is the picked row. */
  faded?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  title?: string;
}

/** Horizontal bars centred on a zero rule: gains grow right in green, losses left in red, with "n · value". */
export function SignedBars({ rows, labelWidth = "3.5rem" }: { rows: SignedRow[]; labelWidth?: string }) {
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
  const anyPressed = rows.some((r) => r.pressed);
  return (
    <div className="grid grid-cols-1 gap-0.5">
      {rows.map((r) => {
        const w = (Math.abs(r.value) / max) * 50;
        const dim = anyPressed ? !r.pressed : r.faded;
        return (
          <button
            key={r.key}
            type="button"
            aria-pressed={r.pressed}
            disabled={!r.onClick}
            onClick={r.onClick}
            title={r.title}
            className={`grid min-h-7 w-full items-center gap-3 rounded-md px-1 text-left text-sm transition enabled:hover:bg-hover ${r.pressed ? "bg-accent-soft" : ""}`}
            style={{ gridTemplateColumns: `${labelWidth} 1fr auto` }}
          >
            <span className="truncate text-muted">{r.label}</span>
            <span className="relative h-2 rounded-full bg-raised">
              <span className="absolute inset-y-[-3px] left-1/2 w-px bg-line-strong" aria-hidden />
              {r.n > 0 && (
                <span
                  className="absolute inset-y-0 rounded-full"
                  style={{
                    left: r.value >= 0 ? "50%" : `${50 - w}%`,
                    width: `${Math.max(w, 0.6)}%`,
                    background: r.value >= 0 ? "var(--color-gain-fill)" : "var(--color-loss-fill)",
                    opacity: dim ? 0.35 : 1,
                  }}
                />
              )}
            </span>
            <span className="min-w-[8rem] whitespace-nowrap text-right tabular-nums">
              <span className="text-muted">{r.n} · </span>
              <span className={r.n === 0 ? "text-muted" : toneClass(r.value)}>{r.n === 0 ? "0" : signedMoney(r.value)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Label left, value right, hairline under: the journal's stat row. */
export function StatRow({ label, children, onClick, title }: { label: ReactNode; children: ReactNode; onClick?: () => void; title?: string }) {
  const body = (
    <>
      <span className="text-muted">{label}</span>
      <span className="text-right font-semibold tabular-nums text-bright">{children}</span>
    </>
  );
  const cls = "flex min-h-9 w-full items-center justify-between gap-3 border-b border-line py-1.5 text-sm last:border-b-0";
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={`${cls} rounded-sm text-left hover:bg-hover`}>{body}</button>
  ) : (
    <div className={cls} title={title}>{body}</div>
  );
}
