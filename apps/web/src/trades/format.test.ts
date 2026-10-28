import { describe, it, expect } from "vitest";
import { tripInstrument } from "./format";

describe("tripInstrument", () => {
  it("names the venue only when the round trip carries one", () => {
    expect(tripInstrument({ instrument: "AAPL", venue: "ALPACA" })).toBe("ALPACA:AAPL");
    expect(tripInstrument({ instrument: "XAUUSD", venue: null })).toBe("XAUUSD");
    expect(tripInstrument({ instrument: "XAUUSD" })).toBe("XAUUSD");
  });
});
