/**
 * The query language of the search bar on Trades, a strategy's trades, the calendar and Logs:
 * free text plus `key:value` tags, e.g. `strategy:gold_ema_pullback side:short pnl:<0 held:>=4h #1000123456`.
 *
 * Pure functions only. The web bar parses as the viewer types (chips, completions, errors); the
 * server parses the same text again and turns the filter into SQL, so both read a word the same
 * way. Every time is UTC. Later tokens of a key replace earlier ones; an error never blocks the
 * valid tokens around it.
 */

export type QueryKey =
  | "text" | "strategy" | "symbol" | "side" | "outcome" | "pnl" | "r" | "held" | "entry" | "exit" | "ended" | "size" | "ticket" | "type"
  | "weekday" | "hour"
  | "level" | "logger" | "time";

/** A numeric bound pair; each bound is inclusive unless its `*Open` flag says otherwise. */
export interface Range { min?: number; max?: number; minOpen?: boolean; maxOpen?: boolean }
/** A UTC time window in epoch ms, `from` inclusive, `to` exclusive. */
export interface Window { from?: number; to?: number }

export type Side = "long" | "short";
export type Outcome = "win" | "loss" | "breakeven" | "open" | "closed";
export type Ended = "stop" | "tp" | "signal" | "venue" | "manual";
export type Level = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

/**
 * What a position is, in one word a filter and a badge share: a CFD (a stock CFD is one whose venue files it
 * under stocks or shares), a share, a coin bought spot, a perpetual future, a dated future, or an option.
 */
export type InstrumentType = "stock-cfd" | "cfd" | "share" | "coin" | "perpetual" | "future" | "option";
export const INSTRUMENT_TYPES: readonly InstrumentType[] = ["cfd", "stock-cfd", "share", "coin", "perpetual", "future", "option"];

/** Whether a venue folder holds shares: MT5 files stock CFDs under `Stocks` (`Standard\Stocks\AAPLm`) or `Shares`. */
export function isStockCategory(category: string | null | undefined): boolean {
  return category != null && /stock|share|equit/iu.test(category);
}

/** The type of an instrument of qkt `kind` (cfd, equity, spot, perpetual, future, option) filed under `category`; null when unknown. */
export function instrumentType(kind: string | null | undefined, category?: string | null): InstrumentType | null {
  switch (kind?.toLowerCase()) {
    case "cfd": return isStockCategory(category) ? "stock-cfd" : "cfd";
    case "equity": return "share";
    case "spot": return "coin";
    case "perpetual": return "perpetual";
    case "future": return "future";
    case "option": return "option";
    default: return null;
  }
}

export interface QueryFilter {
  /** Free words; each must match somewhere (strategy, instrument, ticket, how it ended; the message on Logs). */
  text: string[];
  /** A strategy id; null selects round trips no strategy claimed. */
  strategy?: string | null;
  /** The instrument with any broker-profile prefix folded away, e.g. XAUUSD. */
  symbol?: string;
  side?: Side;
  outcome?: Outcome;
  pnl?: Range;
  r?: Range;
  /** Hold time in ms. */
  held?: Range;
  entry?: Window;
  /**
   * Round trips with a closing leg in the window: a position closed in parts matches on every day
   * it closed some, and its totals then count only the legs inside the window. An engine close
   * (no venue legs) is its own single leg.
   */
  exit?: Window;
  ended?: Ended;
  /** What the position is; `cfd` includes stock CFDs. */
  type?: InstrumentType;
  size?: Range;
  ticket?: string;
  /** Entry weekday, UTC: 0 is Monday, 6 is Sunday. */
  weekday?: number;
  /** Entry hour of day, UTC (0-23), as an inclusive range unless a bound says otherwise. */
  hour?: Range;
  level?: Level;
  logger?: string;
  /** When a log line was written. */
  time?: Window;
}

