import type { InstrumentType, QueryFilter, Range, Window } from "@qkt-insights/contract/query";
import { decimalsOf, MAX_PRICE_DIGITS, roundPrice } from "@qkt-insights/contract/prices";
import type { Db } from "./db.js";
import { SWAP_ONLY, winRatePct } from "./analytics.js";
import { refreshProjections } from "./projections.js";
import { statement } from "./statements.js";
import { instanceMoneyDigits, roundMoney } from "./money.js";
import { digitsFromPrices, INFERRED_POINT_VALUE, PROFILE_SUFFIX } from "./inferredVenueFacts.js";
import { quantityUnitOf } from "./instrumentKind.js";
import { instanceCurrencies, TRIP_CURRENCY, type CurrencyNet } from "./currencies.js";

/*
 * Reads over the round_trips projection (one row per venue position, kept on write by the
 * position reducer, 032_round_trips.sql) for the Trades page, a strategy's trades, the calendar
 * drill and the trade drawer: the query language compiled to bound SQL, keyset pages, totals,
 * facets, CSV pages and one round trip in full with its engine timeline.
 */

export type TripSide = "long" | "short";
/** How a position ended, as the Trades page names it (the projection's `so` is `venue`). */
export type TripEnded = "stop" | "tp" | "signal" | "venue" | "manual";

export interface TripRow {
  /** The venue position ticket. */
  id: string;
  broker: string | null;
  /** null: no strategy claimed the position. */
  strategyId: string | null;
  symbol: string;
  instrument: string;
  /** The currency of the account it was booked on (currencies.ts); null when no account reported one. */
  currency: string | null;
  /** The instrument's kind as qkt states it on the position's deals (cfd, equity, spot, perpetual, future, option); null when not stated. */
  kind: string | null;
  /** What one unit of `qty` is (instrumentKind.ts: lots, shares, coins, contracts, or a unit qkt names); null when unknown. */
  unit: string | null;
  /** Underlying per unit of `qty`, as stated; null when not stated. */
  contractSize: number | null;
  /** The venue's folder for the instrument (`Stocks` for an MT5 stock CFD), as stated; null when not stated. */
  category: string | null;
  /**
   * The venue the position is on, from its symbol's broker prefix without a profile suffix
   * ("EXNESS_S01:AAPL" -> "EXNESS"), when the instance trades this instrument on more than one
   * venue account (an AAPL stock CFD beside an AAPL share); null when the instrument alone says it.
   */
  venue: string | null;
  side: TripSide;
  status: "open" | "closed";
  entryTs: number | null;
  entryPrice: number | null;
  exitTs: number | null;
  exitPrice: number | null;
  qty: number;
  /** Realized money incl. commission, swap and fee (a still-open position: what it booked so far). */
  pnl: number | null;
  /** Unrounded: what a total adds. Absent where a row was not read from the store (a public view). */
  pnlExact?: number | null;
  /**
   * With an `exit:` window in the query: the realized of this position's closing legs inside the
   * window, when it also has closing legs outside it (closed in parts across the window's edge).
   * null otherwise, where `pnl` is all of it.
   */
  pnlInExit: number | null;
  holdMs: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  /** Money lost had the initial stop filled; null without a stop. */
  risk: number | null;
  r: number | null;
  ended: TripEnded | null;
  legs: number;
  entryOrderId: string | null;
  /** "deal": a venue position; "ledger": one engine close no broker deal stands for (paper). */
  source: "deal" | "ledger";
  /** Why the position closed, as qkt stated it (STOP, TAKE_PROFIT, SIGNAL, MANUAL, TIMED, STOP_OUT, ...); null when not stated. */
  closeReason: string | null;
  /** Decimals the venue quotes this instrument with: every price of the row prints at it. */
  priceDigits: number;
}

/**
 * The initial stop as the venue holds it: qkt states the engine's level unrounded (0.582774), the
 * venue keeps it at the instrument's tick (0.58277), and money at risk and R are measured to that,
 * so the stop the drawer shows reproduces the risk beside it. See venueStops.
 */
const STOP = "qkt_venue_stop(t.instance_id, upper(t.instrument), t.stop_price)";
/**
 * Money at risk to the initial stop of a closed round trip: what qkt stated for its entry, else the
 * venue's money per point (inferred from its gross over the move) times the points to the stop.
 */
const RISK = `(CASE WHEN t.open = 0 AND t.risk_amount > 0 THEN t.risk_amount
  WHEN t.open = 0 AND ${STOP} IS NOT NULL AND t.entry_price IS NOT NULL AND abs(t.entry_price - ${STOP}) > 0
  THEN ${INFERRED_POINT_VALUE} * abs(t.entry_price - ${STOP}) END)`;
/**
 * The unrounded net the legs state: R divides it, not the cent-rounded `realized`, so a trip whose
 * money is a fraction of a cent of a small risk keeps its true R (-0.0056 over 0.005 is -1.12, not -2).
 */
const EXACT = "coalesce(t.realized_exact, t.realized)";
/** P&L over that risk; without a stated risk or a venue price per point, the move over the points to the stop. */
const R = `(CASE WHEN t.open = 0 AND t.risk_amount > 0 AND t.exit_price IS NOT NULL THEN ${EXACT} / t.risk_amount
  WHEN t.open = 0 AND ${STOP} IS NOT NULL AND t.entry_price IS NOT NULL AND t.exit_price IS NOT NULL
    AND abs(t.entry_price - ${STOP}) > 0
  THEN coalesce(${EXACT} / ${RISK},
    (CASE t.side WHEN 'long' THEN t.exit_price - t.entry_price ELSE t.entry_price - t.exit_price END) / abs(t.entry_price - ${STOP})) END)`;
const ENDED = "(CASE t.ended WHEN 'so' THEN 'venue' ELSE t.ended END)";
/** The UTC entry weekday, 0 Monday .. 6 Sunday, and hour 0-23. */
const ENTRY_WEEKDAY = "((CAST(strftime('%w', t.entry_ts / 1000, 'unixepoch') AS INTEGER) + 6) % 7)";
const ENTRY_HOUR = "CAST(strftime('%H', t.entry_ts / 1000, 'unixepoch') AS INTEGER)";
const PNL = "(CASE WHEN t.open = 1 AND t.exit_ts IS NULL THEN NULL ELSE t.realized END)";

