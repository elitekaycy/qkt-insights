import { createHmac, randomBytes } from "node:crypto";
import type { AccountSummary, AdjustmentRow, ClosedTradeRow, DealRow, StrategyRow, TripAnalytics, TripBucket, TripRow, TradeRow } from "@qkt-insights/store";
import type { PerformanceBundle } from "./performance.js";

/*
 * Public responses are rebuilt field by field from these allow-lists. Nothing from an admin
 * response is forwarded wholesale, so a field added to a store row stays private until it is
 * listed here on purpose.
 */

const ID_KEY = randomBytes(32);

/** A stable stand-in for a ticket or order id: rows still join, the venue id never leaves. */
export function opaqueId(id: string | null | undefined): string | null {
  if (id == null || id === "") return null;
  return createHmac("sha256", ID_KEY).update(id).digest("hex").slice(0, 16);
}

/** "EXNESS_P549:GBPUSD" -> "GBPUSD": the prefix names a broker profile. */
export function publicSymbol(symbol: string | null | undefined): string {
  if (!symbol) return "";
  const i = symbol.lastIndexOf(":");
  return i >= 0 ? symbol.slice(i + 1) : symbol;
}

const METADATA_STRINGS = ["dslName", "portfolioId", "portfolioName", "portfolioAlias"] as const;
const METADATA_NUMBERS = ["portfolioWeight", "allocatedCapital"] as const;
const RISK_NUMBERS = ["maxDrawdownPct", "maxDailyDrawdownPct"] as const;

function publicMetadata(meta: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!meta) return out;
  for (const k of METADATA_STRINGS) if (typeof meta[k] === "string") out[k] = meta[k];
  for (const k of METADATA_NUMBERS) if (typeof meta[k] === "number") out[k] = meta[k];
  if (Array.isArray(meta.symbols)) out.symbols = [...new Set(meta.symbols.filter((s): s is string => typeof s === "string").map(publicSymbol))];
  const risk = meta.risk;
  if (risk && typeof risk === "object") {
    const picked: Record<string, number> = {};
    for (const k of RISK_NUMBERS) {
      const v = (risk as Record<string, unknown>)[k];
      if (typeof v === "number") picked[k] = v;
    }
    if (Object.keys(picked).length > 0) out.risk = picked;
  }
  return out;
}

/** A strategy as a public link shows it: its net is its closes' and its venue adjustments' (dividends, charges). */
export function publicStrategy(row: StrategyRow, closes: ClosedTradeRow[], adjustments: AdjustmentRow[], cutoff: number): StrategyRow {
  return {
    strategyId: row.strategyId,
    firstSeen: row.firstSeen,
    lastSeen: Math.min(row.lastSeen, cutoff),
    startingBalance: row.startingBalance,
    definedCapital: row.definedCapital,
    metadata: publicMetadata(row.metadata),
    realizedNet: closes.length > 0 ? adjustments.reduce((a, r) => a + r.realized, closes.reduce((a, c) => a + c.realized, 0)) : null,
    dealCount: closes.length,
    active: true,
  };
}

function publicClose(c: ClosedTradeRow & { entryOrderId?: string | null; exitOrderId?: string | null; entryPrice?: number | null; exitPrice?: number; holdMs?: number | null }) {
  return {
    ts: c.ts, symbol: publicSymbol(c.symbol), side: c.side, qty: c.qty, price: c.price, realized: c.realized, entryTs: c.entryTs,
    orderId: opaqueId(c.orderId), entryOrderId: opaqueId(c.entryOrderId), exitOrderId: opaqueId(c.exitOrderId),
    ...(c.entryPrice !== undefined ? { entryPrice: c.entryPrice } : {}),
    ...(c.exitPrice !== undefined ? { exitPrice: c.exitPrice } : {}),
    ...(c.holdMs !== undefined ? { holdMs: c.holdMs } : {}),
  };
}

type Keyed = { key: string; venues?: string[] };

