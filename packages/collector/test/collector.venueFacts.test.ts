import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  openDb, LiveBus, LiveStateStore, storedRoundTrips, listRoundTrips, rebuildProjection, inferenceCounts, type Db, type RoundTripRow,
} from "@qkt-insights/store";
import { registerCollector } from "../src/index.js";
import { opaqueAccountId } from "@qkt-insights/contract";

/*
 * Golden envelopes of one strategy's two round trips, as three producers send them: qkt stating its
 * venue facts for an MT5 account and for a VGP gateway account, and an older qkt on MT5 that states
 * none. Every figure the dashboard shows must come out the same; the explicit ones without any MT5
 * convention being inferred. Synthetic accounts and prices.
 */

const T0 = Date.UTC(2026, 9, 21, 12);
const S = 1_000;
const M = 60_000;

type Raw = { type: string; ts: number; payload: Record<string, unknown>; strategyId?: string };
let seq = 0;
const ev = (type: string, ts: number, payload: Record<string, unknown>, strategyId?: string): Raw => ({ type, ts, payload, strategyId });

/** Trip 1: a bracket entry closed by its target. Trip 2: an EXIT AFTER entry closed by its timed exit. */
const TRIP1 = { entry: 84_500, stop: 84_400, target: 84_700, exit: 84_700, gross: 2, qty: 0.01 };
const TRIP2 = { entry: 84_600, exit: 84_550, gross: -0.5, qty: 0.01 };
const COMMISSION = 0.05;

interface Venue {
  broker: string; symbol: string; currency: string; accountId: string; venue: Record<string, string>; login: string; server?: string;
  tick: number; deal: (n: number) => string; order: (n: number) => string; position: (n: number) => string;
}

const MT5: Venue = {
  broker: "EXNESS", symbol: "EXNESS:BTCUSD", currency: "USD", accountId: "mt5:1234567@Demo-Server", login: "1234567", server: "Demo-Server",
  venue: { connector: "mt5", adapter: "exness", label: "EXNESS" }, tick: 0.01,
  deal: (n) => `90${n}`, order: (n) => `100${Math.ceil(n / 2)}`, position: (n) => `100${n}`,
};
const VGP: Venue = {
  broker: "PAPER_DERIBIT", symbol: "PAPER_DERIBIT:BTC_USDC_PERPETUAL", currency: "USD", accountId: "vgp:paper:paper", login: "paper",
  venue: { connector: "vgp", adapter: "paper", label: "PAPER_DERIBIT" }, tick: 0.1,
  deal: (n) => `paper-${n}`, order: (n) => `paper-o-${n}`, position: (n) => `PAPER_DERIBIT:BTC_USDC_PERPETUAL#${T0 + (n - 1) * 10 * M}`,
};
const instrumentOf = (v: Venue) => ({ symbol: v.symbol, venueCode: v === MT5 ? "BTCUSDm" : "BTC_USDC-PERPETUAL", kind: v === MT5 ? "cfd" : "perpetual",
  contractSize: 1, tickSize: v.tick, quoteCurrency: "USD", valuePerPoint: 1 });