/** What a total adds for a trip: its unrounded net, null like PNL while the trip is open. */
const PNL_EXACT = `(CASE WHEN t.open = 1 AND t.exit_ts IS NULL THEN NULL ELSE ${EXACT} END)`;

const COLUMNS = `t.position_ticket id, t.broker, t.strategy_id strategyId, coalesce(t.symbol, t.instrument) symbol, upper(t.instrument) instrument,
  t.side, CASE WHEN t.open = 1 THEN 'open' ELSE 'closed' END status, t.entry_ts entryTs, t.entry_price entryPrice,
  CASE WHEN t.open = 1 THEN NULL ELSE t.exit_ts END exitTs, CASE WHEN t.open = 1 THEN NULL ELSE t.exit_price END exitPrice,
  coalesce(t.qty, 0) qty, ${PNL} pnl, ${PNL_EXACT} pnlExact, t.hold_ms holdMs, t.stop_price stopPrice, t.target_price targetPrice, ${RISK} risk, ${R} r,
  ${ENDED} ended, t.legs, t.entry_order_id entryOrderId, t.source, t.close_reason closeReason, ${TRIP_CURRENCY("t")} currency,
  (SELECT json_array(d.instrument_kind, d.contract_size, d.quantity_unit, d.instrument_category) FROM deals d
     WHERE d.instance_id=t.instance_id AND d.position_ticket=t.position_ticket
       AND (d.instrument_kind IS NOT NULL OR d.quantity_unit IS NOT NULL) ORDER BY d.ts, d.rowid LIMIT 1) instrumentFacts`;

type StoredTrip = Omit<TripRow, "priceDigits" | "kind" | "unit" | "contractSize" | "category" | "venue"> & { instrumentFacts: string | null };

/** A stored row with the instrument facts of its deals read out (kind, unit, contract size, venue folder). */
function withInstrument({ instrumentFacts, ...r }: StoredTrip): Omit<TripRow, "priceDigits" | "venue"> {
  const [kind, contractSize, stated, category] = instrumentFacts
    ? (JSON.parse(instrumentFacts) as [string | null, number | null, string | null, string | null]) : [null, null, null, null];
  return { ...r, kind, unit: quantityUnitOf(kind, stated), contractSize, category: category ?? null };
}

/** Each instrument type as a condition on one deal `d` of the position (contract query.ts instrumentType). */
const TYPE_SQL: Record<InstrumentType, string> = {
  cfd: "d.instrument_kind='cfd'",
  "stock-cfd": "d.instrument_kind='cfd' AND (lower(d.instrument_category) LIKE '%stock%' OR lower(d.instrument_category) LIKE '%share%' OR lower(d.instrument_category) LIKE '%equit%')",
  share: "d.instrument_kind='equity'",
  coin: "d.instrument_kind='spot'",
  perpetual: "d.instrument_kind='perpetual'",
  future: "d.instrument_kind='future'",
  option: "d.instrument_kind='option'",
};

const ENTRY_WINDOW_MS = 10 * 60_000;
const AFTER_MS = 2 * 60_000;
const OUT = new Set(["OUT", "INOUT", "OUT_BY"]);

interface EventRow { id: string; type: string; ts: number; seq: number; strategyId: string | null; payload: string }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v != null && typeof v === "object" ? (v as Record<string, unknown>) : {});
const parse = (payload: string): Record<string, unknown> => { try { return obj(JSON.parse(payload)); } catch { return {}; } };
/** A stop or target as qkt sends it: a bare price, or `{type: "Fixed", price}`. */
const levelOf = (v: unknown): number | null => num(v) ?? num(obj(v).price);

/**
 * Decimals each instrument's venue prices show on the instance: its stated tick size, else what its
 * newest deals' prices show. e.g. { XAUUSD: 2, EURUSD: 5 }
 */
export function instrumentDigits(db: Db, instanceId: string): Map<string, number> {
  // deals only grow: the newest deal id says whether the answer can have changed
  const mark = (statement(db, "SELECT MAX(rowid) m FROM deals WHERE instance_id=?").get(instanceId) as { m: number | null }).m ?? 0;
  let byInstance = digitsCache.get(db);
  if (!byInstance) digitsCache.set(db, (byInstance = new Map()));
  const hit = byInstance.get(instanceId);
  if (hit && hit.mark === mark) return hit.digits;
  const digits = readDigits(db, instanceId);
  byInstance.set(instanceId, { mark, digits });
  return digits;
}

const digitsCache = new WeakMap<Db, Map<string, { mark: number; digits: Map<string, number> }>>();

function readDigits(db: Db, instanceId: string): Map<string, number> {
  const rows = statement(db, `SELECT symbol, price, tick_size tick FROM deals WHERE instance_id=? AND canonical=1 AND price IS NOT NULL
    ORDER BY ts DESC LIMIT 2000`).all(instanceId) as Array<{ symbol: string | null; price: number; tick: number | null }>;
  const prices = new Map<string, number[]>();
  const ticks = new Map<string, number>();
  for (const r of rows) {
    const k = instrumentKey(r.symbol);
    if (!k) continue;
    prices.set(k, [...(prices.get(k) ?? []), r.price]);
    if (r.tick != null && r.tick > 0 && !ticks.has(k)) ticks.set(k, r.tick);
  }
  return new Map([...prices].map(([k, ps]) => [k, digitsOf(ticks.get(k), ps, k)]));
}

/** The decimals a price of an instrument shows: its stated tick's, else what its prices and name say. */
function digitsOf(tick: number | null | undefined, prices: readonly number[], instrument: string): number {
  return tick != null && tick > 0 ? Math.min(MAX_PRICE_DIGITS, decimalsOf(tick)) : digitsFromPrices(prices, instrument);
}

const venueStopReady = new WeakSet<Db>();

/**
 * Readies STOP for one instance's queries: registers qkt_venue_stop on the connection once and loads
 * the instance's instrument digits, so the SQL rounds each row's stop with an O(1) map lookup (a
 * function cannot query the connection it runs on). Without known digits the stop stays as stated.
 */
