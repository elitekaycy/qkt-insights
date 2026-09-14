import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { Shares, portfolioGroupOf, resolveVisibility } from "../src/shares.js";

const standalone = { strategyId: "gold", metadata: {} };
const childA = { strategyId: "book:s0", metadata: { portfolioId: "book" } };
const childB = { strategyId: "book_2:s1", metadata: { portfolioId: "book_2" } };
const roster = [standalone, childA, childB];

describe("Shares", () => {
  it("everything is private when nothing is set", () => {
    const v = resolveVisibility([], roster);
    expect(v.overview).toBe(false);
    expect([...v.strategies.values()]).toEqual([false, false, false]);
    expect(v.portfolios.get("book")).toBe(false);
  });

  it("a public overview makes every strategy and portfolio public", () => {
    const s = new Shares(openDb(":memory:"));
    s.set("i1", "overview", "", "public");
    const v = resolveVisibility(s.list("i1"), roster);
    expect(v.overview).toBe(true);
    expect(v.strategies.get("gold")).toBe(true);
    expect(v.strategies.get("book:s0")).toBe(true);
    expect(v.portfolios.get("book")).toBe(true);
  });

  it("a strategy's own setting beats its portfolio, which beats the overview", () => {
    const s = new Shares(openDb(":memory:"));
    s.set("i1", "overview", "", "public");
    s.set("i1", "portfolio", "book", "private");
    s.set("i1", "strategy", "book_2:s1", "public");
    const v = resolveVisibility(s.list("i1"), roster);
    expect(v.strategies.get("gold")).toBe(true);
    expect(v.strategies.get("book:s0")).toBe(false);
    expect(v.strategies.get("book_2:s1")).toBe(true);
    expect(v.portfolios.get("book")).toBe(false);
  });

  it("a private overview still lets an explicitly public strategy through", () => {
    const s = new Shares(openDb(":memory:"));
    s.set("i1", "strategy", "gold", "public");
    const v = resolveVisibility(s.list("i1"), roster);
    expect(v.overview).toBe(false);
    expect(v.strategies.get("gold")).toBe(true);
    expect(v.strategies.get("book:s0")).toBe(false);
  });

  it("resetting to inherit removes the explicit setting but keeps the link token", () => {
    const s = new Shares(openDb(":memory:"));
    s.set("i1", "strategy", "gold", "public");
    const token = s.ensureToken("i1", "strategy", "gold");
    s.set("i1", "strategy", "gold", null);
    expect(resolveVisibility(s.list("i1"), roster).strategies.get("gold")).toBe(false);
    expect(s.ensureToken("i1", "strategy", "gold")).toBe(token);
  });

  it("scopes settings to their instance", () => {
    const s = new Shares(openDb(":memory:"));
    s.set("i1", "overview", "", "public");
    expect(resolveVisibility(s.list("i2"), roster).overview).toBe(false);
  });

  it("issues one unguessable token per subject, finds it, and rotates it", () => {
    const s = new Shares(openDb(":memory:"));
    const a = s.ensureToken("i1", "overview", "");
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s.ensureToken("i1", "overview", "")).toBe(a);
    expect(s.ensureToken("i1", "strategy", "gold")).not.toBe(a);
    expect(s.byToken(a)).toMatchObject({ instanceId: "i1", kind: "overview", subject: "" });
    const b = s.rotate("i1", "overview", "");
    expect(b).not.toBe(a);
    expect(s.byToken(a)).toBeUndefined();
    expect(s.byToken(b)).toMatchObject({ kind: "overview" });
  });

  it("tracks which tokens were handed out, and a rotation clears that", () => {
    const s = new Shares(openDb(":memory:"));
    s.ensureToken("i1", "strategy", "gold");
    expect(s.exposed("i1")).toEqual([]);
    const token = s.expose("i1", "strategy", "gold");
    expect(s.exposed("i1").map((r) => r.token)).toEqual([token]);
    expect(s.instancesWithExposedLinks()).toEqual(["i1"]);
    s.rotate("i1", "strategy", "gold");
    expect(s.exposed("i1")).toEqual([]);
  });

  it("rejects malformed tokens without querying", () => {
    const s = new Shares(openDb(":memory:"));
    expect(s.byToken("")).toBeUndefined();
    expect(s.byToken("x".repeat(500))).toBeUndefined();
    expect(s.byToken("' OR 1=1 --")).toBeUndefined();
  });

  it("groups shard portfolios the way the dashboard does", () => {
    expect(portfolioGroupOf({ portfolioId: "forward_bench_3" })).toBe("forward_bench");
    expect(portfolioGroupOf({ portfolioId: "book" })).toBe("book");
    expect(portfolioGroupOf({})).toBeNull();
    expect(portfolioGroupOf(null)).toBeNull();
  });
});
