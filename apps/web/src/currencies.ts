import { useQuery } from "@tanstack/react-query";
import { get, type InstanceRow } from "./api";
import type { CurrencyNet } from "./trades/data";
import { useView } from "./view";

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

/**
 * The mark a figure carries when it adds money from accounts in different currencies: "USD+USDC", with what that
 * means for its tooltip ("Adds USD and USDC 1:1, no conversion."). Null when the money is in one currency.
 */
export function currencyMix(currencies: readonly (string | null | undefined)[] | undefined): { label: string; title: string } | null {
  const list = [...new Set((currencies ?? []).filter((c): c is string => !!c))].sort();
  if (list.length < 2) return null;
  const words = list.length === 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return { label: list.join("+"), title: `Adds ${words} 1:1, no conversion.` };
}

/** The mix mark for figures that span the instance's accounts (the shell's instance list); none on a shared link. */
export function useInstanceCurrencyMix(instanceId: string | null): { label: string; title: string } | null {
  const view = useView();
  const instances = useQuery({ queryKey: ["instances"], queryFn: () => get<InstanceRow[]>("/instances"), enabled: !view.public, refetchInterval: 30_000 });
  return view.public ? null : currencyMix(instances.data?.find((i) => i.id === instanceId)?.currencies);
}