export interface QueryToken {
  raw: string;
  key?: QueryKey;
  /** The canonical form a chip shows and the URL keeps, e.g. `held:<1h`, `win`, `#123`. */
  text?: string;
  /** Plain words for the chip's tooltip, e.g. "Held under 1h". */
  label?: string;
  error?: string;
}

export interface ParsedQuery {
  filter: QueryFilter;
  /** Every token in order, valid or not. */
  tokens: QueryToken[];
  /** The valid tokens after later-wins de-duplication: what the chips show. */
  chips: QueryToken[];
  errors: string[];
  /** The chips joined by spaces: the form the URL keeps. */
  canonical: string;
}

export interface QueryContext {
  /** Strategy ids on the instance: `strategy:` accepts a unique prefix and checks the name. */
  strategies?: readonly string[];
  /** Instruments on the instance: `symbol:` and bare instrument names resolve against them. */
  instruments?: readonly string[];
  /** Clock for relative windows (`today`, `7d`); defaults to now. */
  now?: number;
}

/** The keys each page applies; the bar keeps the others as chips but says the page ignores them. */
export const TRADE_KEYS: ReadonlySet<QueryKey> = new Set<QueryKey>(["text", "strategy", "symbol", "side", "outcome", "pnl", "r", "held", "entry", "exit", "ended", "size", "ticket", "weekday", "hour", "type"]);
export const LOG_KEYS: ReadonlySet<QueryKey> = new Set<QueryKey>(["text", "strategy", "level", "logger", "time"]);

/**
 * The Logs pages' default lines: warnings and errors, and the order flow (orders submitted, accepted and filled, trades)
 * at any level, by the qkt loggers that write it. Sent as `/logs?level=WARN,ERROR&orLogger=...`.
 */
export const LOG_ATTENTION = { levels: ["WARN", "ERROR"], loggers: ["OrderManager", "TradingPipeline", "trade"] } as const;

const KEY_ALIAS: Record<string, QueryKey> = {
  strategy: "strategy", strat: "strategy",
  symbol: "symbol", sym: "symbol", instrument: "symbol", inst: "symbol", pair: "symbol",
  side: "side", dir: "side", direction: "side",
  outcome: "outcome", result: "outcome", is: "outcome",
  pnl: "pnl", profit: "pnl", net: "pnl",
  r: "r", rr: "r",
  held: "held", hold: "held", duration: "held",
  entry: "entry", entered: "entry", opened: "entry",
  exit: "exit", exited: "exit", closed: "exit", day: "exit", date: "exit",
  ended: "ended", end: "ended", by: "ended", reason: "ended",
  type: "type", kind: "type",
  size: "size", qty: "size", lots: "size", volume: "size",
  ticket: "ticket", id: "ticket", position: "ticket", trade: "ticket",
  weekday: "weekday", dow: "weekday", wd: "weekday",
  hour: "hour",
  level: "level", lvl: "level", severity: "level",
  logger: "logger",
  time: "time", at: "time", when: "time",
};

/** The key an alias names (`dir` → side, `qty` → size), or undefined. */
export function resolveKey(alias: string): QueryKey | undefined {
  return Object.hasOwn(KEY_ALIAS, alias.toLowerCase()) ? KEY_ALIAS[alias.toLowerCase()] : undefined;
}

