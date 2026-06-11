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
