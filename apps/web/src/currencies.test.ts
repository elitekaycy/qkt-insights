import { describe, it, expect } from "vitest";
import { currencyMix, currencyName, splitNets } from "./currencies";

describe("money in more than one currency", () => {
  it("splits a net only when it spans currencies", () => {
    expect(splitNets(undefined)).toBeNull();
    expect(splitNets([{ currency: "USD", net: 5, n: 2 }])).toBeNull();
    expect(splitNets([{ currency: "USD", net: 5, n: 2 }, { currency: "USDC", net: -1, n: 1 }])).toEqual([{ currency: "USD", net: 5, n: 2 }, { currency: "USDC", net: -1, n: 1 }]);
    expect(currencyName(null)).toBe("no currency");
  });

  it("marks a figure that adds currencies, and only then", () => {
    expect(currencyMix(["USD"])).toBeNull();
    expect(currencyMix(undefined)).toBeNull();
    expect(currencyMix(["USD", "USD", null])).toBeNull();
    expect(currencyMix(["USDC", "USD"])).toEqual({ label: "USD+USDC", title: "Adds USD and USDC 1:1, no conversion." });
    expect(currencyMix(["USD", "USDC", "USDT"])).toEqual({ label: "USD+USDC+USDT", title: "Adds USD, USDC and USDT 1:1, no conversion." });
  });
});
