import { describe, it, expect } from "vitest";
import { parseStrategyCapital } from "../src/capital.js";

describe("parseStrategyCapital", () => {
  it("is empty when unset", () => {
    expect(parseStrategyCapital(undefined)).toEqual({});
    expect(parseStrategyCapital("  ")).toEqual({});
  });

  it("maps strategy ids to positive capital", () => {
    expect(parseStrategyCapital('{"gold_gaparmor_calm_v31":7000,"eur_fade":2500.5}'))
      .toEqual({ gold_gaparmor_calm_v31: 7000, eur_fade: 2500.5 });
  });

  it("refuses malformed JSON", () => {
    expect(() => parseStrategyCapital("{gold:7000")).toThrow(/STRATEGY_CAPITAL is not valid JSON/);
  });

  it("refuses anything but an object", () => {
    expect(() => parseStrategyCapital("[7000]")).toThrow("STRATEGY_CAPITAL must be a JSON object of strategyId -> capital");
    expect(() => parseStrategyCapital("7000")).toThrow("STRATEGY_CAPITAL must be a JSON object of strategyId -> capital");
  });

  it("names the strategy whose capital is not a positive number", () => {
    expect(() => parseStrategyCapital('{"gold":0}')).toThrow("STRATEGY_CAPITAL.gold must be a positive number");
    expect(() => parseStrategyCapital('{"gold":"7000"}')).toThrow("STRATEGY_CAPITAL.gold must be a positive number");
  });
});
