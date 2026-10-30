import { describe, it, expect } from "vitest";
import type { PositionPath } from "./data";
import { bucketLabel, labelPlacements, levels, markerIndex, priceAxisDigits, priceTick, shadedSpans, timeTick, moments, pathOption, pathTip, pnlLine, priceRange } from "./positionMap";

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 8);

/** A short EURUSD entered at 1.1000: best +250 at 1.0975, worst -100 at 1.1010, latest +150 at 1.0985. */
function path(over: Partial<PositionPath> = {}): PositionPath {
  return {
    ticket: "P1", status: "open", side: "short",
    entry: { ts: T0, price: 1.1 }, exit: null,
    stopPrice: 1.103, targetPrice: 1.05,
    bucketMs: 5 * M, buckets: [M, 5 * M, 15 * M],
    candles: [
      { t: T0, o: 1.1002, h: 1.1002, l: 1.099, c: 1.099, marks: 2 },
      { t: T0 + 5 * M, o: 1.101, h: 1.101, l: 1.101, c: 1.101, marks: 1 },
      { t: T0 + 15 * M, o: 1.0975, h: 1.0985, l: 1.0975, c: 1.0985, marks: 2 },
    ],
    pnl: [{ ts: T0 + M, pnl: -20 }, { ts: T0 + 3 * M, pnl: 100 }, { ts: T0 + 7 * M, pnl: -100 }, { ts: T0 + 16 * M, pnl: 250 }, { ts: T0 + 18 * M, pnl: 150 }],
    best: { ts: T0 + 16 * M, price: 1.0975, pnl: 250 },
    worst: { ts: T0 + 7 * M, price: 1.101, pnl: -100 },
    last: { ts: T0 + 18 * M, price: 1.0985, pnl: 150, swap: -2.5 },
    marks: 5, firstMarkTs: T0 + M, longestGap: null, gapSpans: [], flatSpans: [], gaps: 0,
    ...over,
  };
}

describe("position map moments", () => {
  it("orders entry, worst, best and latest by time, with the time after entry", () => {
    const ms = moments(path(), null);
    expect(ms.map((m) => [m.key, m.afterEntryMs])).toEqual([["entry", 0], ["worst", 7 * M], ["best", 16 * M], ["now", 18 * M]]);
    expect(ms.find((m) => m.key === "entry")!.pnl).toBeNull();
  });

  it("ends a closed trip at the exit with the realized net, not the latest mark", () => {
    const ms = moments(path({ status: "closed", exit: { ts: T0 + 20 * M, price: 1.0986 } }), 138.4);
    expect(ms.at(-1)).toEqual({ key: "exit", label: "Exit", ts: T0 + 20 * M, price: 1.0986, pnl: 138.4, afterEntryMs: 20 * M });
    expect(ms.some((m) => m.key === "now")).toBe(false);
  });

  it("shows one mark that is both best and worst once", () => {
    const one = { ts: T0 + M, price: 1.1, pnl: 0 };
    expect(moments(path({ best: one, worst: one, last: { ...one, swap: 0 } }), null).map((m) => m.key)).toEqual(["entry", "best", "now"]);
  });
});

describe("position map levels", () => {
  it("draws a stop near the path and lists a far target as off the chart", () => {
    expect(levels(path())).toEqual([{ key: "stop", price: 1.103, inView: true }, { key: "target", price: 1.05, inView: false }]);
    expect(levels(path({ stopPrice: null, targetPrice: 0 }))).toEqual([]);
  });

  it("keeps the y range on the path, the entry and the moments only", () => {
    const r = priceRange(path())!;
    expect(r.min).toBeLessThan(1.0975);
    expect(r.max).toBeGreaterThan(1.101);
    expect(r.max).toBeLessThan(1.103);
  });
});

describe("position map P&L line", () => {
  it("breaks across a stretch without marks and joins everywhere else", () => {
    const p = path({ pnl: [{ ts: T0, pnl: 1 }, { ts: T0 + M, pnl: 2 }, { ts: T0 + 60 * M, pnl: 3 }], gapSpans: [{ from: T0 + M, to: T0 + 60 * M }], gaps: 1 });
    expect(pnlLine(p)).toEqual([[T0, 1], [T0 + M, 2], [T0 + M + 1, null], [T0 + 60 * M, 3]]);
    expect(pnlLine(path())).toHaveLength(5);
  });
});

