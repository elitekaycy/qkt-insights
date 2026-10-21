import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { get, type LiveAccount, type LiveStateSnapshot } from "./api";
import type { LiveEnvelope } from "./useLiveStream";

function replaceOrAppend<T>(list: T[], match: (x: T) => boolean, next: T): T[] {
  const i = list.findIndex(match);
  if (i < 0) return [...list, next];
  const out = list.slice();
  out[i] = next;
  return out;
}

function accountKey(instanceId: string, account: Pick<LiveAccount, "broker" | "login" | "server" | "accountId">): string {
  if (account.login && account.server) return JSON.stringify([instanceId, account.server, account.login]);
  if (account.accountId) return JSON.stringify([instanceId, account.accountId]);
  return JSON.stringify([instanceId, account.broker]);
}

/** The label an account is shown under: the config entry qkt named, else the label without its profile suffix. */
function displayBroker(p: { broker: string; venue?: { label?: string | null } }): string {
  return p.venue?.label ?? p.broker.replace(/_S\d+$/u, "");
}

/** Folds pushed account state into the cached snapshot so values tick instantly. */
function applyEnvelope(prev: LiveStateSnapshot | undefined, e: LiveEnvelope): LiveStateSnapshot {
  const snap = prev ?? { accounts: [], positions: [], orders: [] };
  const p = e.payload as unknown as Omit<LiveAccount, "instanceId" | "lastSeen" | "stale"> & { venue?: { label?: string | null } };
  const { venue: _venue, ...fields } = p;
  const next: LiveAccount = { ...fields, broker: displayBroker(p), instanceId: e.instanceId, lastSeen: e.ts, stale: false };
  const same = (a: LiveAccount) => accountKey(a.instanceId, a) === accountKey(e.instanceId, next);
  // The collector resolves an account id for an envelope that states none; keep it.
  next.accountId ??= snap.accounts.find(same)?.accountId;
  return { ...snap, accounts: replaceOrAppend(snap.accounts, same, next) };
}

/**
 * Broker truth from collector memory: account snapshots and open position
 * lists for every instance. Polls every 10s as reconciliation; a WS state.*
 * envelope (passed in from useLiveStream) is applied straight into the cache
 * so panels tick the moment the push arrives. Consumers filter by their
 * instanceId.
 */
export function useLiveState(live: LiveEnvelope[] = []): UseQueryResult<LiveStateSnapshot> {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["live-state"],
    queryFn: () => get<LiveStateSnapshot>("/live/state"),
    refetchInterval: 30_000,
  });
  const newest = live[0];
  useEffect(() => {
    if (newest?.type === "state.account") {
      qc.setQueryData<LiveStateSnapshot>(["live-state"], (prev) => applyEnvelope(prev, newest));
    } else if (newest?.type === "state.positions" || newest?.type === "state.orders") {
      void qc.invalidateQueries({ queryKey: ["live-state"] });
    }
  }, [newest, qc]);
  return query;
}
