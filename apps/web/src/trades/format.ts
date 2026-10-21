import { DASH, fixed, MINUS, ts } from "../format";

/** A price at its instrument's precision ("4122.72"); a dash when missing. */
export function px(v: number | null | undefined, digits: number): string {
  return v == null || !Number.isFinite(v) ? DASH : fixed(v, digits);
}

/** An R multiple, "+1.25R" / "−0.80R"; a dash without one. */
export function rMultiple(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return DASH;
  const s = Math.abs(r).toFixed(2);
  if (Number(s) === 0) return `${s}R`;
  return `${r > 0 ? "+" : MINUS}${s}R`;
}

/** "2026-10-21 14:30" (UTC), the table's stamp. */
export function minuteStamp(ms: number | null | undefined): string {
  return ms == null ? DASH : ts(ms).slice(0, 16);
}

/** "14:30:01.282" (UTC), the timeline's stamp: latencies are milliseconds apart. */
export function preciseClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

/** A latency between two steps: "+712 ms", "+3.4 s", "+2m 5s". */
export function latency(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `+${ms} ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `+${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `+${h}h ${m % 60}m` : `+${Math.floor(h / 24)}d ${h % 24}h`;
}

export const ENDED_LABEL: Record<string, string> = { stop: "stop", tp: "target", signal: "signal", venue: "venue", manual: "manual" };
export const ENDED_TITLE: Record<string, string> = {
  stop: "The venue filled the stop-loss",
  tp: "The venue filled the take-profit",
  signal: "The strategy sent the close",
  venue: "The venue closed it (stop-out)",
  manual: "Closed by hand (qkt bot close)",
};
