import { describe, expect, it } from "vitest";
import { dealNet, fixed, instrumentOf, money, num, openPnl, pct, price } from "./format";

describe("price", () => {
  it("drops float representation noise from venue prices", () => {
    expect(price(4414.869000000001)).toBe("4414.869");
    expect(price(4611.0470000000005)).toBe("4611.047");
    expect(price(4460.231000000001)).toBe("4460.231");
  });

  it("keeps every real digit of a quote", () => {
    expect(price(1.08543)).toBe("1.08543");
    expect(price(157.123)).toBe("157.123");
    expect(price(4359.652)).toBe("4359.652");
  });

  it("renders a missing price as a dash", () => {
    expect(price(null)).toBe("—");
    expect(price(undefined)).toBe("—");
  });
});

describe("signed zero", () => {
  it("never renders -0.00", () => {
    expect(money(-0.004)).toBe("0.00");
    expect(money(-0)).toBe("0.00");
    expect(money(-1234.5)).toBe("-1,234.50");
    expect(fixed(-0.001)).toBe("0.00");
    expect(num(-0.0001)).toBe("0.00");
    expect(pct(-0.0001)).toBe("0.0%");
  });
});

describe("net figures", () => {
  it("a deal's net includes the venue fee", () => {
    expect(dealNet({ profit: 10, commission: -0.7, swap: -0.3, fee: -1 })).toBeCloseTo(8, 9);
    expect(dealNet({ profit: 10, commission: null, swap: null })).toBe(10);
  });

  it("open P&L includes swap", () => {
    expect(openPnl({ profit: -19.17, swap: -2.4 })).toBeCloseTo(-21.57, 9);
    expect(openPnl({ profit: 5 })).toBe(5);
  });

  it("aggregates by instrument", () => {
    expect(instrumentOf("ICM_S05:XAUUSD")).toBe("XAUUSD");
    expect(instrumentOf("XAUUSD")).toBe("XAUUSD");
  });
});
