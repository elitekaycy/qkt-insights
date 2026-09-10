import { describe, expect, it } from "vitest";
import { price } from "./format";

describe("price", () => {
  it("drops float representation noise from venue prices", () => {
    expect(price(4414.869000000001)).toBe("4414.869");
    expect(price(4611.0470000000005)).toBe("4611.047");
    expect(price(4460.231000000001)).toBe("4460.231");
  });

  it("keeps every real digit of a quote", () => {
    expect(price(1.08543)).toBe("1.08543");
    expect(price(157.123)).toBe("157.123");
    expect(price(4359.652)).toBe("4359.652");
  });

  it("renders a missing price as a dash", () => {
    expect(price(null)).toBe("—");
    expect(price(undefined)).toBe("—");
  });
});
