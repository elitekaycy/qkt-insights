import type { ViewBreakdown, ViewDay } from "./api";

export interface ShareRow { key: string | null; views: number; share: number }

/** Each row's fraction of all views in the range, 0-1; zero when there were none. */
export function withShares(rows: ViewBreakdown[], total: number): ShareRow[] {
  return rows.map((r) => ({ ...r, share: total > 0 ? r.views / total : 0 }));
}

const DAY_MS = 86_400_000;

/**
 * One entry per UTC day from `from` to `to`. A day with no stored views truly had none, so it
 * is filled with zeros; the chart would otherwise draw a gap as if data were missing.
 */
export function fillDays(daily: ViewDay[], from: number, to: number): ViewDay[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: ViewDay[] = [];
  for (let t = from - (from % DAY_MS); t < to; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, views: 0, visitors: 0 });
  }
  return out;
}

/** A readable name for a shared link. */
export function linkLabel(kind: string, subject: string, names: ReadonlyMap<string, string>): string {
  if (kind === "overview") return "Overview";
  if (kind === "portfolio") return `Portfolio ${subject}`;
  return names.get(subject) ?? subject;
}