/** The engine events and venue deals of both trips, stating every fact qkt now sends. */
function explicit(v: Venue, strategy: string): Raw[] {
  const venueFacts = { venue: v.venue, accountId: v.accountId };
  const instrument = instrumentOf(v);
  const out: Raw[] = [];
  const trip = (n: 1 | 2, t0: number) => {
    const t = n === 1 ? TRIP1 : TRIP2;
    const pos = v.position(n);
    const entryId = `dsl-${strategy}--${n}`;
    const exitId = n === 1 ? `dsl-${strategy}--${n}-bracket-tp` : `dsl-${strategy}--${n}-exit-close`;
    const reason = n === 1 ? "TAKE_PROFIT" : "TIMED";
    const bracket = n === 1 ? { initialStop: TRIP1.stop, initialTarget: TRIP1.target, riskAmount: 1 } : {};
    out.push(ev("order.submit", t0, { orderId: entryId, orderType: n === 1 ? "Bracket" : "Market", symbol: v.symbol, side: "BUY", qty: t.qty }, strategy));
    out.push(ev("order.filled", t0 + S, {
      orderId: entryId, brokerOrderId: v.order(2 * n - 1), symbol: v.symbol, price: t.entry, qty: t.qty, venueCosts: COMMISSION,
      strategyId: strategy, attribution: "order", positionId: pos, legEntry: "IN", ...bracket, instrument,
    }, strategy));
    out.push(ev("order.filled", t0 + 2 * M, {
      orderId: exitId, brokerOrderId: v.order(2 * n), symbol: v.symbol, price: t.exit, qty: t.qty, venueCosts: COMMISSION,
      ...(n === 1 ? { exitReason: "TAKE_PROFIT" } : {}),
      strategyId: strategy, attribution: "order", positionId: pos, legEntry: "OUT", closeReason: reason, instrument,
    }, strategy));
    out.push(ev("trade.closed", t0 + 2 * M, {
      orderId: exitId, symbol: v.symbol, side: "SELL", qty: t.qty, price: t.exit, realized: t.gross - 2 * COMMISSION, ts: t0 + 2 * M,
      strategyId: strategy, attribution: "order", positionId: pos, legEntry: "OUT", closeReason: reason,
    }, strategy));
    const deal = (k: number, entry: "IN" | "OUT", ts: number, price: number, profit: number, comment: string, how: string) => ev("broker.deal", ts, {
      broker: v.broker, dealTicket: v.deal(k), positionTicket: pos, orderTicket: v.order(k), symbol: v.symbol, side: entry === "IN" ? "BUY" : "SELL",
      entry, qty: t.qty, price, profit,
      // qkt repeats the typed costs in the scalars (MT5 sign: negative when paid)
      commission: -COMMISSION, swap: 0, comment, ts, strategyId: strategy,
      positionId: pos, legEntry: entry, ...(entry === "OUT" ? { closeReason: reason } : {}),
      costs: [{ kind: "COMMISSION", amount: COMMISSION, currency: v.currency }],
      realizedSource: v === MT5 ? "venue" : "engine", attribution: how, instrument, ...venueFacts,
    });
    out.push(deal(2 * n - 1, "IN", t0 + S, t.entry, 0, v === MT5 ? `dsl-${strategy}--${n}` : `${strategy}.k1`, "order"));
    out.push(deal(2 * n, "OUT", t0 + 2 * M, t.exit, t.gross, v === MT5 && n === 1 ? `[tp ${TRIP1.target}]` : "", "position"));
  };
  trip(1, T0);
  trip(2, T0 + 10 * M);
  return out;
}

/** The same trips as a qkt that states no venue fact sends them for an MT5 account. */
function legacyMt5(strategy: string): Raw[] {
  const v = MT5;
  const out: Raw[] = [];
  const trip = (n: 1 | 2, t0: number) => {
    const t = n === 1 ? TRIP1 : TRIP2;
    const pos = v.position(n);
    const entryId = `dsl-${strategy}--${n}`;
    out.push(ev("order.submit", t0, {
      orderId: entryId, orderType: n === 1 ? "Bracket" : "Market", symbol: v.symbol, side: "BUY", qty: t.qty,
      ...(n === 1 ? { stopLoss: { type: "Fixed", price: TRIP1.stop }, takeProfit: TRIP1.target } : {}),
    }, strategy));
    out.push(ev("order.accepted", t0 + S / 2, { orderId: entryId, brokerOrderId: pos }, strategy));
    out.push(ev("order.filled", t0 + S, { orderId: entryId, brokerOrderId: pos, symbol: v.symbol, price: t.entry, qty: t.qty, venueCosts: COMMISSION }, strategy));
    if (n === 2) out.push(ev("order.submit", t0 + 2 * M - S, { orderId: `${entryId}-exit-close`, orderType: "Market", symbol: v.symbol, side: "SELL", qty: t.qty, closesTicket: pos }, strategy));
    out.push(ev("order.filled", t0 + 2 * M, { orderId: n === 1 ? `${entryId}-tp` : `${entryId}-exit-close`, brokerOrderId: pos, symbol: v.symbol,
      price: t.exit, qty: t.qty, venueCosts: COMMISSION, exitReason: n === 1 ? "TAKE_PROFIT" : "CLOSE" }, strategy));
    out.push(ev("trade.closed", t0 + 2 * M, { orderId: `${entryId}-x`, symbol: v.symbol, side: "SELL", qty: t.qty, price: t.exit,
      realized: t.gross - 2 * COMMISSION, ts: t0 + 2 * M }, strategy));
    const deal = (k: number, entry: "IN" | "OUT", ts: number, price: number, profit: number, comment: string) => ev("broker.deal", ts, {
      broker: v.broker, dealTicket: v.deal(k), positionTicket: pos, orderTicket: entry === "IN" ? pos : `200${k}`, symbol: v.symbol,
      side: entry === "IN" ? "BUY" : "SELL", entry, qty: t.qty, price, profit, commission: -COMMISSION, swap: 0, comment, ts,
      ...(entry === "IN" ? { strategyId: strategy } : {}),
    });
    out.push(deal(2 * n - 1, "IN", t0 + S, t.entry, 0, `dsl-${strategy}--${n}`));
    out.push(deal(2 * n, "OUT", t0 + 2 * M, t.exit, t.gross, n === 1 ? `[tp ${TRIP1.target}]` : ""));
  };
  trip(1, T0);
  trip(2, T0 + 10 * M);
  return out;
}

