import { describe, expect, it } from "vitest";
import { axisTick, compact, compactPnl, returnPct, dealNet, duration, fixed, human, instrumentOf, money, num, openPnl, pct, price, signedMoney, signedPct, toneClass, ts, tsShort } from "./format";
import { tableStamp } from "./trades/format";

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
    expect(money(-1234.5)).toBe("\u22121,234.50");
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

describe("signed money", () => {
  it("always carries a sign and a true minus", () => {
    expect(signedMoney(1234.5)).toBe("+1,234.50");
    expect(signedMoney(-56)).toBe("\u221256.00");
    expect(signedMoney(-0.004)).toBe("0.00");
    expect(signedMoney(null)).toBe("\u2014");
  });

  it("signs money so colour is never the only signal", () => {
    expect(signedMoney(1002.4)).toBe("+1,002.40");
    expect(signedMoney(-1002.4)).toBe("\u22121,002.40");
    expect(signedMoney(0.001)).toBe("0.00");
  });

  it("maps polarity to the gain and loss text tones", () => {
    expect(toneClass(5)).toBe("text-gain");
    expect(toneClass(-5)).toBe("text-loss");
    expect(toneClass(-0.001)).toBe("text-muted");
    expect(toneClass(null)).toBe("text-muted");
  });

  it("signs percent changes", () => {
    expect(signedPct(6.224)).toBe("+6.22%");
    expect(signedPct(-1.05)).toBe("\u22121.05%");
    expect(signedPct(-0.001)).toBe("0.00%");
  });
});

describe("compact axis labels", () => {
  it("shortens with a true minus", () => {
    expect(compact(1234)).toBe("1.2k");
    expect(compact(-56000)).toBe("\u221256.0k");
    expect(compact(250000)).toBe("250k");
    expect(compact(-0.001)).toBe("0");
    expect(compact(0)).toBe("0");
    expect(compact(2)).toBe("2");
    expect(compact(-500)).toBe("\u2212500");
    expect(compact(100)).toBe("100");
    expect(compact(12.5)).toBe("12.5");
    expect(compact(-1.25)).toBe("\u22121.25");
  });
});

describe("compact cell money", () => {
  it("keeps the sign at cell width", () => {
    expect(compactPnl(1234)).toBe("+1.23k");
    expect(compactPnl(-640.4)).toBe("\u2212640");
    expect(compactPnl(-5.94)).toBe("\u22125.94");
    expect(compactPnl(14.84)).toBe("+14.8");
    expect(compactPnl(-0.4)).toBe("\u22120.40");
    expect(compactPnl(0.003)).toBe("0");
    expect(returnPct(0.0024)).toBe("<0.01%");
    expect(returnPct(-0.0024)).toBe("\u2212<0.01%");
    expect(returnPct(-0.06)).toBe("\u22120.06%");
    expect(returnPct(0)).toBe("0.00%");
  });
});

describe("durations and times", () => {
  it("reads in the largest two units, days included", () => {
    expect(duration(83_000)).toBe("1m 23s");
    expect(duration(3 * 3600_000)).toBe("3h");
    expect(duration(72 * 3600_000)).toBe("3d");
    expect(duration(50 * 3600_000)).toBe("2d 2h");
    expect(duration(-1)).toBe("\u2014");
  });

  it("prints UTC regardless of the viewer's zone", () => {
    const ms = Date.UTC(2026, 8, 2, 13, 26, 33);
    expect(ts(ms)).toBe("2026-09-02 13:26:33");
    expect(tsShort(ms)).toBe("02 Sep 13:26");
    expect(human(ms)).toBe("Wed, 02 Sep 2026 \u00b7 13:26:33 UTC");
  });
});

describe("shortDay", () => {
  it("names a day or a month briefly", async () => {
    const { shortDay } = await import("./format");
    expect(shortDay("2026-10-07")).toBe("Oct 7");
    expect(shortDay("2026-10")).toBe("Oct 2026");
  });
});

describe("tableStamp", () => {
  const now = Date.UTC(2026, 9, 22, 3, 0);
  it("drops the year inside the current year so the cell never clips", () => {
    expect(tableStamp(Date.UTC(2026, 9, 19, 20, 0), now)).toBe("19 Oct 20:00");
  });
  it("keeps the year, as the day, for an older trade", () => {
    expect(tableStamp(Date.UTC(2025, 11, 31, 23, 59), now)).toBe("2025-12-31");
  });
  it("is a dash when there is no time", () => {
    expect(tableStamp(null, now)).toBe("—");
  });
});

describe("axisTick", () => {
  it("keeps the digits that tell neighbouring ticks apart", () => {
    expect([4_980_000, 4_990_000, 5_000_000, 5_010_000].map(axisTick)).toEqual(["4.98M", "4.99M", "5M", "5.01M"]);
    expect([59_500, 60_000, 60_500].map(axisTick)).toEqual(["59.5k", "60k", "60.5k"]);
    expect(axisTick(4_985_000)).toBe("4.985M");
  });
  it("matches compact for small values and signs", () => {
    expect(axisTick(-0.25)).toBe("\u22120.25");
    expect(axisTick(-1500)).toBe("\u22121.5k");
    expect(axisTick(0)).toBe("0");
    expect(axisTick(-0.001)).toBe("0");
  });
});
