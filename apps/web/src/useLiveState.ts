import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { get, type LiveStateSnapshot } from "./api";
import type { LiveEnvelope } from "./useLiveStream";

/**
 * Broker truth from collector memory: account snapshots and open position
 * lists for every instance. Polls every 10s; a WS state.* envelope (passed in
 * from useLiveStream) refetches immediately so panels tick in real time.
 * Consumers filter by their instanceId.
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
    if (newest?.type.startsWith("state.")) qc.invalidateQueries({ queryKey: ["live-state"] });
  }, [newest, qc]);
  return query;
}