function venueStops(db: Db, instanceId: string): void {
  if (!venueStopReady.has(db)) {
    db.function("qkt_venue_stop", (instance: unknown, instrument: unknown, stop: unknown) => {
      if (typeof stop !== "number") return null;
      const d = digitsCache.get(db)?.get(String(instance))?.digits.get(String(instrument));
      return d == null ? stop : Number(stop.toFixed(d));
    });
    venueStopReady.add(db);
  }
  instrumentDigits(db, instanceId);
}

const instrumentKey = (symbol: string | null): string => {
  if (!symbol) return "";
  const i = symbol.lastIndexOf(":");
  return (i >= 0 ? symbol.slice(i + 1) : symbol).toUpperCase();
};

function withDigits(rows: StoredTrip[], digits: Map<string, number>, venues: ReadonlySet<string>): TripRow[] {
  return rows.map((r) => ({ ...withInstrument(r), venue: venueOf(r, venues), priceDigits: digits.get(r.instrument) ?? digitsFromPrices([], r.instrument) }));
}

/** The venue a round trip names (TripRow.venue): only for an instrument in `venues` (multiVenueInstruments). */
function venueOf(r: { symbol: string; instrument: string; broker: string | null }, venues: ReadonlySet<string>): string | null {
  if (!venues.has(r.instrument)) return null;
  const i = r.symbol.lastIndexOf(":");
  const prefix = i >= 0 ? r.symbol.slice(0, i) : r.broker;
  return prefix ? prefix.toUpperCase().replace(PROFILE_SUFFIX, "") : null;
}

/**
 * The instruments the instance's venue deals show on more than one venue account (the same stock
 * as a CFD and as a share), which a round trip then names with its venue. Deals that state no
 * account (an older qkt) never split an instrument. Cached until a deal is stored.
 */
export function multiVenueInstruments(db: Db, instanceId: string): ReadonlySet<string> {
  const mark = (statement(db, "SELECT MAX(rowid) m FROM deals WHERE instance_id=?").get(instanceId) as { m: number | null }).m ?? 0;
  let byInstance = venuesCache.get(db);
  if (!byInstance) venuesCache.set(db, (byInstance = new Map()));
  const hit = byInstance.get(instanceId);
  if (hit && hit.mark === mark) return hit.instruments;
  const instruments = new Set((statement(db,
    `SELECT upper(substr(symbol, instr(symbol, ':') + 1)) i FROM deals
     WHERE instance_id=? AND canonical=1 AND symbol IS NOT NULL AND account_id IS NOT NULL
     GROUP BY i HAVING COUNT(DISTINCT account_id) > 1`,
  ).all(instanceId) as Array<{ i: string }>).map((r) => r.i));
  byInstance.set(instanceId, { mark, instruments });
  return instruments;
}

const venuesCache = new WeakMap<Db, Map<string, { mark: number; instruments: ReadonlySet<string> }>>();

/** A price at its row's precision, for text (CSV, timeline). */
export function tripPrice(v: number | null | undefined, digits: number): string {
  return roundPrice(v, digits) ?? "";
}

export type RoundTripSort = "entry" | "exit" | "pnl" | "r" | "held" | "size" | "strategy" | "symbol" | "side" | "entryPrice" | "exitPrice" | "ended" | "ticket";

/** Sort keys and the column each reads: the only text that ever reaches ORDER BY. */
export const ROUND_TRIP_SORTS: Record<RoundTripSort, string> = {
  entry: "t.entry_ts", exit: "(CASE WHEN t.open = 1 THEN NULL ELSE t.exit_ts END)", pnl: PNL, r: R, held: "t.hold_ms", size: "t.qty",
  strategy: "t.strategy_id", symbol: "t.instrument", side: "t.side", entryPrice: "t.entry_price", exitPrice: "t.exit_price", ended: ENDED,
  ticket: "t.position_ticket",
};

export interface RoundTripScope {
  instanceId: string;
  /** Only this strategy's round trips (a strategy page); null: only unattributed ones. */
  strategyId?: string | null;
  /** Only round trips still open or closed at or after this time (the page's date range). */
  since?: number;
  /** Public views: only round trips of these strategies, fully closed at or before the cutoff. */
  allowed?: readonly string[];
  closedBy?: number;
}

export interface RoundTripQuery extends RoundTripScope {
  filter?: QueryFilter;
  sort?: RoundTripSort;
  dir?: "asc" | "desc";
  cursor?: string | null;
  limit?: number;
}

export interface RoundTripPage { rows: TripRow[]; nextCursor: string | null }

export interface RoundTripTotals {
  /** Round trips in the scope, before the query. */
  total: number;
  /** Round trips the query matched. */
  matched: number;
  closed: number;
  open: number;
  /**
   * Realized P&L of the matched round trips (a partly closed one counts what it closed). With an
   * `exit:` window it is the realized of their closing legs inside the window, so a day's drill
   * shows the day's money as the calendar books it (per closing leg, on the leg's UTC day).
   */
  net: number;
  /** Whether `net` is the closing legs inside the query's `exit:` window. */
  netInExit: boolean;
  /**
   * `net` and the matched count per account currency, largest count first. `net` adds them 1:1, so a reader
   * shows these instead when there is more than one. With one known currency (or none) the instance's money
   * is not split: a single entry holds all of it.
   */
  currencies: CurrencyNet[];
  wins: number;
  losses: number;
  /** Winning over decided closed round trips, in percent; null when none was decided. */
  winRate: number | null;
  /** Mean P&L per closed round trip. */
  avg: number | null;
  best: number | null;
  worst: number | null;
}

class Sql {
  readonly where: string[] = [];
  readonly params: Record<string, unknown> = {};
  private n = 0;
  bind(v: unknown): string {
    const k = `v${this.n++}`;
    this.params[k] = v;
    return `@${k}`;
  }
}