/** The account and its open position while trip 1 is held, stated or not. */
function state(v: Venue, strategy: string, stated: boolean): Raw[] {
  const facts = stated ? { venue: v.venue, accountId: v.accountId } : {};
  const pos = v.position(1);
  return [
    ev("state.account", T0 + 30 * S, { broker: v.broker, currency: v.currency, balance: 10_000, equity: 10_001, login: v.login,
      ...(v.server ? { server: v.server } : {}), ...facts }),
    ev("state.positions", T0 + 30 * S, { broker: v.broker, positions: [{
      ticket: pos, symbol: v.symbol, side: "BUY", qty: TRIP1.qty, entryPrice: TRIP1.entry, currentPrice: TRIP1.entry + 100, profit: 1,
      strategyId: strategy, openedAt: T0 + S,
      ...(stated ? { positionId: pos, attribution: "order", initialStop: TRIP1.stop, initialTarget: TRIP1.target, riskAmount: 1, instrument: instrumentOf(v) } : {}),
    }], ...facts }),
  ];
}

let app: FastifyInstance;
let db: Db;
let liveState: LiveStateStore;
beforeEach(async () => {
  db = openDb(":memory:");
  liveState = new LiveStateStore();
  app = Fastify();
  registerCollector(app, { db, bus: new LiveBus(), liveState, ingestToken: "secret-token" });
  await app.ready();
});
afterEach(async () => { await app.close(); });

async function post(instanceId: string, events: Raw[]): Promise<void> {
  const res = await app.inject({
    method: "POST", url: "/ingest", headers: { authorization: "Bearer secret-token" },
    payload: { instanceId, events: events.map((e) => ({ v: 1, instanceId, id: `${instanceId}-${seq}`, seq: seq++, ...e })) },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ accepted: expect.any(Number) });
  expect(db.prepare("SELECT reason FROM quarantined_events").all()).toEqual([]);
}

/** What the dashboard shows of a round trip, without the venue's own ids. */
const shape = (r: RoundTripRow) => ({
  strategyId: r.strategyId, side: r.side, entryPrice: r.entryPrice, exitPrice: r.exitPrice, qty: r.qty, realized: r.realized, gross: r.gross,
  commission: r.commission, swap: r.swap, fee: r.fee, ended: r.ended, stopPrice: r.stopPrice, targetPrice: r.targetPrice,
  entryOrderId: r.entryOrderId, holdMs: r.holdMs, open: r.open, source: r.source, legs: r.legs,
});
const trips = (instanceId: string) => storedRoundTrips(db, { instanceId }).sort((a, b) => (a.entryTs ?? 0) - (b.entryTs ?? 0));
const listed = (instanceId: string) => listRoundTrips(db, { instanceId, sort: "entry", dir: "asc" }).rows
  .map((r) => ({ ended: r.ended, risk: r.risk, r: r.r, pnl: r.pnl, priceDigits: r.priceDigits }));

