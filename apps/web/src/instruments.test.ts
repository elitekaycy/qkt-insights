import { describe, expect, it } from "vitest";
import { INSTRUMENT_TYPES } from "@qkt-insights/contract/query";
import type { LiveAccount } from "./api";
import { distinctLegs, GLOSSARY, legLabel, legsLine, optionFromSymbol, optionLine, shortInstrument, sizeInWords, strategyCurrencies, strategyEnvironment, strategyLegs, TYPE_LABEL, type InstrumentType, type Leg } from "./instruments";

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

describe("strategy instruments", () => {
  it("lists an instrument once however many broker profiles of one account traded it", () => {
    // soak_o12_xau: one stream, deals under ten Exness profiles, only some of them in live state
    const exness = { instanceId: "soak", broker: "EXNESS_O13", currency: "USD", balance: 1, equity: 1, lastSeen: 1, stale: false,
      connector: "mt5", adapter: "exness", profiles: ["EXNESS_O10", "EXNESS_O12X", "EXNESS_O13"] };
    const labels = ["EXNESS_O12", "EXNESS_O12X", "EXNESS_O10", "EXNESS_O13", "EXNESS_H02", "EXNESS_O08", "EXNESS_O04", "EXNESS_O11", "EXNESS_H01", "EXNESS_O08B"];
    const legs = strategyLegs({
      metadata: { streams: [{ alias: "xau", broker: "EXNESS_O12X", symbol: "XAUUSD", qktSymbol: "EXNESS_O12X:XAUUSD", timeframe: "5m" }] },
      instruments: labels.map((b) => ({ symbol: `${b}:XAUUSD`, broker: b, kind: "cfd", category: "Metals", contractSize: 100, unit: "lots" })),
    }, [exness], "soak");
    expect(legs.map((l) => legLabel(l, NOW))).toEqual(["CFD · XAUUSD · Exness"]);
  });

  it("keeps one instrument at two venues apart, and folds an unplaced label into the one venue it can be", () => {
    const leg = (venue: string | null, type: InstrumentType | null = "cfd") => ({ symbol: `X:${venue}`, name: "XAUUSD", type, venue });
    expect(distinctLegs([leg("Exness"), leg("IC Markets"), leg(null)]).map((l) => l.venue)).toEqual(["Exness", "IC Markets", null]);
    expect(distinctLegs([leg(null, null), leg("Exness")]).map((l) => [l.venue, l.type])).toEqual([["Exness", "cfd"]]);
    expect(distinctLegs([{ ...leg("Exness"), type: "stock-cfd" as const }, leg("Exness")])).toHaveLength(2);
  });
});

describe("glossary", () => {
  it("explains every type it labels", () => {
    for (const t of INSTRUMENT_TYPES) {
      expect(TYPE_LABEL[t]).toBeTruthy();
      expect(GLOSSARY[t].text.length).toBeGreaterThan(40);
    }
    expect(GLOSSARY.funding.text).toMatch(/longs/);
  });
});

describe("strategyCurrencies", () => {
  const account = (broker: string, currency: string, profiles: string[] = []): LiveAccount =>
    ({ instanceId: "soak", broker, currency, balance: 0, equity: 0, lastSeen: 0, stale: false, profiles }) as LiveAccount;
  const accounts = [account("EXNESS_O10", "USD", ["EXNESS_H01", "EXNESS_O10"]), account("PAPER_H", "USDC")];

  it("names the currency of each account a strategy's streams trade on", () => {
    const row = { metadata: { streams: [{ broker: "EXNESS_H01", symbol: "XAUUSD" }, { broker: "PAPER_H", symbol: "BTC_USDC_PERPETUAL" }] } };
    expect(strategyCurrencies(row, accounts, "soak")).toEqual(["USD", "USDC"]);
    expect(strategyCurrencies({ metadata: { streams: [{ broker: "exness_o10" }] } }, accounts, "soak")).toEqual(["USD"]);
  });

  it("skips labels no live account reports, and has nothing without streams", () => {
    expect(strategyCurrencies({ metadata: { streams: [{ broker: "GONE" }] } }, accounts, "soak")).toEqual([]);
    expect(strategyCurrencies({ metadata: null }, accounts, "soak")).toEqual([]);
    expect(strategyCurrencies(null, accounts, "soak")).toEqual([]);
  });
});

