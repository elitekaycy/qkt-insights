import { describe, it, expect } from "vitest";
import { TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  it("returns the cached value within the TTL without calling the loader again", async () => {
    let now = 0;
    const cache = new TtlCache(5000, 200, () => now);
    let calls = 0;
    const loader = () => { calls++; return { calls }; };

    const first = await cache.get("/stats?instance=qkt-prod", loader);
    now = 4999;
    const second = await cache.get("/stats?instance=qkt-prod", loader);

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it("reloads once the TTL has expired", async () => {
    let now = 0;
    const cache = new TtlCache(5000, 200, () => now);
    let calls = 0;
    const loader = () => { calls++; return calls; };

    expect(await cache.get("k", loader)).toBe(1);
    now = 5000;
    expect(await cache.get("k", loader)).toBe(2);
    expect(calls).toBe(2);
  });

  it("keys entries independently", async () => {
    const cache = new TtlCache(5000, 200, () => 0);
    expect(await cache.get("a", () => "A")).toBe("A");
    expect(await cache.get("b", () => "B")).toBe("B");
    expect(await cache.get("a", () => "never")).toBe("A");
  });

  it("awaits async loaders and caches the resolved value", async () => {
    const cache = new TtlCache(5000, 200, () => 0);
    let calls = 0;
    const loader = async () => { calls++; return "v"; };
    expect(await cache.get("k", loader)).toBe("v");
    expect(await cache.get("k", loader)).toBe("v");
    expect(calls).toBe(1);
  });

  it("evicts the oldest entry past maxEntries", async () => {
    const cache = new TtlCache(5000, 2, () => 0);
    await cache.get("a", () => "A");
    await cache.get("b", () => "B");
    await cache.get("c", () => "C");

    let reloaded = false;
    expect(await cache.get("a", () => { reloaded = true; return "A2"; })).toBe("A2");
    expect(reloaded).toBe(true);
    expect(await cache.get("c", () => "never")).toBe("C");
  });
});
