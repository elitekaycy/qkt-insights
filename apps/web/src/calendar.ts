import { compact, day as utcDay, DAY_MS } from "./format";

/* The month grids' pure parts, shared by the journal calendar, Home's month and a strategy's periods. */

/** Monday-first, the grids' column order. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Cell shade: the gain or loss fill mixed into the card, `floor`% (9 by default) to 55% by the size of the day. */
export function shade(net: number, maxAbs: number, floor = 9): string {
  const k = Math.min(1, Math.abs(net) / (maxAbs || 1));
  const color = net >= 0 ? "var(--color-gain-fill)" : "var(--color-loss-fill)";
  return `color-mix(in srgb, ${color} ${Math.round(floor + (55 - floor) * k)}%, var(--color-panel))`;
}

/** Phone-width cell figure: sign and compact size only, the shade carries the rest. */
export function compactSigned(net: number): string {
  const c = compact(net);
  return net > 0 && c !== "0" ? `+${c}` : c;
}

/** A month's Monday-first grid, whole weeks: each UTC day and whether it is in the month. */
export function monthCells(month: string): { day: string; inMonth: boolean }[] {
  const first = Date.parse(`${month}-01T00:00:00Z`);
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => ({ day: utcDay(first + (i - lead) * DAY_MS), inMonth: i >= lead && i < lead + days }));
}

export function shiftMonth(month: string, n: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
