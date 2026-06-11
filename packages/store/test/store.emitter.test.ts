import { describe, it, expect } from "vitest";
import { LiveBus } from "../src/index.js";
import type { Envelope } from "@qkt-insights/contract";

describe("LiveBus", () => {
  it("delivers published envelopes to subscribers and supports unsubscribe", () => {
    const bus = new LiveBus();
    const got: Envelope[] = [];
    const off = bus.subscribe((e) => got.push(e));
    const e = { v: 1, instanceId: "qkt-prod", id: "1", seq: 1, ts: 1, type: "trade",
      payload: { orderId: "o", symbol: "X", side: "BUY", price: 1, qty: 1, ts: 1 } } as Envelope;
    bus.publish(e);
    off();
    bus.publish(e);
    expect(got).toHaveLength(1);
  });
});