const SIDES: Record<string, Side> = { long: "long", buy: "long", short: "short", sell: "short" };
const OUTCOMES: Record<string, Outcome> = {
  win: "win", wins: "win", winner: "win", winners: "win", loss: "loss", losses: "loss", loser: "loss", losers: "loss",
  breakeven: "breakeven", even: "breakeven", flat: "breakeven", open: "open", running: "open", closed: "closed",
};
const TYPES: Record<string, InstrumentType> = {
  cfd: "cfd", cfds: "cfd",
  "stock-cfd": "stock-cfd", stockcfd: "stock-cfd", stock_cfd: "stock-cfd",
  share: "share", shares: "share", equity: "share", equities: "share", stock: "share", stocks: "share",
  coin: "coin", coins: "coin", spot: "coin",
  perpetual: "perpetual", perpetuals: "perpetual", perp: "perpetual", perps: "perpetual",
  future: "future", futures: "future", dated: "future",
  option: "option", options: "option",
};
const TYPE_LABEL: Record<InstrumentType, string> = {
  cfd: "CFDs", "stock-cfd": "Stock CFDs", share: "Shares", coin: "Coins (spot)", perpetual: "Perpetual futures", future: "Dated futures", option: "Options",
};
const ENDED: Record<string, Ended> = {
  stop: "stop", sl: "stop", stopped: "stop", stop_loss: "stop", stoploss: "stop",
  tp: "tp", target: "tp", take_profit: "tp", takeprofit: "tp",
  signal: "signal", rule: "signal", strategy: "signal",
  venue: "venue", stopout: "venue", stop_out: "venue", margin: "venue", liquidation: "venue",
  manual: "manual", bot: "manual", hand: "manual",
};
/** Weekday names to 0 (Monday) .. 6 (Sunday), the week the calendar draws. */
export const WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_LABEL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** `mon`, `monday`, `tues`: at least three letters of the day's name. */
const weekdayOf = (s: string): number | null => {
  const i = s.length >= 3 ? WEEKDAY_LABEL.findIndex((d) => d.toLowerCase().startsWith(s)) : -1;
  return i >= 0 ? i : null;
};
const LEVELS: Record<string, Level> = { error: "ERROR", err: "ERROR", warn: "WARN", warning: "WARN", info: "INFO", debug: "DEBUG", trace: "TRACE" };
/** Bare words that name a filter on their own: `win`, `long`, `stop`. */
const BARE: Record<string, string> = {
  ...Object.fromEntries(Object.keys(OUTCOMES).map((w) => [w, `outcome:${w}`])),
  long: "side:long", short: "side:short",
  stop: "ended:stop", sl: "ended:stop", tp: "ended:tp",
};

const UNATTRIBUTED = new Set(["unattributed", "none", "-"]);
export const UNATTRIBUTED_STRATEGY = "unattributed";

const H = 3_600_000, M = 60_000, D = 86_400_000;
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: M, min: M, h: H, hr: H, d: D, w: 7 * D };

/** `90m`, `1.5h`, `2d`, `1h30m` → ms; null when it is not a duration. */
export function parseDuration(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (!/^(\d+(?:\.\d+)?(ms|s|min|m|hr|h|d|w))+$/.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|min|m|hr|h|d|w)/g)) total += Number(m[1]) * UNIT[m[2]!]!;
  return Math.round(total);
}

/** ms → the shortest exact duration text: 3_600_000 → "1h", 5_400_000 → "90m". */
export function formatDuration(ms: number): string {
  if (ms % D === 0) return `${ms / D}d`;
  if (ms % H === 0) return `${ms / H}h`;
  if (ms % M === 0) return `${ms / M}m`;
  return `${Math.round(ms / 1000)}s`;
}

const money = (s: string): number | null => {
  const m = /^([+-]?)\$?(\d+(?:\.\d+)?)(k)?$/i.exec(s.trim());
  return m ? Number(`${m[1]}${m[2]}`) * (m[3] ? 1000 : 1) : null;
};
const multiple = (s: string): number | null => {
  const m = /^([+-]?\d+(?:\.\d+)?)r?$/i.exec(s.trim());
  return m ? Number(m[1]) : null;
};
const hourOf = (s: string): number | null => {
  const m = /^(\d{1,2})$/.exec(s.trim());
  return m && Number(m[1]) <= 23 ? Number(m[1]) : null;
};
const lots = (s: string): number | null => {
  const m = /^(\d+(?:\.\d+)?)$/.exec(s.trim());
  return m ? Number(m[1]) : null;
};

/**
 * `>50`, `>=1`, `<0`, `<=-1`, `=5`, `5`, `1..2` (both ends included). With `halfOpen`, a range
 * `a..b` excludes b, the convention hold buckets use (1h..4h holds 1h but not 4h).
 */
