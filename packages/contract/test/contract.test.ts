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


describe("enriched qkt payloads", () => {
  it("accepts sink health and global risk payloads", () => {
    const health = EnvelopeSchema.parse({ ...base, type: "insights.health",
      payload: { sent: 10, failed: 1, dropped: 2, queued: 3, queueCapacity: 100, batchSize: 50 } });
    expect(health.payload.dropped).toBe(2);

    expect(EnvelopeSchema.parse({ ...base, type: "risk.halted",
      payload: { reason: "operator" } }).payload).toMatchObject({ reason: "operator" });
    expect(EnvelopeSchema.parse({ ...base, type: "risk.resumed", payload: {} }).type).toBe("risk.resumed");
  });

  it("accepts strategy lifecycle payloads", () => {
    expect(EnvelopeSchema.parse({ ...base, strategyId: "hedge_straddle", type: "strategy.started",
      payload: {
        strategyId: "hedge_straddle",
        ts: base.ts,
        deployName: "prod-hedge",
        sourcePath: "/srv/qkt/strategies/hedge.qkt",
        sourceSha256: "abc123",
        dslVersion: 1,
        runtimeMode: "live",
        brokers: ["exness"],
        symbols: ["EXNESS:XAUUSD"],
        streams: [{ alias: "gold", qktSymbol: "EXNESS:XAUUSD", timeframe: "M1" }],
        params: { risk: 0.01 },
        defaults: { tif: "Gtc" },
        risk: { maxOrderQty: 1 },
      } }).type).toBe("strategy.started");
    expect(EnvelopeSchema.parse({ ...base, strategyId: "hedge_straddle", type: "strategy.stopped",
      payload: { strategyId: "hedge_straddle", flatten: false, ts: base.ts } }).type).toBe("strategy.stopped");
  });

  it("accepts enriched signal and order payloads without stripping additive fields", () => {
    const signal = EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "signal",
      payload: { intent: "BUY", symbol: "XAUUSD", side: "BUY", qty: 0.25, extraContext: "rule-1" } });
    expect(signal.payload.qty).toBe(0.25);
    expect((signal.payload as any).extraContext).toBe("rule-1");

    const order = EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "order.submit",
      payload: { orderId: "br1", orderType: "Bracket", symbol: "XAUUSD", side: "BUY", qty: 0.1,
        strategyId: "latch", timeInForce: "GTC", createdTs: base.ts, takeProfit: 2360,
        stopLoss: { type: "Fixed", price: 2340 }, stopLossAst: { type: "By", distance: { type: "NumLit", value: 10 } },
        entry: { orderId: "entry", orderType: "Market", symbol: "XAUUSD", side: "BUY", qty: 0.1 } } });
    expect((order.payload as any).timeInForce).toBe("GTC");
    expect((order.payload as any).stopLoss.price).toBe(2340);

    const stack = EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "order.submit",
      payload: { orderId: "stk1", orderType: "Stack", symbol: "XAUUSD", side: "BUY", qty: 0.3,
        layers: 2, withinMillis: 60000, hasOuterBracket: true,
        stackLayers: [
          { index: 0, sizing: { type: "SizeQty", expr: { type: "NumLit", value: 0.1 } }, orderType: { type: "Market" }, trigger: { type: "Immediate" }, resolvedQuantity: 0.1 },
          { index: 1, sizing: { type: "SizeQty", expr: { type: "NumLit", value: 0.2 } }, orderType: { type: "Limit", price: { type: "NumLit", value: 2345 } }, trigger: { type: "At", direction: "BELOW", price: { type: "NumLit", value: 2345 } }, resolvedQuantity: 0.2 },
        ],
        outerBracket: { takeProfit: { type: "Rr", multiplier: { type: "NumLit", value: 2 } }, stopLoss: { type: "By", distance: { type: "NumLit", value: 10 } } } } });
    expect((stack.payload as any).stackLayers).toHaveLength(2);

    const modified = EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "order.modified",
      payload: { orderId: "br1", brokerOrderId: "venue-1", changes: { newQuantity: 0.2, newLimitPrice: 2355.5 } } });
    expect((modified.payload as any).changes.newLimitPrice).toBe(2355.5);
  });

  it("accepts qkt causal decision and fill-accounting payloads", () => {
    expect(EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "decision.rule_evaluated",
      payload: {
        decisionId: "decision-1",
        ruleId: "latch#0",
        strategyFingerprint: "a".repeat(64),
        ruleFingerprint: "b".repeat(64),
        conditionFingerprint: "c".repeat(64),
        conditionResult: true,
        alias: "asset1",
        broker: "EXNESS",
        timeframe: "1m",
        signalCount: 1,
        candle: {
          symbol: "EXNESS:EURUSD",
          startTimeMs: base.ts - 60_000,
          endTimeMs: base.ts,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        },
      } }).type).toBe("decision.rule_evaluated");
    expect(EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "decision.order_linked",
      payload: { decisionId: "decision-1", ruleId: "latch#0", signalIndex: 0, orderId: "o1" } }).type)
      .toBe("decision.order_linked");
    expect(EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "fill.accounted",
      payload: {
        orderId: "o1",
        symbol: "EXNESS:EURUSD",
        fillSliceId: "o1:1",
        sourceFillSequenceId: 1,
        cumulativeFilled: 0.01,
        modeledCommissionAccount: 0,
        venueCostsAccount: 0,
        totalCostsAccount: 0,
        accountNativeRealized: 0,
        strategyNativeRealized: 0,
        nativeCurrency: "USD",
        grossAccountRealized: 0,
        grossStrategyAccountRealized: 0,
        accountCurrency: "USD",
        netAccountRealized: 0,
        netStrategyAccountRealized: 0,
      } }).type).toBe("fill.accounted");
  });

  it("accepts qkt bot close audit payloads", () => {
    expect(EnvelopeSchema.parse({ ...base, strategyId: "manual", type: "bot.close",
      payload: {
        symbol: "EXNESS:EURUSD",
        ticket: "3073111647",
        ok: "true",
        deal: "2525951538",
        price: "1.1540700000000002",
      } }).type).toBe("bot.close");
  });

  it("accepts cancel and latch signal variants", () => {
    expect(EnvelopeSchema.parse({ ...base, type: "signal.cancel",
      payload: { intent: "CANCEL_PENDING_FOR_SYMBOL", symbol: "XAUUSD" } }).type).toBe("signal.cancel");
    expect(EnvelopeSchema.parse({ ...base, strategyId: "latch", type: "signal.latch_armed",
      payload: { intent: "ARM_LATCH", reference: "close", offset: "0.5", streamAlias: "gold", armWindowMs: 60000, expiresAt: 1718000060000 } }).type).toBe("signal.latch_armed");
  });

  it("accepts broker and marketdata lifecycle payloads", () => {
    expect(EnvelopeSchema.safeParse({ ...base, type: "broker.connected",
      payload: { broker: "EXNESS", state: "connected", reason: "session-start", ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "broker.disconnected",
      payload: { broker: "EXNESS", state: "disconnected", reason: "gateway-unreachable", consecutiveFailures: 3, ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "broker.reconnected",
      payload: { broker: "EXNESS", state: "reconnected", reason: "gateway-recovered", consecutiveFailures: 4, ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "marketdata.connected",
      payload: { source: "tradingview", symbols: ["XAUUSD"], state: "connected", reason: "session-start", ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "marketdata.disconnected",
      payload: { source: "tradingview", symbols: ["XAUUSD"], state: "disconnected", reason: "source-disconnected", ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "marketdata.reconnected",
      payload: { source: "tradingview", symbols: ["XAUUSD"], state: "reconnected", reason: "source-reconnected", ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "marketdata.stale",
      payload: { source: "Composite", symbols: ["EXNESS:XAUUSD"], state: "stale", reason: "quote age exceeded threshold", ts: base.ts } }).success).toBe(true);
  });

  it("accepts durable position risk and portfolio projection payloads", () => {
    expect(EnvelopeSchema.safeParse({ ...base, type: "position.valued",
      payload: { broker: "EXNESS", ticket: "123", symbol: "EXNESS:XAUUSD", side: "BUY", qty: 0.01,
        entryPrice: 2300.5, currentPrice: 2310.2, profit: 9.7, strategyId: "hedge" } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, strategyId: "hedge", type: "risk.snapshot",
      payload: { strategyId: "hedge", equity: 980, dailyLoss: 20 } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "portfolio.configured",
      payload: { portfolioId: "book", strategies: ["hedge"], ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "portfolio.allocation.updated",
      payload: { portfolioId: "book", allocations: [{ strategyId: "hedge", weight: 1 }], ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "portfolio.exposure.updated",
      payload: { portfolioId: "book", gross: 1000, net: 100, ts: base.ts } }).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, type: "portfolio.equity.updated",
      payload: { portfolioId: "book", equity: 1010, realized: 10, unrealized: 0, ts: base.ts } }).success).toBe(true);
  });
});
