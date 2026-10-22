import { describe, it, expect } from "vitest";
import { mt5AccountId, vgpAccountId } from "@qkt-insights/contract";
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
    // a bare MT5 login@server names the account qkt reports, kept only as its opaque id
    expect(Object.keys(limits)).toEqual([mt5AccountId("777", "Demo-Server"), "*"]);
    expect(limits[mt5AccountId("777", "Demo-Server")]).toMatchObject({ basis: "static", startBalance: 50000, timezone: "Europe/Athens", dailyLossIncludesFloating: true });
    expect(limits["*"]).toEqual({ maxDrawdown: 3000 });
  });

  it("hashes every form of an account key to the one opaque id and keeps no login or server", () => {
    const profile = { maxDrawdown: 3000 };
    const id = mt5AccountId("777", "Demo-Server");
    for (const key of ["777@Demo-Server", "mt5:777@Demo-Server", id]) {
      const limits = parseAccountLimits(JSON.stringify({ [key]: profile }));
      expect(limits).toEqual({ [id]: profile });
      expect(JSON.stringify(limits)).not.toMatch(/777|Demo-Server/);
    }
    expect(parseAccountLimits(JSON.stringify({ "vgp:deribit:acct-9": profile }))).toEqual({ [vgpAccountId("deribit", "acct-9")]: profile });
    expect(parseAccountLimits(JSON.stringify({ EXNESS: profile }))).toEqual({ EXNESS: profile });
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