function parseRange(v: string, num: (s: string) => number | null, halfOpen = false): Range | null {
  const between = /^(.+?)\.\.(.+)$/.exec(v);
  if (between) {
    const a = num(between[1]!), b = num(between[2]!);
    if (a === null || b === null || a === b) return null;
    return { min: Math.min(a, b), max: Math.max(a, b), maxOpen: halfOpen };
  }
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(v);
  if (!m) return null;
  const n = num(m[2]!);
  if (n === null) return null;
  switch (m[1]) {
    case ">": return { min: n, minOpen: true };
    case ">=": return { min: n };
    case "<": return { max: n, maxOpen: true };
    case "<=": return { max: n };
    default: return { min: n, max: n };
  }
}

/** One UTC day, month or year as [from, to); null when it is not one. */
function parseSpan(s: string): Window | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) {
    const from = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    // reject 2026-02-31 and friends: the date must survive the round trip
    return new Date(from).toISOString().slice(0, 10) === s ? { from, to: from + D } : null;
  }
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { from: Date.UTC(Number(m[1]), Number(m[2]) - 1, 1), to: Date.UTC(Number(m[1]), Number(m[2]), 1) };
  const y = /^(\d{4})$/.exec(s);
  if (y) return { from: Date.UTC(Number(y[1]), 0, 1), to: Date.UTC(Number(y[1]) + 1, 0, 1) };
  return null;
}

/**
 * A time filter: `2026-10-21`, `2026-10`, `2026`, `>=2026-10-15`, `>2026-10-15` (after that day),
 * `<2026-10-01`, `2026-10-01..2026-10-15` (both days included), `today`, `yesterday`, or a recent
 * span like `7d` / `1h` (the last 7 days / hour).
 */
export function parseWindow(v: string, now = Date.now()): Window | null {
  const s = v.trim().toLowerCase();
  const today = Math.floor(now / D) * D;
  if (s === "today") return { from: today, to: today + D };
  if (s === "yesterday") return { from: today - D, to: today };
  const recent = parseDuration(s);
  if (recent !== null && recent > 0 && !/^\d{4}$/.test(s)) return { from: now - recent };
  const between = /^(.+)\.\.(.+)$/.exec(s);
  if (between) {
    const a = parseSpan(between[1]!), b = parseSpan(between[2]!);
    return a && b ? { from: Math.min(a.from!, b.from!), to: Math.max(a.to!, b.to!) } : null;
  }
  const m = /^(>=|<=|>|<)?(.+)$/.exec(s);
  const span = m ? parseSpan(m[2]!) : null;
  if (!m || !span) return null;
  switch (m[1]) {
    case ">=": return { from: span.from };
    case ">": return { from: span.to };
    case "<": return { to: span.from };
    case "<=": return { to: span.to };
    default: return span;
  }
}

/** "XAUUSD" from "ICM_S05:XAUUSD": the instrument behind a broker-profile symbol. */
export function foldInstrument(symbol: string): string {
  const i = symbol.lastIndexOf(":");
  return (i >= 0 ? symbol.slice(i + 1) : symbol).toUpperCase();
}

const KNOWN = "strategy:, symbol:, side:, pnl:, r:, held:, entry:, exit:, ended:, type:, size:, weekday:, hour:, #ticket, level:, logger:, time:";
const HINT: Partial<Record<QueryKey, string>> = {
  side: "side: long or short",
  outcome: "outcome: win, loss, breakeven, open or closed",
  pnl: "pnl: a money amount like >50, <0, -20..80 or >=1k",
  r: "r: a multiple of the initial risk like >=1, <0 or -1..2",
  held: "held: a duration like <1h, >=4h, 1h..4h, 30m or 2d",
  entry: "entry: a UTC date or month like 2026-10-21, 2026-10, >=2026-10-15, 2026-10-01..2026-10-15, today or 7d",
  exit: "exit: a UTC date or month like 2026-10-21, 2026-10, >=2026-10-15, 2026-10-01..2026-10-15, today or 7d",
  time: "time: a UTC date or span like 2026-10-21, >=2026-10-15, today, 1h or 7d",
  ended: "ended: stop, tp, signal, venue or manual",
  type: "type: cfd, stock-cfd, share, coin, perpetual, future or option",
  size: "size: lots like >=0.5, <1 or 0.1..0.5",
  weekday: "weekday: the UTC entry day, mon to sun",
  hour: "hour: the UTC entry hour 0-23, like 14, >=8 or 8..16",
  ticket: "#ticket: the venue position ticket, like #1000123456",
  level: "level: error, warn, info or debug",
  logger: "logger: part of a logger name, like logger:MT5Broker",
};