const EXPECTED = [
  { strategyId: "alpha", side: "long", entryPrice: TRIP1.entry, exitPrice: TRIP1.exit, qty: 0.01, realized: 1.9, gross: 2, commission: -0.1, swap: 0, fee: 0,
    ended: "tp", stopPrice: TRIP1.stop, targetPrice: TRIP1.target, entryOrderId: "dsl-alpha--1", holdMs: 2 * M - S, open: false, source: "deal", legs: 2 },
  { strategyId: "alpha", side: "long", entryPrice: TRIP2.entry, exitPrice: TRIP2.exit, qty: 0.01, realized: -0.6, gross: -0.5, commission: -0.1, swap: 0, fee: 0,
    ended: "signal", stopPrice: null, targetPrice: null, entryOrderId: "dsl-alpha--2", holdMs: 2 * M - S, open: false, source: "deal", legs: 2 },
];

describe("venue facts: one shape for every connector", () => {
  it("an MT5 account with facts, the same account from an older qkt, and a VGP account give the same round trips", async () => {
    await post("mt5", [...state(MT5, "alpha", true), ...explicit(MT5, "alpha")]);
    await post("legacy", [...state(MT5, "alpha", false), ...legacyMt5("alpha")]);
    await post("vgp", [...state(VGP, "alpha", true), ...explicit(VGP, "alpha")]);
    for (const instance of ["mt5", "legacy", "vgp"]) expect(trips(instance).map(shape), instance).toEqual(EXPECTED);
    expect(trips("mt5").map((r) => [r.closeReason, r.riskAmount])).toEqual([["TAKE_PROFIT", 1], ["TIMED", null]]);
    expect(trips("vgp").map((r) => [r.closeReason, r.riskAmount])).toEqual([["TAKE_PROFIT", 1], ["TIMED", null]]);
    expect(trips("legacy").map((r) => [r.closeReason, r.riskAmount])).toEqual([[null, null], [null, null]]);
    // R and risk: stated by qkt, else inferred from the venue's gross over the move; the same here.
    const lists = ["mt5", "legacy", "vgp"].map(listed);
    for (const l of lists) expect(l.map(({ ended, risk, r, pnl }) => ({ ended, risk, r, pnl }))).toEqual([
      { ended: "tp", risk: 1, r: 1.9, pnl: 1.9 }, { ended: "signal", risk: null, r: null, pnl: -0.6 },
    ]);
    // the stated tick wins over the prices' decimals: BTCUSD 0.01, the perpetual 0.1
    expect(listed("mt5").map((r) => r.priceDigits)).toEqual([2, 2]);
    expect(listed("vgp").map((r) => r.priceDigits)).toEqual([1, 1]);
  });

  it("states one account and its positions the same way for both connectors", async () => {
    await post("mt5", state(MT5, "alpha", true));
    await post("legacy", state(MT5, "alpha", false));
    await post("vgp", state(VGP, "alpha", true));
    const snap = liveState.snapshot(T0 + 31 * S);
    const account = (i: string) => snap.accounts.filter((a) => a.instanceId === i).map((a) => ({ broker: a.broker, accountId: a.accountId }));
    expect(account("mt5")).toEqual([{ broker: "EXNESS", accountId: opaqueAccountId(MT5.accountId) }]);
    expect(account("legacy")).toEqual([{ broker: "EXNESS", accountId: opaqueAccountId(MT5.accountId) }]);
    expect(account("vgp")).toEqual([{ broker: "PAPER_DERIBIT", accountId: opaqueAccountId(VGP.accountId) }]);
    const position = (i: string) => snap.positions.filter((g) => g.instanceId === i).flatMap((g) => g.list.map((p) => ({
      broker: g.broker, strategyId: p.strategyId, positionId: p.positionId, initialStop: p.initialStop, riskAmount: p.riskAmount,
    })));
    expect(position("mt5")).toEqual([{ broker: "EXNESS", strategyId: "alpha", positionId: "1001", initialStop: TRIP1.stop, riskAmount: 1 }]);
    expect(position("vgp")).toEqual([{ broker: "PAPER_DERIBIT", strategyId: "alpha", positionId: VGP.position(1), initialStop: TRIP1.stop, riskAmount: 1 }]);
    expect(position("legacy")).toEqual([{ broker: "EXNESS", strategyId: "alpha", positionId: undefined, initialStop: undefined, riskAmount: undefined }]);
    liveState.flushRollup(db, T0 + 31 * S);
    expect(db.prepare("SELECT instance_id i, broker, account FROM account_equity ORDER BY i").all()).toEqual([
      { i: "legacy", broker: "EXNESS", account: opaqueAccountId(MT5.accountId) }, { i: "mt5", broker: "EXNESS", account: opaqueAccountId(MT5.accountId) },
      { i: "vgp", broker: "PAPER_DERIBIT", account: opaqueAccountId(VGP.accountId) },
    ]);
  });

  it("infers nothing from MT5 conventions for envelopes that state their facts", async () => {
    const before = inferenceCounts();
    await post("mt5", [...state(MT5, "alpha", true), ...explicit(MT5, "alpha")]);
    await post("vgp", [...state(VGP, "alpha", true), ...explicit(VGP, "alpha")]);
    // another tool's trade on the account: qkt sends it unattributed, with its facts but no fill of this instance
    const foreign = { broker: MT5.broker, positionTicket: "7001", positionId: "7001", orderTicket: "7001", symbol: MT5.symbol, qty: 0.01,
      commission: 0, swap: 0, attribution: "none", venue: MT5.venue, accountId: MT5.accountId, costs: [], realizedSource: "venue" };
    await post("mt5", [
      ev("broker.deal", T0 + 40 * M, { ...foreign, dealTicket: "8001", side: "BUY", entry: "IN", legEntry: "IN", price: 1, profit: 0, comment: "dsl-other--0", ts: T0 + 40 * M }),
      ev("broker.deal", T0 + 41 * M, { ...foreign, dealTicket: "8002", side: "SELL", entry: "OUT", legEntry: "OUT", price: 2, profit: 0.01, comment: "[sl 2]",
        closeReason: "SIGNAL", ts: T0 + 41 * M }),
    ]);
    expect(trips("mt5").find((r) => r.positionTicket === "7001")).toMatchObject({ strategyId: null, entryOrderId: null, ended: "signal", stopPrice: null });
    trips("mt5"); trips("vgp"); listed("mt5"); listed("vgp");
    liveState.snapshot(T0 + 31 * S);
    expect(inferenceCounts()).toEqual(before);
    await post("legacy", [...state(MT5, "alpha", false), ...legacyMt5("alpha")]);
    trips("legacy");
    const after = inferenceCounts();
    for (const kind of ["login-server-account", "deal-comment-ended", "engine-events-ended", "ticket-entry-order"])
      expect(after[kind] ?? 0, kind).toBeGreaterThan(before[kind] ?? 0);
  });

  it("counts typed costs once: the scalars that repeat them are not added", async () => {
    await post("vgp", explicit(VGP, "alpha"));
    const deals = db.prepare("SELECT entry, commission, swap, fee, close_reason r, realized_source s, account_id a FROM deals ORDER BY ts").all();
    expect(deals).toEqual([
      { entry: "IN", commission: -0.05, swap: 0, fee: 0, r: null, s: "engine", a: opaqueAccountId(VGP.accountId) },
      { entry: "OUT", commission: -0.05, swap: 0, fee: 0, r: "TAKE_PROFIT", s: "engine", a: opaqueAccountId(VGP.accountId) },
      { entry: "IN", commission: -0.05, swap: 0, fee: 0, r: null, s: "engine", a: opaqueAccountId(VGP.accountId) },
      { entry: "OUT", commission: -0.05, swap: 0, fee: 0, r: "TIMED", s: "engine", a: opaqueAccountId(VGP.accountId) },
    ]);
    // funding and exchange fees land in swap and fee
    await post("vgp", [ev("broker.deal", T0 + 30 * M, { broker: VGP.broker, dealTicket: "paper-9", positionTicket: "P9", positionId: "P9", symbol: VGP.symbol,
      side: "SELL", entry: "OUT", legEntry: "OUT", qty: 0.01, price: 1, profit: 3, commission: -1, swap: -2, fee: -0.5, ts: T0 + 30 * M,
      costs: [{ kind: "COMMISSION", amount: 1 }, { kind: "FUNDING", amount: 2 }, { kind: "EXCHANGE_FEE", amount: 0.25 }, { kind: "TAX", amount: 0.25 }] })]);
    expect(db.prepare("SELECT commission, swap, fee FROM deals WHERE deal_ticket='paper-9'").get()).toEqual({ commission: -1, swap: -2, fee: -0.5 });
  });

  it("maps every stated close reason to how the round trip ended", async () => {
    const reasons = { STOP: "stop", TAKE_PROFIT: "tp", SIGNAL: "signal", TIMED: "signal", MANUAL: "manual", STOP_OUT: "so", LIQUIDATION: "so", EXPIRY: "so" };
    const events: Raw[] = [];
    Object.keys(reasons).forEach((reason, i) => {
      const pos = `R${i}`;
      const t = T0 + i * 10 * M;
      const base = { broker: VGP.broker, positionTicket: pos, positionId: pos, symbol: VGP.symbol, qty: 1, price: 100, commission: 0, swap: 0, strategyId: "alpha" };
      events.push(ev("broker.deal", t, { ...base, dealTicket: `${pos}-in`, side: "BUY", entry: "IN", legEntry: "IN", profit: 0, ts: t, costs: [] }));
      // a stated reason wins over the venue comment and the engine events
      events.push(ev("broker.deal", t + M, { ...base, dealTicket: `${pos}-out`, side: "SELL", entry: "OUT", legEntry: "OUT", profit: 1, ts: t + M,
        closeReason: reason, comment: "[sl 99]", costs: [] }));
    });
    await post("vgp", events);
    const ended = Object.fromEntries(trips("vgp").map((r) => [r.closeReason, r.ended]));
    expect(ended).toEqual(reasons);
  });
});

