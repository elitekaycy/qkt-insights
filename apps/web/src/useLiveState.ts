import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { get, type LiveAccount, type LivePositionGroup, type LivePositionRow, type LiveStateSnapshot } from "./api";
import type { LiveEnvelope } from "./useLiveStream";

function replaceOrAppend<T>(list: T[], match: (x: T) => boolean, next: T): T[] {
  const i = list.findIndex(match);
  if (i < 0) return [...list, next];
  const out = list.slice();
  out[i] = next;
  return out;
}

/** Folds a pushed state.* envelope into the cached snapshot so values tick instantly. */
function applyEnvelope(prev: LiveStateSnapshot | undefined, e: LiveEnvelope): LiveStateSnapshot {
  const snap = prev ?? { accounts: [], positions: [] };
  if (e.type === "state.account") {
    const p = e.payload as unknown as Omit<LiveAccount, "instanceId" | "lastSeen" | "stale">;
    const next: LiveAccount = { ...p, instanceId: e.instanceId, lastSeen: e.ts, stale: false };
    return { ...snap, accounts: replaceOrAppend(snap.accounts, (a) => a.instanceId === e.instanceId && a.broker === p.broker, next) };
  }
  const p = e.payload as unknown as { broker: string; positions: LivePositionRow[] };
  const next: LivePositionGroup = { instanceId: e.instanceId, broker: p.broker, at: e.ts, stale: false, list: p.positions };
  return { ...snap, positions: replaceOrAppend(snap.positions, (g) => g.instanceId === e.instanceId && g.broker === p.broker, next) };
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
    refetchInterval: 10000,
  });
  const newest = live[0];
  useEffect(() => {
    if (newest?.type === "state.account" || newest?.type === "state.positions") {
      qc.setQueryData<LiveStateSnapshot>(["live-state"], (prev) => applyEnvelope(prev, newest));
    }
  }, [newest, qc]);
  return query;
}
