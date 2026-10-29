import { describe, it, expect } from "vitest";
import { legCosts, tradeStory, tripInstrument } from "./format";

describe("legCosts", () => {
  it("totals a leg's costs and names each kind it booked, funding apart from swap", () => {
    expect(legCosts({ commission: -0.25, swap: 0, funding: -0.9, fee: null })).toEqual({ total: -1.15, parts: "commission −0.25 · funding −0.90" });
    expect(legCosts({ commission: -0.07, swap: -1.2, fee: 0 })).toEqual({ total: -1.27, parts: "commission −0.07 · swap −1.20" });
    expect(legCosts({ commission: null, swap: null, fee: null })).toEqual({ total: 0, parts: "" });
  });
});

describe("tripInstrument", () => {
  it("names the venue only when the round trip carries one", () => {
    expect(tripInstrument({ instrument: "AAPL", venue: "ALPACA" })).toBe("ALPACA:AAPL");
    expect(tripInstrument({ instrument: "XAUUSD", venue: null })).toBe("XAUUSD");
    expect(tripInstrument({ instrument: "XAUUSD" })).toBe("XAUUSD");
  });
});

describe("tradeStory", () => {
  const trip = { status: "closed" as const, entryTs: 1, entryPrice: 1.11879, exitTs: 2, exitPrice: 1.11759, stopPrice: 1.11759, targetPrice: 1.12119, ended: "stop", priceDigits: 5 };

  it("tells a closed trade as opened, its stop and target, and how it closed", () => {
    expect(tradeStory(trip)).toEqual([
      { key: "opened", label: "Opened", ts: 1, price: 1.11879 },
      { key: "protection", label: "Stop", ts: null, price: 1.11759, detail: "target 1.12119" },
      { key: "closed", label: "Hit the stop", ts: 2, price: 1.11759 },
    ]);
  });

  it("leaves out a stop it never had, and says when the trade is still open", () => {
    expect(tradeStory({ ...trip, status: "open", exitTs: null, exitPrice: null, stopPrice: 0, targetPrice: null, ended: null })).toEqual([
      { key: "opened", label: "Opened", ts: 1, price: 1.11879 },
      { key: "open", label: "Still open", ts: null, price: null },
    ]);
    expect(tradeStory({ ...trip, stopPrice: null, ended: null })[1]).toEqual({ key: "protection", label: "Target", ts: null, price: 1.12119, detail: undefined });
    expect(tradeStory({ ...trip, stopPrice: null, targetPrice: null, ended: null })[1]!.label).toBe("Closed");
  });
});