const op = (r: Range, unit: (n: number) => string): string => {
  if (r.min !== undefined && r.max !== undefined) return r.min === r.max ? `exactly ${unit(r.min)}` : `${unit(r.min)} to ${unit(r.max)}`;
  if (r.min !== undefined) return `${r.minOpen ? "above" : "at least"} ${unit(r.min)}`;
  if (r.max !== undefined) return `${r.maxOpen ? "under" : "at most"} ${unit(r.max)}`;
  return "";
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const windowLabel = (w: Window): string => {
  if (w.from !== undefined && w.to !== undefined) return w.to - w.from === D ? `on ${iso(w.from)}` : `${iso(w.from)} to ${iso(w.to - 1)}`;
  if (w.from !== undefined) return `since ${new Date(w.from).toISOString().slice(0, 16).replace("T", " ")}`;
  if (w.to !== undefined) return `before ${iso(w.to)}`;
  return "";
};

function resolveName(value: string, known: readonly string[] | undefined, fold: (s: string) => string): { name: string } | { candidates: string[] } {
  if (!known || known.length === 0) return { name: value };
  const v = fold(value);
  const exact = known.find((k) => fold(k) === v);
  if (exact) return { name: exact };
  const prefix = known.filter((k) => fold(k).startsWith(v));
  if (prefix.length === 1) return { name: prefix[0]! };
  return { candidates: prefix.length > 1 ? prefix : [...known] };
}

const list = (names: readonly string[]) => names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");

interface Interpreted { key: QueryKey; text: string; label: string; apply: (f: QueryFilter) => void }

/** Interprets one `key:value` token (key already resolved); an error string when the value does not parse. */
function interpret(key: QueryKey, value: string, ctx: QueryContext): Interpreted | string {
  const lv = value.toLowerCase();
  const now = ctx.now ?? Date.now();
  if (!value) return `${key}: needs a value. ${HINT[key] ?? ""}`.trim();
  switch (key) {
    case "side": {
      const s = SIDES[lv];
      return s ? { key, text: `side:${s}`, label: s === "long" ? "Long trades" : "Short trades", apply: (f) => { f.side = s; } } : HINT.side!;
    }
    case "outcome": {
      const o = OUTCOMES[lv];
      const label = { win: "Winners", loss: "Losers", breakeven: "Breakeven", open: "Still open", closed: "Closed" };
      return o ? { key, text: o, label: label[o], apply: (f) => { f.outcome = o; } } : HINT.outcome!;
    }
    case "ended": {
      const e = ENDED[lv];
      const label = { stop: "Hit the stop", tp: "Hit the target", signal: "Closed by the strategy", venue: "Closed by the venue", manual: "Closed by hand" };
      return e ? { key, text: `ended:${e}`, label: label[e], apply: (f) => { f.ended = e; } } : HINT.ended!;
    }
    case "type": {
      const t = TYPES[lv];
      return t ? { key, text: `type:${t}`, label: TYPE_LABEL[t], apply: (f) => { f.type = t; } } : HINT.type!;
    }
    case "level": {
      const l = LEVELS[lv];
      return l ? { key, text: `level:${l.toLowerCase()}`, label: `${l} lines`, apply: (f) => { f.level = l; } } : HINT.level!;
    }
    case "pnl": {
      const r = parseRange(lv, money);
      return r ? { key, text: `pnl:${lv}`, label: `P&L ${op(r, String)}`, apply: (f) => { f.pnl = r; } } : HINT.pnl!;
    }
    case "r": {
      const r = parseRange(lv, multiple);
      return r ? { key, text: `r:${lv}`, label: `R ${op(r, (n) => `${n}R`)}`, apply: (f) => { f.r = r; } } : HINT.r!;
    }
    case "size": {
      const r = parseRange(lv, lots);
      return r ? { key, text: `size:${lv}`, label: `Size ${op(r, String)}`, apply: (f) => { f.size = r; } } : HINT.size!;
    }
    case "held": {
      const r = parseRange(lv, parseDuration, true);
      return r ? { key, text: `held:${lv}`, label: `Held ${op(r, formatDuration)}`, apply: (f) => { f.held = r; } } : HINT.held!;
    }
    case "entry": case "exit": case "time": {
      const w = parseWindow(lv, now);
      if (!w) return key === "exit" && ENDED[lv] ? `exit: takes a date. For how a trade ended use ended:${ENDED[lv]}` : HINT[key]!;
      const verb = key === "entry" ? "Entered" : key === "exit" ? "Exited" : "Written";
      return { key, text: `${key}:${lv}`, label: `${verb} ${windowLabel(w)} (UTC)`, apply: (f) => { f[key] = w; } };
    }
    case "weekday": {
      const d = weekdayOf(lv);
      return d === null ? HINT.weekday! : { key, text: `weekday:${WEEKDAY_NAMES[d]}`, label: `Entered on a ${WEEKDAY_LABEL[d]} (UTC)`, apply: (f) => { f.weekday = d; } };
    }
    case "hour": {
      const r = parseRange(lv, hourOf);
      return r ? { key, text: `hour:${lv}`, label: `Entered ${op(r, (n) => `${String(n).padStart(2, "0")}:00`)} UTC`, apply: (f) => { f.hour = r; } } : HINT.hour!;
    }
    case "ticket": {
      const t = value.replace(/^#/, "");
      return /^[A-Za-z0-9_.:-]{1,64}$/.test(t) ? { key, text: `#${t}`, label: `Ticket ${t}`, apply: (f) => { f.ticket = t; } } : HINT.ticket!;
    }
    case "logger":
      return /^[\w.$:\-/]{1,128}$/.test(value) ? { key, text: `logger:${value}`, label: `Logger contains ${value}`, apply: (f) => { f.logger = value; } } : HINT.logger!;
    case "strategy": {
      if (UNATTRIBUTED.has(lv)) return { key, text: `strategy:${UNATTRIBUTED_STRATEGY}`, label: "No strategy claimed it", apply: (f) => { f.strategy = null; } };
      const r = resolveName(value, ctx.strategies, (s) => s.toLowerCase());
      if ("candidates" in r) return `strategy: no strategy "${value}" here. Try ${list(r.candidates)} or unattributed`;
      return { key, text: `strategy:${r.name}`, label: `Strategy ${r.name}`, apply: (f) => { f.strategy = r.name; } };
    }
    case "symbol": {
      const r = resolveName(foldInstrument(value), ctx.instruments, foldInstrument);
      if ("candidates" in r) return `symbol: no instrument "${foldInstrument(value)}" here. Try ${list(r.candidates)}`;
      const name = foldInstrument(r.name);
      return { key, text: `symbol:${name}`, label: `Only ${name}`, apply: (f) => { f.symbol = name; } };
    }
    case "text":
      return { key, text: /\s/.test(value) ? `"${value}"` : value, label: `Text "${value}"`, apply: (f) => { f.text.push(value); } };
  }
}

/** Reads one token: `key:value`, `#ticket`, a bare word that names a filter, or free text. */
export function parseToken(raw: string, ctx: QueryContext = {}): QueryToken & { apply?: (f: QueryFilter) => void } {
  const quoted = /^"(.*)"$/.exec(raw);
  if (quoted) return finish(raw, interpret("text", quoted[1]!, ctx));
  if (raw.startsWith("#")) return finish(raw, interpret("ticket", raw.slice(1), ctx));
  const i = raw.indexOf(":");
  // "ICM_S05:XAUUSD" is a symbol, not an unknown key: only a known alias before the colon is a key
  if (i > 0) {
    const key = resolveKey(raw.slice(0, i));
    if (key) return finish(raw, interpret(key, raw.slice(i + 1).replace(/^"(.*)"$/, "$1"), ctx));
    if (/^[a-z_]+$/i.test(raw.slice(0, i)) && !ctx.instruments?.some((s) => foldInstrument(s) === foldInstrument(raw))) {
      return { raw, error: `Unknown filter "${raw.slice(0, i)}". Known: ${KNOWN}` };
    }
  }
  const bare = raw.toLowerCase();
  if (BARE[bare]) return parseToken(BARE[bare]!, ctx);
  if (ctx.instruments?.some((s) => foldInstrument(s) === foldInstrument(raw))) return parseToken(`symbol:${raw}`, ctx);
  if (ctx.strategies?.some((s) => s.toLowerCase() === bare)) return parseToken(`strategy:${raw}`, ctx);
  if (parseSpan(raw) && /^\d{4}-\d{2}(-\d{2})?$/.test(raw)) return parseToken(`exit:${raw}`, ctx);
  return finish(raw, interpret("text", raw, ctx));
}

function finish(raw: string, r: Interpreted | string): QueryToken & { apply?: (f: QueryFilter) => void } {
  if (typeof r === "string") return { raw, error: `"${raw}": ${r}` };
  return { raw, key: r.key, text: r.text, label: r.label, apply: r.apply };
}

/** Splits on whitespace, keeping quoted phrases (`"order rejected"`, `logger:"a b"`) whole. */
export function tokenize(text: string): string[] {
  return [...text.matchAll(/[^\s"]+:"[^"]*"|"[^"]*"|\S+/g)].map((m) => m[0]);
}

/** Parses a whole query line. */
export function parseQuery(text: string, ctx: QueryContext = {}): ParsedQuery {
  const tokens = tokenize(text).map((t) => parseToken(t, ctx));
  // later tokens of a key replace earlier ones; free words and errors all stay
  const lastOf = new Map<QueryKey, number>();
  tokens.forEach((t, i) => { if (t.key && t.key !== "text") lastOf.set(t.key, i); });
  const kept = tokens.filter((t, i) => t.key && !t.error && (t.key === "text" || lastOf.get(t.key) === i));
  const filter: QueryFilter = { text: [] };
  for (const t of kept) t.apply!(filter);
  const strip = ({ apply: _apply, ...t }: QueryToken & { apply?: unknown }): QueryToken => t;
  return {
    filter,
    tokens: tokens.map(strip),
    chips: kept.map(strip),
    errors: tokens.flatMap((t) => (t.error ? [t.error] : [])),
    canonical: kept.map((t) => t.text).join(" "),
  };
}

/** The query without one chip (by its canonical text), as canonical text. */
export function withoutChip(query: string, chip: string, ctx: QueryContext = {}): string {
  const p = parseQuery(query, ctx);
  const i = p.chips.findIndex((c) => c.text === chip);
  return p.chips.filter((_, j) => j !== i).map((c) => c.text).join(" ");
}

/** The query with tokens added; they replace any chip of the same key. */
export function withTokens(query: string, add: string, ctx: QueryContext = {}): string {
  return parseQuery(`${query} ${add}`.trim(), ctx).canonical;
}

/** The query minus every chip of the given keys (e.g. clearing the day a calendar drill set). */
export function withoutKeys(query: string, keys: readonly QueryKey[], ctx: QueryContext = {}): string {
  return parseQuery(query, ctx).chips.filter((c) => !keys.includes(c.key!)).map((c) => c.text).join(" ");
}
