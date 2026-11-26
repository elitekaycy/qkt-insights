import { describe, expect, it } from "vitest";
import type { SetMember } from "../api";
import { changeWords, membersBySet, memberSymbol } from "./membership";

const member = (set: string, symbol: string, rank: number | null, state: SetMember["state"] = "member"): SetMember =>
  ({ set, member: symbol, state, change: state === "sticky" ? "stick" : "join", rank, since: 0 });

describe("set membership words", () => {
  it("names every kind qkt journals, with status tones only, and shows an unknown kind as sent", () => {
    for (const kind of ["join", "leave", "stick", "release", "stay", "restore", "unavailable"]) {
      const w = changeWords(kind);
      expect(w.label).not.toBe(kind);
      expect(["info", "warn", "neutral"]).toContain(w.tone);
    }
    expect(changeWords("expire")).toEqual({ label: "expire", tone: "neutral", explain: 'qkt reported "expire".' });
  });

  it("drops the venue from a member's symbol", () => {
    expect(memberSymbol("BINANCE:BTCUSDT")).toBe("BTCUSDT");
    expect(memberSymbol("KALSHI:KXBTC-26NOV-T95000")).toBe("KXBTC-26NOV-T95000");
    expect(memberSymbol("XAUUSD")).toBe("XAUUSD");
  });

  it("groups members by set in the order sent", () => {
    const groups = membersBySet([member("a", "X:1", 1), member("a", "X:2", null, "sticky"), member("b", "X:3", 1)]);
    expect(groups.map((g) => [g.set, g.members.map((m) => m.member)])).toEqual([["a", ["X:1", "X:2"]], ["b", ["X:3"]]]);
  });
});
