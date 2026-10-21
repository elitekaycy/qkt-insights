import { describe, it, expect } from "vitest";
import { decimalsOf, defaultDigits, digitsFrom, roundPrice } from "../src/prices.js";

describe("instrument price precision", () => {
  it("reads the decimals a venue quoted, without float noise", () => {
    expect(decimalsOf(4127.67)).toBe(2);
    expect(decimalsOf(1.08455)).toBe(5);
    expect(decimalsOf(4135)).toBe(0);
    expect(decimalsOf(4115.2)).toBe(1);
    expect(decimalsOf(0.1 + 0.2)).toBe(1);
    expect(decimalsOf(4122.72447856)).toBe(6);
  });

  it("falls back to the convention: metals, JPY crosses, FX, anything else", () => {
    expect(defaultDigits("XAUUSD")).toBe(2);
    expect(defaultDigits("XAGUSD")).toBe(3);
    expect(defaultDigits("USDJPY")).toBe(3);
    expect(defaultDigits("EURUSD")).toBe(5);
    expect(defaultDigits("US500")).toBe(2);
  });

  it("reads the most decimals, never below the convention for metals and FX", () => {
    const gold = Array.from({ length: 30 }, (_, i) => 4100 + i * 0.37);
    expect(digitsFrom(gold, "XAUUSD")).toBe(2);
    expect(digitsFrom(Array.from({ length: 30 }, (_, i) => 100 + i), "US500")).toBe(0);
    expect(digitsFrom(Array.from({ length: 30 }, (_, i) => 4000 + i), "XAUUSD")).toBe(2);
    expect(digitsFrom([4100.123], "XAUUSD")).toBe(3);
    expect(digitsFrom([4000, 4020], "XAUUSD")).toBe(2);
    expect(digitsFrom([1.0845], "EURUSD")).toBe(5);
    expect(digitsFrom([], "USDJPY")).toBe(3);
  });

  it("rounds to the precision, never printing -0", () => {
    expect(roundPrice(4122.72447856, 2)).toBe("4122.72");
    expect(roundPrice(0.069218324998, 2)).toBe("0.07");
    expect(roundPrice(-0.001, 2)).toBe("0.00");
    expect(roundPrice(null, 2)).toBeNull();
  });
});
