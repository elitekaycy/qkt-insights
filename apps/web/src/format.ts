/**
 * Every number and time the dashboard prints goes through here, so units, signs and decimals
 * read the same on every page. Times are UTC (labelled where shown), matching qkt and the
 * venue deal history. A true minus sign (U+2212) keeps signed columns aligned; nothing that
 * rounds to zero keeps a sign, so "-0.00" never appears. A missing value is an em dash.
 */

export const DASH = "—";
export const MINUS = "−";
export const DAY_MS = 86_400_000;

const missing = (v: number | null | undefined): v is null | undefined => v == null || !Number.isFinite(v);

/** Swap a leading hyphen for a true minus and drop the sign of anything that rounds to zero. */
function minus(s: string): string {
  if (/^-[0.,]*$/.test(s.replace(/[^0-9.,-]/g, ""))) return s.replace(/^-/, "");
  return s.replace(/^-/, MINUS);
}

function grouped(abs: number, digits: number): string {
  return abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** toFixed that never prints "-0.00", with a true minus. */
export function fixed(v: number, digits = 2): string {
  return minus(v.toFixed(digits));
}

/** A money level (balance, equity, price-free amounts): grouped, 2 dp, unsigned unless negative. */
export function money(v: number | null | undefined, digits = 2): string {
  return num(v, digits);
}

/** A money change (P&L, cost, delta): always signed, "+1,234.50" / "−56.00", unsigned when it rounds to zero. */
export function signedMoney(v: number | null | undefined, digits = 2): string {
  if (missing(v)) return DASH;
  const s = grouped(Math.abs(v), digits);
  if (/^[0.,]*$/.test(s)) return s;
  return v > 0 ? `+${s}` : `${MINUS}${s}`;
}

export type Polarity = "gain" | "loss" | "flat";

/** Gain, loss, or flat; a value that rounds to zero at `digits` is flat. */
export function polarity(v: number | null | undefined, digits = 2): Polarity {
  if (missing(v)) return "flat";
  if (Number(Math.abs(v).toFixed(digits)) === 0) return "flat";
  return v > 0 ? "gain" : "loss";
}

/** Text-colour class for a signed figure: gains green, losses red, flat muted. */
export function toneClass(v: number | null | undefined, digits = 2): string {
  if (missing(v)) return "text-muted";
  const p = polarity(v, digits);
  return p === "gain" ? "text-gain" : p === "loss" ? "text-loss" : "text-muted";
}

/**
 * Instrument price without binary float noise the venue feed carries, e.g.
 * 4414.869000000001 → "4414.869". Twelve significant digits keep every real
 * digit an FX or metals quote has while dropping the representation error.
 */
export function price(v: number | null | undefined): string {
  if (missing(v)) return DASH;
  return minus(String(Number(v.toPrecision(12))));
}

/** A position size (lots, contracts, coins) with every real digit and none of the float noise. */
export function quantity(v: number | null | undefined): string {
  return price(v);
}

/** Compact axis value, e.g. 1234 → "1.2k", −56000 → "−56k"; tooltips and tables keep full precision. */
export function compact(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 && abs >= 0.005 ? MINUS : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  // keep a decimal through the tens of thousands: an equity axis spanning 59–61k
  // would otherwise print the same rounded label on neighbouring ticks
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  // small ticks keep only the decimals they need: 0, 0.5, 1.25, 12.5
  const fixedSmall = abs.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  const small = fixedSmall.includes(".") ? fixedSmall.replace(/\.?0+$/, "") || "0" : fixedSmall;
  return small === "0" ? "0" : `${sign}${small}`;
}

/**
 * A value axis tick: compact, keeping the digits the tick carries. Ticks are multiples of their
 * interval, so an equity axis 10k apart around 5m reads 4.98m, 4.99m, 5m rather than 5.0m on
 * every line (capital M for millions, so it never reads as minutes); tables and tooltips keep full precision.
 */
export function axisTick(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 && abs >= 0.005 ? MINUS : "";
  const trim = (n: number, digits: number) => n.toFixed(digits).replace(/\.?0+$/, "");
  if (abs >= 1_000_000_000) return `${sign}${trim(abs / 1_000_000_000, 3)}B`;
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000, 3)}M`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000, 2)}k`;
  const small = trim(abs, abs >= 100 ? 0 : abs >= 10 ? 1 : 2) || "0";
  return small === "0" ? "0" : `${sign}${small}`;
}

/**
 * Compact signed money for narrow cells, about three significant figures so a cell agrees with the
 * total beside it: "−5.94", "+14.8", "−0.40", "+1.23k", "0". Tooltips keep full precision.
 */
