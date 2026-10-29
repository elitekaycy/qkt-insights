import { describe, expect, it } from "vitest";
import { instanceState } from "./instance";

describe("instanceState", () => {
  const now = Date.UTC(2026, 9, 29, 21, 0, 0);

  it("says nothing while the instance reports inside its 30 s pulse", () => {
    expect(instanceState(now - 29_000, now)).toBeNull();
    expect(instanceState(null, now)).toBeNull();
  });

  it("is stale from 30 s and down from the monitor's 150 s, with the age in words", () => {
    expect(instanceState(now - 45_000, now)).toEqual({ state: "stale", age: "45s" });
    expect(instanceState(now - 150_000, now)).toEqual({ state: "down", age: "2m" });
    expect(instanceState(now - 2 * 3_600_000, now)).toEqual({ state: "down", age: "2h" });
    expect(instanceState(now - 3 * 86_400_000, now)).toEqual({ state: "down", age: "3d" });
  });
});