function scopeSql(s: RoundTripScope, sql: Sql): void {
  sql.where.push(`t.instance_id=${sql.bind(s.instanceId)}`);
  if (s.strategyId !== undefined) sql.where.push(s.strategyId === null ? "t.strategy_id IS NULL" : `t.strategy_id=${sql.bind(s.strategyId)}`);
  if (s.since != null) sql.where.push(`(t.open=1 OR t.exit_ts>=${sql.bind(s.since)})`);
  if (s.allowed) sql.where.push(`t.strategy_id IN (SELECT value FROM json_each(${sql.bind(JSON.stringify(s.allowed))}))`);
  if (s.closedBy != null) sql.where.push(`t.open=0 AND t.exit_ts<=${sql.bind(s.closedBy)}`);
}

function rangeSql(col: string, r: Range | undefined, sql: Sql): void {
  if (!r) return;
  if (r.min !== undefined) sql.where.push(`${col}${r.minOpen ? ">" : ">="}${sql.bind(r.min)}`);
  if (r.max !== undefined) sql.where.push(`${col}${r.maxOpen ? "<" : "<="}${sql.bind(r.max)}`);
}

function windowSql(col: string, w: Window | undefined, sql: Sql): void {
  if (!w) return;
  if (w.from !== undefined) sql.where.push(`${col}>=${sql.bind(w.from)}`);
  if (w.to !== undefined) sql.where.push(`${col}<${sql.bind(w.to)}`);
}

/**
 * `exit:` selects the round trips with a closing leg in the window (a position closed in parts
 * matches on each day it closed some). An engine close (ledger row) is its own single leg. The
 * trip's exit_ts is its latest closing leg, so `exit_ts >= from` is implied and narrows by index.
 */
function exitSql(w: Window | undefined, sql: Sql): void {
  if (!w) return;
  const legs = legWindow(w, sql, "ct.ts");
  const own = legWindow(w, sql, "t.exit_ts");
  if (w.from !== undefined) sql.where.push(`t.exit_ts>=${sql.bind(w.from)}`);
  sql.where.push(`(CASE WHEN t.source='ledger' THEN ${own} ELSE EXISTS (SELECT 1 FROM closed_trades ct
    WHERE ct.instance_id=t.instance_id AND ct.position_ticket=t.position_ticket AND ${legs}) END)`);
}

/** The window as a condition on `col` ("1" without bounds). */
function legWindow(w: Window, sql: Sql, col: string): string {
  const c: string[] = [];
  if (w.from !== undefined) c.push(`${col}>=${sql.bind(w.from)}`);
  if (w.to !== undefined) c.push(`${col}<${sql.bind(w.to)}`);
  return c.length ? c.join(" AND ") : "1";
}

/** The realized of a trip's closing legs inside an `exit:` window (an engine close: all of it). */
function realizedInExit(w: Window, sql: Sql): string {
  return `(CASE WHEN t.source='ledger' THEN ${EXACT} ELSE (SELECT COALESCE(SUM(COALESCE(ct.realized_exact, ct.realized)), 0) FROM closed_trades ct
    WHERE ct.instance_id=t.instance_id AND ct.position_ticket=t.position_ticket AND ${legWindow(w, sql, "ct.ts")}) END)`;
}

