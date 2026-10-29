import { describe, it, expect } from "vitest";
import type { AccountReconciliation, ReconciledLedger, ReconciledPositions } from "./api";
import { DAY_REASON, EMPTY_TEXT, ignoredLine, unassignedLabels, unassignedLine, checkedLabel, dayCounts, dayMonth, dayTradesPath, ledgerLine, positionIssues, positionsLine, verdict } from "./reconciliation";

const positions = (over: Partial<ReconciledPositions> = {}): ReconciledPositions => ({
  status: "ok", venueAt: Date.UTC(2026, 9, 22, 1, 59), venueCount: 2, insightsCount: 2, missing: [], gone: [], mismatched: [], ...over,
});
const ledger = (over: Partial<ReconciledLedger> = {}): ReconciledLedger => ({ status: "ok", trips: 412, tripsNet: 1234.5, dealsNet: 1234.5, diff: 0, mismatched: [], ...over });
const account = (over: Partial<AccountReconciliation> = {}): AccountReconciliation => ({
  account: "mt5:0123456789abcdef", label: "ICM", firstDay: "2026-09-01", lastDay: "2026-10-21", throughDay: "2026-10-21",
  daysOk: 50, daysDiff: 0, daysExternal: 0, daysIncomplete: 1, days: [], positions: positions(), ledger: ledger(), checkedAt: Date.UTC(2026, 9, 22, 2), ...over,
});

describe("reconciliation wording", () => {
  it("says an account is reconciled through its last day, and when it was checked (UTC)", () => {
    expect(verdict(account())).toEqual({ tone: "ok", text: "Reconciled ✓ through 21 Oct" });
    expect(checkedLabel(Date.UTC(2026, 9, 22, 2), Date.UTC(2026, 9, 22, 9))).toBe("checked 02:00 UTC");
    expect(checkedLabel(Date.UTC(2026, 9, 21, 2), Date.UTC(2026, 9, 22, 9))).toBe("checked 21 Oct 02:00 UTC");
    expect(dayCounts(account())).toBe("50 days ok · 1 incomplete");
  });

  it("keeps an account reconciled through balance moves without a deal, and says how many", () => {
    expect(verdict(account({ daysExternal: 2 }))).toEqual({ tone: "ok", text: "Reconciled ✓ through 21 Oct · 2 balance moves without a deal" });
    expect(verdict(account({ daysExternal: 1 })).text).toBe("Reconciled ✓ through 21 Oct · 1 balance move without a deal");
    expect(dayCounts(account({ daysExternal: 2 }))).toBe("50 days ok · 2 without a deal · 1 incomplete");
  });

  it("counts the days that differ and says how far the books are clean", () => {
    expect(verdict(account({ daysDiff: 2, throughDay: "2026-10-04" }))).toEqual({ tone: "bad", text: "2 days differ · ok through 4 Oct" });
    expect(verdict(account({ daysDiff: 1, throughDay: null }))).toEqual({ tone: "bad", text: "1 day differs" });
    expect(dayCounts(account({ daysOk: 1, daysDiff: 1, daysIncomplete: 0 }))).toBe("1 day ok · 1 differs");
    expect(verdict(account({ daysOk: 0, throughDay: null }))).toEqual({ tone: "neutral", text: "No complete day to check yet" });
  });

  it("explains each reason in plain words, a balance move without a deal as money in or out", () => {
    expect(DAY_REASON["no-deals"]).toBe("Balance moved without a deal: a deposit, withdrawal or credit, or a deal insights does not have.");
    expect(DAY_REASON["deals-differ"]).toMatch(/^The deals insights has do not add up to the balance change/u);
    expect(DAY_REASON["no-prior-balance"]).toMatch(/first day/u);
  });

  it("puts the positions and ledger results on one line each", () => {
    expect(positionsLine(positions())).toEqual({ tone: "ok", text: "Open positions ✓ 2 at the venue match insights" });
    expect(positionsLine(positions({ venueCount: 0, insightsCount: 0 })).text).toBe("Open positions ✓ none at the venue, none in insights");
    expect(positionsLine(positions({ status: "stale", venueAt: null })).text).toBe("Open positions: not compared (no recent venue report)");
    const diff = positions({
      status: "diff",
      missing: [{ ticket: "901", symbol: "XAUUSD", side: "BUY", qty: 0.1 }],
      gone: [{ ticket: "877", symbol: "XAUUSD", side: "SELL", qty: 0.25 }],
      mismatched: [{ ticket: "650", symbol: "XAUUSD", field: "qty", venue: 0.3, insights: 0.1 }],
    });
    expect(positionsLine(diff)).toEqual({ tone: "bad", text: "Open positions: 1 at the venue missing in insights · 1 open in insights gone at the venue · 1 with a different side or size" });
    expect(positionIssues(diff)).toEqual([
      "#901 XAUUSD BUY 0.1: open at the venue, no open round trip in insights",
      "#877 XAUUSD SELL 0.25: open in insights, gone at the venue",
      "#650 XAUUSD: qty is 0.3 at the venue, 0.1 in insights",
    ]);
    expect(ledgerLine(ledger())).toEqual({ tone: "ok", text: "Ledger ✓ 412 closed round trips add up to their deals (▲ +1,234.50)" });
    expect(ledgerLine(ledger({ status: "diff", trips: 1, tripsNet: -10, dealsNet: -11 }))).toEqual({ tone: "bad", text: "Ledger: 1 closed round trip sums to −10.00, its deals to −11.00" });
  });

  it("drills a differing day to all-time Trades on its instance, filtered to that UTC day", () => {
    expect(dayTradesPath("qkt-live", "2026-10-03")).toBe("/t?i=qkt-live&range=all&q=exit%3A2026-10-03");
    expect(dayMonth("2026-01-09")).toBe("9 Jan");
  });

  it("counts deals no account takes instead of dropping them", () => {
    expect(unassignedLine(1)).toBe("1 deal not assigned to an account");
    expect(unassignedLine(1204)).toBe("1,204 deals not assigned to an account");
    expect(unassignedLabels([{ broker: "MYSTERY_P1", deals: 2 }, { broker: "OTHER", deals: 1 }])).toEqual(["MYSTERY_P1: 2 deals", "OTHER: 1 deal"]);
  });

  it("says how many deals an ignored magic range kept out, and their net", () => {
    expect(ignoredLine({ ranges: [], deals: 0, net: 0 })).toBeNull();
    expect(ignoredLine({ ranges: ["31000-31199"], deals: 0, net: 0 })).toEqual({ text: "0 deals from another system are left out of strategy totals; the balance check counts them.", title: "Deals from magics 31000-31199" });
    expect(ignoredLine({ ranges: ["31000-31199"], deals: 1204, net: -3.2 })!.text).toBe("1,204 deals from another system (net −3.20) are left out of strategy totals; the balance check counts them.");
    expect(ignoredLine({ ranges: ["40000"], deals: 1, net: 5 })).toEqual({ text: "1 deal from another system (net +5.00) is left out of strategy totals; the balance check counts them.", title: "Deals from magic 40000" });
    expect(ignoredLine({ ranges: [], deals: 2, net: 1 })!.title).toBe("Deals from magic ranges no longer configured");
  });

  it("says why the card is empty", () => {
    expect(EMPTY_TEXT).toMatch(/02:00 UTC/u);
    expect(EMPTY_TEXT).toMatch(/balance/u);
  });
});
