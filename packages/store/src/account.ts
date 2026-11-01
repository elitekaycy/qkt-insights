import type { Db } from "./db.js";
import {
  accountBinds, adjustmentRows, canonicalDeal, dealOnAccount, SWAP_ONLY, closeDealOf, closedTradeRows, fullyClosedPosition, instrumentOf, OUT_LEGS,
  type DayNet, type DealClosedTrade,
} from "./analytics.js";
import { addMoney, exactMoney, instanceMoneyDigits, roundMoney } from "./money.js";

/**
 * Account-level figures: every closed trade on the instance's account, whichever strategy owned it.
 * Summing the per-strategy reports misses three things this does not: strategies that left the
 * active roster, deals no strategy claimed (shown as an unattributed bucket), and a strategy whose
 * deals were all closed by the venue after it stopped reporting.
 */
export interface AccountFilter {
  instanceId: string;
  /** Restricts the closes to these strategies (public links); unattributed closes are then left out. */
  strategyIds?: ReadonlySet<string>;
  from?: number;
  to?: number;
  /** Only positions fully closed by `to` (requires `to`), as public views need. */
  closedPositionsOnly?: boolean;
  /** One venue account's closes only; absent, every account on the instance. */
  account?: AccountScope;
}

/** One venue account of an instance as the account readers group it: its id (null when none was stated) and its broker labels. */
export interface AccountScope {
  identity: string | null;
  labels: readonly string[];
}

/**
 * The close filter of one account: its id, and as a JSON array every broker label it is known under, the labels its
 * equity reported under and those its deals were booked under. A deal names its account; an engine close names only
 * the profile in its symbol ("PAPER_A:BTC_USDC_PERPETUAL"), which these labels place.
 */
function accountFilter(db: Db, instanceId: string, scope: AccountScope | undefined): { accountId?: string | null; accountLabels?: string | null } {
  if (!scope) return {};
  const labels = new Set(scope.labels);
  if (scope.identity != null) {
    for (const r of db.prepare("SELECT DISTINCT broker FROM deals WHERE instance_id=? AND account_id=?").all(instanceId, scope.identity) as Array<{ broker: string }>) {
      labels.add(r.broker);
    }
  }
  return { accountId: scope.identity, accountLabels: JSON.stringify([...labels]) };
}

export interface AccountClose extends Omit<DealClosedTrade, "entryPrice" | "exitPrice" | "holdMs"> {
  entryPrice: number | null;
  exitPrice: number;
  holdMs: number | null;
  /** The owning strategy; null for a close no strategy claimed. */
  strategyId: string | null;
  /** The symbol without its broker-profile prefix, e.g. "ICM_S05:XAUUSD" -> "XAUUSD". */
  instrument: string;
}

/**
 * Every closed trade on the account, oldest first. A strategy with closing broker deals counts its
 * deals; one without (paper/backtest) counts its trade.closed rows, which is the same per-strategy
 * choice the strategy pages make, so the account total equals the sum of its strategies plus the
 * unattributed bucket.
 */
