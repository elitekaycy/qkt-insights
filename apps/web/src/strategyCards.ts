import { exactMoney, roundMoney } from "@qkt-insights/contract/money";
import type { StrategyRow } from "./api";
import type { StrategyPeriods } from "./home";
import { portfolioGroupId, strategyCapital, strategyDisplayName, summarizePortfolio } from "./portfolio";

/*
 * The Strategies page's cards, as pure functions over the lines Home's table is built from
 * (strategyLines over every close on the account plus what each strategy floats), so a card and
 * its table row can never disagree. Nothing here reads React.
 */

export interface CardLine {
  key: string | null;
  row: StrategyRow | null;
  periods: StrategyPeriods;
}

export interface CardFigures {
  /** Realized over every close plus open P&L now. */
  net: number;
  realized: number;
  floating: number;
  /** Realized since the account's trading day began; open P&L is `floating`. */
  today: number;
  /** The return's base and where it comes from; null amount when no capital is known. */
  base: number | null;
  baseSource: string | null;
  trades: number;
  winRate: number | null;
  /** Deepest fall of cumulative realized P&L from its peak, as positive money. */
  maxDd: number;
  lastTs: number | null;
}

export function cardFigures(line: CardLine, digits = 2): CardFigures {
  const p = line.periods;
  const capital = line.row ? strategyCapital(line.row) : { amount: null, source: null };
  return {
    net: roundMoney(p.all + p.floating, digits),
    realized: p.all,
    floating: p.floating,
    today: p.todayRealized,
    base: capital.amount,
    baseSource: capital.source,
    trades: p.trades,
    winRate: p.winRate,
    maxDd: p.maxDd,
    lastTs: p.lastTs,
  };
}

/** What the cards add to: net incl. open and today, summed from the same figures each card prints. */
export function cardsTotal(lines: readonly CardLine[], digits = 2): { net: number; today: number } {
  let net = 0;
  let today = 0;
  for (const l of lines) {
    const f = cardFigures(l, digits);
    net = roundMoney(net + f.net, digits);
    today = roundMoney(today + f.today, digits);
  }
  return { net, today };
}

/**
 * A line the page folds away until asked: a retired strategy. A strategy on the live roster always
 * shows, traded or not, so a book deployed today lists every member before its first trade.
 */
export function isFolded(line: CardLine): boolean {
  return line.row != null && !line.row.active;
}

export type CardSort = "attention" | "net" | "today" | "name" | "last";
export const CARD_SORTS: ReadonlyArray<{ key: CardSort; label: string }> = [
  { key: "attention", label: "Needs attention" },
  { key: "net", label: "By net P&L" },
  { key: "today", label: "By today" },
  { key: "name", label: "By name" },
  { key: "last", label: "By last trade" },
];

export function cardName(line: CardLine): string {
  return line.row ? strategyDisplayName(line.row) : line.key ?? "Unattributed";
}

/**
 * Largest first for figures, newest first for the last trade, A to Z for names; the unattributed bucket always last.
 * "Needs attention" puts halted strategies first, then those holding a position without a stop (`noStop`), then the
 * rest by today's realized P&L, largest first. Today is realized only: open P&L has its own figure.
 */
