import { describe, it, expect } from "vitest";
import { EnvelopeSchema, parseEnvelope } from "../src/index.js";

const base = { v: 1, instanceId: "qkt-prod", id: "e1", seq: 5, ts: 1718000000000 };

describe("EnvelopeSchema", () => {
  it("accepts a valid trade envelope", () => {
    const env = { ...base, strategyId: "latch", type: "trade",
      payload: { orderId: "o1", symbol: "XAUUSD", side: "BUY", price: 2350.5, qty: 0.1, ts: base.ts } };
    expect(EnvelopeSchema.parse(env).type).toBe("trade");
  });

  it("accepts an order.filled envelope", () => {
    const env = { ...base, type: "order.filled",
      payload: { orderId: "o1", brokerOrderId: "b1", symbol: "XAUUSD", price: 2350.5, qty: 0.1, venueCosts: 0.02 } };
    expect(EnvelopeSchema.parse(env).type).toBe("order.filled");
  });

  it("accepts a snapshot.equity envelope", () => {
    const env = { ...base, strategyId: "latch", type: "snapshot.equity",
      payload: { strategyId: "latch", realized: 10, unrealized: -2, equity: 1008, startingBalance: 1000 } };
    expect(EnvelopeSchema.parse(env).type).toBe("snapshot.equity");
  });

  it("rejects an envelope with a wrong payload for its type", () => {
    const env = { ...base, type: "trade", payload: { nonsense: true } };
    expect(() => EnvelopeSchema.parse(env)).toThrow();
  });

  it("parseEnvelope returns ok=false on malformed input", () => {
    const res = parseEnvelope({ foo: "bar" });
    expect(res.ok).toBe(false);
  });
});

describe("log envelope", () => {
  it("accepts a valid log envelope", () => {
    const env = { ...base, strategyId: "latch", type: "log",
      payload: { level: "WARN", logger: "com.qkt.app.LiveSession", message: "stale symbol XAUUSD" } };
    expect(EnvelopeSchema.parse(env).type).toBe("log");
  });
  it("rejects an unknown log level", () => {
    const env = { ...base, type: "log", payload: { level: "TRACE", logger: "x", message: "m" } };
    expect(() => EnvelopeSchema.parse(env)).toThrow();
  });
});

describe("broker state envelopes", () => {
  it("accepts state.account, state.positions, broker.deal", () => {
    expect(EnvelopeSchema.safeParse({ ...base, type: "state.account", payload: {
      broker: "EXNESS", currency: "USD", balance: 7824.05, equity: 7676.54,
      margin: 540.97, marginFree: 7135.57, openProfit: -147.51, marginLevel: 1419.03,
    } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "state.positions", payload: {
      broker: "EXNESS", positions: [{ ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY",
        qty: 0.01, entryPrice: 2300.5, currentPrice: 2310.2, profit: 9.7, swap: -0.12,
        openedAt: 1781200000000, strategyId: "hedge_straddle" }],
    } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "broker.deal", payload: {
      broker: "EXNESS", dealTicket: "456", positionTicket: "123", orderTicket: "789",
      symbol: "EXNESS:XAUUSD", side: "SELL", entry: "OUT", qty: 0.01, price: 2310.2,
      profit: 9.7, commission: -0.07, swap: -0.12, magic: 10001,
      comment: "dsl-hedge_straddle", ts: 1781201000000, strategyId: "hedge_straddle",
    } }).success).toBe(true);
  });

  it("accepts state.positions with an empty list and null strategyId", () => {
    expect(EnvelopeSchema.safeParse({ ...base, type: "state.positions",
      payload: { broker: "EXNESS", positions: [] } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "broker.deal", payload: {
      broker: "EXNESS", dealTicket: "456", qty: 0.01, price: 2310.2,
      profit: 9.7, ts: 1781201000000, strategyId: null,
    } }).success).toBe(true);
  });

  it("rejects a state.account payload missing equity", () => {
    expect(EnvelopeSchema.safeParse({ ...base, type: "state.account",
      payload: { broker: "EXNESS", currency: "USD", balance: 7824.05 } }).success).toBe(false);
  });
});

describe("trade.closed envelope", () => {
  it("accepts a close with realized pnl", () => {
    const env = { ...base, strategyId: "latch", type: "trade.closed",
      payload: { orderId: "o1", symbol: "XAUUSD", side: "SELL", qty: 0.1, price: 2360, realized: 9.5, ts: base.ts } };
    expect(EnvelopeSchema.parse(env).type).toBe("trade.closed");
  });
  it("rejects a close without realized", () => {
    const env = { ...base, type: "trade.closed",
      payload: { orderId: "o1", symbol: "XAUUSD", side: "SELL", qty: 0.1, price: 2360, ts: base.ts } };
    expect(() => EnvelopeSchema.parse(env)).toThrow();
  });
});
