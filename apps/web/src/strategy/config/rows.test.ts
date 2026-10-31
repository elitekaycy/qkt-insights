import { describe, it, expect } from "vitest";
import type { EffectiveConfig } from "../../api";
import { configChanges, configGroups, duration, percentOf } from "./rows";

const set = (value: number | string, source: "configured" | "default" = "configured") => ({ value, source });

const CONFIG: EffectiveConfig = {
  kind: "standalone", tradingMode: "demo", runtimeMode: set("paper"),
  accounts: [{ name: "EXNESS", type: "mt5", connector: "mt5", adapter: "exness", environment: "demo", tickPollIntervalMs: 500 }],
  currency: set("USD"), startingBalance: set(25000),
  risk: { appliesTo: "strategy", maxDailyLoss: set(1000, "default"), maxDrawdownFraction: { source: "default" }, totalDdBasis: set("STATIC", "default"), maxDailyDrawdownFraction: set(0.03) },
  orders: { maxOrderQty: set(2), priceCollarFraction: set(0.05), measuredUsageHours: { source: "configured" }, marginFloorPct: set(200, "default") },
  marketData: { candleCloseGraceMs: set(2000, "default") },
};

const rows = (c: EffectiveConfig) => configGroups(c).flatMap((g) => g.rows);
const value = (c: EffectiveConfig, label: string) => rows(c).find((r) => r.label === label)?.value;

describe("configGroups", () => {
  it("groups in reading order, a book only when there is one", () => {
    expect(configGroups(CONFIG).map((g) => g.title)).toEqual(["Account", "Risk limits", "Orders", "Market data"]);
    expect(configGroups({ ...CONFIG, book: { name: "b" } }).map((g) => g.title)).toEqual(["Account", "Risk limits", "Book", "Orders", "Market data"]);
  });

  it("reads a limit with no value as None set, never 0", () => {
    expect(value(CONFIG, "Max drawdown")).toBe("None set");
    expect(value(CONFIG, "Measured-usage window")).toBe("None set");
    expect(rows(CONFIG).map((r) => r.value)).not.toContain("0");
  });

  it("says a value is qkt's default and a configured one is not", () => {
    expect(rows(CONFIG).find((r) => r.label === "Max daily loss")!.isDefault).toBe(true);
    expect(rows(CONFIG).find((r) => r.label === "Max order size")!.isDefault).toBe(false);
  });

  it("puts plain words in the labels and the config key only in the tooltip", () => {
    const row = rows(CONFIG).find((r) => r.label === "Max daily loss")!;
    expect(row.yaml).toBe("risk.max_daily_loss");
    for (const r of rows(CONFIG)) expect(r.label).not.toMatch(/_|\./);
  });

  it("formats each unit once", () => {
    expect(value(CONFIG, "Max daily loss")).toBe("1,000");
    expect(value(CONFIG, "Max daily drawdown")).toBe("3%");
    expect(value(CONFIG, "Price collar")).toBe("5%");
    expect(value(CONFIG, "Margin floor")).toBe("200%");
    expect(value(CONFIG, "Candle close grace")).toBe("2 s");
    expect(value(CONFIG, "Tick poll interval")).toBe("500 ms");
    expect(value(CONFIG, "Drawdown from")).toBe("Starting balance");
    expect(value(CONFIG, "Trading mode")).toBe("Demo");
    expect(value(CONFIG, "Account type")).toBe("MT5");
    expect(percentOf(0.07)).toBe("7%");
    expect(duration(600_000)).toBe("10 min");
  });

  it("names this strategy's own limits, or says it has none", () => {
    expect(value(CONFIG, "These limits watch")).toBe("Every strategy in this qkt");
    expect(value(CONFIG, "This strategy's own limits")).toBe("None set");
    const own = { ...CONFIG, strategyRisk: { maxDailyLoss: set(500), maxOpenPositions: set(3) } };
    expect(value(own, "This strategy's own limits")).toBeUndefined();
    expect(value(own, "This strategy's daily loss")).toBe("500");
    expect(value(own, "This strategy's open positions")).toBe("3");
  });

  it("states a book's caps as multiples of its capital", () => {
    const book = { ...CONFIG, book: { name: "b", capital: set(80000), weight: 0.6, allocatedCapital: 48000, maxGrossExposure: set(2.5), maxNetExposure: { source: "default" as const }, deRiskSteps: [{ drawdown: 0.03, factor: 0.5 }] } };
    expect(value(book, "Book capital")).toBe("80,000");
    expect(value(book, "This strategy's weight")).toBe("60%");
    expect(value(book, "Max gross exposure")).toBe("2.5× capital");
    expect(value(book, "Max net exposure")).toBe("None set");
    expect(value(book, "De-risk steps")).toBe("3%: size × 0.5");
    expect(value({ ...book, risk: { ...book.risk, appliesTo: "book" } }, "Drawdown from")).toBe("Book capital");
  });
});

describe("configChanges", () => {
  it("names what moved, in the page's words", () => {
    const after = { ...CONFIG, risk: { ...CONFIG.risk, maxDailyLoss: set(500) }, orders: { ...CONFIG.orders, measuredUsageHours: set(24) } };
    expect(configChanges(CONFIG, after)).toEqual([
      { label: "Max daily loss", from: "1,000", to: "500" },
      { label: "Measured-usage window", from: "None set", to: "24 h" },
    ]);
  });

  it("finds nothing between equal configs, and a row one side lacks", () => {
    expect(configChanges(CONFIG, CONFIG)).toEqual([]);
    const { startingBalance: _s, ...without } = CONFIG;
    expect(configChanges(CONFIG, without)).toEqual([{ label: "Starting balance", from: "25,000", to: null }]);
  });
});