describe("position map option", () => {
  const input = (view: "price" | "pnl", over: Partial<PositionPath> = {}) => {
    const p = path(over);
    return { path: p, moments: moments(p, null), view, digits: 5, narrow: false };
  };
  type S = { type: string; data: unknown[]; markLine?: { data: Array<{ name?: string; yAxis: number }> }; markArea?: { data: unknown[] } };

  it("draws candles at the middle of their window and the markers at their exact time", () => {
    const o = pathOption(input("price"));
    const [candles, markers] = o.series as S[];
    expect(candles!.type).toBe("candlestick");
    expect(candles!.data[0]).toEqual([T0 + 2.5 * M, 1.1002, 1.099, 1.099, 1.1002]);
    expect((markers!.data as Array<{ value: number[] }>).map((d) => d.value)).toEqual([[T0, 1.1], [T0 + 7 * M, 1.101], [T0 + 16 * M, 1.0975], [T0 + 18 * M, 1.0985]]);
    expect(candles!.markLine!.data.map((l) => l.name)).toEqual(["entry", "stop"]);
  });

  it("places the P&L markers on the P&L axis, entry at zero, and shades gaps", () => {
    const o = pathOption(input("pnl", { gapSpans: [{ from: T0 + 8 * M, to: T0 + 15 * M }], gaps: 1 }));
    const [line, markers] = o.series as S[];
    expect(line!.type).toBe("line");
    expect((markers!.data as Array<{ value: number[] }>).map((d) => d.value[1])).toEqual([0, -100, 250, 150]);
    const shaded = line!.markArea!.data as Array<[{ xAxis: number; label: { formatter: string } }, { xAxis: number }]>;
    expect(shaded.map(([a, b]) => [a.xAxis, b.xAxis, a.label.formatter])).toEqual([[T0 + 8 * M, T0 + 15 * M, "no marks"]]);
  });

  it("indexes markers so a moment can be focused from outside the chart", () => {
    const i = input("price");
    expect([...markerIndex(i.moments, "price")]).toEqual([["entry", 0], ["worst", 1], ["best", 2], ["now", 3]]);
    // a moment without a price is not on the price chart
    const p = path({ worst: { ts: T0 + 7 * M, price: null, pnl: -100 } });
    expect(markerIndex(moments(p, null), "price").has("worst")).toBe(false);
    expect(markerIndex(moments(p, null), "pnl").get("worst")).toBe(1);
  });

  it("marks the latest price of an open position with a still marker, never a pulse", () => {
    const types = (o: ReturnType<typeof pathOption>) => (o.series as S[]).map((s) => s.type);
    expect(types(pathOption(input("price")))).toEqual(["candlestick", "scatter"]);
  });

  it("tooltips the candle under the pointer and the moments inside it", () => {
    const p = path();
    const html = pathTip([{ seriesType: "candlestick", value: [T0 + 17.5 * M, 1.0975, 1.0985, 1.0975, 1.0985] }], { path: p, moments: moments(p, null), view: "price", digits: 5 });
    expect(html).toContain("5m candle");
    expect(html).toContain("1.09850");
    expect(html).toContain("Best 08:16:00");
    expect(html).toContain("Latest 08:18:00");
    expect(html).not.toContain("Worst");
  });

  it("moves a label that would collide beside its marker", () => {
    const at = (key: "best" | "worst" | "now", f: number, y: number) => ({ key, ts: T0 + f * 1000, y });
    // best and latest both low and close together near the right edge: the later one goes left
    expect([...labelPlacements([at("worst", 600, 9), at("best", 880, 1), at("now", 970, 2)], 5, T0, T0 + 1000_000)]).toEqual([["worst", "top"], ["best", "bottom"], ["now", "left"]]);
    // far apart, each keeps its side
    expect([...labelPlacements([at("best", 100, 1), at("now", 600, 2)], 5, T0, T0 + 1000_000)]).toEqual([["best", "bottom"], ["now", "bottom"]]);
    expect([...labelPlacements([at("best", 100, 1), at("now", 150, 2)], 5, T0, T0 + 1000_000)]).toEqual([["best", "bottom"], ["now", "right"]]);
  });

  it("shades flat stretches lighter than gaps and labels only the wide ones", () => {
    const p = path({ flatSpans: [{ from: T0 + 2 * M, to: T0 + 9 * M }], gapSpans: [{ from: T0 + 10 * M, to: T0 + 10.5 * M }], gaps: 1 });
    const area = shadedSpans(p, T0, T0 + 18 * M, false)!.data as Array<[{ xAxis: number; itemStyle: { color: string }; label: { show: boolean; formatter: string } }, { xAxis: number }]>;
    expect(area.map(([a]) => [a.label.formatter, a.label.show, a.itemStyle.color])).toEqual([
      ["no price change", true, "var(--color-faint) / 0.08"],
      ["no marks", false, "var(--color-faint) / 0.18"],
    ]);
    expect(shadedSpans(path(), T0, T0 + 18 * M, false)).toBeUndefined();
  });

  it("prints price ticks at one precision that tells them apart", () => {
    expect(priceAxisDigits(7000, 2)).toBe(0);
    expect(priceAxisDigits(180, 3)).toBe(0);
    expect(priceAxisDigits(0.0048, 5)).toBe(4);
    expect(priceAxisDigits(0.00002, 5)).toBe(5);
    expect(priceTick(84000, 0)).toBe("84,000");
    expect(priceTick(1.12, 4)).toBe("1.1200");
    expect(priceTick(-2.5, 1)).toBe("\u22122.5");
  });

  it("names the day at midnight and the hour inside it on a multi-day axis", () => {
    expect(timeTick(Date.UTC(2026, 9, 24))).toBe("24 Oct");
    expect(timeTick(Date.UTC(2026, 9, 24, 6))).toBe("06:00");
  });

  it("tooltips a focused marker as its moment in full", () => {
    const p = path();
    const html = pathTip([{ seriesType: "scatter", value: [T0 + 7 * M, 1.101] }], { path: p, moments: moments(p, null), view: "price", digits: 5 });
    expect(html).toContain("Worst · 20 Oct 08:07:00 UTC");
    expect(html).toContain("\u2212100.00");
    expect(html).toContain("1.10100");
    expect(html).toContain("After entry");
    expect(pathTip([{ seriesType: "scatter", value: [T0 + 99 * M, 1] }], { path: p, moments: moments(p, null), view: "price", digits: 5 })).toBe("");
  });

  it("labels candle sizes", () => {
    expect([M, 5 * M, 15 * M, 30 * M, 60 * M, 240 * M, 1440 * M].map(bucketLabel)).toEqual(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);
  });
});
