import type { ReactNode } from "react";
import { DASH, glyph, signedMoney, toneClass } from "../format";
import { InfoIcon, Popover } from "../components/ui";

/*
 * The journal's widget kit for the strategy page: a titled card with a click hint, KPI cards with
 * a tap-to-open explanation, the win-rate ring, the profit-factor gauge, payoff bars, signed bars
 * centred on zero, stat rows and a faint sparkline. Colours are theme tokens; every signed figure
 * carries a glyph or sign so colour is never the only signal.
 */

export const ICON = {
  pnl: "M3 17l6-6 4 4 8-8M21 7v5h-5",
  percent: "M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  gauge: "M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0",
  scale: "M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8",
  target: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  drawdown: "M3 7l6 6 4-4 8 8M21 11v6h-6",
  ratio: "M22 12h-4l-3 9L9 3l-3 9H2",
  line: "M3 3v18h18M7 15l4-5 4 3 5-7",
  bars: "M3 3v18h18M7 16v-5M11 16V8M15 16v-3M19 16V6",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  flag: "M4 22V4M4 4h13l-2 4 2 4H4",
  hourglass: "M6 2h12M6 22h12M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4",
  side: "M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4",
  streak: "M4 6h16M4 12h10M4 18h6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  coins: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  logs: "M5 4h14M5 9h14M5 14h9M5 19h6",
} as const;

export function Icon({ d, className = "h-[15px] w-[15px]" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** What a metric is and how to read it, opened by click or tap (never hover only). */
export function Explain({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover label={`What ${label} means`} align="right" trigger={<span className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition hover:bg-hover hover:text-bright"><InfoIcon className="h-[15px] w-[15px]" /></span>}>
      {children}
    </Popover>
  );
}

/**
 * The journal card: icon, title, a one-line hint on the right (what clicking does, or the scope
 * when the card ignores the search), optional explanation, then the body.
 */
export function Widget({
  icon,
  title,
  hint,
  explain,
  children,
  className = "",
  pad = true,
  busy,
}: {
  icon?: string;
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
    <section className={`@container min-w-0 rounded-card border border-line bg-panel transition-colors hover:border-line-strong ${className}`}>
      <header className="flex min-h-11 items-center gap-2 px-4 pt-3">
        {icon && <span className="text-faint"><Icon d={icon} /></span>}
        <h3 className="min-w-0 truncate text-[13px] font-medium text-muted">{title}</h3>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {hint && <span className="hidden text-[11px] text-muted sm:inline">{hint}</span>}
          {explain && <Explain label={title}>{explain}</Explain>}
        </span>
      </header>
      {hint && <div className="px-4 text-[11px] text-muted sm:hidden">{hint}</div>}
      <div className={`${pad ? "px-4 pb-4 pt-2" : "pt-2"} transition-opacity ${busy ? "opacity-60" : ""}`}>{children}</div>
    </section>
  );
}

/** A big signed money figure: "▼ −1,002.40", 24px/650, tabular. */
export function BigPnl({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  if (value == null) return <div className={`text-2xl font-headline text-faint ${className}`}>{DASH}</div>;
  return (
    <div className={`text-2xl font-headline tracking-tight ${toneClass(value)} ${className}`}>
      {glyph(value)} {signedMoney(value)}
    </div>
  );
}

/** Win rate as a donut: gain arc for wins, loss arc for losses, the percentage in the middle. */
export function Ring({ wins, losses, size = 72, onWins, onLosses, picked }: {
  wins: number; losses: number; size?: number; onWins?: () => void; onLosses?: () => void; picked?: "win" | "loss" | null;
}) {
  const total = wins + losses;
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && wins > 0 && losses > 0 ? 3 : 0;
  const winLen = total > 0 ? (wins / total) * c : 0;
  const lossLen = total > 0 ? c - winLen : 0;
  const pct = total > 0 ? Math.round((wins / total) * 100) : null;
  const dim = (k: "win" | "loss") => (picked && picked !== k ? 0.35 : 1);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={pct == null ? "No decided trades" : `${pct}% of decided trades won`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-raised)" strokeWidth={9} />
      {total > 0 && (
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {wins > 0 && (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-gain-fill)" strokeWidth={9} opacity={dim("win")}
              strokeDasharray={`${Math.max(0, winLen - gap)} ${c}`} className={onWins ? "cursor-pointer" : ""} onClick={onWins}>
              <title>{wins} wins: click to list them</title>
            </circle>
          )}
          {losses > 0 && (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-loss-fill)" strokeWidth={9} opacity={dim("loss")}
              strokeDasharray={`${Math.max(0, lossLen - gap)} ${c}`} strokeDashoffset={-winLen} className={onLosses ? "cursor-pointer" : ""} onClick={onLosses}>
              <title>{losses} losses: click to list them</title>
            </circle>
          )}
        </g>
      )}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="fill-bright text-[17px] font-headline tabular-nums">
        {pct == null ? DASH : `${pct}%`}
      </text>
    </svg>
  );
}

/** Profit factor as a half gauge from 0 to 3, a tick at the 1.0 break-even, green at or above it and red below. */
export function Gauge({ value }: { value: number | "inf" | null }) {
  const w = 132, h = 76, r = 54, cx = w / 2, cy = 66;
  const max = 3;
  const v = value === "inf" ? max : value == null ? 0 : Math.min(max, Math.max(0, value));
  const point = (k: number) => {
    const a = Math.PI * (1 - k);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
  };
  const arc = (k: number) => {
    const [x, y] = point(k);
    return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`;
  };
  const [tx1, ty1] = [cx + (r - 9) * Math.cos(Math.PI * (2 / 3)), cy - (r - 9) * Math.sin(Math.PI * (2 / 3))];
  const [tx2, ty2] = [cx + (r + 7) * Math.cos(Math.PI * (2 / 3)), cy - (r + 7) * Math.sin(Math.PI * (2 / 3))];
  const good = value === "inf" || (typeof value === "number" && value >= 1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Profit factor ${value ?? "unknown"}, break-even at 1`}>
      <path d={arc(1)} fill="none" stroke="var(--color-raised)" strokeWidth={9} strokeLinecap="round" />
      {value != null && v > 0 && <path d={arc(v / max)} fill="none" stroke={good ? "var(--color-gain-fill)" : "var(--color-loss-fill)"} strokeWidth={9} strokeLinecap="round" />}
      <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="var(--color-muted)" strokeWidth={1.5}>
        <title>break-even (1.0)</title>
      </line>
    </svg>
  );
}