/** Whether a deal trip also has closing legs outside an `exit:` window. */
function legsOutsideExit(w: Window, sql: Sql): string {
  return `(t.source<>'ledger' AND EXISTS (SELECT 1 FROM closed_trades ct
    WHERE ct.instance_id=t.instance_id AND ct.position_ticket=t.position_ticket AND NOT (${legWindow(w, sql, "ct.ts")})))`;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The parsed query as WHERE clauses; every value is bound, every column comes from this function.
 * `hideIds` (public views) keeps tickets and order ids out of reach: a search could otherwise probe them.
 */
function filterSql(f: QueryFilter | undefined, sql: Sql, hideIds = false): void {
  if (!f) return;
  for (const word of f.text) {
    const p = sql.bind(`%${likeEscape(word.toLowerCase())}%`);
    const ids = hideIds ? "" : ` OR t.position_ticket LIKE ${p} ESCAPE '\\' OR lower(coalesce(t.entry_order_id,'')) LIKE ${p} ESCAPE '\\'`;
    sql.where.push(`(lower(coalesce(t.strategy_id,'unattributed')) LIKE ${p} ESCAPE '\\' OR lower(t.instrument) LIKE ${p} ESCAPE '\\'
      OR coalesce(${ENDED},'') LIKE ${p} ESCAPE '\\'${ids})`);
  }
  if (f.strategy !== undefined) sql.where.push(f.strategy === null ? "t.strategy_id IS NULL" : `t.strategy_id=${sql.bind(f.strategy)}`);
  if (f.symbol) sql.where.push(`t.instrument=${sql.bind(f.symbol.toUpperCase())}`);
  if (f.side) sql.where.push(`t.side=${sql.bind(f.side)}`);
  switch (f.outcome) {
    case "win": sql.where.push("t.open=0 AND t.realized>0"); break;
    case "loss": sql.where.push("t.open=0 AND t.realized<0"); break;
    case "breakeven": sql.where.push("t.open=0 AND t.realized=0"); break;
    case "open": sql.where.push("t.open=1"); break;
    case "closed": sql.where.push("t.open=0"); break;
  }
  rangeSql(PNL, f.pnl, sql);
  rangeSql(R, f.r, sql);
  rangeSql("t.hold_ms", f.held, sql);
  rangeSql("t.qty", f.size, sql);
  windowSql("t.entry_ts", f.entry, sql);
  exitSql(f.exit, sql);
  if (f.ended) sql.where.push(`t.ended=${sql.bind(f.ended === "venue" ? "so" : f.ended)}`);
  if (f.type) sql.where.push(`EXISTS (SELECT 1 FROM deals d WHERE d.instance_id=t.instance_id AND d.position_ticket=t.position_ticket AND ${TYPE_SQL[f.type]})`);
  if (f.weekday !== undefined) sql.where.push(`t.entry_ts IS NOT NULL AND ${ENTRY_WEEKDAY}=${sql.bind(f.weekday)}`);
  if (f.hour) {
    sql.where.push("t.entry_ts IS NOT NULL");
    rangeSql(ENTRY_HOUR, f.hour, sql);
  }
  if (f.ticket && !hideIds) sql.where.push(`(t.position_ticket=${sql.bind(f.ticket)} OR t.entry_order_id=${sql.bind(f.ticket)})`);
}

type CursorKey = [isNull: 0 | 1, value: string | number | null, id: string];

function encodeCursor(k: CursorKey): string {
  return Buffer.from(JSON.stringify(k)).toString("base64url");
}

/** The position a cursor names; null when it is not one this code wrote. */
export function decodeCursor(cursor: string): CursorKey | null {
  try {
    const k = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (!Array.isArray(k) || k.length !== 3 || (k[0] !== 0 && k[0] !== 1) || typeof k[2] !== "string") return null;
    if (k[1] !== null && typeof k[1] !== "string" && typeof k[1] !== "number") return null;
    return k as CursorKey;
  } catch {
    return null;
  }
}

/**
 * One page of round trips, ordered by the sort column (empty values last, either direction) and
 * then the ticket. The cursor is the last row's sort key, so pages stay stable while new trades
 * arrive at the top: rows that arrive later never shift a page the viewer already has.
 */
export function listRoundTrips(db: Db, q: RoundTripQuery): RoundTripPage {
  refreshProjections(db);
  venueStops(db, q.instanceId);
  const sql = new Sql();
  scopeSql(q, sql);
  filterSql(q.filter, sql, q.allowed != null);
  const col = ROUND_TRIP_SORTS[q.sort ?? "entry"];
  const desc = (q.dir ?? "desc") === "desc";
  const cmp = desc ? "<" : ">";
  const at = q.cursor ? decodeCursor(q.cursor) : null;
  if (at) {
    const id = sql.bind(at[2]);
    if (at[0] === 1) sql.where.push(`(${col} IS NULL AND t.position_ticket ${cmp} ${id})`);
    else {
      const v = sql.bind(at[1]);
      sql.where.push(`((${col} IS NOT NULL AND (${col} ${cmp} ${v} OR (${col} = ${v} AND t.position_ticket ${cmp} ${id}))) OR ${col} IS NULL)`);
    }
  }
  const limit = Math.max(1, Math.min(q.limit ?? 100, 1000));
  const order = desc ? "DESC" : "ASC";
  const exit = q.filter?.exit;
  const inExit = exit ? `CASE WHEN ${legsOutsideExit(exit, sql)} THEN ${realizedInExit(exit, sql)} END` : "NULL";
  const rows = db.prepare(
    `SELECT ${COLUMNS}, ${inExit} pnlInExit, ${col} sortValue FROM round_trips t WHERE ${sql.where.join(" AND ")}
     ORDER BY (${col} IS NULL) ASC, ${col} ${order}, t.position_ticket ${order} LIMIT ${limit + 1}`,
  ).all(sql.params) as Array<StoredTrip & { sortValue: string | number | null }>;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const digits = exit ? instanceMoneyDigits(db, q.instanceId) : 2;
  return {
    rows: withDigits(page.map(({ sortValue: _s, ...row }) => (row.pnlInExit == null ? row : { ...row, pnlInExit: roundMoney(row.pnlInExit, digits) })),
      instrumentDigits(db, q.instanceId), multiVenueInstruments(db, q.instanceId)),
    nextCursor: more && last ? encodeCursor([last.sortValue == null ? 1 : 0, last.sortValue, last.id]) : null,
  };
}

/** Counts and money of the matched round trips, and how many the scope holds before the query. */
export function roundTripTotals(db: Db, q: RoundTripQuery): RoundTripTotals {
  refreshProjections(db);
  venueStops(db, q.instanceId);
  const scope = new Sql();
  scopeSql(q, scope);
  const total = (db.prepare(`SELECT COUNT(*) n FROM round_trips t WHERE ${scope.where.join(" AND ")}`).get(scope.params) as { n: number }).n;
  const sql = new Sql();
  scopeSql(q, sql);
  filterSql(q.filter, sql, q.allowed != null);
  const exit = q.filter?.exit;
  const a = db.prepare(
    `SELECT COUNT(*) matched, COALESCE(SUM(t.open=0),0) closed, COALESCE(SUM(t.open=1),0) open,
       COALESCE(SUM(${exit ? realizedInExit(exit, sql) : EXACT}),0) net,
       COALESCE(SUM(t.open=0 AND t.realized>0),0) wins, COALESCE(SUM(t.open=0 AND t.realized<0),0) losses,
       AVG(CASE WHEN t.open=0 THEN t.realized END) avg,
       MAX(CASE WHEN t.open=0 THEN t.realized END) best, MIN(CASE WHEN t.open=0 THEN t.realized END) worst
     FROM round_trips t WHERE ${sql.where.join(" AND ")}`,
  ).get(sql.params) as Omit<RoundTripTotals, "total" | "winRate" | "netInExit">;
  // the exact sum, at the minor unit
  const digits = instanceMoneyDigits(db, q.instanceId);
  const net = roundMoney(a.net, digits);
  const known = instanceCurrencies(db, q.instanceId);
  const currencies = known.length > 1
    ? (db.prepare(
      `SELECT ${TRIP_CURRENCY("t")} currency, COALESCE(SUM(${exit ? realizedInExit(exit, sql) : EXACT}),0) net, COUNT(*) n
       FROM round_trips t WHERE ${sql.where.join(" AND ")} GROUP BY 1 ORDER BY n DESC, currency IS NULL, currency`,
    ).all(sql.params) as CurrencyNet[]).map((c) => ({ ...c, net: roundMoney(c.net, digits) }))
    : a.matched > 0 ? [{ currency: known[0] ?? null, net, n: a.matched }] : [];
  return { total, ...a, net, netInExit: exit != null, winRate: winRatePct(a.wins, a.losses), currencies };
}

export interface RoundTripFacets {
  strategies: Array<{ id: string | null; n: number }>;
  instruments: Array<{ name: string; n: number }>;
  /** UTC exit days with closes, newest first (at most 120). */
  days: string[];
  /** Sizes traded most often. */
  sizes: number[];
}

/** What the scope holds, for completions: strategies, instruments, exit days and common sizes. */
export function roundTripFacets(db: Db, s: RoundTripScope): RoundTripFacets {
  refreshProjections(db);
  venueStops(db, s.instanceId);
  const sql = new Sql();
  scopeSql(s, sql);
  const where = sql.where.join(" AND ");
  const strategies = db.prepare(`SELECT t.strategy_id id, COUNT(*) n FROM round_trips t WHERE ${where} GROUP BY t.strategy_id ORDER BY n DESC`).all(sql.params) as RoundTripFacets["strategies"];
  const instruments = db.prepare(`SELECT t.instrument name, COUNT(*) n FROM round_trips t WHERE ${where} GROUP BY t.instrument ORDER BY n DESC`).all(sql.params) as RoundTripFacets["instruments"];
  const days = (db.prepare(`SELECT DISTINCT strftime('%Y-%m-%d', t.exit_ts / 1000, 'unixepoch') d FROM round_trips t
    WHERE ${where} AND t.exit_ts IS NOT NULL ORDER BY d DESC LIMIT 120`).all(sql.params) as Array<{ d: string }>).map((r) => r.d);
  const sizes = (db.prepare(`SELECT t.qty q FROM round_trips t WHERE ${where} GROUP BY t.qty ORDER BY COUNT(*) DESC LIMIT 8`).all(sql.params) as Array<{ q: number }>).map((r) => r.q);
  return { strategies, instruments, days, sizes };
}

/** Every matched round trip in pages of `pageSize`, for an export that never holds the whole set. */
export function* roundTripPages(db: Db, q: RoundTripQuery, pageSize = 1000): Generator<TripRow[]> {
  let cursor: string | null = null;
  for (;;) {
    const page = listRoundTrips(db, { ...q, cursor, limit: pageSize });
    if (page.rows.length) yield page.rows;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

// ---------------------------------------------------------------------------------------------
// One round trip in full

export interface RoundTripLeg {
  dealTicket: string; orderTicket: string | null; broker: string; symbol: string | null; side: string | null; entry: string | null;
  qty: number | null; price: number | null; profit: number | null; commission: number | null;
  /** Swap without perpetual funding; funding: the leg's perpetual funding (0 when it states none). */
  swap: number | null; funding: number; fee: number | null;
  /** profit + commission + swap + funding + fee. */
  net: number; comment: string | null; ts: number;
  /** Why this leg closed, as qkt stated it; null for an opening leg or when not stated. */
  closeReason: string | null;
  /** Who computed profit: "venue" or "engine" (qkt's accounting, for a venue that reports none); null when not stated. */
  realizedSource: string | null;
  /** The instrument's stated price tick and account money per point per unit of qty; null when not stated. */
  tickSize: number | null; valuePerPoint: number | null;
}

export interface TimelineStep {
  ts: number;
  /** signal | decision | submit | accepted | rejected | cancelled | modified | fill | deal | closed | bot */
  kind: string;
  title: string;
  detail: string | null;
  /** engine: qkt's clock; venue: the broker's deal time. */
  source: "engine" | "venue";
  /** Time since the step before it. */
  sinceMs: number | null;
}

export interface Slippage {
  /** The price the engine expected (submit reference, stop or target). */
  reference: number;
  fill: number;
  /** Price units against the trade: positive is worse than the reference. */
  points: number;
  /** points in money at the trade's size; null when the venue's P&L cannot price a point. */
  money: number | null;
  basis: "reference price" | "stop" | "target";
}

export interface RoundTripDetail {
  trip: TripRow;
  legs: RoundTripLeg[];
  timeline: TimelineStep[];
  entrySlippage: Slippage | null;
  exitSlippage: Slippage | null;
  /** Lowest and highest marked P&L while open; null when no marks were sampled. */
  excursion: { mae: number; mfe: number; marks: number } | null;
  /** Every engine event the timeline was built from, oldest first. */
  events: Array<{ id: string; type: string; ts: number; seq: number; strategyId: string | null; payload: unknown }>;
}

const TIMELINE_TYPES = ["signal", "decision.order_linked", "decision.rule_evaluated", "order.submit", "order.accepted", "order.rejected", "order.cancelled",
  "order.modified", "order.filled", "order.partially_filled", "fill.accounted", "trade", "trade.closed", "bot.close", "bot.modify", "bot.cancel"];
const BETWEEN_TYPES = ["order.modified", "bot.modify", "bot.cancel"];

/** The round trip with its legs, the engine's story of it and its execution quality; null when there is none. */
export function roundTripDetail(db: Db, instanceId: string, id: string): RoundTripDetail | null {
  refreshProjections(db);
  venueStops(db, instanceId);
  const stored = statement(db, `SELECT ${COLUMNS}, NULL pnlInExit FROM round_trips t WHERE t.instance_id=? AND t.position_ticket=?`).get(instanceId, id) as StoredTrip | undefined;
  if (!stored) return null;
  const legs = venueLegs(db, instanceId, stored.id);
  const digits = digitsOf(legs.find((l) => l.tickSize != null)?.tickSize, legs.flatMap((l) => (l.price != null ? [l.price] : [])), stored.instrument);
  const trip: TripRow = { ...withInstrument(stored), venue: venueOf(stored, multiVenueInstruments(db, instanceId)), priceDigits: digits };
  const ids = new Set<string>();
  if (trip.entryOrderId) ids.add(trip.entryOrderId);
  const ticket = trip.id;
  const events = engineEvents(db, instanceId, trip, ids, ticket);
  const parsed = events.map((e) => ({ ...e, payload: parse(e.payload) }));
  const dir = trip.side === "long" ? 1 : -1;
  const gross = legs.filter((l) => OUT.has(l.entry ?? "")).reduce((a, l) => a + (l.profit ?? 0), 0);
  const move = trip.entryPrice != null && trip.exitPrice != null ? dir * (trip.exitPrice - trip.entryPrice) : null;
  // The account money one point is worth at the trip's size: stated per unit of qty, else the venue's gross over the move.
  const valuePerPoint = legs.find((l) => l.valuePerPoint != null)?.valuePerPoint;
  const perPoint = valuePerPoint != null ? valuePerPoint * trip.qty
    : move != null && Math.abs(move) > 1e-12 && gross / move > 0 ? gross / move : null;
  const slip = (reference: number | null, fill: number | null, sign: 1 | -1, basis: Slippage["basis"]): Slippage | null => {
    if (reference == null || fill == null) return null;
    // entry: paying more than the reference on a long is worse; exit: receiving less is worse
    // at the instrument's precision: a computed stop or target carries float noise past it
    const points = Number((sign * dir * (fill - reference)).toFixed(digits)) || 0;
    return { reference, fill, points, money: perPoint != null ? points * perPoint || 0 : null, basis };
  };
  const submit = parsed.find((e) => e.type === "order.submit" && ids.has(String(e.payload.orderId)) && e.payload.closesTicket == null);
  const entryFill = parsed.find((e) => e.type === "order.filled" && e.payload.exitReason == null && ids.has(String(e.payload.orderId)));
  const entrySlippage = slip(num(submit?.payload.referencePrice), num(entryFill?.payload.price) ?? trip.entryPrice, 1, "reference price");
  let exitSlippage: Slippage | null = null;
  if (trip.status === "closed") {
    const closeSubmit = parsed.find((e) => e.type === "order.submit" && ticket != null && e.payload.closesTicket === ticket);
    if (trip.ended === "stop" && trip.stopPrice != null) exitSlippage = slip(trip.stopPrice, trip.exitPrice, -1, "stop");
    else if (trip.ended === "tp" && trip.targetPrice != null) exitSlippage = slip(trip.targetPrice, trip.exitPrice, -1, "target");
    else if (closeSubmit) exitSlippage = slip(num(closeSubmit.payload.referencePrice), trip.exitPrice, -1, "reference price");
  }
  return {
    trip, legs,
    timeline: timeline(trip, legs, parsed, digits),
    entrySlippage, exitSlippage,
    excursion: trip.entryTs != null ? excursion(db, instanceId, ticket, trip.entryTs, trip.exitTs ?? Date.now()) : null,
    events: parsed,
  };
}

function venueLegs(db: Db, instanceId: string, ticket: string): RoundTripLeg[] {
  const rows = statement(db, `SELECT d.deal_ticket dealTicket, d.order_ticket orderTicket, d.broker, d.symbol, d.side, d.entry, d.qty, d.price,
      d.profit, d.commission, CASE WHEN d.swap IS NULL THEN NULL ELSE ${SWAP_ONLY("d")} END swap, COALESCE(d.funding,0) funding, d.fee,
      d.comment, d.ts, d.close_reason closeReason, d.realized_source realizedSource,
      d.tick_size tickSize, d.value_per_point valuePerPoint
    FROM deals d WHERE d.instance_id=? AND d.position_ticket=? AND d.canonical=1 ORDER BY d.ts, d.rowid`).all(instanceId, ticket) as Omit<RoundTripLeg, "net">[];
  return rows.map((l) => ({ ...l, net: (l.profit ?? 0) + (l.commission ?? 0) + (l.swap ?? 0) + l.funding + (l.fee ?? 0) }));
}

/**
 * The engine events of one round trip: those naming its orders, its ticket, or the decision that
 * placed it, around the entry and the exit (plus stop and target changes in between). Orders are
 * linked transitively: the entry order names its bracket plan, a close order names the ticket.
 */
function engineEvents(db: Db, instanceId: string, trip: TripRow, ids: Set<string>, ticket: string | null): EventRow[] {
  const windows: Array<[number, number, string[]]> = [];
  if (trip.entryTs != null) windows.push([trip.entryTs - ENTRY_WINDOW_MS, trip.entryTs + AFTER_MS, TIMELINE_TYPES]);
  if (trip.exitTs != null) windows.push([trip.exitTs - ENTRY_WINDOW_MS, trip.exitTs + AFTER_MS, TIMELINE_TYPES]);
  if (trip.entryTs != null) windows.push([trip.entryTs, trip.exitTs ?? Date.now(), BETWEEN_TYPES]);
  const seen = new Map<string, EventRow>();
  const stmt = statement(db, `SELECT id, type, ts, seq, strategy_id strategyId, payload FROM events
    WHERE instance_id=@instanceId AND type IN (SELECT value FROM json_each(@types)) AND ts BETWEEN @from AND @to`);
  for (const [from, to, types] of windows) {
    for (const e of stmt.all({ instanceId, types: JSON.stringify(types), from, to }) as EventRow[]) seen.set(e.id, e);
  }
  const all = [...seen.values()].map((e) => ({ e, p: parse(e.payload) }));
  const decisions = new Set<string>();
  const order = (p: Record<string, unknown>) => obj(p.order);
  // two passes reach every link: entry → plan → signal → decision; ticket → close order
  for (let pass = 0; pass < 2; pass++) {
    for (const { e, p } of all) {
      if (e.type === "order.submit" && ids.has(String(p.orderId)) && str(p.planOrderId)) ids.add(String(p.planOrderId));
      if (e.type === "order.submit" && ticket != null && p.closesTicket === ticket && str(p.orderId)) ids.add(String(p.orderId));
      if (e.type === "signal" && (ids.has(String(order(p).orderId)) || ids.has(String(obj(order(p).entry).orderId)))) {
        if (str(order(p).orderId)) ids.add(String(order(p).orderId));
      }
      if (e.type === "decision.order_linked" && ids.has(String(p.orderId)) && str(p.decisionId)) decisions.add(String(p.decisionId));
    }
  }
  const mine = ({ e, p }: { e: EventRow; p: Record<string, unknown> }) =>
    ids.has(String(p.orderId)) || ids.has(String(order(p).orderId)) || ids.has(String(obj(order(p).entry).orderId))
    || (ticket != null && (p.positionId === ticket || p.nextPositionId === ticket || p.brokerOrderId === ticket || p.ticket === ticket || p.closesTicket === ticket))
    || (e.type.startsWith("decision.") && decisions.has(String(p.decisionId)));
  return all.filter(mine).map(({ e }) => e).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

function excursion(db: Db, instanceId: string, ticket: string, from: number, to: number): RoundTripDetail["excursion"] {
  const m = statement(db, `SELECT MIN(profit) lo, MAX(profit) hi, COUNT(profit) n FROM position_valuations
    WHERE instance_id=? AND ticket=? AND ts>=? AND ts<=?`).get(instanceId, ticket, from, to) as { lo: number | null; hi: number | null; n: number };
  return m.n > 0 ? { mae: Math.min(0, m.lo ?? 0), mfe: Math.max(0, m.hi ?? 0), marks: m.n } : null;
}

const fmt = (v: unknown) => (typeof v === "number" ? String(Number(v.toPrecision(12))) : String(v ?? ""));
/** A size as the engine computed it can carry 16 digits; four decimals is what a lot size needs. */
const lot = (v: unknown) => (typeof v === "number" ? String(Number(v.toFixed(4))) : fmt(v));

/** The story in order: engine steps and venue deals merged by time, each with the gap since the one before. */
function timeline(trip: TripRow, legs: RoundTripLeg[], events: Array<Omit<EventRow, "payload"> & { payload: Record<string, unknown> }>, digits: number): TimelineStep[] {
  const px = (v: unknown) => (typeof v === "number" ? tripPrice(v, digits) : typeof v === "string" && Number.isFinite(Number(v)) ? tripPrice(Number(v), digits) : fmt(v));
  const steps: Array<Omit<TimelineStep, "sinceMs">> = [];
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case "decision.rule_evaluated":
        steps.push({ ts: e.ts, kind: "decision", title: `Rule ${fmt(p.ruleId)} ${p.conditionResult ? "fired" : "evaluated"}`, detail: p.timeframe ? `on the ${fmt(p.timeframe)} bar` : null, source: "engine" });
        break;
      case "signal": {
        const o = obj(p.order);
        steps.push({ ts: e.ts, kind: "signal", title: `Signal ${fmt(p.side)} ${lot(p.qty)} ${instrumentKey(str(p.symbol))}`, detail: o.closesTicket ? `close ticket ${fmt(o.closesTicket)}` : str(p.intent), source: "engine" });
        break;
      }
      case "order.submit": {
        const parts = [str(p.orderType), levelOf(p.stopLoss) != null ? `stop ${px(levelOf(p.stopLoss))}` : null, levelOf(p.takeProfit) != null ? `target ${px(levelOf(p.takeProfit))}` : null,
          num(p.referencePrice) != null ? `reference ${px(p.referencePrice)}` : null].filter(Boolean);
        steps.push({ ts: e.ts, kind: "submit", title: p.closesTicket ? `Close order submitted ${fmt(p.side)} ${lot(p.qty)}` : `Order submitted ${fmt(p.side)} ${lot(p.qty)}`, detail: parts.join(" · ") || null, source: "engine" });
        break;
      }
      case "order.accepted":
        steps.push({ ts: e.ts, kind: "accepted", title: "Accepted by the venue", detail: p.brokerOrderId ? `ticket ${fmt(p.brokerOrderId)}` : null, source: "engine" });
        break;
      case "order.rejected":
        steps.push({ ts: e.ts, kind: "rejected", title: "Rejected", detail: str(p.reason), source: "engine" });
        break;
      case "order.cancelled":
        steps.push({ ts: e.ts, kind: "cancelled", title: "Cancelled", detail: str(p.reason), source: "engine" });
        break;
      case "order.modified": {
        const c = obj(p.changes);
        const parts = [c.newStopPrice != null ? `stop → ${px(c.newStopPrice)}` : null, c.newLimitPrice != null ? `limit → ${px(c.newLimitPrice)}` : null, c.newQuantity != null ? `qty → ${fmt(c.newQuantity)}` : null].filter(Boolean);
        steps.push({ ts: e.ts, kind: "modified", title: "Order modified", detail: parts.join(" · ") || null, source: "engine" });
        break;
      }
      case "bot.modify":
        steps.push({ ts: e.ts, kind: "modified", title: "Stop / target changed", detail: [p.sl ? `stop → ${px(p.sl)}` : null, p.tp ? `target → ${px(p.tp)}` : null].filter(Boolean).join(" · ") || null, source: "engine" });
        break;
      case "bot.close":
        steps.push({ ts: e.ts, kind: "bot", title: "Closed by hand (qkt bot close)", detail: p.price ? `at ${px(p.price)}` : null, source: "engine" });
        break;
      case "bot.cancel":
        steps.push({ ts: e.ts, kind: "bot", title: "Cancelled by hand (qkt bot cancel)", detail: null, source: "engine" });
        break;
      case "order.filled": case "order.partially_filled": {
        const reason = {
          STOP: "stop", STOP_LOSS: "stop", TAKE_PROFIT: "target", CLOSE: "close order", SIGNAL: "signal", TIMED: "timed hold", MANUAL: "hand",
          STOP_OUT: "stop-out", LIQUIDATION: "liquidation", EXPIRY: "expiry",
        }[String(p.closeReason ?? p.exitReason)] ?? null;
        steps.push({ ts: e.ts, kind: "fill", title: `${e.type === "order.partially_filled" ? "Partly filled" : "Filled"} ${lot(p.qty)} @ ${px(p.price)}`, detail: reason ? `exit by ${reason}` : null, source: "engine" });
        break;
      }
      case "trade.closed":
        steps.push({ ts: e.ts, kind: "closed", title: "Engine booked the close", detail: num(p.realized) != null ? `realized ${fmt(p.realized)}` : null, source: "engine" });
        break;
    }
  }
  for (const l of legs) {
    const net = l.entry === "IN" ? null : `net ${fmt(Math.round(l.net * 100) / 100)}`;
    steps.push({ ts: l.ts, kind: "deal", title: `Venue deal ${l.entry ?? ""} ${l.side ?? ""} ${lot(l.qty)} @ ${px(l.price)}`.replace(/\s+/g, " "), detail: [`deal ${l.dealTicket}`, l.comment || null, net].filter(Boolean).join(" · "), source: "venue" });
  }
  steps.sort((a, b) => a.ts - b.ts);
  return steps.map((s, i) => ({ ...s, sinceMs: i === 0 ? null : s.ts - steps[i - 1]!.ts }));
}
