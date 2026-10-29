import { parseQuery, withoutKeys, withTokens, type QueryKey } from "@qkt-insights/contract/query";
import type { TripBucket, TripDay } from "../trades/analytics";
import { signedMoney } from "../format";

/*
 * The strategy page's click-to-filter rules and window sums, as pure functions: a figure on screen
 * becomes the query token that lists its trades, and clicking it again takes the token away.
 */

/** Buckets with fewer round trips than this are drawn faded: too few to read an edge from. */
export const MIN_SAMPLE = 30;

/** What to do about an empty selection: loosen the search, widen a range, or nothing yet to show. */
export function emptyHint(q: string, from: number | undefined): string {
  if (q) return "Loosen the search above or widen the range.";
  return from != null && from > 0 ? "Widen the range: none closed in it." : "This strategy has not closed a trade yet.";
}

/** The query with `token` added, or without it when it is already a chip (the second click clears). */
export function toggleToken(q: string, token: string): string {
  const p = parseQuery(q);
  const added = parseQuery(token).chips[0];
  if (added && p.chips.some((c) => c.text === added.text)) return p.chips.filter((c) => c.text !== added.text).map((c) => c.text).join(" ");
  return withTokens(q, token);
}

/** The canonical chip of one key in the query, e.g. `exit:2026-10-21`; null without one. */
export function chipOf(q: string, key: QueryKey): string | null {
  return parseQuery(q).chips.find((c) => c.key === key)?.text ?? null;
}

/** The query without the given keys: what a section keeps whole while a day or month is picked. */
export function without(q: string, keys: readonly QueryKey[]): string {
  return withoutKeys(q, keys);
}

/** The exit day or month a query picks (`exit:2026-10-21`, `exit:2026-10`), or null. */
export function pickedSpan(q: string): { day: string | null; month: string | null } {
  const v = chipOf(q, "exit")?.slice("exit:".length) ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { day: v, month: v.slice(0, 7) };
  if (/^\d{4}-\d{2}$/.test(v)) return { day: null, month: v };
  return { day: null, month: null };
}

/** The exit days a stretch of time covers, as a query token: `exit:2026-10-02` or `exit:2026-10-02..2026-10-09`. */
export function exitSpan(from: number, to: number): string {
  const a = new Date(from).toISOString().slice(0, 10);
  const b = new Date(to).toISOString().slice(0, 10);
  return a === b ? `exit:${a}` : `exit:${a}..${b}`;
}

export interface WindowTotals { from: string; to: string; days: number; trades: number; wins: number; losses: number; pnl: number; winRate: number | null }

/**
 * Sums of the days a zoomed chart shows: `start`/`end` are the visible share of the axis in
 * percent, as the chart reports it. Null `window` means the whole period.
 */
export function windowTotals(days: readonly TripDay[], window: { start: number; end: number } | null): WindowTotals | null {
  if (days.length === 0) return null;
  const last = days.length - 1;
  const i = window ? Math.max(0, Math.min(last, Math.round((window.start / 100) * last))) : 0;
  const j = window ? Math.max(i, Math.min(last, Math.round((window.end / 100) * last))) : last;
  const shown = days.slice(i, j + 1);
  const wins = shown.reduce((a, d) => a + d.wins, 0);
  const losses = shown.reduce((a, d) => a + d.losses, 0);
  return {
    from: shown[0]!.day,
    to: shown[shown.length - 1]!.day,
    days: shown.length,
    trades: shown.reduce((a, d) => a + d.n, 0),
    wins,
    losses,
    pnl: shown.reduce((a, d) => a + d.pnl, 0),
    winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
  };
}

/** Days with their running total, oldest first. */
export function withCumulative<T extends { pnl: number }>(rows: readonly T[]): Array<T & { cum: number }> {
  let cum = 0;
  return rows.map((r) => ({ ...r, cum: (cum += r.pnl) }));
}

/** Profit factor as text: "∞" with no losses, a dash with nothing decided. */
export function profitFactorText(pf: number | "inf" | null): string {
  if (pf === "inf") return "∞";
  return pf == null ? "—" : pf.toFixed(2);
}

/** The nearest trade to a time on the cumulative chart's axis (trades are in exit order). */
export function nearestByTime<T extends { exitTs: number }>(rows: readonly T[], ts: number): T | null {
  let best: T | null = null;
  for (const r of rows) if (best == null || Math.abs(r.exitTs - ts) < Math.abs(best.exitTs - ts)) best = r;
  return best;
}

/**
 * Today's story on a strategy's Overview, as short parts: "8 trades", "1 won", "5 stopped (−6.00)", "open +0.75",
 * "6 lost in a row". The stop count and its money come from today's "ended" buckets; parts with nothing to say are
 * left out. An empty list means nothing happened today.
 */
export function todayParts(today: { closed: number; wins: number; ended: readonly Pick<TripBucket, "key" | "n" | "pnl">[] } | null, open: number | null, streak: number): string[] {
  const parts: string[] = [];
  if (today && today.closed > 0) {
    parts.push(`${today.closed} ${today.closed === 1 ? "trade" : "trades"}`);
    parts.push(`${today.wins} won`);
    const stops = today.ended.find((b) => b.key === "stop");
    if (stops && stops.n > 0) parts.push(`${stops.n} stopped (${signedMoney(stops.pnl)})`);
  }
  if (open != null && open !== 0) parts.push(`open ${signedMoney(open)}`);
  if (parts.length > 0 && Math.abs(streak) >= 3) parts.push(`${Math.abs(streak)} ${streak > 0 ? "won" : "lost"} in a row`);
  return parts;
}

/** A line that tells the strategy's story: a warning or error, or an order, fill, trade, stop or rejection. */
export function importantLog(l: { level: string; message: string; logger: string }): boolean {
  if (l.level === "ERROR" || l.level === "WARN") return !/StateFileWriter|scheduled break/iu.test(`${l.logger} ${l.message}`);
  return /\b(order|fill(ed)?|trade|position|stop|target|reject(ed)?|entry|exit)\b/iu.test(l.message);
}
