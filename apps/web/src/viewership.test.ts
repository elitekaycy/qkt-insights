import { describe, expect, it } from "vitest";
import { fillDays, linkLabel, withShares } from "./viewership";

describe("withShares", () => {
  it("adds each row's fraction of the total", () => {
    expect(withShares([{ key: "Chrome", views: 3 }, { key: null, views: 1 }], 4)).toEqual([
      { key: "Chrome", views: 3, share: 0.75 },
      { key: null, views: 1, share: 0.25 },
    ]);
    expect(withShares([], 0)).toEqual([]);
  });
});

describe("fillDays", () => {
  it("fills every UTC day in the range, zero where nothing was viewed", () => {
    const from = Date.UTC(2026, 8, 13, 15);
    const to = Date.UTC(2026, 8, 15, 12);
    expect(fillDays([{ day: "2026-09-14", views: 4, visitors: 2 }], from, to)).toEqual([
      { day: "2026-09-13", views: 0, visitors: 0 },
      { day: "2026-09-14", views: 4, visitors: 2 },
      { day: "2026-09-15", views: 0, visitors: 0 },
    ]);
  });
});

describe("linkLabel", () => {
  it("names overview, portfolio and strategy links", () => {
    const names = new Map([["gold", "book / gold_leg"]]);
    expect(linkLabel("overview", "", names)).toBe("Overview");
    expect(linkLabel("portfolio", "book", names)).toBe("Portfolio book");
    expect(linkLabel("strategy", "gold", names)).toBe("book / gold_leg");
    expect(linkLabel("strategy", "silver", names)).toBe("silver");
  });
});
