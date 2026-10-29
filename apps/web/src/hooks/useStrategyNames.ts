import { useQuery } from "@tanstack/react-query";
import { get, type StrategyRow } from "../api";
import { strategyDisplayName } from "../portfolio";

/**
 * A strategy's name by id, the one every page shows: its display name (strategyDisplayName), else the id itself
 * while the roster loads or for a strategy it no longer lists. Reads the same cached roster query the pages use.
 */
export function useStrategyNames(instanceId: string | null | undefined): (id: string) => string {
  const roster = useQuery({
    queryKey: ["strategies", instanceId],
    queryFn: () => get<StrategyRow[]>(`/strategies?instance=${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    refetchInterval: 30_000,
  });
  const byId = new Map((roster.data ?? []).map((r) => [r.strategyId, strategyDisplayName(r)]));
  return (id) => byId.get(id) ?? id;
}