/** Two rows, average win and average loss, with bars scaled to the larger of the two. */
export function PayoffBars({ avgWin, avgLoss, onWin, onLoss }: { avgWin: number | null; avgLoss: number | null; onWin?: () => void; onLoss?: () => void }) {
  const max = Math.max(Math.abs(avgWin ?? 0), Math.abs(avgLoss ?? 0)) || 1;
  const row = (label: string, v: number | null, fill: string, onClick?: () => void) => (
    <button type="button" onClick={onClick} disabled={!onClick || v == null} className="grid w-full grid-cols-[3rem_1fr_auto] items-center gap-3 rounded-md py-1 text-left text-sm enabled:hover:bg-hover">
      <span className="text-body">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-raised">
        <span className="block h-full rounded-full" style={{ width: `${(Math.abs(v ?? 0) / max) * 100}%`, background: fill }} />
      </span>
      <span className={`min-w-16 text-right font-semibold tabular-nums ${toneClass(v)}`}>{v == null ? DASH : signedMoney(v, 0)}</span>
    </button>
  );
  return (
    <div className="grid gap-0.5">
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
    <div className="grid gap-0.5">
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
            <span className="truncate text-body">{r.label}</span>
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
            <span className="min-w-[6.5rem] whitespace-nowrap text-right tabular-nums">
              <span className="text-muted">{r.n} · </span>
              <span className={r.n === 0 ? "text-faint" : toneClass(r.value)}>{r.n === 0 ? "0" : signedMoney(r.value, 0)}</span>
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
      <span className="text-body">{label}</span>
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

/** A faint area sparkline behind a KPI: one colour, never recoloured by its last point. */
export function Spark({ values, className = "" }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const w = 200, h = 48;
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - ((v - min) / span) * h] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className={`pointer-events-none ${className}`}>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill="var(--color-s1)" opacity={0.12} />
      <path d={line} fill="none" stroke="var(--color-s1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.7} />
    </svg>
  );
}
