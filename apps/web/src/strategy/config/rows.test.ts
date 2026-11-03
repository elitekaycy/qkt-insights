import { describe, it, expect } from "vitest";
import type { EffectiveConfig } from "../../api";
import { configChanges, configGroups, currencyHint, duration, percentOf } from "./rows";

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

  it("reads the account's own currency beside a configured one that differs, and says which amounts are which", () => {
    const venue = (currencies: string[]) => configGroups(CONFIG, currencies).flatMap((g) => g.rows);
    const of = (rs: ReturnType<typeof venue>, label: string) => rs.find((r) => r.label === label)?.value;
    // the reported case: a USDC paper account under a qkt configured in USD
    expect(of(venue(["USDC"]), "Account currency")).toBe("USDC");
    expect(of(venue(["USDC"]), "Configured currency")).toBe("USD");
    expect(currencyHint(CONFIG, ["USDC"])).toBe("amounts as configured, in USD");
    // they agree: one row, plain
    expect(of(venue(["USD"]), "Account currency")).toBe("USD");
    expect(of(venue(["USD"]), "Configured currency")).toBeUndefined();
    expect(currencyHint(CONFIG, ["USD"])).toBe("amounts in USD");
    // accounts in several currencies: each named
    expect(of(venue(["USD", "USDC"]), "Account currency")).toBe("USD, USDC");
    expect(of(venue(["USD", "USDC"]), "Configured currency")).toBe("USD");
    expect(currencyHint(CONFIG, ["USD", "USDC"])).toBe("amounts as configured, in USD");
    // Insights never heard from the account: never stated as the account's
    expect(of(venue([]), "Account currency")).toBeUndefined();
    expect(of(venue([]), "Configured currency")).toBe("USD");
    expect(currencyHint(CONFIG, [])).toBe("amounts as configured, in USD");
    // no configured currency to state
    expect(currencyHint({ ...CONFIG, currency: undefined }, ["USDC"])).toBeUndefined();
  });

  it("names this strategy's own limits, or says it has none", () => {
    expect(value(CONFIG, "These limits watch")).toBe("Every strategy in this qkt");
    expect(value(CONFIG, "This strategy's own limits")).toBe("None set");
    const own = { ...CONFIG, strategyRisk: { maxDailyLoss: set(500), maxOpenPositions: set(3) } };
    expect(value(own, "This strategy's own limits")).toBeUndefined();
    expect(value(own, "This strategy's daily loss")).toBe("500");
    expect(value(own, "This strategy's open positions")).toBe("3");
  });

  it("states the shared daily limits only when this qkt reports them", () => {
    expect(value(CONFIG, "Hard daily loss")).toBeUndefined();
    expect(value(CONFIG, "Max daily loss covers")).toBeUndefined();

    const shared = (risk: NonNullable<EffectiveConfig["risk"]>, kind: EffectiveConfig["kind"] = "standalone") => ({ ...CONFIG, kind, risk: { ...CONFIG.risk, ...risk } });
    const daemon = shared({ maxDailyLossAppliesTo: "daemon", hardDailyLoss: set(1500) });
    expect(value(daemon, "Hard daily loss")).toBe("1,500");
    expect(rows(daemon).find((r) => r.label === "Hard daily loss")).toMatchObject({ isDefault: false, yaml: "risk.hard_daily_loss" });
    expect(value(daemon, "Max daily loss covers")).toBe("Every strategy in this qkt");
    expect(rows(daemon).find((r) => r.label === "Max daily loss covers")!.explain).toContain("blocks new entries");

    const book = shared({ appliesTo: "book", maxDailyLossAppliesTo: "book" }, "portfolio_child");
    expect(value(book, "Max daily loss covers")).toBe("The whole book");
    expect(rows(book).find((r) => r.label === "Max daily loss covers")!.explain).toContain("flattens and halts the book");
    expect(rows(book).find((r) => r.label === "These limits watch")!.explain).toContain("loss and drawdown halts");

    const mixedChild = shared({ appliesTo: "book", maxDailyLossAppliesTo: "daemon" }, "portfolio_child");
    expect(value(mixedChild, "These limits watch")).toBe("The whole book");
    expect(rows(mixedChild).find((r) => r.label === "These limits watch")!.explain).not.toContain("loss and drawdown halts");
    expect(value(mixedChild, "Max daily loss covers")).toBe("Every strategy in this qkt");
  });

  it("explains a breach by what this qkt says the daily loss applies to", () => {
    const explain = (config: EffectiveConfig, label: string) => rows(config).find((r) => r.label === label)!.explain;
    const risk = (r: NonNullable<EffectiveConfig["risk"]>, kind: EffectiveConfig["kind"] = "standalone"): EffectiveConfig => ({ ...CONFIG, kind, risk: { ...CONFIG.risk, ...r } });

    // A qkt older than the shared limits states no scope: a breach there still stops its standalones.
    expect(CONFIG.risk?.maxDailyLossAppliesTo).toBeUndefined();
    expect(explain(CONFIG, "These limits watch")).toBe("The day's loss adds up every strategy this qkt runs, and any breach stops them all.");
    expect(explain(CONFIG, "Max daily loss")).toBe("Realized loss in one day that halts trading until the next day.");

    const daemon = risk({ maxDailyLossAppliesTo: "daemon" });
    expect(explain(daemon, "These limits watch")).toContain("blocks new entries everywhere");
    expect(explain(daemon, "These limits watch")).toContain("positions stay");
    expect(explain(daemon, "These limits watch")).not.toContain("stops them all");
    expect(explain(daemon, "Max daily loss")).toContain("blocks new entries");
    expect(explain(daemon, "Max daily loss")).not.toContain("halts trading");

    const off = risk({ maxDailyLoss: { source: "default" }, maxDailyLossAppliesTo: "daemon" });
    expect(explain(off, "These limits watch")).toBe("A drawdown breach blocks new entries in every strategy running on its own here. Positions stay and exits pass.");

    const child = risk({ appliesTo: "book", maxDailyLossAppliesTo: "book" }, "portfolio_child");
    expect(explain(child, "Max daily loss")).toContain("flattens and halts it");

    // A bot session runs alone, so what it reports of the daemon's total does not reach its rows.
    expect(explain(risk({ maxDailyLossAppliesTo: "daemon" }, "bot_session"), "Max daily loss")).toBe("Realized loss in one day that halts trading until the next day.");
  });

  it("reads a hard limit that is off as None set, as qkt states it", () => {
    const off = { ...CONFIG, risk: { ...CONFIG.risk, hardDailyLoss: { source: "default" as const } } };
    expect(value(off, "Hard daily loss")).toBe("None set");
    expect(rows(off).find((r) => r.label === "Hard daily loss")!.isDefault).toBe(true);
  });

  it("says nothing of what an unset max daily loss covers", () => {
    const unset = { ...CONFIG, risk: { ...CONFIG.risk, maxDailyLoss: { source: "default" as const }, maxDailyLossAppliesTo: "daemon" as const } };
    expect(value(unset, "Max daily loss")).toBe("None set");
    expect(value(unset, "Max daily loss covers")).toBeUndefined();
  });

  it("shows neither shared limit on a bot session, which runs alone and does not apply them", () => {
    const bot: EffectiveConfig = { ...CONFIG, kind: "bot_session", risk: { ...CONFIG.risk, maxDailyLossAppliesTo: "daemon", hardDailyLoss: set(1500) } };
    expect(value(bot, "Hard daily loss")).toBeUndefined();
    expect(value(bot, "Max daily loss covers")).toBeUndefined();
    expect(value(bot, "Max daily loss")).toBe("1,000");
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

  it("names a move of the max daily loss from a book to the whole qkt", () => {
    const child = (scope: "book" | "daemon") => ({ ...CONFIG, risk: { ...CONFIG.risk, appliesTo: "book" as const, maxDailyLossAppliesTo: scope } });
    expect(configChanges(child("book"), child("daemon"))).toEqual([
      { label: "Max daily loss covers", from: "The whole book", to: "Every strategy in this qkt" },
    ]);
  });

  it("finds nothing between equal configs, and a row one side lacks", () => {
    expect(configChanges(CONFIG, CONFIG)).toEqual([]);
    const { startingBalance: _s, ...without } = CONFIG;
    expect(configChanges(CONFIG, without)).toEqual([{ label: "Starting balance", from: "25,000", to: null }]);
  });
});
