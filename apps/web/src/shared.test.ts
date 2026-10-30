import { describe, it, expect } from "vitest";
import { sharedLandingPath, sharedStrategyState } from "./shared";

describe("sharedLandingPath", () => {
  it("lands a private strategy tab on the strategy's overview", () => {
    expect(sharedLandingPath("/s/gold/code", "overview")).toBe("/s/gold");
    expect(sharedLandingPath("/s/gold/logs", "portfolio")).toBe("/s/gold");
    expect(sharedLandingPath("/s/gold/code", "strategy")).toBe("/");
  });

  it("lands a bare private path on the link's own page", () => {
    expect(sharedLandingPath("/code", "strategy")).toBe("/");
    expect(sharedLandingPath("/logs", "overview")).toBe("/");
  });

  it("leaves every other path alone", () => {
    for (const path of ["/", "/s/gold", "/s/gold/periods", "/s/code", "/strategies", "/s/gold/trades"]) {
      expect(sharedLandingPath(path, "overview"), path).toBeNull();
    }
  });
});

describe("sharedStrategyState", () => {
  it("waits for the roster, then shows only what it carries", () => {
    expect(sharedStrategyState(undefined, true, "gold")).toBe("wait");
    expect(sharedStrategyState([{ strategyId: "gold" }], false, "gold")).toBe("show");
    expect(sharedStrategyState([{ strategyId: "silver" }], false, "gold")).toBe("not-on-link");
    expect(sharedStrategyState([], false, "gold")).toBe("not-on-link");
  });

  it("an unread roster leaves it to the page, not to a claim the strategy is absent", () => {
    expect(sharedStrategyState(undefined, false, "gold")).toBe("show");
  });
});
