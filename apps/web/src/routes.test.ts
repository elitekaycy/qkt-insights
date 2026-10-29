import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { movedPath, PAGE_PATHS, parsePath, PRIVATE_STRATEGY_TABS, routePath, STRATEGY_TABS, withScope, type Route } from "./routes";

describe("routes", () => {
  it("round-trips every page and strategy deep link", () => {
    const routes: Route[] = [
      { page: "home" },
      { page: "strategies" },
      { page: "strategies", strategy: "gold_rsi_fade_v2", tab: "overview" },
      { page: "strategies", strategy: "gold rsi/fade", tab: "time" },
      { page: "strategies", strategy: "gold", tab: "periods", period: "calendar" },
      { page: "strategies", strategy: "gold", tab: "periods", period: "days" },
      { page: "strategies", strategy: "gold", tab: "periods", period: "months" },
      { page: "strategies", strategy: "gold", tab: "logs" },
      { page: "strategies", strategy: "gold", tab: "code" },
      { page: "strategies", portfolio: "book-1" },
      { page: "trades" },
      { page: "calendar" },
      { page: "risk" },
      { page: "edge" },
      { page: "logs" },
      { page: "health" },
      { page: "settings", section: "sharing" },
      { page: "settings", section: "viewership" },
    ];
    for (const r of routes) expect(parsePath(routePath(r))).toEqual(r);
  });

  it("keeps a strategy's code and logs off shared links", () => {
    expect([...PRIVATE_STRATEGY_TABS].sort()).toEqual(["code", "logs"]);
    expect(STRATEGY_TABS.filter((t) => !PRIVATE_STRATEGY_TABS.has(t))).not.toContain("code");
  });

  it("falls back to Home on an unknown path and to the overview tab on an unknown tab", () => {
    expect(parsePath("/nope")).toEqual({ page: "home" });
    expect(parsePath("/s/x/nope")).toEqual({ page: "strategies", strategy: "x", tab: "overview" });
    // the retired performance tab's figures live on the overview now
    expect(parsePath("/s/x/performance")).toEqual({ page: "strategies", strategy: "x", tab: "overview" });
    expect(parsePath("/find")).toEqual({ page: "logs" });
    expect(movedPath("/find")).toBe("/log");
    expect(movedPath("/log")).toBeNull();
  });

  it("sends the retired Calendar, Daily and Monthly sections to their Periods view", () => {
    expect(parsePath("/s/gold/calendar")).toEqual({ page: "strategies", strategy: "gold", tab: "periods", period: "calendar" });
    expect(movedPath("/s/gold/calendar")).toBe("/s/gold/periods");
    expect(movedPath("/s/gold/daily")).toBe("/s/gold/periods/days");
    expect(movedPath("/s/gold/monthly")).toBe("/s/gold/periods/months");
    expect(movedPath("/s/gold/periods/days")).toBeNull();
    expect(parsePath("/s/gold/periods/nope")).toEqual({ page: "strategies", strategy: "gold", tab: "periods", period: "calendar" });
  });

  it("carries the instance and range to the next page, never page filters", () => {
    expect(withScope("/edge", "?i=qkt-quant-live&range=30d&q=XAUUSD&trade=1")).toBe("/edge?i=qkt-quant-live&range=30d");
    expect(withScope("/t?range=7d", "?i=a&range=30d")).toBe("/t?range=7d&i=a");
    // the account chosen on Home is the one Equity & risk opens on
    expect(withScope("/risk", "?i=a&account=vgp%3A7bf764b24864a0b1")).toBe("/risk?i=a&account=vgp%3A7bf764b24864a0b1");
  });

  it("carries the search only between the pages with the query bar", () => {
    const from = "?i=a&q=side%3Ashort+pnl%3A%3C0&trade=9";
    expect(withScope("/t", from)).toBe("/t?i=a&q=side%3Ashort+pnl%3A%3C0");
    expect(withScope("/s/gold/trades", from)).toBe("/s/gold/trades?i=a&q=side%3Ashort+pnl%3A%3C0");
    expect(withScope("/calendar", from)).toBe("/calendar?i=a&q=side%3Ashort+pnl%3A%3C0");
    expect(withScope("/log", from)).toBe("/log?i=a&q=side%3Ashort+pnl%3A%3C0");
    expect(withScope("/", from)).toBe("/?i=a");
    expect(withScope("/t?q=win", from)).toBe("/t?q=win&i=a");
    expect(withScope("/", "")).toBe("/");
  });

  it("never shadows a collector API route, which shares the origin", () => {
    const apiDir = fileURLToPath(new URL("../../../packages/api/src/", import.meta.url));
    const apiPaths = new Set<string>();
    for (const f of readdirSync(apiDir).filter((n) => n.endsWith(".ts"))) {
      for (const m of readFileSync(apiDir + f, "utf8").matchAll(/\.(?:get|put|post|delete)(?:<.*?>)?\(\s*"(\/[^"]*)"/g)) apiPaths.add(m[1]!);
    }
    expect(apiPaths.has("/strategies")).toBe(true);
    for (const page of Object.values(PAGE_PATHS)) {
      if (page === "/") continue;
      for (const api of apiPaths) expect(api === page || api.startsWith(`${page}/`), `${page} collides with ${api}`).toBe(false);
    }
  });
});
