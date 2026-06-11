import { describe, it, expect } from "vitest";
import { parseMode } from "../src/server.js";

describe("parseMode", () => {
  it("defaults to run", () => expect(parseMode([])).toBe("run"));
  it("accepts collect/serve/run", () => {
    expect(parseMode(["collect"])).toBe("collect");
    expect(parseMode(["serve"])).toBe("serve");
    expect(parseMode(["run"])).toBe("run");
  });
  it("throws on an unknown mode", () => expect(() => parseMode(["bogus"])).toThrow());
});
