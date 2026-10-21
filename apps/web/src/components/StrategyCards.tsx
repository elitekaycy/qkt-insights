import { useId, type ReactNode } from "react";
import { age, count, DASH, money, pct, ts } from "../format";
import { haltSummary } from "../halt";
import { Link } from "../router";
import { cardFigures, cardName, sparkPath, thinCurve, type CardLine, type PortfolioCard } from "../strategyCards";
import { Pnl, Popover, ReturnPct } from "./ui";

/*
 * The Strategies page's cards: one per strategy (name, net with its return on its own base, a
 * sparkline of cumulative realized P&L, today, trades, win rate, max drawdown, last close), and a
 * group card per portfolio with its sleeves beneath. The whole card is the link; status stays
 * quiet: nothing while running, a muted card with "Halted" (reason on hover or tap) otherwise.
 */

const SPARK_W = 120;
const SPARK_H = 36;

/** Cumulative realized P&L, one stable series colour with a faint fade; a dashed zero when the curve crosses it. */
export function Sparkline({ points, className = "" }: { points: readonly number[]; className?: string }) {
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

/** The faint arrow at a card's top-right, shown on hover or keyboard focus. */
function CardArrow() {
  return (
    <span aria-hidden className="shrink-0 text-sm leading-none text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-50">
      →
    </span>
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

const BASE_WORD: Record<string, string> = { defined: "capital", "portfolio allocation": "allocated", "starting balance": "start balance" };

/**
 * "on 1,000,000 capital": the base the strategy page measures its return on (strategyCapital), named
 * by its source; the full source on hover.
 */
function BaseLabel({ base, source }: { base: number | null; source: string | null }) {
  if (base == null) return <span className="text-xs text-faint">no capital known</span>;
  return (
    <span className="text-xs text-faint" title={`return on ${money(base, 0)} ${source === "defined" ? "defined capital" : source ?? "capital"}`}>
      on {money(base, 0)} {BASE_WORD[source ?? ""] ?? ""}
    </span>
  );
}

/** A halted strategy's quiet label; the reason, how it ends and the resume command on hover or tap. */
function HaltLabel({ summary }: { summary: string }) {
  return (
    <span className="pointer-events-auto relative z-10 shrink-0" title={summary}>
      <Popover label="Why this strategy is halted" align="right" trigger={<span className="text-xs text-muted hover:text-body">Halted</span>}>
        {summary}
      </Popover>
    </span>
  );
}

export function StrategyCard({ line, curve, name, origin }: { line: CardLine; curve: readonly number[]; name?: string; origin: string }) {
  const f = cardFigures(line);
  const label = name ?? cardName(line);
  const halt = line.row ? haltSummary(line.row) : null;
  const retired = line.row != null && !line.row.active;
  const quiet = halt != null || retired || line.key == null;
  const to = line.key ? `/s/${encodeURIComponent(line.key)}` : null;
  return (
    <LinkCard to={to} origin={origin} label={label} className="h-full">
      <div className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className={`min-w-0 truncate text-sm font-medium ${quiet ? "text-muted" : "text-bright"}`} title={line.key ?? "closes and positions no strategy claimed"}>
            {label}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {halt && <HaltLabel summary={halt} />}
            {!halt && retired && <span className="text-xs text-faint">Retired</span>}
            {to && <CardArrow />}
          </span>
        </div>
        <div className={`flex items-end justify-between gap-3 ${quiet ? "opacity-60 grayscale" : ""}`}>
          <div className="min-w-0">
            <Pnl value={f.net} className="block text-xl font-headline tabular-nums" />
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
              <ReturnPct net={f.net} base={f.base} />
              {line.row && <BaseLabel base={f.base} source={f.baseSource} />}
            </div>
          </div>
          <span title={`cumulative realized P&L over ${count(f.trades)} close${f.trades === 1 ? "" : "s"}`} className="shrink-0">
            <Sparkline points={curve} className="h-9 w-28" />
          </span>
        </div>
        <div className={`mt-auto grid grid-cols-4 gap-2 border-t border-line pt-3 ${quiet ? "opacity-60 grayscale" : ""}`}>
          <Fig k="Trades">{count(f.trades)}</Fig>
          <Fig k="Win rate" title="wins over decided closes; breakeven excluded">{pct(f.winRate)}</Fig>
          <Fig k="Max DD" title="deepest fall of cumulative realized P&L from its peak">
            {f.maxDd > 0 ? <span className="text-loss">{money(-f.maxDd)}</span> : money(0)}
          </Fig>
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
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 truncate text-[15px] font-headline text-bright">{group.id}</h2>
              <CardArrow />
            </div>
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
