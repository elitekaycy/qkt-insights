import { describe, it, expect } from "vitest";
import { Concurrency, LoginGuard, WindowCounter } from "../src/limits.js";

const MIN = 60_000;

describe("WindowCounter", () => {
  it("allows up to the limit inside one window and resets after it", () => {
    const c = new WindowCounter(3, MIN);
    expect([c.hit("a", 0), c.hit("a", 1), c.hit("a", 2), c.hit("a", 3)]).toEqual([true, true, true, false]);
    expect(c.hit("b", 3)).toBe(true);
    expect(c.hit("a", MIN)).toBe(true);
  });

  it("reports when a blocked key may retry", () => {
    const c = new WindowCounter(1, MIN);
    c.hit("a", 1000);
    c.hit("a", 2000);
    expect(c.retryAfterMs("a", 2000)).toBe(MIN - 1000);
  });

  it("forgets windows that have ended", () => {
    const c = new WindowCounter(1, MIN);
    for (let i = 0; i < 100; i++) c.hit(`k${i}`, 0);
    c.sweep(MIN);
    expect(c.size).toBe(0);
  });
});

describe("LoginGuard", () => {
  it("locks one IP after its failure budget without locking others", () => {
    const g = new LoginGuard({ perIpFailures: 3, globalFailures: 100, windowMs: 15 * MIN, lockMs: 15 * MIN });
    for (let i = 0; i < 3; i++) g.recordFailure("1.1.1.1", i);
    expect(g.lockedFor("1.1.1.1", 10)).toBeGreaterThan(0);
    expect(g.lockedFor("2.2.2.2", 10)).toBe(0);
    expect(g.lockedFor("1.1.1.1", 15 * MIN + 10)).toBe(0);
  });

  it("locks every IP once the global failure budget is spent", () => {
    const g = new LoginGuard({ perIpFailures: 100, globalFailures: 4, windowMs: 15 * MIN, lockMs: 15 * MIN });
    for (let i = 0; i < 4; i++) g.recordFailure(`10.0.0.${i}`, i);
    expect(g.lockedFor("9.9.9.9", 10)).toBeGreaterThan(0);
  });

  it("a trusted IP is exempt from the global lock but not from its own per-IP lock", () => {
    const g = new LoginGuard({ perIpFailures: 3, globalFailures: 4, windowMs: 15 * MIN, lockMs: 15 * MIN });
    for (let i = 0; i < 4; i++) g.recordFailure(`10.0.0.${i}`, i);
    expect(g.lockedFor("9.9.9.9", 10, { trusted: true })).toBe(0);
    for (let i = 0; i < 3; i++) g.recordFailure("9.9.9.9", 20 + i);
    expect(g.lockedFor("9.9.9.9", 30, { trusted: true })).toBeGreaterThan(0);
  });

  it("a success clears that IP's failures but not the global lock", () => {
    const g = new LoginGuard({ perIpFailures: 3, globalFailures: 3, windowMs: 15 * MIN, lockMs: 15 * MIN });
    g.recordFailure("1.1.1.1", 0);
    g.recordFailure("1.1.1.1", 1);
    g.recordSuccess("1.1.1.1");
    g.recordFailure("1.1.1.1", 2);
    expect(g.lockedFor("1.1.1.1", 3)).toBeGreaterThan(0);
  });
});

describe("Concurrency", () => {
  it("admits up to the limit and frees a slot on release", () => {
    const c = new Concurrency(2);
    const a = c.tryAcquire();
    const b = c.tryAcquire();
    expect(a && b).toBe(true);
    expect(c.tryAcquire()).toBe(false);
    c.release();
    expect(c.tryAcquire()).toBe(true);
  });
});
