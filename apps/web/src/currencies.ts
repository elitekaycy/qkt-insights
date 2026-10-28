import type { CurrencyNet } from "./trades/data";

/*
 * Money from venue accounts in different currencies (USD, USDC, USDT) is never one number: the collector
 * splits a trade list's net per account currency, and every figure that still adds across accounts says so.
 */

/** The per-currency nets to show in place of one net: null when the money is in one currency (or none). */
export function splitNets(currencies: readonly CurrencyNet[] | undefined): CurrencyNet[] | null {
  return currencies && currencies.length > 1 ? [...currencies] : null;
}

/** "USD", or "no currency" for round trips on an account that never reported one. */
export function currencyName(c: string | null): string {
  return c ?? "no currency";
}

/** What the app says when an instance's accounts book in more than one currency; null when they do not. */
export function mixedCurrencyNote(instanceId: string, currencies: readonly string[] | undefined): string | null {
  if (!currencies || currencies.length < 2) return null;
  const list = currencies.length === 2 ? currencies.join(" and ") : `${currencies.slice(0, -1).join(", ")} and ${currencies[currencies.length - 1]}`;
  return `Accounts on ${instanceId} book in ${list}. A figure that spans accounts (a strategy's or the account's total, a book) adds them 1:1 with no conversion; trade lists show their net per currency.`;
}