export function compactPnl(v: number): string {
  const abs = Math.abs(v);
  if (Number(abs.toFixed(2)) === 0) return "0";
  const body = abs >= 100_000 ? `${(abs / 1000).toFixed(0)}k`
    : abs >= 10_000 ? `${(abs / 1000).toFixed(1)}k`
    : abs >= 1000 ? `${(abs / 1000).toFixed(2)}k`
    : abs >= 100 ? abs.toFixed(0)
    : abs >= 10 ? abs.toFixed(1)
    : abs.toFixed(2);
  return `${v > 0 ? "+" : MINUS}${body}`;
}

/** A signed return in percent units that never prints a non-zero return as "0.00%": "−0.06%", "<0.01%", "−<0.01%". */
export function returnPct(v: number | null | undefined): string {
  if (missing(v)) return DASH;
  if (v !== 0 && Math.abs(v) < 0.005) return `${v < 0 ? MINUS : ""}<0.01%`;
  return signedPct(v, 2);
}

/** A fraction as a percent: 0.0622 → "6.2%". */
export function pct(v: number | null | undefined, digits = 1): string {
  if (missing(v)) return DASH;
  return `${fixed(v * 100, digits)}%`;
}

/** A value already in percent units: 6.22 → "6.22%". */
export function pctValue(v: number | null | undefined, digits = 2): string {
  if (missing(v)) return DASH;
  return `${fixed(v, digits)}%`;
}

/** A signed percent change already in percent units: "+6.22%" / "−1.05%". */
export function signedPct(v: number | null | undefined, digits = 2): string {
  if (missing(v)) return DASH;
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `${s}%`;
  return `${v > 0 ? "+" : MINUS}${s}%`;
}

/** A plain number: grouped thousands, fixed decimals, true minus. */
export function num(v: number | null | undefined, digits = 2): string {
  if (missing(v)) return DASH;
  return minus(v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
}

/** A count: grouped, no decimals. */
export function count(v: number | null | undefined): string {
  return num(v, 0);
}

/** A 0-100 win rate as "55%", "—" when no round trip was decided. */
export function winPct(v: number | null | undefined): string {
  return missing(v) ? DASH : `${v.toFixed(0)}%`;
}

/** Days with one decimal: 3.25 → "3.3d". */
export function days(v: number | null | undefined): string {
  return missing(v) ? DASH : `${fixed(v, 1)}d`;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-06-11 13:26:33" (UTC). */
export function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** "Wed 2026-06-11 13:26:33" (UTC). */
export function tsDay(ms: number): string {
  return `${WEEKDAYS[new Date(ms).getUTCDay()]} ${ts(ms)}`;
}

/** Narrow stamp for phone-width rows, "02 Sep 13:26" (UTC). */
export function tsShort(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** "Wed" for a "YYYY-MM-DD" UTC day. */
export function weekday(day: string): string {
  return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
}

/** "2026-06-11" (UTC day). */
export function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "Oct 7" for a "YYYY-MM-DD" day, "Oct 2026" for a "YYYY-MM" month: a drill-down's origin label. */
export function shortDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const mon = MONTHS[(m ?? 1) - 1];
  return d == null ? `${mon} ${y}` : `${mon} ${d}`;
}

/** "13:26" (UTC). */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** Full timestamp, "Wed, 11 Jun 2026 · 13:45:09 UTC". */
export function human(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getUTCDay()]}, ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

/** "September 2026" for a "YYYY-MM" month key. */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[(m ?? 1) - 1]} ${y}`;
}

/** 850ms, 45s, 3m 25s, 3h 25m, 2d 4h. */
export function duration(ms: number | null | undefined): string {
  if (missing(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** A span in its largest whole unit: "45s", "12m", "3h", "2d". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

/** How long ago a time was: "45s ago", "12m ago". */
export function age(ms: number): string {
  return `${elapsed(Date.now() - ms)} ago`;
}

/**
 * The instrument behind a venue symbol: qkt prefixes each symbol with the broker profile that saw
 * it, e.g. "ICM_S05:XAUUSD" -> "XAUUSD". Aggregate by this; show the full symbol as detail.
 */
export function instrumentOf(symbol: string | null | undefined): string {
  if (!symbol) return "";
  const i = symbol.lastIndexOf(":");
  return i >= 0 ? symbol.slice(i + 1) : symbol;
}

/** A deal leg's net: venue profit plus every cost it booked (commission, swap, funding, fee). */
export function dealNet(d: { profit: number | null; commission: number | null; swap: number | null; funding?: number | null; fee?: number | null }): number {
  return (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0) + (d.funding ?? 0) + (d.fee ?? 0);
}

/** A live position's open P&L as the venue floats it: profit plus accrued swap. */
export function openPnl(p: { profit?: number | null; swap?: number | null }): number {
  return (p.profit ?? 0) + (p.swap ?? 0);
}
