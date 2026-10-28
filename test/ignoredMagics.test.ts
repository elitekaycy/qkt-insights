import { describe, it, expect } from "vitest";
import { parseIgnoredMagics } from "../src/ignoredMagics.js";

describe("parseIgnoredMagics", () => {
  it("is empty when unset", () => {
    expect(parseIgnoredMagics(undefined)).toEqual({});
    expect(parseIgnoredMagics("  ")).toEqual({});
  });

  it("maps instance ids to inclusive ranges, a single magic as a range of one", () => {
    expect(parseIgnoredMagics('{"forward":["31000-31199",40000," 50000 - 50010 "]}'))
      .toEqual({ forward: [{ lo: 31000, hi: 31199 }, { lo: 40000, hi: 40000 }, { lo: 50000, hi: 50010 }] });
  });

  it("refuses malformed JSON and anything but an object of arrays", () => {
    expect(() => parseIgnoredMagics("{forward")).toThrow(/INSIGHTS_IGNORE_MAGICS is not valid JSON/);
    expect(() => parseIgnoredMagics('["31000-31199"]')).toThrow("INSIGHTS_IGNORE_MAGICS must be a JSON object of instanceId -> [magic ranges]");
    expect(() => parseIgnoredMagics('{"forward":"31000-31199"}')).toThrow('INSIGHTS_IGNORE_MAGICS["forward"] must be an array of ranges such as "31000-31199"');
  });

  it("names the range it cannot read", () => {
    for (const bad of ['"31199-31000"', '"abc"', '"1-2-3"', "-5", "1.5", '""'])
      expect(() => parseIgnoredMagics(`{"forward":[${bad}]}`)).toThrow(/INSIGHTS_IGNORE_MAGICS\["forward"\]: .* is not a range of whole magics such as "31000-31199"/);
  });
});
