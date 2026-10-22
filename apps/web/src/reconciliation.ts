import type { AccountReconciliation, ReconciledDayReason, ReconciledLedger, ReconciledPositions } from "./api";
import { clock, count, pnl, quantity, signedMoney, tsShort } from "./format";
import { PAGE_PATHS } from "./routes";

/*
 * The wording of the Health page's Reconciliation card, kept out of React so it is tested as
 * text. Days are UTC; the store decides every status, this only says it.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "21 Oct" for "2026-10-21". */
export function dayMonth(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** "checked 02:00 UTC" today, "checked 20 Oct 02:00 UTC" on an earlier day. */
export function checkedLabel(checkedAt: number, now = Date.now()): string {
  const sameDay = new Date(checkedAt).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  return `checked ${sameDay ? clock(checkedAt) : tsShort(checkedAt)} UTC`;
}

export type ReconciliationTone = "ok" | "bad" | "neutral";

/** The account's one-line verdict on its days. */
export function verdict(a: AccountReconciliation): { tone: ReconciliationTone; text: string } {
  if (a.daysDiff > 0) {
    const n = `${count(a.daysDiff)} ${a.daysDiff === 1 ? "day differs" : "days differ"}`;
    return { tone: "bad", text: a.throughDay ? `${n} · ok through ${dayMonth(a.throughDay)}` : n };
  }
  if (a.throughDay) return { tone: "ok", text: `Reconciled ✓ through ${dayMonth(a.throughDay)}${a.daysExternal > 0 ? ` · ${externalCount(a.daysExternal)}` : ""}` };
  return { tone: "neutral", text: "No complete day to check yet" };
}

/** "2 balance moves without a deal": deposits, withdrawals or credits, which are not failures. */
export function externalCount(n: number): string {
  return `${count(n)} balance ${n === 1 ? "move" : "moves"} without a deal`;
}

/** "19 days ok · 1 differs · 2 without a deal · 1 incomplete". */
export function dayCounts(a: AccountReconciliation): string {
  const parts = [`${count(a.daysOk)} ${a.daysOk === 1 ? "day" : "days"} ok`];
  if (a.daysDiff > 0) parts.push(`${count(a.daysDiff)} ${a.daysDiff === 1 ? "differs" : "differ"}`);
  if (a.daysExternal > 0) parts.push(`${count(a.daysExternal)} without a deal`);
  if (a.daysIncomplete > 0) parts.push(`${count(a.daysIncomplete)} incomplete`);
  return parts.join(" · ");
}

/** Why a day is not ok, in plain words. */
export const DAY_REASON: Record<ReconciledDayReason, string> = {
  "no-deals": "Balance moved without a deal: a deposit, withdrawal or credit, or a deal insights does not have.",
  "deals-differ": "The deals insights has do not add up to the balance change: a deal insights does not have, or a deposit, withdrawal or credit the same day.",
  "no-prior-balance": "No balance snapshot before the day began (the account's first day here), so the day has no starting point.",
  "no-balance": "The account reported equity but no balance that day.",
};

/** The open-positions result on one line. */
export function positionsLine(p: ReconciledPositions): { tone: ReconciliationTone; text: string } {
  if (p.status === "stale") return { tone: "neutral", text: "Open positions: not compared, no venue positions report in the 5 minutes before the check" };
  if (p.status === "ok") {
    return { tone: "ok", text: p.venueCount === 0 ? "Open positions ✓ none at the venue, none in insights" : `Open positions ✓ ${count(p.venueCount)} at the venue match insights` };
  }
  const parts: string[] = [];
  if (p.missing.length > 0) parts.push(`${count(p.missing.length)} at the venue missing in insights`);
  if (p.gone.length > 0) parts.push(`${count(p.gone.length)} open in insights gone at the venue`);
  if (p.mismatched.length > 0) parts.push(`${count(p.mismatched.length)} with a different side or size`);
  return { tone: "bad", text: `Open positions: ${parts.join(" · ")}` };
}

/** Each position the check flagged, for the expanded detail: "#123 XAUUSD BUY 0.10: missing in insights". */
export function positionIssues(p: ReconciledPositions): string[] {
  const ref = (x: { ticket: string; symbol: string | null }) => `#${x.ticket}${x.symbol ? ` ${x.symbol}` : ""}`;
  return [
    ...p.missing.map((x) => `${ref(x)} ${x.side ?? ""} ${quantity(x.qty)}: open at the venue, no open round trip in insights`.replace(/ {2,}/gu, " ")),
    ...p.gone.map((x) => `${ref(x)} ${x.side ?? ""} ${quantity(x.qty)}: open in insights, gone at the venue`.replace(/ {2,}/gu, " ")),
    ...p.mismatched.map((x) => `${ref(x)}: ${x.field} is ${x.field === "qty" ? quantity(Number(x.venue)) : x.venue} at the venue, ${x.field === "qty" ? quantity(Number(x.insights)) : x.insights} in insights`),
  ];
}

/** The ledger result on one line. */
export function ledgerLine(l: ReconciledLedger, digits = 2): { tone: ReconciliationTone; text: string } {
  const trips = `${count(l.trips)} closed round ${l.trips === 1 ? "trip" : "trips"}`;
  if (l.status === "ok") return { tone: "ok", text: `Ledger ✓ ${trips} ${l.trips === 1 ? "adds up to its" : "add up to their"} deals (${pnl(l.tripsNet, digits)})` };
  return { tone: "bad", text: `Ledger: ${trips} ${l.trips === 1 ? "sums" : "sum"} to ${signedMoney(l.tripsNet, digits)}, ${l.trips === 1 ? "its" : "their"} deals to ${signedMoney(l.dealsNet, digits)}` };
}

/** "3 deals not assigned to an account": deals whose label and account id match no account (or more than one). */
export function unassignedLine(deals: number): string {
  return `${count(deals)} ${deals === 1 ? "deal" : "deals"} not assigned to an account`;
}

/** Each label behind the unassigned deals, for the expanded detail: "MYSTERY_P1: 2 deals". */
export function unassignedLabels(labels: ReadonlyArray<{ broker: string; deals: number }>): string[] {
  return labels.map((l) => `${l.broker}: ${count(l.deals)} ${l.deals === 1 ? "deal" : "deals"}`);
}

/** What an empty card says, and why: no run stores an account before qkt has sent its balance. */
export const EMPTY_TEXT = "No venue account reconciled yet. The check runs a couple of minutes after the collector starts and every night at 02:00 UTC, for each account qkt has sent a balance for.";

/** Where a differing day drills to: Trades on the instance, all time, filtered to the round trips closed that UTC day. */
export function dayTradesPath(instanceId: string, day: string): string {
  const q = new URLSearchParams({ i: instanceId, range: "all", q: `exit:${day}` });
  return `${PAGE_PATHS.trades}?${q.toString()}`;
}
