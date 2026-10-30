import type { ReactNode } from "react";
import { age, count, money, signedPct, ts } from "../format";
import { haltWords } from "../halt";
import { Link } from "../router";
import { cardFigures, cardName, sparkPath, thinCurve, type CardLine, type PortfolioCard } from "../strategyCards";
import { legsLine, type Leg } from "../instruments";
import { Pill, Pnl, ReturnPct } from "./ui";

/*
 * The Strategies page's cards: one per strategy (name with what it trades on its tooltip, net incl. open, a line of
 * cumulative realized P&L once there are five closes, then today and open on one line; return, trades and last close
 * on the net's tooltip), and a group card per portfolio with its sleeves beneath. The whole card is the link. A halted
 * strategy stays at full ink with an amber pill beside its name; a retired one is muted.
 */

const SPARK_W = 120;
const SPARK_H = 36;

/** Cumulative realized P&L in the one series colour, with a dashed zero when the curve crosses it. */
function Sparkline({ points, className = "" }: { points: readonly number[]; className?: string }) {
  const path = sparkPath(thinCurve(points), SPARK_W, SPARK_H);
  if (!path) return <div className={className} aria-hidden />;
  return (
    <svg aria-hidden focusable="false" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" className={`block overflow-visible ${className}`}>
      {path.zeroY != null && (
        <line x1="0" x2={SPARK_W} y1={path.zeroY} y2={path.zeroY} stroke="var(--color-axis)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <path d={path.line} fill="none" stroke="var(--color-s1)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A card surface whose whole area is one link: the anchor covers the card, so it opens on click,
 * tap or Enter, and keeps open-in-new-tab. Parts with a tooltip (the halt pill, the net figure) take the pointer.
 */
function LinkCard({ to, origin, label, bare = false, className = "", children }: { to: string | null; origin: string; label: string; bare?: boolean; className?: string; children: ReactNode }) {
  const surface = bare
    ? "has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-accent-soft hover:bg-hover"
    : `border border-line bg-panel ${to ? "hover:border-line-strong has-[a:focus-visible]:border-accent-hi has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-accent-soft" : ""}`;
  return (
    <article className={`group relative rounded-card transition duration-150 ${to ? surface : bare ? "" : "border border-line bg-panel"} ${className}`}>
      {to && <Link to={to} from={origin} aria-label={`Open ${label}`} className="absolute inset-0 z-0 rounded-card focus-visible:outline-none"><span className="sr-only">{label}</span></Link>}
      <div className="pointer-events-none relative">{children}</div>
    </article>
  );
}

const BASE_WORD: Record<string, string> = { defined: "defined capital", "portfolio allocation": "portfolio allocation", "starting balance": "starting balance" };

/** At least this many closes before a curve is drawn: two points make a diagonal, not a shape. */
const SPARK_MIN_CLOSES = 5;

/**
 * One strategy's card. Every card has the same rows at the same heights, so a grid of them lines up: name and status,
 * net incl. open beside its curve (nothing until five closes), then today and open. A halt is an amber pill whose
 * tooltip says why in plain words; what it trades is on the name's tooltip; the return, trades and last close on the
 * figure's tooltip.
 */
export function StrategyCard({ line, curve, name, origin, legs = [], mix = null, unpriced = false }: {
  line: CardLine; curve: readonly number[]; name?: string; origin: string;
  /** Its open positions have no venue price: open P&L shows as unknown, never 0.00. */
  unpriced?: boolean;
  /** What it trades: type, instrument and venue per leg. */
  legs?: readonly Leg[];
  /** Set when the strategy trades accounts in different currencies: its figure's tooltip says so. */
  mix?: { label: string; title: string } | null;
}) {
  const f = cardFigures(line);
  const label = name ?? cardName(line);
  const retired = line.row != null && !line.row.active;
  const halt = line.row != null && !retired ? haltWords(line.row) : null;
  const to = line.key ? `/s/${encodeURIComponent(line.key)}` : null;
  const ret = f.base ? `Return ${signedPct((f.net / f.base) * 100, 1)} on the strategy's ${BASE_WORD[f.baseSource ?? ""] ?? "base"} of ${money(f.base, 0)}` : "Return: no capital known";
  const tip = [ret, `${count(f.trades)} trades`, f.lastTs == null ? "no close yet" : `last close ${age(f.lastTs)} (${ts(f.lastTs)} UTC)`, mix?.title].filter(Boolean).join(" · ");
  const trades = legs.length > 0 ? legsLine(legs).title.replace(/\n/g, " · ") : undefined;
  return (
    <LinkCard to={to} origin={origin} label={label} className="h-full">
      <div className={`flex h-full flex-col gap-2 p-4 ${retired ? "opacity-60" : ""}`}>
        <div className="flex h-5 min-w-0 items-center gap-2">
          <span className="pointer-events-auto min-w-0 truncate text-sm font-medium text-bright" title={[line.key, trades].filter(Boolean).join(" · ") || undefined}>{label}</span>
          {halt && <span className="pointer-events-auto ml-auto shrink-0" title={halt.label}><Pill tone="warn">Halted</Pill></span>}
          {retired && <span className="ml-auto shrink-0 text-xs text-muted">Retired</span>}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="pointer-events-auto min-w-0 whitespace-nowrap" title={tip}><Pnl value={f.net} className="text-xl font-headline" /></span>
          {f.trades >= SPARK_MIN_CLOSES && (
            <span title={`cumulative realized P&L over ${count(f.trades)} closes`} className="pointer-events-auto shrink-0">
              <Sparkline points={curve} className="h-7 w-20" />
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted">
          <span title="realized since the account's trading day began">Today <Pnl value={f.today} /></span>
          {" · "}
          {unpriced
            ? <span title="No price from the venue for its open position">Open —</span>
            : <span title="floating on its open positions now">Open <Pnl value={f.floating} /></span>}
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
            <h2 className="min-w-0 break-words text-sm font-headline text-bright">{group.id}</h2>
            <div className="text-xs text-muted">
              portfolio · {group.children.length} strateg{group.children.length === 1 ? "y" : "ies"} · {count(group.trades)} trades
              {group.lastTs != null && ` · last close ${age(group.lastTs)}`}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-4">
            <Sparkline points={curve} className="hidden h-8 w-32 sm:block" />
            <div className="text-right">
              <Pnl value={group.net} className="block text-xl font-headline" />
              <div className="flex items-baseline justify-end gap-x-1.5">
                <ReturnPct net={group.net} base={group.base} />
                <span className="text-xs text-muted" title={group.base == null ? "a sleeve has no allocation" : `return on ${money(group.base, 0)} allocated across the sleeves`}>
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

/** The cards' grid: one column on phones, two on tablets, three or four on wide screens (by the page's width, not the window's). */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3 @7xl:grid-cols-4">{children}</div>;
}