export function sortCards<T extends CardLine>(lines: readonly T[], by: CardSort, noStop: ReadonlySet<string> = new Set()): T[] {
  const rank = (l: T): number => (l.row?.halted && l.row.active ? 0 : l.key != null && noStop.has(l.key) ? 1 : 2);
  const value = (l: T): number | string => {
    if (by === "name") return cardName(l).toLowerCase();
    if (by === "today" || by === "attention") return l.periods.todayRealized;
    if (by === "last") return l.periods.lastTs ?? -Infinity;
    return l.periods.all + l.periods.floating;
  };
  return [...lines].sort((a, b) => {
    if ((a.key == null) !== (b.key == null)) return a.key == null ? 1 : -1;
    if (by === "attention" && rank(a) !== rank(b)) return rank(a) - rank(b);
    const x = value(a), y = value(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return by === "name" ? c : -c;
  });
}

/**
 * A strategy that has done nothing yet: no close, nothing open, not halted. The page lists these in one line
 * ("Not traded yet (5): …") instead of five cards of zeros.
 */
export function notTradedYet(line: CardLine): boolean {
  return line.key != null && line.periods.trades === 0 && line.periods.floating === 0 && !(line.row?.halted ?? false);
}

export interface PortfolioCard<T extends CardLine> {
  id: string;
  children: T[];
  net: number;
  /** Realized since the account's day began. */
  today: number;
  trades: number;
  /** Sum of the children's allocations; null when any child has none. */
  base: number | null;
  lastTs: number | null;
}

/** Lines split into portfolios (by logical portfolio id, in first-seen order) and standalone strategies. */
export function cardGroups<T extends CardLine>(lines: readonly T[], digits = 2): { portfolios: PortfolioCard<T>[]; standalone: T[] } {
  const groups = new Map<string, T[]>();
  const standalone: T[] = [];
  for (const l of lines) {
    const id = l.row ? portfolioGroupId(l.row) : null;
    if (id) groups.set(id, [...(groups.get(id) ?? []), l]);
    else standalone.push(l);
  }
  const portfolios = [...groups.entries()].map(([id, children]) => {
    const rows = children.flatMap((l) => (l.row ? [l.row] : []));
    const sum = (f: (p: StrategyPeriods) => number) => children.reduce((a, l) => roundMoney(a + f(l.periods), digits), 0);
    const last = children.map((l) => l.periods.lastTs).filter((t): t is number => t != null);
    return {
      id,
      children,
      net: sum((p) => p.all + p.floating),
      today: sum((p) => p.todayRealized),
      trades: children.reduce((a, l) => a + l.periods.trades, 0),
      base: summarizePortfolio(id, rows, new Map(), false).allocatedCapital,
      lastTs: last.length ? Math.max(...last) : null,
    };
  });
  return { portfolios, standalone };
}

/**
 * Cumulative realized P&L per strategy key from every close, starting at 0 before the first: the
 * sparkline's points. Same closes and order as strategyPeriods, so the last point equals `all`.
 */
export function realizedCurves(
  closes: ReadonlyArray<{ strategyId: string | null; ts: number; realized: number; realizedExact?: number }>,
  opts: { now: number; digits?: number },
): Map<string | null, number[]> {
  const digits = opts.digits ?? 2;
  const out = new Map<string | null, number[]>();
  const running = new Map<string | null, number>();
  const ordered = [...closes].filter((c) => c.ts <= opts.now).sort((a, b) => a.ts - b.ts);
  for (const c of ordered) {
    let curve = out.get(c.strategyId);
    if (!curve) out.set(c.strategyId, (curve = [0]));
    const sum = (running.get(c.strategyId) ?? 0) + exactMoney(c);
    running.set(c.strategyId, sum);
    curve.push(roundMoney(sum, digits));
  }
  return out;
}

/** Several curves added point by point in close order, for a portfolio's combined line. */
export function mergeCurves(
  closes: ReadonlyArray<{ strategyId: string | null; ts: number; realized: number; realizedExact?: number }>,
  keys: ReadonlySet<string | null>,
  opts: { now: number; digits?: number },
): number[] {
  const mine = closes.filter((c) => keys.has(c.strategyId)).map((c) => ({ ...c, strategyId: null }));
  return realizedCurves(mine, opts).get(null) ?? [];
}

/**
 * At most `max` points of a curve, keeping each bucket's lowest and highest in their order plus the
 * first and last point, so every drawn vertex is a stored value and no peak or trough disappears.
 */
export function thinCurve(points: readonly number[], max = 120): number[] {
  if (points.length <= max) return [...points];
  const buckets = Math.floor((max - 2) / 2);
  const inner = points.length - 2;
  const out = [points[0]!];
  for (let b = 0; b < buckets; b++) {
    const from = 1 + Math.floor((b * inner) / buckets);
    const to = 1 + Math.floor(((b + 1) * inner) / buckets);
    if (to <= from) continue;
    let lo = from, hi = from;
    for (let i = from; i < to; i++) {
      if (points[i]! < points[lo]!) lo = i;
      if (points[i]! > points[hi]!) hi = i;
    }
    for (const i of lo === hi ? [lo] : lo < hi ? [lo, hi] : [hi, lo]) out.push(points[i]!);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** SVG path data for a sparkline in a width x height box, plus where zero sits (null when off the range). */
export function sparkPath(points: readonly number[], width: number, height: number, pad = 2): { line: string; area: string; zeroY: number | null } | null {
  if (points.length < 2) return null;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const span = max - min || 1;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);
  const last = points.length - 1;
  const coords = points.map((v, i) => `${((i / last) * width).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M${coords.join(" L")}`;
  return { line, area: `${line} L${width},${height} L0,${height} Z`, zeroY: min < 0 && max > 0 ? Number(y(0).toFixed(2)) : null };
}
