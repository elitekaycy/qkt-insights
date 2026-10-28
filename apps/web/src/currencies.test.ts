import { describe, it, expect } from "vitest";
import { currencyName, mixedCurrencyNote, splitNets } from "./currencies";

describe("money in more than one currency", () => {
  it("splits a net only when it spans currencies", () => {
    expect(splitNets(undefined)).toBeNull();
    expect(splitNets([{ currency: "USD", net: 5, n: 2 }])).toBeNull();
    expect(splitNets([{ currency: "USD", net: 5, n: 2 }, { currency: "USDC", net: -1, n: 1 }])).toEqual([{ currency: "USD", net: 5, n: 2 }, { currency: "USDC", net: -1, n: 1 }]);
    expect(currencyName(null)).toBe("no currency");
  });

  it("says when an instance's accounts book in more than one currency", () => {
    expect(mixedCurrencyNote("forward", ["USD"])).toBeNull();
    expect(mixedCurrencyNote("forward", undefined)).toBeNull();
    expect(mixedCurrencyNote("soak", ["USD", "USDC"])).toMatch(/^Accounts on soak book in USD and USDC\. .*1:1 with no conversion/u);
    expect(mixedCurrencyNote("soak", ["USD", "USDC", "USDT"])).toMatch(/^Accounts on soak book in USD, USDC and USDT\./u);
  });
});