export function accountCloses(db: Db, f: AccountFilter): AccountClose[] {
  if (f.closedPositionsOnly && f.to == null) throw new Error("closedPositionsOnly needs a `to` cutoff");
  const ids = f.strategyIds ? JSON.stringify([...f.strategyIds]) : null;
  const account = accountFilter(db, f.instanceId, f.account);
  const deals = closedTradeRows(db, { instanceId: f.instanceId, to: f.to, closedPositionsOnly: f.closedPositionsOnly, strategyIds: ids, ...account });
  // A strategy with deals on any account never counts its engine closes, whichever account is read.
  const dealBacked = new Set(account.accountLabels == null ? deals.map((d) => d.strategyId)
    : (db.prepare("SELECT DISTINCT strategy_id s FROM closed_trades WHERE instance_id=?").all(f.instanceId) as Array<{ s: string | null }>).map((r) => r.s));

  const out: AccountClose[] = deals.map((d) => {
    const row = { ...d, instrument: instrumentOf(d.symbol) };
    tripOf.set(row, d.orderId != null ? `p:${d.orderId}` : `d:${closeDealOf(d)}`);
    return row;
  });
  // trade.closed rows carry no position identity, so public (closedPositionsOnly) views skip them.
  if (!f.closedPositionsOnly) {
    const lc = ["instance_id=@instanceId"];
    if (f.to != null) lc.push("ts<=@to");
    if (ids != null) lc.push("strategy_id IN (SELECT value FROM json_each(@ids))");
    if (account.accountLabels != null) lc.push("substr(symbol, 1, instr(symbol, ':') - 1) IN (SELECT value FROM json_each(@accountLabels))");
    const ledger = db.prepare(
      `SELECT ts, symbol, side, qty, price, realized, entry_ts entryTs, order_id orderId, strategy_id strategyId
       FROM trade_closes WHERE ${lc.join(" AND ")} ORDER BY ts ASC`,
    ).all({ instanceId: f.instanceId, to: f.to, ids, ...accountBinds(account) }) as Array<{
      ts: number; symbol: string; side: string; qty: number; price: number; realized: number;
      entryTs: number | null; orderId: string | null; strategyId: string | null;
    }>;
    const digits = instanceMoneyDigits(db, f.instanceId);
    for (const r of ledger) {
      if (dealBacked.has(r.strategyId)) continue;
      out.push({
        ...r, realized: roundMoney(r.realized, digits), realizedExact: r.realized, entryPrice: null, exitPrice: r.price, holdMs: r.entryTs != null ? r.ts - r.entryTs : null,
        entryOrderId: null, exitOrderId: null, instrument: instrumentOf(r.symbol),
      });
    }
    out.sort((a, b) => a.ts - b.ts);
  }
  return f.from == null ? out : out.filter((c) => c.ts >= f.from!);
}

/** The round trip a close belongs to ("p:<position>", "d:<deal rowid>"); an engine close has none (it is its own). */
const tripOf = new WeakMap<AccountClose, string>();

/** Costs by kind, negative when paid: swap without funding, and perpetual funding apart. net = the sum of all five. */
export interface AccountCosts { grossProfit: number; commission: number; swap: number; funding: number; fee: number; net: number }

export interface AccountBucket {
  /** Instrument, or strategy id; null is the unattributed bucket. */
  key: string | null;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  /** byInstrument only: the venue symbols folded into the instrument. */
  venues?: string[];
}

export interface AccountSummary {
  /** Newest first. */
  closes: AccountClose[];
  /**
   * Net per UTC close day: the realized of every closing leg booked that day. `trades` counts the
   * round trips (positions) with a closing leg that day, the ones the day's `exit:<day>` drill lists.
   */
  dailyNets: DayNet[];
  totalNet: number;
  /** Closes (one per closing leg); wins, losses and breakeven classify each close at the minor unit. */
  trades: number;
  wins: number;
  losses: number;
  /** Closes with exactly zero net: excluded from the win rate. */
  breakeven: number;
  /** Sum of winning closes' net (after costs), the profit-factor numerator. */
  sumWins: number;
  /** Sum of losing closes' net as a positive number, the profit-factor denominator. */
  sumLosses: number;
  /** Gross = deal profit before commission, swap and fee, over every leg. Null without broker deals. */
  costs: AccountCosts | null;
  byInstrument: AccountBucket[];
  byStrategy: AccountBucket[];
}

/** Adds a close; `net` runs unrounded until accountSummary rounds it once. */
function bucket(map: Map<string | null, AccountBucket>, key: string | null, c: AccountClose): AccountBucket {
  const b = map.get(key) ?? { key, net: 0, trades: 0, wins: 0, losses: 0 };
  b.net += exactMoney(c);
  b.trades++;
  if (c.realized > 0) b.wins++;
  else if (c.realized < 0) b.losses++;
  map.set(key, b);
  return b;
}

