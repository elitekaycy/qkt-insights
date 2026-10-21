import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGE_PATHS, parsePath, routePath, withScope, type Route } from "./routes";

describe("routes", () => {
  it("round-trips every page and strategy deep link", () => {
    const routes: Route[] = [
      { page: "home" },
      { page: "strategies" },
      { page: "strategies", strategy: "gold_rsi_fade_v2", tab: "overview" },
      { page: "strategies", strategy: "gold rsi/fade", tab: "performance" },
      { page: "strategies", strategy: "eurusd", tab: "calendar" },
      { page: "strategies", portfolio: "book-1" },
      { page: "trades" },
      { page: "calendar" },
      { page: "risk" },
      { page: "edge" },
      { page: "logs" },
      { page: "health" },
      { page: "search" },
      { page: "settings", section: "sharing" },
      { page: "settings", section: "viewership" },
    ];
    for (const r of routes) expect(parsePath(routePath(r))).toEqual(r);
  });

  it("falls back to Home on an unknown path and to the overview tab on an unknown tab", () => {
    expect(parsePath("/nope")).toEqual({ page: "home" });
    expect(parsePath("/s/x/nope")).toEqual({ page: "strategies", strategy: "x", tab: "overview" });
  });

  it("carries the instance and range to the next page, never page filters", () => {
    expect(withScope("/edge", "?i=qkt-quant-live&range=30d&q=XAUUSD")).toBe("/edge?i=qkt-quant-live&range=30d");
    expect(withScope("/t?range=7d", "?i=a&range=30d")).toBe("/t?range=7d&i=a");
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