/** Instrument keys pass; the venue symbols behind them name broker profiles and are dropped. */
function relabelKeys<T extends Keyed>(rows: T[]): Array<Omit<T, "venues">> {
  return rows.map(({ venues: _venues, ...r }) => ({ ...r, key: publicSymbol(r.key) }));
}

/**
 * Report, daily nets, drawdown periods, post-loss rows, day/hour cells, rolling points and costs
 * are numbers keyed by time or bucket, so they pass as built.
 * Everything that can carry a venue id or a broker-prefixed symbol is rebuilt.
 */
export function publicBundle(b: PerformanceBundle) {
  return {
    ...b,
    closes: b.closes?.map(publicClose),
    breakdowns: b.breakdowns && { ...b.breakdowns, bySymbol: relabelKeys(b.breakdowns.bySymbol) },
    contribution: b.contribution && { ...b.contribution, bySymbol: relabelKeys(b.contribution.bySymbol) },
    excursions: b.excursions && {
      ...b.excursions,
      rows: b.excursions.rows.map((r) => ({
        ticket: opaqueId(r.ticket) ?? "", symbol: publicSymbol(r.symbol), side: r.side, ts: r.ts, exitPnl: r.exitPnl,
        mae: r.mae, mfe: r.mfe, capturePct: r.capturePct, observations: r.observations,
      })),
    },
  };
}

/** The account roll-up of a shared overview: built from its public strategies only, ids opaque. */
export function publicAccountSummary(s: AccountSummary) {
  return {
    ...s,
    closes: s.closes.map((c) => ({ ...publicClose(c), strategyId: c.strategyId, instrument: c.instrument })),
    byInstrument: relabelKeys(s.byInstrument.map((b) => ({ ...b, key: b.key ?? "" }))),
  };
}

export function publicTrade(t: TradeRow) {
  const p = t.payload as { orderId?: string; symbol?: string; side?: string; price?: number; qty?: number; ts?: number };
  return {
    id: opaqueId(t.id), strategyId: t.strategyId, ts: t.ts,
    payload: { orderId: opaqueId(p.orderId), symbol: publicSymbol(p.symbol), side: p.side ?? "", price: p.price ?? 0, qty: p.qty ?? 0, ts: p.ts ?? t.ts },
  };
}

export function publicDeal(d: DealRow & { fee?: number | null }) {
  return {
    id: opaqueId(d.id), broker: "Account", dealTicket: opaqueId(d.dealTicket), positionTicket: opaqueId(d.positionTicket), orderTicket: opaqueId(d.orderTicket),
    symbol: publicSymbol(d.symbol), side: d.side, entry: d.entry, qty: d.qty, price: d.price, profit: d.profit, commission: d.commission,
    swap: d.swap, funding: d.funding, fee: d.fee ?? null, magic: null, comment: null, strategyId: d.strategyId, ts: d.ts,
  };
}

/** A round trip without its venue ticket, order ids, broker profile, stop or target. */
export function publicRoundTrip(r: TripRow) {
  return {
    id: opaqueId(r.id), broker: null, strategyId: r.strategyId, symbol: publicSymbol(r.symbol), instrument: r.instrument, currency: r.currency, venue: null,
    side: r.side, status: r.status, entryTs: r.entryTs, entryPrice: r.entryPrice, exitTs: r.exitTs, exitPrice: r.exitPrice, qty: r.qty,
    pnl: r.pnl, holdMs: r.holdMs, stopPrice: null, targetPrice: null, risk: null, r: r.r, ended: r.ended, legs: r.legs, entryOrderId: null, source: r.source, priceDigits: r.priceDigits,
  };
}

const publicBucket = (b: TripBucket): TripBucket => ({ key: b.key, label: b.label, filter: b.filter, n: b.n, wins: b.wins, losses: b.losses, pnl: b.pnl });

