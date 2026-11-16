import { describe, it, expect } from "vitest";
import { moneyDigits, moneySign, roundMoney } from "../src/money.js";

describe("money at the minor unit", () => {
  it("reads the minor unit from the currency, 2 when unknown", () => {
    expect([moneyDigits("USD"), moneyDigits("usd"), moneyDigits("JPY"), moneyDigits("KWD"), moneyDigits(undefined), moneyDigits("XYZ")]).toEqual([2, 2, 0, 3, 2, 2]);
  });

  it("reads a win or a loss from what was booked, finer than the minor unit, and float noise as breakeven", () => {
    expect(moneySign(0.0045)).toBe(1);
    expect(moneySign(-0.0001)).toBe(-1);
    expect(moneySign(0)).toBe(0);
    expect(moneySign(0.1 + -0.1)).toBe(0);
    expect(moneySign(0.1 + 0.2 - 0.3)).toBe(0);
    expect(moneySign(-250.2 + 250.2)).toBe(0);
    expect(moneySign(12.5)).toBe(1);
  });

  it("rounds float sums back to the cent, halves away from zero, never -0", () => {
    expect(roundMoney(-250.2 + -0.1)).toBe(-250.3);
    expect(roundMoney(6054.7300000000005)).toBe(6054.73);
    expect(roundMoney(0.3 - 0.1 - 0.2)).toBe(0);
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true);
    expect([roundMoney(1.005), roundMoney(-1.005), roundMoney(2.675)]).toEqual([1.01, -1.01, 2.68]);
    expect([roundMoney(12.3456, 0), roundMoney(12.3456, 3)]).toEqual([12, 12.346]);
  });
});
