import { describe, expect, it } from "vitest";
import { compact, compactPnl, dealNet, duration, fixed, glyph, human, instrumentOf, money, num, openPnl, pct, pnl, price, signedMoney, signedPct, toneClass, ts, tsShort } from "./format";

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

  it("pairs a glyph with the sign so colour is never the only signal", () => {
    expect(pnl(1002.4)).toBe("\u25b2 +1,002.40");
    expect(pnl(-1002.4)).toBe("\u25bc \u22121,002.40");
    expect(pnl(0.001)).toBe("0.00");
    expect(glyph(-3)).toBe("\u25bc");
    expect(glyph(0)).toBe("");
  });

  it("maps polarity to the gain and loss text tones", () => {
    expect(toneClass(5)).toBe("text-gain");
    expect(toneClass(-5)).toBe("text-loss");
    expect(toneClass(-0.001)).toBe("text-muted");
    expect(toneClass(null)).toBe("text-faint");
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
    expect(compact(-1.25)).toBe("\u22121.25");
  });
});

describe("compact cell money", () => {
  it("keeps the glyph and sign at cell width", () => {
    expect(compactPnl(1234)).toBe("\u25b2 +1.2k");
    expect(compactPnl(-640.4)).toBe("\u25bc \u2212640");
    expect(compactPnl(0.3)).toBe("0");
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
