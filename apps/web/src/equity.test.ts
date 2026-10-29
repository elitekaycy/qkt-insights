import { describe, expect, it } from "vitest";
import { biggestMovers, deepestFall, deepestId } from "./equity";

const curve = (...v: number[]) => v.map((equity) => ({ equity }));

describe("biggestMovers", () => {
  it("keeps the four lines that moved the most, in their order", () => {
    const series = [
      { id: "a", points: curve(10_000, 10_001) },
      { id: "b", points: curve(10_000, 9_980) },
      { id: "c", points: curve(10_000, 10_000) },
      { id: "d", points: curve(10_000, 10_050) },
      { id: "e", points: curve(10_000, 9_990) },
      { id: "f", points: [] },
    ];
    expect(biggestMovers(series)).toEqual(["a", "b", "d", "e"]);
    expect(biggestMovers(series, 2)).toEqual(["b", "d"]);
  });
});

describe("deepestFall and deepestId", () => {
  it("measures the fall below the running peak and picks the curve that fell the most", () => {
    expect(deepestFall(curve(100, 110, 99, 120))).toBeCloseTo(0.1, 9);
    expect(deepestFall(curve(100, 101, 102))).toBe(0);
    expect(deepestId([{ id: "flat", points: curve(10_000, 10_000) }, { id: "dip", points: curve(100, 90, 95) }, { id: "small", points: curve(100, 99) }])).toBe("dip");
    expect(deepestId([{ id: "flat", points: curve(10_000, 10_000) }])).toBeNull();
  });
});
