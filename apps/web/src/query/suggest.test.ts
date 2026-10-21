import { describe, it, expect } from "vitest";
import { LOG_KEYS, TRADE_KEYS } from "@qkt-insights/contract/query";
import { suggest } from "./suggest";
import { latency, minuteStamp, preciseClock, rMultiple } from "../trades/format";

const DATA = {
  keys: TRADE_KEYS,
  strategies: ["gold_ema_pullback", "eurusd_rsi_fade"],
  instruments: ["XAUUSD", "EURUSD"],
  days: ["2026-10-21", "2026-10-20", "2026-09-30"],
  sizes: [0.5, 0.21],
};
const texts = (input: string, data: Parameters<typeof suggest>[1] = DATA) => suggest(input, data).map((s) => s.text);

describe("query bar completions", () => {
  it("offers the page's common filters on an empty box", () => {
    expect(texts("")).toEqual(["side:long", "side:short", "win", "loss", "ended:stop", "ended:tp", "r:>=1", "held:<1h", "open"]);
    expect(texts("", { keys: LOG_KEYS, strategies: ["gold"] })).toEqual(["level:error", "level:warn", "time:1h", "time:today", "strategy:", "logger:"]);
  });

  it("after key: offers that key's values from the data", () => {
    expect(texts("strategy:")).toEqual(["strategy:gold_ema_pullback", "strategy:eurusd_rsi_fade", "strategy:unattributed"]);
    expect(texts("strategy:eur")).toEqual(["strategy:eurusd_rsi_fade"]);
    expect(texts("symbol:x")).toEqual(["symbol:XAUUSD"]);
    expect(texts("exit:2026-10")).toEqual(["exit:2026-10-21", "exit:2026-10-20", "exit:2026-10"]);
    expect(texts("size:")).toEqual(["size:0.5", "size:0.21"]);
  });

  it("offers a comparison being typed once it parses", () => {
    expect(suggest("pnl:>250", DATA)[0]).toMatchObject({ text: "pnl:>250", label: "P&L above 250", group: "Apply" });
    expect(texts("held:>=3h")[0]).toBe("held:>=3h");
    expect(texts("held:>=3x")).toEqual([]);
  });

  it("finds filters by synonyms and prefixes, and key templates by their start", () => {
    expect(texts("sl")).toContain("ended:stop");
    expect(texts("xau")).toContain("symbol:XAUUSD");
    expect(texts("he")[0]).toBe("held:");
    expect(texts("gold")).toContain("strategy:gold_ema_pullback");
  });

  it("never offers what is already applied, or a key the page ignores", () => {
    expect(texts("", { ...DATA, active: "side:long win" })).not.toContain("side:long");
    expect(texts("", { ...DATA, active: "side:long win" })).not.toContain("win");
    expect(texts("level:")).toEqual([]);
    expect(texts("pnl:", { keys: LOG_KEYS })).toEqual([]);
  });
});

describe("trade formatting", () => {
  it("prints R, stamps and latencies", () => {
    expect(rMultiple(1.254)).toBe("+1.25R");
    expect(rMultiple(-0.8)).toBe("−0.80R");
    expect(rMultiple(0.001)).toBe("0.00R");
    expect(rMultiple(null)).toBe("—");
    expect(minuteStamp(Date.UTC(2026, 9, 21, 14, 30, 59))).toBe("2026-10-21 14:30");
    expect(preciseClock(Date.UTC(2026, 9, 21, 14, 30, 1, 282))).toBe("14:30:01.282");
    expect(latency(null)).toBe("");
    expect(latency(712)).toBe("+712 ms");
    expect(latency(3400)).toBe("+3.4 s");
    expect(latency(125_000)).toBe("+2m 5s");
    expect(latency(3 * 3_600_000 + 60_000)).toBe("+3h 1m");
  });
});
