import { describe, it, expect } from "vitest";
import { parseAccountLimits } from "../src/accountLimits.js";

describe("parseAccountLimits", () => {
  it("is empty when unset", () => {
    expect(parseAccountLimits(undefined)).toEqual({});
    expect(parseAccountLimits("  ")).toEqual({});
  });

  it("reads a profile per account key", () => {
    const limits = parseAccountLimits(JSON.stringify({
      "777@Demo-Server": { basis: "static", startBalance: 50000, dailyLossPct: 5, maxDrawdownPct: 10, dailyResetHour: 0, timezone: "Europe/Athens", dailyLossIncludesFloating: true },
      "*": { maxDrawdown: 3000 },
    }));
    expect(limits["777@Demo-Server"]).toMatchObject({ basis: "static", startBalance: 50000, timezone: "Europe/Athens", dailyLossIncludesFloating: true });
    expect(limits["*"]).toEqual({ maxDrawdown: 3000 });
  });

  it("refuses what it cannot apply", () => {
    expect(() => parseAccountLimits("{")).toThrow(/not valid JSON/);
    expect(() => parseAccountLimits("[]")).toThrow(/JSON object/);
    expect(() => parseAccountLimits('{"a":{"dailyLossPct":-1}}')).toThrow(/positive number/);
    expect(() => parseAccountLimits('{"a":{"basis":"trailing"}}')).toThrow(/basis/);
    expect(() => parseAccountLimits('{"a":{"basis":"static"}}')).toThrow(/startBalance/);
    expect(() => parseAccountLimits('{"a":{"timezone":"Mars/Base"}}')).toThrow(/IANA/);
    expect(() => parseAccountLimits('{"a":{"dailyResetHour":24}}')).toThrow(/0-23/);
    expect(() => parseAccountLimits('{"a":{"maxDailyLoss":5}}')).toThrow(/not a known limit/);
  });
});
