import { describe, it, expect } from "vitest";
import { legCosts, tripInstrument } from "./format";

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
