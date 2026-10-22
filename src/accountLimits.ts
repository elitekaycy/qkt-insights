import { opaqueAccountId } from "@qkt-insights/contract/accountIdentity";
import type { AccountLimitProfile, AccountLimits } from "@qkt-insights/store";

const NUMBERS = ["startBalance", "dailyLossPct", "dailyLoss", "maxDrawdownPct", "maxDrawdown"] as const;

/**
 * INSIGHTS_ACCOUNT_LIMITS: risk limits per venue account, keyed by its account id in any form
 * ("login@server", "mt5:login@server", "vgp:adapter:login" or the opaque "mt5:<16 hex>" the
 * dashboard shows; each is hashed to the opaque id here, so only that is kept), broker label, or
 * "*" for every account, e.g.
 * {"12345678@Broker-Server":{"basis":"static","startBalance":50000,"dailyLossPct":5,"maxDrawdownPct":10,
 *   "dailyResetHour":0,"timezone":"Europe/Athens","dailyLossIncludesFloating":true}}.
 * Unset, the limits come from the strategies' qkt risk config (one account only).
 */
export function parseAccountLimits(json: string | undefined): AccountLimits {
  if (!json?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`INSIGHTS_ACCOUNT_LIMITS is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed))
    throw new Error("INSIGHTS_ACCOUNT_LIMITS must be a JSON object of account -> limits");
  const out: AccountLimits = {};
  for (const [account, raw] of Object.entries(parsed)) {
    const at = `INSIGHTS_ACCOUNT_LIMITS["${account}"]`;
    if (typeof raw !== "object" || raw == null || Array.isArray(raw)) throw new Error(`${at} must be an object`);
    const v = raw as Record<string, unknown>;
    const p: AccountLimitProfile = {};
    for (const k of Object.keys(v)) {
      if (![...NUMBERS, "basis", "dailyResetHour", "timezone", "dailyLossIncludesFloating"].includes(k)) throw new Error(`${at}.${k} is not a known limit`);
    }
    for (const k of NUMBERS) {
      if (v[k] === undefined) continue;
      if (typeof v[k] !== "number" || !Number.isFinite(v[k]) || (v[k] as number) <= 0) throw new Error(`${at}.${k} must be a positive number`);
      p[k] = v[k] as number;
    }
    if (v.basis !== undefined) {
      if (v.basis !== "peak" && v.basis !== "static") throw new Error(`${at}.basis must be "peak" or "static"`);
      p.basis = v.basis;
    }
    if (v.dailyResetHour !== undefined) {
      if (!Number.isInteger(v.dailyResetHour) || (v.dailyResetHour as number) < 0 || (v.dailyResetHour as number) > 23) throw new Error(`${at}.dailyResetHour must be a whole hour 0-23`);
      p.dailyResetHour = v.dailyResetHour as number;
    }
    if (v.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: String(v.timezone) });
      } catch {
        throw new Error(`${at}.timezone must be an IANA timezone such as "UTC" or "Europe/Athens"`);
      }
      p.timezone = String(v.timezone);
    }
    if (v.dailyLossIncludesFloating !== undefined) {
      if (typeof v.dailyLossIncludesFloating !== "boolean") throw new Error(`${at}.dailyLossIncludesFloating must be true or false`);
      p.dailyLossIncludesFloating = v.dailyLossIncludesFloating;
    }
    if (p.basis === "static" && p.startBalance == null) throw new Error(`${at}: a static basis needs startBalance`);
    out[opaqueAccountId(account)] = p;
  }
  return out;
}