/**
 * Instrument buckets without the venue a multi-venue instrument's bucket names ("ALPACA:AAPL"): each keeps
 * its own figures, numbered when the instrument repeats ("AAPL", "AAPL 2").
 */
function publicInstrumentBuckets(buckets: readonly TripBucket[]): TripBucket[] {
  const seen = new Map<string, number>();
  return buckets.map((b) => {
    const name = publicSymbol(b.key);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const key = n === 1 ? name : `${name} ${n}`;
    return { ...publicBucket(b), key, label: key };
  });
}

/** The journal aggregates with every trade id made opaque. */
export function publicTripAnalytics(a: TripAnalytics): TripAnalytics {
  const ref = (t: { id: string; pnl: number } | null) => (t ? { id: opaqueId(t.id) ?? "", pnl: t.pnl } : null);
  return {
    total: a.total, matched: a.matched, currencies: a.currencies.map((c) => ({ currency: c.currency, net: c.net, n: c.n })), closed: a.closed, open: a.open, pnl: a.pnl, grossWin: a.grossWin, grossLoss: a.grossLoss,
    wins: a.wins, losses: a.losses, breakeven: a.breakeven, winRate: a.winRate, profitFactor: a.profitFactor, avgWin: a.avgWin,
    avgLoss: a.avgLoss, payoff: a.payoff, expectancy: a.expectancy, r: { n: a.r.n, avg: a.r.avg, total: a.r.total },
    best: ref(a.best), worst: ref(a.worst), avgHoldMs: a.avgHoldMs, maxDd: a.maxDd, maxDdWindow: a.maxDdWindow ? { from: a.maxDdWindow.from, to: a.maxDdWindow.to } : null,
    streaks: { current: a.streaks.current, maxWin: a.streaks.maxWin, maxLoss: a.streaks.maxLoss },
    postLoss: a.postLoss.map((p) => ({ n: p.n, sample: p.sample, nextWinRate: p.nextWinRate, nextAvg: p.nextAvg })),
    trades: a.trades.map((t) => ({ id: opaqueId(t.id) ?? "", exitTs: t.exitTs, pnl: t.pnl, cum: t.cum })),
    tradesTruncated: a.tradesTruncated,
    daily: a.daily.map((d) => ({ day: d.day, n: d.n, wins: d.wins, losses: d.losses, pnl: d.pnl })),
    monthly: a.monthly.map((m) => ({ day: m.day, n: m.n, wins: m.wins, losses: m.losses, pnl: m.pnl, grossWin: m.grossWin, grossLoss: m.grossLoss })),
    side: a.side.map(publicBucket), ended: a.ended.map(publicBucket), hold: a.hold.map(publicBucket), instrument: publicInstrumentBuckets(a.instrument),
    weekday: a.weekday.map(publicBucket), hour: a.hour.map(publicBucket),
  };
}

/**
 * Venue accounts become "Account", "Account 2", ... in the order the instance first reported them, and every name
 * one account goes by (its id, key and broker labels) becomes that account's name, so each public route names an
 * account alike. With a single account every label is "Account": one account is often stored under several broker
 * labels over time (a profile rename), and those are not separate accounts. TOTAL keeps its name; a name no account
 * answers to is numbered after them.
 */
export function accountLabeller(accounts: ReadonlyArray<{ key: string; identity: string | null; labels: readonly string[] }>): (name: string) => string {
  const single = accounts.length <= 1;
  const labels = new Map<string, string>();
  accounts.forEach((a, i) => {
    const label = i === 0 ? "Account" : `Account ${i + 1}`;
    for (const n of [a.key, a.identity, ...a.labels]) if (n != null && !labels.has(n)) labels.set(n, label);
  });
  let next = accounts.length;
  return (name) => {
    if (name === "TOTAL") return name;
    if (single) return "Account";
    let label = labels.get(name);
    if (!label) {
      label = next === 0 ? "Account" : `Account ${next + 1}`;
      next++;
      labels.set(name, label);
    }
    return label;
  };
}