describe("strategyEnvironment", () => {
  const stream = (venue: Record<string, unknown> | null) => ({ broker: "X", symbol: "Y", venue });
  it("says paper, demo or live from each stream's venue facts", () => {
    const row = { metadata: { streams: [stream({ connector: "mt5", adapter: "exness", tradeMode: "demo" }), stream({ connector: "vgp", adapter: "paper", tradeMode: "demo" })] } };
    expect(strategyEnvironment(row).map((e) => e.label)).toEqual(["Demo", "Paper"]);
    expect(strategyEnvironment({ metadata: { streams: [stream({ connector: "mt5", adapter: "icmarkets", tradeMode: "real" })] } }).map((e) => e.label)).toEqual(["Live"]);
    expect(strategyEnvironment({ metadata: { streams: [stream({ connector: "paper" })] } }).map((e) => e.label)).toEqual(["Paper"]);
  });

  it("shows nothing when qkt states no venue", () => {
    expect(strategyEnvironment({ metadata: { streams: [stream(null)] } })).toEqual([]);
    expect(strategyEnvironment({ metadata: null })).toEqual([]);
    expect(strategyEnvironment(null)).toEqual([]);
  });
});

describe("optionFromSymbol", () => {
  it("reads a Deribit option symbol, with the premium in the settlement currency or the coin", () => {
    expect(optionFromSymbol("PAPER_DERIBIT_B:BTC_USDC_29OCT26_80500_C")).toEqual({ base: "BTC", premium: "USDC", expiry: Date.UTC(2026, 9, 29), strike: 80500, right: "call" });
    expect(optionFromSymbol("BTC-29NOV26-70000-P")).toEqual({ base: "BTC", premium: "BTC", expiry: Date.UTC(2026, 10, 29), strike: 70000, right: "put" });
    expect(optionLine("BTC_USDC_29OCT26_80500_C", NOW)).toBe("Call 80,500 · exp 29 Oct");
  });

  it("is null for anything else", () => {
    expect(optionFromSymbol("BTC_USDC_PERPETUAL")).toBeNull();
    expect(optionFromSymbol("BTC_USDC_30OCT26")).toBeNull();
    expect(optionFromSymbol("EURUSD")).toBeNull();
    expect(optionLine("XAUUSD")).toBeNull();
  });
});

describe("short instrument names", () => {
  const leg = (name: string, type: InstrumentType | null, venue: string | null, extra: Partial<Leg> = {}): Leg => ({ symbol: `L:${name}`, name, type, venue, ...extra });

  it("names a derivative by its coin and kind, anything else by its name", () => {
    expect(shortInstrument("PAPER_F:BTC_USDC_PERPETUAL", "perpetual")).toBe("BTC perp");
    expect(shortInstrument("PAPER_DERIBIT:BTC_USDC@front", "future")).toBe("BTC future");
    expect(shortInstrument("PAPER_DERIBIT:BTC_USDC_30OCT26", "future")).toBe("BTC future 30 Oct");
    expect(shortInstrument("BTC_USDC_29OCT26_80500_C", "option")).toBe("BTC option");
    expect(shortInstrument("EXNESS_O12:XAUUSD", "cfd")).toBe("XAUUSD");
    expect(shortInstrument("XAUUSD", null)).toBe("XAUUSD");
  });

  it("says what a strategy trades in one short line, every leg in full in the title", () => {
    expect(legsLine([leg("XAUUSD", "cfd", "Exness")]).text).toBe("XAUUSD · Exness");
    expect(legsLine([leg("BTC_USDC_PERPETUAL", "perpetual", "Paper (Deribit prices)")]).text).toBe("BTC perp · Paper");
    const expiry = legsLine([
      leg("BTC_USDC_PERPETUAL", "perpetual", "Paper (Deribit prices)"),
      leg("BTC_USDC_29OCT26_80500_C", "option", "Paper (Deribit prices)"),
    ], NOW);
    expect(expiry.text).toBe("BTC perp + options · Paper");
    expect(legsLine([leg("PAPER_DERIBIT_B.BTC_USDC", null, null), leg("BTC_USDC_PERPETUAL", "perpetual", "Paper (Deribit prices)")]).text).toBe("BTC perp · Paper");
    expect(legsLine([leg("PAPER_DERIBIT_B.ETH_USDC", null, null), leg("BTC_USDC_PERPETUAL", "perpetual", "Paper (Deribit prices)")]).text).toBe("BTC perp, ETH · Paper");
    expect(expiry.title).toBe("Perpetual future BTC_USDC_PERPETUAL · Paper (Deribit prices)\nOption BTC 80500 call, 29 Oct · Paper (Deribit prices)");
    expect(legsLine([leg("BTC_USDC_29OCT26_80500_C", "option", null), leg("BTC_USDC_29OCT26_80000_P", "option", null)]).text).toBe("BTC options");
    expect(legsLine([leg("AAPL", "stock-cfd", "Exness"), leg("XAUUSD", "cfd", "Exness")]).text).toBe("AAPL, XAUUSD · Exness");
    expect(legsLine([]).text).toBe("");
    for (const l of [expiry.text, legsLine([leg("BTC_USDC@front", "future", "Paper (Deribit prices)")]).text]) expect(l).not.toMatch(/PAPER_|_USDC|\(|more/u);
  });
});