describe("mixed instance: deal-backed and engine-ledger round trips per broker", () => {
  const ledgerOnly = (strategy: string, symbol: string, n: number): Raw[] => Array.from({ length: n }, (_, i) =>
    ev("trade.closed", T0 + i * 10 * M + 2 * M, { orderId: `dsl-${strategy}--${i}-exit-close`, symbol, side: "SELL", qty: 0.01, price: 84_500,
      realized: -0.25, ts: T0 + i * 10 * M + 2 * M }, strategy));

  it("keeps a venue's engine closes when another broker of the instance stores deals, in either order", async () => {
    // an older qkt: the gateway strategy has engine closes only, the MT5 strategy has deals too
    await post("mixed", ledgerOnly("e2e_vgp", VGP.symbol, 3));
    await post("mixed", legacyMt5("e2e_mt5"));
    await post("mixed", ledgerOnly("e2e_vgp", VGP.symbol, 4).slice(3));
    const bySource = () => db.prepare(
      "SELECT strategy_id s, source, COUNT(*) n, ROUND(SUM(realized), 2) net FROM round_trips WHERE instance_id='mixed' GROUP BY 1, 2 ORDER BY 1",
    ).all();
    // e2e_mt5's own engine closes are its deals' positions; e2e_vgp's are its round trips
    expect(bySource()).toEqual([
      { s: "e2e_mt5", source: "deal", n: 2, net: 1.3 },
      { s: "e2e_vgp", source: "ledger", n: 4, net: -1 },
    ]);
    rebuildProjection(db, "closed_trades", { force: true });
    expect(bySource()).toEqual([
      { s: "e2e_mt5", source: "deal", n: 2, net: 1.3 },
      { s: "e2e_vgp", source: "ledger", n: 4, net: -1 },
    ]);
  });

  it("replaces a venue's engine closes with its positions once its deals arrive", async () => {
    await post("mixed", [...legacyMt5("e2e_mt5"), ...ledgerOnly("e2e_vgp", VGP.symbol, 2)]);
    await post("mixed", explicit(VGP, "e2e_vgp"));
    expect(db.prepare("SELECT strategy_id s, source, COUNT(*) n FROM round_trips WHERE instance_id='mixed' GROUP BY 1, 2 ORDER BY 1").all()).toEqual([
      { s: "e2e_mt5", source: "deal", n: 2 },
      { s: "e2e_vgp", source: "deal", n: 2 },
    ]);
  });

  it("states the ledger trip's close reason", async () => {
    await post("paper", [ev("trade.closed", T0, { orderId: "x-sl", symbol: "PAPER:BTCUSD", side: "SELL", qty: 1, price: 1, realized: -1, ts: T0,
      closeReason: "STOP", positionId: "PAPER:BTCUSD#1", legEntry: "OUT" }, "alpha")]);
    expect(trips("paper").map((r) => [r.source, r.ended, r.closeReason])).toEqual([["ledger", "stop", "STOP"]]);
  });
});