/** The account roll-up the Overview shows: totals, costs, and where the money came from. */
export function accountSummary(db: Db, f: AccountFilter): AccountSummary {
  const closes = accountCloses(db, f);
  const digits = instanceMoneyDigits(db, f.instanceId);
  const byDay = new Map<string, DayNet>();
  const tripsByDay = new Map<string, Set<string>>();
  const byInstrument = new Map<string | null, AccountBucket>();
  const byStrategy = new Map<string | null, AccountBucket>();
  let totalNet = 0, wins = 0, losses = 0, sumWins = 0, sumLosses = 0;
  closes.forEach((c, i) => {
    totalNet += exactMoney(c);
    if (c.realized > 0) { wins++; sumWins = addMoney(sumWins, c.realized, digits); } else if (c.realized < 0) { losses++; sumLosses = addMoney(sumLosses, -c.realized, digits); }
    const day = new Date(c.ts).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { day, net: 0, trades: 0 };
    d.net += exactMoney(c);
    // a position closed in parts on one day is one round trip of that day; an engine close is its own
    const trips = tripsByDay.get(day) ?? new Set<string>();
    trips.add(tripOf.get(c) ?? `l:${i}`);
    tripsByDay.set(day, trips);
    d.trades = trips.size;
    byDay.set(day, d);
    const inst = bucket(byInstrument, c.instrument, c);
    inst.venues ??= [];
    if (!inst.venues.includes(c.symbol)) inst.venues.push(c.symbol);
    bucket(byStrategy, c.strategyId, c);
  });
  // Venue adjustments (a stock CFD's dividend, a charge) are the account's money but no close: in the net, its day
  // and its strategy's and instrument's buckets, never in a trade count or a win.
  const ids = f.strategyIds ? JSON.stringify([...f.strategyIds]) : null;
  const account = accountFilter(db, f.instanceId, f.account);
  for (const a of adjustmentRows(db, { instanceId: f.instanceId, from: f.from, to: f.to, closedPositionsOnly: f.closedPositionsOnly, strategyIds: ids, ...account })) {
    totalNet += a.realizedExact;
    const day = new Date(a.ts).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { day, net: 0, trades: 0 };
    d.net += a.realizedExact;
    byDay.set(day, d);
    for (const [map, key] of [[byStrategy, a.strategyId], [byInstrument, instrumentOf(a.symbol)]] as const) {
      const b = map.get(key) ?? { key, net: 0, trades: 0, wins: 0, losses: 0 };
      b.net += a.realizedExact;
      map.set(key, b);
    }
  }
  for (const b of [...byInstrument.values(), ...byStrategy.values()]) b.net = roundMoney(b.net, digits);
  return {
    closes: [...closes].reverse(),
    dailyNets: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => ({ ...d, net: roundMoney(d.net, digits) })),
    totalNet: roundMoney(totalNet, digits),
    trades: closes.length,
    wins,
    losses,
    breakeven: closes.length - wins - losses,
    sumWins,
    sumLosses,
    costs: accountCosts(db, f),
    byInstrument: [...byInstrument.values()].sort((a, b) => b.trades - a.trades),
    byStrategy: [...byStrategy.values()].sort((a, b) => b.net - a.net),
  };
}

/** Commission, swap, funding and fee across every leg (The5ers books commission on the entry leg too). */
function accountCosts(db: Db, f: AccountFilter): AccountCosts | null {
  const cl = ["d.instance_id=@instanceId", canonicalDeal("d")];
  if (f.from != null) cl.push("d.ts>=@from");
  if (f.to != null) cl.push("d.ts<=@to");
  if (f.closedPositionsOnly) cl.push(fullyClosedPosition("d"));
  const ids = f.strategyIds ? JSON.stringify([...f.strategyIds]) : null;
  if (ids != null) cl.push("d.strategy_id IN (SELECT value FROM json_each(@ids))");
  const account = accountFilter(db, f.instanceId, f.account);
  if (account.accountLabels != null) cl.push(dealOnAccount("d"));
  const row = db.prepare(
    `SELECT COUNT(*) n, SUM(CASE WHEN d.entry IN ${OUT_LEGS} THEN 1 ELSE 0 END) outs,
            COALESCE(SUM(d.profit),0) grossProfit, COALESCE(SUM(d.commission),0) commission,
            COALESCE(SUM(${SWAP_ONLY("d")}),0) swap, COALESCE(SUM(d.funding),0) funding, COALESCE(SUM(d.fee),0) fee
     FROM deals d WHERE ${cl.join(" AND ")}`,
  ).get({ instanceId: f.instanceId, from: f.from, to: f.to, ids, ...accountBinds(account) }) as {
    n: number; outs: number | null; grossProfit: number; commission: number; swap: number; funding: number; fee: number;
  };
  if (!row.outs) return null;
  const digits = instanceMoneyDigits(db, f.instanceId);
  const [grossProfit, commission, swap, funding, fee] = [row.grossProfit, row.commission, row.swap, row.funding, row.fee]
    .map((v) => roundMoney(v, digits)) as [number, number, number, number, number];
  return { grossProfit, commission, swap, funding, fee, net: roundMoney(grossProfit + commission + swap + funding + fee, digits) };
}
