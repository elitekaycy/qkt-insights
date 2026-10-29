import { describe, expect, it } from "vitest";
import type { LiveAccount } from "./api";
import { GLOSSARY, INSTRUMENT_TYPE_KEYS, legLabel, sizeInWords, strategyLegs, TYPE_LABEL } from "./instruments";

const NOW = Date.UTC(2026, 9, 29);

describe("sizeInWords", () => {
  it("says what a size is for each type", () => {
    expect(sizeInWords(2, { kind: "equity" })).toBe("2 shares");
    expect(sizeInWords(1, { kind: "equity" })).toBe("1 share");
    expect(sizeInWords(0.01, { kind: "cfd", category: "Stocks", contractSize: 100 })).toBe("0.01 lot = 1 share");
    expect(sizeInWords(0.5, { kind: "cfd", category: "Stocks", contractSize: 100 })).toBe("0.5 lot = 50 shares");
    expect(sizeInWords(2, { kind: "cfd", category: "Metals", contractSize: 100 })).toBe("2 lots");
    expect(sizeInWords(10, { kind: "perpetual", contractSize: 0.001 })).toBe("10 contracts × 0.001");
    expect(sizeInWords(1, { kind: "option", contractSize: 1 })).toBe("1 contract");
    expect(sizeInWords(0.3, { kind: "spot", unit: "BTC" })).toBe("0.3 BTC");
    expect(sizeInWords(3, { kind: "spot", unit: "coins" })).toBe("3 coins");
    expect(sizeInWords(0.7, {})).toBe("0.7");
  });
});

describe("strategy legs", () => {
  const accounts = [{ instanceId: "i", broker: "EXNESS_O1", connector: "mt5", adapter: "exness", profiles: ["EXNESS_O1", "EXNESS_O2"] }] as LiveAccount[];

  it("names each leg's type, instrument and venue from qkt's stream facts", () => {
    const legs = strategyLegs({
      metadata: { streams: [
        { alias: "a", broker: "EXNESS_O2", symbol: "AAPL", qktSymbol: "EXNESS_O2:AAPL", instrument: { kind: "cfd", category: "Stocks" } },
        { alias: "b", broker: "DERIBIT", symbol: "BTC-29NOV26-70000-C", qktSymbol: "DERIBIT:BTC-29NOV26-70000-C",
          instrument: { kind: "option", strike: 70000, optionRight: "call", expiry: Date.UTC(2026, 10, 29, 8), underlying: "btc_usdc" },
          venue: { connector: "vgp", adapter: "deribit", label: "DERIBIT" } },
        { alias: "c", broker: "ALPACA", symbol: "AAPL", qktSymbol: "ALPACA:AAPL", instrument: { kind: "equity" }, venue: { connector: "vgp", adapter: "alpaca" } },
        { alias: "d", broker: "DERIBIT", symbol: "BTC-PERPETUAL", qktSymbol: "DERIBIT:BTC-PERPETUAL", instrument: { kind: "perpetual" }, venue: { connector: "vgp", adapter: "deribit" } },
        { alias: "e", broker: "ALPACA", symbol: "BTCUSD", qktSymbol: "ALPACA:BTCUSD", instrument: { kind: "spot" }, venue: { connector: "vgp", adapter: "alpaca" } },
      ] },
      instruments: [],
    }, accounts, "i");
    expect(legs.map((l) => legLabel(l, NOW))).toEqual([
      "Stock CFD · AAPL · Exness",
      "Option · BTC 70000 call, 29 Nov · Deribit",
      "Share · AAPL · Alpaca",
      "Perpetual future · BTC-PERPETUAL · Deribit",
      "Coin (spot) · BTCUSD · Alpaca",
    ]);
  });

  it("falls back to what the strategy's deals state, and to nothing it cannot know", () => {
    const legs = strategyLegs({
      metadata: { streams: [{ alias: "g", broker: "EXNESS_O1", symbol: "XAUUSD", qktSymbol: "EXNESS_O1:XAUUSD" }] },
      instruments: [
        { symbol: "EXNESS_O1:XAUUSD", broker: "EXNESS_O1", kind: "cfd", category: "Metals", contractSize: 100, unit: "lots" },
        { symbol: "OTHER:EURUSD", broker: "OTHER", kind: "cfd", category: null, contractSize: null, unit: "lots" },
      ],
    }, accounts, "i");
    expect(legs.map((l) => legLabel(l, NOW))).toEqual(["CFD · XAUUSD · Exness", "CFD · EURUSD"]);
    expect(strategyLegs({ metadata: { streams: [{ broker: "X", symbol: "Y", qktSymbol: "X:Y" }] } }, [], "i").map((l) => legLabel(l, NOW))).toEqual(["Y"]);
    expect(strategyLegs(null)).toEqual([]);
  });
});

describe("glossary", () => {
  it("explains every type it labels", () => {
    for (const t of INSTRUMENT_TYPE_KEYS) {
      expect(TYPE_LABEL[t]).toBeTruthy();
      expect(GLOSSARY[t].text.length).toBeGreaterThan(40);
    }
    expect(GLOSSARY.funding.text).toMatch(/longs/);
  });
});
