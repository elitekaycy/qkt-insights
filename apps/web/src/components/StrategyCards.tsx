import { useId, type ReactNode } from "react";
import { age, count, DASH, money, ts } from "../format";
import { haltClearing, haltReasonText, haltSummary } from "../halt";
import { Link } from "../router";
import { cardFigures, cardName, sparkPath, thinCurve, type CardLine, type PortfolioCard } from "../strategyCards";
import type { Leg } from "../instruments";
import { LegLine } from "./InstrumentType";
import { CurrencyMix, Pnl, ReturnPct } from "./ui";

/*
 * The Strategies page's cards: one per strategy (name, what it trades on one line, net incl. open with its return on
 * its own base on hover, a sparkline of cumulative realized P&L once there are five closes, then today, open, trades
 * and last close), and a group card per portfolio with its sleeves beneath. The whole card is the link. A halted
 * strategy stays at full ink with its reason in amber under the name; a retired one is muted.
 */

const SPARK_W = 120;
const SPARK_H = 36;

/** Cumulative realized P&L, one stable series colour with a faint fade; a dashed zero when the curve crosses it. */
function Sparkline({ points, className = "" }: { points: readonly number[]; className?: string }) {
  const id = useId().replace(/:/g, "");
  const path = sparkPath(thinCurve(points), SPARK_W, SPARK_H);
  if (!path) return <div className={className} aria-hidden />;
  return (
    <svg aria-hidden focusable="false" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className={`block overflow-visible ${className}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-s1)" stopOpacity={0.18} />
          <stop offset="100%" stopColor="var(--color-s1)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {path.zeroY != null && (
        <line x1="0" x2={SPARK_W} y1={path.zeroY} y2={path.zeroY} stroke="var(--color-axis)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <path d={path.area} fill={`url(#${id})`} />
      <path d={path.line} fill="none" stroke="var(--color-s1)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A card surface whose whole area is one link: the anchor covers the card, so it opens on click,
 * tap or Enter, and keeps open-in-new-tab. Controls inside (the halt reason) sit above it.
 */
function LinkCard({ to, origin, label, bare = false, className = "", children }: { to: string | null; origin: string; label: string; bare?: boolean; className?: string; children: ReactNode }) {
  const surface = bare
    ? "has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-accent-soft hover:bg-hover"
    : `border border-line bg-panel ${to ? "hover:-translate-y-px hover:border-line-strong hover:shadow-card-lift has-[a:focus-visible]:border-accent-hi has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-accent-soft motion-reduce:hover:translate-y-0" : ""}`;
  return (
    <article className={`group relative rounded-card transition duration-150 ${to ? surface : bare ? "" : "border border-line bg-panel"} ${className}`}>
      {to && <Link to={to} from={origin} aria-label={`Open ${label}`} className="absolute inset-0 z-0 rounded-card focus-visible:outline-none"><span className="sr-only">{label}</span></Link>}
      <div className="pointer-events-none relative">{children}</div>
    </article>
  );
}

function Fig({ k, title, children }: { k: string; title?: string; children: ReactNode }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[11px] text-faint">{k}</div>
      <div className="truncate text-xs font-medium tabular-nums text-body">{children}</div>
    </div>
  );
}

const BASE_WORD: Record<string, string> = { defined: "defined capital", "portfolio allocation": "portfolio allocation", "starting balance": "starting balance" };

/** A halted strategy's reason under its name, in amber at full ink: it needs action, it is not retired. */
function HaltLine({ row }: { row: NonNullable<CardLine["row"]> }) {
  const summary = haltSummary(row) ?? "";
  return (
    <p className="mt-0.5 text-xs font-medium text-warn" title={summary}>
      Halted · {haltReasonText(row.haltReason)} · {haltClearing(row)}
    </p>
  );
}

/** At least this many closes before a curve is drawn: two points make a diagonal, not a shape. */
const SPARK_MIN_CLOSES = 5;

export function StrategyCard({ line, curve, name, origin, legs = [], mix = null }: {
  line: CardLine; curve: readonly number[]; name?: string; origin: string;
  /** What it trades: type, instrument and venue per leg. */
  legs?: readonly Leg[];
  /** Set when the strategy trades accounts in different currencies: its figures carry "USD+USDC". */
  mix?: { label: string; title: string } | null;
}) {
  const f = cardFigures(line);
  const label = name ?? cardName(line);
  const retired = line.row != null && !line.row.active;
  const halted = line.row != null && !retired && line.row.halted === true;
  const to = line.key ? `/s/${encodeURIComponent(line.key)}` : null;
  const baseWords = f.base == null ? "no capital known" : `Return on the strategy's ${BASE_WORD[f.baseSource ?? ""] ?? "base"} of ${money(f.base, 0)}`;
  return (
    <LinkCard to={to} origin={origin} label={label} className="h-full">
      <div className={`flex h-full flex-col gap-3 p-4 ${retired ? "opacity-60" : ""}`}>
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <span className="min-w-0 break-words text-sm font-medium text-bright" title={line.key ?? undefined}>{label}</span>
            {retired && <span className="ml-auto shrink-0 text-xs text-faint">Retired</span>}
          </div>
          {halted && <HaltLine row={line.row!} />}
          {legs.length > 0 && <LegLine legs={legs} className="mt-1" />}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-muted">Net incl. open</div>
            <span className="block whitespace-nowrap"><Pnl value={f.net} className="text-xl font-headline tabular-nums" /><CurrencyMix mix={mix} /></span>
            <span title={baseWords}><ReturnPct net={f.net} base={f.base} /></span>
          </div>
          {f.trades >= SPARK_MIN_CLOSES ? (
            <span title={`cumulative realized P&L over ${count(f.trades)} closes`} className="shrink-0">
              <Sparkline points={curve} className="h-9 w-28" />
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted">{f.trades === 0 ? "no closes" : `${count(f.trades)} ${f.trades === 1 ? "close" : "closes"}`}</span>
          )}
        </div>
        <div className="mt-auto grid grid-cols-4 gap-2 border-t border-line pt-3">
          <Fig k="Today" title="realized since the account's trading day began"><Pnl value={f.today} glyphs={false} /></Fig>
          <Fig k="Open" title="floating on its open positions now"><Pnl value={f.floating} glyphs={false} /></Fig>
          <Fig k="Trades">{count(f.trades)}</Fig>
          <Fig k="Last close" title={f.lastTs == null ? undefined : `${ts(f.lastTs)} UTC`}>{f.lastTs == null ? DASH : age(f.lastTs)}</Fig>
        </div>
      </div>
    </LinkCard>
  );
}

/** A portfolio: its own card (net, return on the allocated capital, combined curve) with its sleeves as cards beneath. */
export function PortfolioGroup<T extends CardLine>({
  group,
  curve,
  to,
  origin,
  children,
}: {
  group: PortfolioCard<T>;
  curve: readonly number[];
  to: string;
  origin: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-line bg-side/60">
      <LinkCard to={to} origin={origin} label={`portfolio ${group.id}`} bare className="rounded-b-none border-b border-line">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5">
          <div className="min-w-0">
            <h2 className="min-w-0 break-words text-[15px] font-headline text-bright">{group.id}</h2>
            <div className="text-xs text-faint">
              portfolio · {group.children.length} strateg{group.children.length === 1 ? "y" : "ies"} · {count(group.trades)} trades
              {group.lastTs != null && ` · last close ${age(group.lastTs)}`}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <Sparkline points={curve} className="hidden h-8 w-32 sm:block" />
            <div className="text-right">
              <Pnl value={group.net} className="block text-lg font-headline tabular-nums" />
              <div className="flex items-baseline justify-end gap-x-1.5">
                <ReturnPct net={group.net} base={group.base} />
                <span className="text-xs text-faint" title={group.base == null ? "a sleeve has no allocation" : `return on ${money(group.base, 0)} allocated across the sleeves`}>
                  {group.base == null ? "no allocation known" : `on ${money(group.base, 0)} allocated`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </LinkCard>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** The cards' grid: one column on phones, two on tablets, three on wide screens (by the page's width, not the window's). */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">{children}</div>;
}
